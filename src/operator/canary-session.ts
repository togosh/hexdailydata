import { lstat } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { z } from 'zod';
import { atomicJson, safePath } from './files.ts';
import { canaryPlanSchema, planDigest, readCanaryJson, type CanaryPlan } from './canary-plan.ts';
import { realClock, type Clock } from '../providers/budget.ts';
import type { Transport, RpcCall } from '../providers/rpc.ts';
import { PrefixScope, prefixPhase } from './canary-prefix.ts';
import { AuditScope, auditPhase, retainedPhase } from './canary-audit.ts';
import type { AuditAccount } from '../worker/sync/audit.ts';
import { headerSchema } from '../services/projections/input.ts';
import type { RpcDiagnostic } from '../providers/rpc-diagnostic.ts';
import { AttemptGate, CanaryStop } from './attempt-gate.ts';
export { CanaryStop } from './attempt-gate.ts';

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
      checkpoint: headerSchema.optional(),
      progress: z.unknown().optional(),
      accounting: z.unknown().optional(),
    })
    .optional(),
  replay: z
    .strictObject({
      start: headerSchema,
      admissionDigest: z.string(),
      stopHeader: headerSchema.nullable(),
      checkpoint: z.object({
        number: z.string(),
        hash: z.string(),
        timestamp: z.string(),
        revision: z.string(),
      }),
      reachedTarget: z.boolean(),
      progress: z.unknown().nullable(),
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
  private gate = new AttemptGate(this);
  private poisoned = false;
  readonly controller = new AbortController();
  private timer: NodeJS.Timeout | undefined;
  private constructor(
    readonly plan: CanaryPlan,
    readonly state: CanaryState,
    readonly clock: Clock,
    readonly hooks: SessionHooks = {},
  ) {}
  static async checkAuditRoots(plan: CanaryPlan) {
    const audit = retainedPhase(plan);
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
    const audit = retainedPhase(plan);
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
      ...(prefixPhase(plan)?.kind === 'common-prefix'
        ? { prefix: { stopHeader: null, ended: null, secondary: [] } }
        : {}),
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
      ...(audit?.kind === 'common-continue'
        ? {
            replay: {
              start: audit.admission.checkpoint,
              admissionDigest: audit.canonicalDigest,
              stopHeader: null,
              checkpoint: {
                number: audit.admission.checkpoint.number,
                hash: audit.admission.checkpoint.hash,
                timestamp: audit.admission.checkpoint.timestamp,
                revision: audit.admission.revision,
              },
              reachedTarget: false,
              progress: null,
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
  stop(reason: string) {
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
    await this.gate.drain();
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
      retained = retainedPhase(this.plan),
      phase = prefix ?? audit;
    if (retained && !auditContext) throw Error('Retained mode requires admitted SQL context.');
    const scope = audit
      ? new AuditScope(this.plan, audit, auditContext!.inventory, source)
      : prefix
        ? new PrefixScope(this.plan, prefix, source, auditContext?.inventory)
        : null;
    return this.gate.transport(
      chain,
      transport,
      source,
      scope ?? { request: (c, calls) => this.scope(c, calls), response() {} },
      phase,
      retained?.priorDispatchFloor ?? 0,
      auditContext,
    );
  }
  secondary(reason: string) {
    (this.state.audit ?? this.state.prefix)?.secondary.push(reason);
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
