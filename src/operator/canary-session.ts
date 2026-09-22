import { lstat } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { z } from 'zod';
import { atomicJson, safePath } from './files.ts';
import { canaryPlanSchema, planDigest, readCanaryJson, type CanaryPlan } from './canary-plan.ts';
import { realClock, type Clock } from '../providers/budget.ts';
import type { Transport, RpcCall } from '../providers/rpc.ts';
import { PrefixScope, prefixPhase } from './canary-prefix.ts';
import { AuditScope, auditPhase } from './canary-audit.ts';
import type { AuditAccount } from '../worker/sync/audit.ts';
import { headerSchema } from '../services/projections/input.ts';
import { operatorError } from './errors.ts';
import {
  RpcExchange,
  attachRpcDiagnostic,
  rpcDiagnostic,
  safeRpcError,
  type RpcDiagnostic,
} from '../providers/rpc-diagnostic.ts';

const integer = z.number().int().nonnegative().safe();
const stateSchema = z.strictObject({
  version: z.literal(1),
  digest: z.string().regex(/^[0-9a-f]{64}$/),
  storage: z.string(),
  quota: z.string(),
  start: integer.nullable(),
  deadline: integer.nullable(),
  highWater: integer,
  http: integer,
  logical: integer,
  chargedBytes: integer,
  observedBytes: integer,
  uncertainAttempts: integer,
  pending: z.boolean(),
  phase: integer,
  status: z.enum(['prepared', 'running', 'stopped', 'complete']),
  reason: z.string().max(160),
  terminal: z.boolean(),
  results: z.array(z.unknown()).max(12),
  prefix: z
    .strictObject({
      stopHeader: headerSchema.nullable(),
      ended: integer.nullable(),
      secondary: z.array(z.string().max(240)).max(16),
      accounting: z.unknown().optional(),
    })
    .optional(),
  audit: z
    .strictObject({
      ended: integer.nullable(),
      secondary: z.array(z.string().max(240)).max(16),
      before: z.string(),
      after: z.string().nullable(),
      unchanged: z.boolean().nullable(),
      progress: z.unknown().optional(),
      accounting: z.unknown().optional(),
    })
    .optional(),
  rpcDiagnostic: z
    .custom<RpcDiagnostic>(
      (v) =>
        v !== null &&
        typeof v === 'object' &&
        (v as RpcDiagnostic).version === 1 &&
        Buffer.byteLength(JSON.stringify(v)) <= 8192,
    )
    .optional(),
  diagnosticPersistence: z.enum(['saved', 'failed']).optional(),
});
export type CanaryState = z.infer<typeof stateSchema>;
export class CanaryStop extends Error {}
export interface SessionHooks {
  /** Offline crash witnesses only; no environment/CLI mechanism enables these hooks. */
  beforeDispatch?: () => Promise<void>;
  beforeSettlement?: () => Promise<void>;
  beforeFinalSave?: () => Promise<void>;
}
const checksum = (value: unknown) =>
  createHash('sha256').update(JSON.stringify(value)).digest('hex');
async function filesystemIdentity(path: string) {
  const s = await safePath(path);
  return `${s.dev}:${s.ino}`;
}

