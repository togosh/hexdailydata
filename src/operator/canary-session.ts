import { lstat } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { z } from 'zod';
import { atomicJson, safePath } from './files.ts';
import { canaryPlanSchema, planDigest, readCanaryJson, type CanaryPlan } from './canary-plan.ts';
import { realClock, type Clock } from '../providers/budget.ts';
import type { Transport, RpcCall } from '../providers/rpc.ts';
import { PrefixScope, prefixPhase } from './canary-prefix.ts';
import { headerSchema } from '../services/projections/input.ts';
import { operatorError } from './errors.ts';

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
  static async prepare(plan: CanaryPlan, clock: Clock = realClock, hooks: SessionHooks = {}) {
    canaryPlanSchema.parse(plan);
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
      if (bytes.length > 65536) throw new Error('Canary state too large.');
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
    if (this.state.prefix) {
      await this.hooks.beforeFinalSave?.();
      if (this.time() >= this.state.deadline! || this.state.terminal || this.poisoned) {
        status = 'stopped';
        reason = this.state.reason || 'Canary deadline or finalization failure.';
      }
      this.state.terminal = true; // This grant can never resume, even on ordinary failure.
      this.state.prefix.ended = this.time();
    }
    this.state.status = status;
    this.state.reason = reason.slice(0, 160);
    await this.save();
    if (this.state.prefix && this.time() >= this.state.deadline! && status === 'complete') {
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
  transport(chain: 1 | 369, transport: Transport, source = String(chain)): Transport {
    const phase = prefixPhase(this.plan);
    const scope = phase ? new PrefixScope(this.plan, phase, source) : null;
    // chain is the authorized logical phase, not eth_chainId of the serving network.
    return async (body, signal) => {
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
      const chunks: Buffer[] = [];
      const aborter = new AbortController();
      const active = AbortSignal.any([combined, aborter.signal]);
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
          if (this.state.prefix)
            this.state.prefix.secondary.push(operatorError(secondary).slice(0, 240));
          console.error(
            JSON.stringify({
              event: 'canary_settlement_failed',
              primary: operatorError(primary),
              secondary: operatorError(secondary),
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
            active.throwIfAborted();
            const now = this.time();
            if (now >= this.state.deadline!) throw new CanaryStop('Canary elapsed cap reached.');
            this.starts = this.starts.filter((s) => s.at > now - phase.cadence.rollingMilliseconds);
            const full =
              this.starts.length >= phase.cadence.http ||
              this.starts.reduce((n, s) => n + s.logical, 0) + calls.length > phase.cadence.logical;
            const earliest = Math.max(
              this.state.start! + phase.cadence.quarantineMilliseconds,
              this.lastStart + phase.cadence.spacingMilliseconds,
              full ? this.starts[0]!.at + phase.cadence.rollingMilliseconds : now,
            );
            if (earliest <= now) break;
            await this.clock.sleep(Math.min(earliest - now, this.state.deadline! - now), active);
          }
        }
        active.throwIfAborted();
        if (this.time() >= this.state.deadline!) {
          this.stop('Canary elapsed cap reached.');
          throw this.controller.signal.reason;
        }
        dispatchAt = this.time();
        this.lastStart = dispatchAt;
        this.starts.push({ at: dispatchAt, logical: calls.length });
        const response = await transport(body, active);
        const self = this;
        return {
          ...response,
          close: async () => {
            aborter.abort();
            try {
              await response.close?.();
            } finally {
              await settle(false);
            }
          },
          body: (async function* () {
            let complete = false;
            let failed = false;
            try {
              for await (const chunk of response.body) {
                // Count the entire observed chunk even if it crosses the ceiling.
                observed += chunk.byteLength;
                if (observed > self.plan.caps.responseBytes) {
                  self.stop('Canary response byte cap crossed.');
                  throw self.controller.signal.reason;
                }
                active.throwIfAborted();
                if (self.time() >= self.state.deadline!) {
                  self.stop('Canary elapsed cap reached.');
                  throw self.controller.signal.reason;
                }
                if (scope && response.status === 200) chunks.push(Buffer.from(chunk));
                yield chunk;
              }
              active.throwIfAborted();
              await self.hooks.beforeSettlement?.();
              if (scope && response.status === 200)
                scope.response(calls, Buffer.concat(chunks).toString('utf8'));
              complete = true;
            } catch (error) {
              failed = true;
              await settleAfterError(error);
              throw error;
            } finally {
              aborter.abort();
              if (!failed) await settle(complete);
            }
          })(),
        };
      } catch (e) {
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