/** The caller holds both stable filesystem leases until SQL and transport cleanup finish. */
export class CanarySession {
  private tail = Promise.resolve();
  private poisoned = false;
  readonly controller = new AbortController();
  private timer: NodeJS.Timeout | undefined;
  private starts: { at: number; logical: number }[] = [];
  private lastStart = 0;
  private constructor(
    readonly plan: CanaryPlan,
    readonly state: CanaryState,
    readonly clock: Clock,
    readonly hooks: SessionHooks = {},
  ) {}
  static async checkAuditRoots(plan: CanaryPlan) {
    const audit = auditPhase(plan);
    if (audit) {
      const identities = await Promise.all(
        [plan.storagePath, plan.quotaPath].map(filesystemIdentity),
      );
      if (
        identities[0] === identities[1] ||
        identities.some((id) => [audit.priorStorageIdentity, audit.priorQuotaIdentity].includes(id))
      )
        throw Error('Pinned audit requires new distinct filesystem identities.');
      for (const root of [plan.storagePath, plan.quotaPath]) {
        const info = await safePath(root);
        if (info.uid !== process.getuid!()) throw Error('Pinned audit state ownership mismatch.');
      }
    }
  }
  static async prepare(plan: CanaryPlan, clock: Clock = realClock, hooks: SessionHooks = {}) {
    canaryPlanSchema.parse(plan);
    const audit = auditPhase(plan);
    await CanarySession.checkAuditRoots(plan);
    try {
      await lstat(plan.sessionPath);
      throw new Error('Canary session already exists; use status/resume.');
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e;
    }
    const now = clock.now();
    if (!Number.isSafeInteger(now) || now < 0) throw new Error('Invalid canary clock.');
    const state: CanaryState = {
      version: 1,
      digest: planDigest(plan),
      storage: await filesystemIdentity(plan.storagePath),
      quota: await filesystemIdentity(plan.quotaPath),
      start: null,
      deadline: null,
      highWater: now,
      http: 0,
      logical: 0,
      chargedBytes: 0,
      observedBytes: 0,
      uncertainAttempts: 0,
      pending: false,
      phase: 0,
      status: 'prepared',
      reason: 'NOT_RUN',
      terminal: false,
      results: [],
      ...(prefixPhase(plan) ? { prefix: { stopHeader: null, ended: null, secondary: [] } } : {}),
      ...(audit
        ? {
            audit: {
              ended: null,
              secondary: [],
              before: audit.canonicalDigest,
              after: null,
              unchanged: null,
            },
          }
        : {}),
    };
    const session = new CanarySession(plan, state, clock, hooks);
    await session.save();
    return session;
  }
  static async load(plan: CanaryPlan, clock: Clock = realClock, hooks: SessionHooks = {}) {
    await safePath(plan.sessionPath, false);
    const { checksum: storedChecksum, ...state } = stateSchema
      .extend({ checksum: z.string().regex(/^[0-9a-f]{64}$/) })
      .parse(await readCanaryJson(plan.sessionPath));
    if (checksum(state) !== storedChecksum) throw new Error('Corrupt canary state checksum.');
    if (
      state.digest !== planDigest(plan) ||
      state.storage !== (await filesystemIdentity(plan.storagePath)) ||
      state.quota !== (await filesystemIdentity(plan.quotaPath)) ||
      state.phase > plan.phases.length ||
      state.results.length !== state.phase ||
      (state.start === null) !== (state.deadline === null) ||
      (state.start !== null && state.deadline !== state.start + plan.caps.milliseconds) ||
      (state.start === null &&
        (state.http !== 0 ||
          state.logical !== 0 ||
          state.chargedBytes !== 0 ||
          state.status !== 'prepared')) ||
      state.observedBytes > state.chargedBytes ||
      state.http > plan.caps.http ||
      state.logical > plan.caps.logical ||
      (state.start !== null && state.highWater < state.start)
    )
      throw new Error('Incompatible or uncertain canary state; no new allowance.');
    const session = new CanarySession(plan, state, clock, hooks);
    session.time();
    return session;
  }
  time() {
    const now = this.clock.now();
    if (!Number.isSafeInteger(now) || now < this.state.highWater) {
      this.stop('Canary clock rollback/invalid time.');
      throw this.controller.signal.reason;
    }
    this.state.highWater = now;
    return now;
  }
  async save() {
    if (this.poisoned) throw new CanaryStop('Canary persistence uncertain.');
    try {
      this.time();
      const bytes = JSON.stringify(this.state);
      if (Buffer.byteLength(bytes) > 65536) throw new Error('Canary state too large.');
      await atomicJson(this.plan.storagePath, 'canary.json', {
        ...this.state,
        checksum: checksum(this.state),
      });
    } catch {
      this.poisoned = true;
      this.stop('Canary persistence uncertain.');
      throw new CanaryStop('Canary persistence uncertain.');
    }
  }
  check(logical = 0) {
    if (this.state.terminal) throw new CanaryStop('Canary terminal stop; no automatic extension.');
    this.controller.signal.throwIfAborted();
    const s = this.state,
      caps = this.plan.caps;
    const reason =
      this.time() >= s.deadline!
        ? 'elapsed'
        : s.http >= caps.http
          ? 'HTTP'
          : s.logical + logical > caps.logical || s.logical >= caps.logical
            ? 'logical'
            : s.chargedBytes >= caps.bytes
              ? 'bytes'
              : null;
    if (reason) {
      this.stop(`Canary ${reason} cap reached.`);
      throw this.controller.signal.reason;
    }
  }
  private stop(reason: string) {
    this.state.terminal = true;
    this.controller.abort(new CanaryStop(reason));
  }
  async start(resume: boolean, invocationStart = this.time()) {
    if (prefixPhase(this.plan) && resume)
      throw new Error('Common prefix resume is not authorized.');
    if (auditPhase(this.plan) && resume) throw new Error('Pinned audit resume is not authorized.');
    if (resume ? this.state.start === null : this.state.start !== null)
      throw new Error('Use run for prepared sessions; resume requires retained started state.');
    if (this.state.status === 'complete') throw new Error('Canary already complete.');
    if (this.state.start === null) {
      this.state.start = invocationStart;
      this.state.deadline = this.state.start + this.plan.caps.milliseconds;
    }
    if (this.state.pending) {
      // The full reservation was already charged. Never reclaim an unknown response.
      this.state.uncertainAttempts++;
      this.state.pending = false;
    }
    this.check();
    this.state.status = 'running';
    this.state.reason = '';
    await this.save();
    this.timer = setTimeout(
      () => this.stop('Canary elapsed cap reached.'),
      this.state.deadline! - this.time(),
    );
  }
  async finish(status: 'stopped' | 'complete', reason: string) {
    // A failed Promise.all can leave its sibling queued or settling. Cancel and
    // drain the shared transport before publishing the final state; its last
    // reservation/settlement must never race this atomic file replacement.
    await this.close();
    const oneShot = this.state.audit ?? this.state.prefix;
    if (oneShot) {
      await this.hooks.beforeFinalSave?.();
      if (this.time() >= this.state.deadline! || this.state.terminal || this.poisoned) {
        status = 'stopped';
        reason = this.state.reason || 'Canary deadline or finalization failure.';
      }
      this.state.terminal = true; // This grant can never resume, even on ordinary failure.
      oneShot.ended = this.time();
    }
    this.state.status = status;
    this.state.reason = reason.slice(0, 160);
    await this.save();
    if (oneShot && this.time() >= this.state.deadline! && status === 'complete') {
      this.state.status = 'stopped';
      this.state.reason = 'Canary elapsed cap reached during final save.';
      await this.save();
    }
  }
  async completed(result: unknown) {
    this.state.results.push(result);
    this.state.phase++;
    await this.save();
  }
  async close() {
    if (this.timer) clearTimeout(this.timer);
    this.controller.abort(new CanaryStop('Canary stopped.'));
    await this.tail;
  }
  /** All chains/aliases share this serialized gate, including both role budgets. */
  transport(
    chain: 1 | 369,
    transport: Transport,
    source = String(chain),
    auditContext?: { inventory: AuditAccount[]; guard: () => Promise<void> },
  ): Transport {
    const prefix = prefixPhase(this.plan),
      audit = auditPhase(this.plan),
      phase = prefix ?? audit;
    if (audit && !auditContext) throw Error('Pinned audit requires admitted SQL context.');
    const scope = audit
      ? new AuditScope(this.plan, audit, auditContext!.inventory, source)
      : prefix
        ? new PrefixScope(this.plan, prefix, source)
        : null;
    // chain is the authorized logical phase, not eth_chainId of the serving network.
    return async (body, signal, requestDeadline = Infinity) => {
      const previous = this.tail;
      let unlock!: () => void;
      this.tail = new Promise<void>((r) => {
        unlock = r;
      });
      await previous;
      const combined = AbortSignal.any([signal, this.controller.signal]);
      let reserved = 0,
        observed = 0,
        finished = false;
      let dispatchAt: number | null = null;
      let exchange: RpcExchange | undefined;
      const chunks: Buffer[] = [];
      const aborter = new AbortController();
      const active = AbortSignal.any([combined, aborter.signal]);
      const checkDeadline = () => {
        active.throwIfAborted();
        const now = this.time();
        if (now >= this.state.deadline!) {
          this.stop('Canary elapsed cap reached.');
          throw this.controller.signal.reason;
        }
        // A late continuation can precede an already-due abort timer callback.
        // The RPC attempt's absolute deadline therefore travels through this gate.
        if (now >= requestDeadline)
          throw new CanaryStop('Canary original request deadline expired.');
        return now;
      };
      const settle = async (complete: boolean) => {
        if (finished) return;
        finished = true;
        try {
          if (reserved) {
            this.state.observedBytes += observed;
            this.state.chargedBytes +=
              (complete ? observed : Math.max(reserved, observed)) - reserved;
            this.state.pending = false;
            if (!complete) this.state.uncertainAttempts++;
            await this.save();
            if (phase)
              console.log(
                JSON.stringify({
                  event: 'canary_attempt',
                  source,
                  dispatchAt,
                  ended: this.time(),
                  observedBytes: observed,
                  complete,
                  calls: JSON.parse(body).map((c: RpcCall) =>
                    c.method === 'eth_call'
                      ? (c.params[0] as { data: string }).data.slice(0, 10)
                      : c.method,
                  ),
                }),
              );
          }
        } finally {
          unlock();
        }
      };
      const settleAfterError = async (primary: unknown) => {
        try {
          await settle(false);
        } catch (secondary) {
          const oneShot = this.state.audit ?? this.state.prefix;
          if (oneShot) oneShot.secondary.push(operatorError(secondary).slice(0, 240));
          console.error(
            JSON.stringify({
              event: 'canary_settlement_failed',
              primary: operatorError(primary),
              secondary: operatorError(secondary),
              rpcDiagnostic: rpcDiagnostic(primary),
              diagnosticPersistence: 'failed',
            }),
          );
        }
      };
      try {
        combined.throwIfAborted();
        const calls = JSON.parse(body) as RpcCall[];
        if (scope) scope.request(chain, calls);
        else this.scope(chain, calls);
        this.check(calls.length);
        const remaining = this.plan.caps.bytes - this.state.chargedBytes;
        reserved = this.plan.caps.responseBytes * 2;
        if (remaining < reserved) {
          reserved = 0;
          this.stop('Canary byte reservation unavailable.');
          throw this.controller.signal.reason;
        }
        this.state.http++;
        this.state.logical += calls.length;
        this.state.chargedBytes += reserved;
        this.state.pending = true;
        await this.save();
        await this.hooks.beforeDispatch?.();
        if (phase) {
          // Recheck after queueing, persistence and late wakes; this gate counts actual
          // physical starts, not ProviderBudget's earlier slot reservations.
          for (;;) {
            const now = checkDeadline();
            this.starts = this.starts.filter((s) => s.at > now - phase.cadence.rollingMilliseconds);
            const full =
              this.starts.length >= phase.cadence.http ||
              this.starts.reduce((n, s) => n + s.logical, 0) + calls.length > phase.cadence.logical;
            const earliest = Math.max(
              this.state.start! + phase.cadence.quarantineMilliseconds,
              audit?.priorDispatchFloor ?? 0,
              this.lastStart + phase.cadence.spacingMilliseconds,
              full ? this.starts[0]!.at + phase.cadence.rollingMilliseconds : now,
            );
            if (earliest <= now) break;
            await this.clock.sleep(
              Math.min(earliest - now, this.state.deadline! - now, requestDeadline - now),
              active,
            );
          }
        }
        // Fence lost SQL snapshots/locks after cadence/persistence waits and before
        // every physical dispatch, including retries. Never reconnect to continue.
        await auditContext?.guard();
        dispatchAt = checkDeadline();
        this.lastStart = dispatchAt;
        this.starts.push({ at: dispatchAt, logical: calls.length });
        exchange = new RpcExchange(
          source,
          calls,
          this.plan.profile.contract,
          this.state.http,
          dispatchAt,
          requestDeadline,
        );
        exchange.binding = {
          originChainId: chain,
          networkChainId: chain === 1 && this.plan.profile.commonHistory !== 'pulsechain' ? 1 : 369,
        };
        const response = await transport(body, active, requestDeadline);
        exchange.headers(response.status, response.retryAfter);
        const self = this;
        let closed = false;
        let cleanupFailure: unknown;
        const closeResponse = async () => {
          if (closed) {
            if (cleanupFailure) throw cleanupFailure;
            return;
          }
          closed = true;
          try {
            await response.close?.();
          } catch {
            self.stop('Canary response cleanup failed.');
            cleanupFailure = self.controller.signal.reason;
            throw cleanupFailure;
          } finally {
            aborter.abort();
          }
        };
        return {
          ...response,
          exchange,
          close: async () => {
            try {
              await closeResponse();
            } finally {
              await settle(false);
            }
            // Deliberate per-attempt cancellation is distinct from a global stop.
            combined.throwIfAborted();
            if (self.time() >= requestDeadline || self.time() >= self.state.deadline!)
              throw new CanaryStop('Canary original request/session deadline expired.');
          },
          body: (async function* () {
            let complete = false;
            let failure: unknown;
            let receiving = true;
            let sizeFailure = false;
            try {
              for await (const chunk of response.body) {
                // Count the entire observed chunk even if it crosses the ceiling.
                observed += chunk.byteLength;
                exchange!.observe(chunk);
                checkDeadline();
                if (observed > self.plan.caps.responseBytes) {
                  sizeFailure = true;
                  self.stop('Canary response byte cap crossed.');
                  throw self.controller.signal.reason;
                }
                if (scope && response.status === 200) chunks.push(Buffer.from(chunk));
                receiving = false;
                yield chunk;
                receiving = true;
              }
              exchange!.complete = true;
              active.throwIfAborted();
              await self.hooks.beforeSettlement?.();
              if (scope && response.status === 200)
                scope.response(calls, Buffer.concat(chunks).toString('utf8'));
              checkDeadline();
              complete = true;
            } catch (caught) {
              // An exception while unwinding a yielded chunk is an iterator-return
              // failure. It must never be hidden by the client's local RangeError.
              if (!receiving) self.stop('Canary response iterator cleanup failed.');
              const error = !receiving ? self.controller.signal.reason : safeRpcError(caught);
              attachRpcDiagnostic(
                error,
                exchange!.failure(
                  'prefix',
                  self.clock.now(),
                  Buffer.concat(chunks),
                  sizeFailure
                    ? 'response-size'
                    : active.aborted ||
                        self.clock.now() >= requestDeadline ||
                        self.clock.now() >= self.state.deadline!
                      ? 'deadline'
                      : 'scope',
                ),
              );
              failure = error;
              throw error;
            } finally {
              // Hold the serialized transport gate through cleanup and durable
              // settlement, including an early consumer return without acceptance.
              try {
                await closeResponse();
              } catch (cleanup) {
                if (failure) {
                  const diagnostic = rpcDiagnostic(failure);
                  if (diagnostic) diagnostic.cleanupFailed = true;
                } else if (!complete) {
                  attachRpcDiagnostic(
                    cleanup,
                    exchange!.failure('prefix', self.clock.now(), undefined, 'close'),
                  );
                  throw cleanup;
                }
                // A complete body still reaches the unchanged RPC envelope parser.
                // close() then reports cleanup failure without replacing that primary.
              } finally {
                if (failure) await settleAfterError(failure);
                else await settle(complete);
              }
            }
          })(),
        };
      } catch (caught) {
        const e = safeRpcError(caught);
        if (exchange)
          attachRpcDiagnostic(
            e,
            exchange.failure(
              'prefix',
              this.clock.now(),
              undefined,
              active.aborted ||
                this.clock.now() >= requestDeadline ||
                this.clock.now() >= this.state.deadline!
                ? 'deadline'
                : 'transport',
            ),
          );
        aborter.abort();
        await settleAfterError(e);
        throw e;
      }
    };
  }
  private scope(chain: number, calls: RpcCall[]) {
    const contains = (n: unknown) =>
      typeof n === 'string' &&
      /^0x[0-9a-f]+$/.test(n) &&
      this.plan.ranges.some(
        (r) => r.chain === chain && BigInt(r.from) <= BigInt(n) && BigInt(n) <= BigInt(r.to),
      );
    for (const call of calls) {
      if (!this.plan.methods.includes(call.method as CanaryPlan['methods'][number]))
        throw new CanaryStop('Canary method outside approval.');
      if (
        call.method === 'eth_getBlockByNumber' &&
        !contains(call.params[0]) &&
        !(
          this.plan.allowHeadObservation && ['latest', 'finalized'].includes(String(call.params[0]))
        )
      )
        throw new CanaryStop('Canary header outside approved ranges.');
      if (call.method === 'eth_getCode' && !contains(call.params[1]))
        throw new CanaryStop('Canary code read outside approved ranges.');
      if (call.method === 'eth_getLogs') {
        const f = call.params[0] as { fromBlock: string; toBlock: string };
        if (
          !this.plan.ranges.some(
            (r) =>
              r.chain === chain &&
              BigInt(r.from) <= BigInt(f.fromBlock) &&
              BigInt(f.toBlock) <= BigInt(r.to),
          )
        )
          throw new CanaryStop('Canary logs outside approved ranges.');
      }
      if (
        call.method === 'eth_getTransactionReceipt' &&
        (chain !== 1 || call.params[0] !== this.plan.profile.constructor.transactionHash)
      )
        throw new CanaryStop('Canary receipt outside approved constructor.');
    }
  }
}
