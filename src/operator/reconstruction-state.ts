import { readdir, lstat } from 'node:fs/promises';
import { z } from 'zod';
import { atomicJson, safePath } from './files.ts';
import { readCanaryJson } from './canary-plan.ts';
import { AttemptGate, CanaryStop } from './attempt-gate.ts';
import { digest, headerSchema, uint, address } from '../services/projections/input.ts';
import {
  exact,
  sha,
  reconstructionPlanSchema,
  type ReconstructionPlan,
} from './reconstruction-plan.ts';
import type { Clock } from '../providers/budget.ts';
import type { SessionHooks } from './canary-session.ts';
import { ReconstructionClock, clockValue } from './reconstruction-clock.ts';

const checkpoint = z.strictObject({ header: headerSchema, revision: uint });
const coverage = z.strictObject({
  source: z.string().max(80),
  count: exact,
  after: address.nullable(),
  pages: exact,
});
const audit = z.strictObject({
  pin: checkpoint,
  canonical: sha,
  schema: sha,
  inventory: sha,
  count: exact,
  binding: sha,
  sources: z.tuple([coverage, coverage]),
  bytes: exact,
  commitment: sha,
  finalizing: z.boolean(),
});
const counters = { http: exact, logical: exact, chargedBytes: exact, observedBytes: exact };
const segment = z.strictObject({
  number: exact,
  started: exact,
  deadline: exact,
  before: z.strictObject(counters),
  ended: exact.nullable(),
});
export const reconstructionStateSchema = z.strictObject({
  version: z.literal(1),
  kind: z.literal('reconstruction-state'),
  digest: sha,
  storage: z.string(),
  quota: z.string(),
  start: exact.nullable(),
  deadline: exact.nullable(),
  highWater: exact,
  ...counters,
  uncertainAttempts: exact,
  pending: z.boolean(),
  status: z.enum(['prepared', 'running', 'paused', 'blocked', 'complete']),
  phase: z.enum(['replay', 'milestone-pending', 'audit', 'milestone-audited', 'complete']),
  reason: z.string().max(240),
  terminal: z.boolean(),
  accepted: checkpoint,
  audited: checkpoint.nullable(),
  milestone: exact,
  stopHeader: headerSchema.nullable(),
  pendingSql: z
    .strictObject({ previous: checkpoint, next: checkpoint, batchDigest: sha })
    .nullable(),
  canonicalAtPause: sha.nullable(),
  audit: audit.nullable(),
  segment: segment.nullable(),
  receipts: z.array(segment).max(16),
  pausedMs: exact,
  lastEnded: exact.nullable(),
  secondary: z.array(z.string().max(240)).max(16),
  rpcDiagnostic: z.unknown().optional(),
  clockDiagnostic: z.unknown().optional(),
  fullTask10: z.literal('PENDING'),
  productionReady: z.literal(false),
});
export type ReconstructionState = z.infer<typeof reconstructionStateSchema>;
/** Audit-only has no SQL transition to recover and never earns a new checkpoint. */
export function assertAuditOnlyState(p: ReconstructionPlan, s: ReconstructionState) {
  if (!p.auditOnly) return;
  const pin = { header: p.admission.checkpoint, revision: p.admission.revision };
  const finished = s.milestone === 1;
  const a = s.audit;
  if (
    digest(s.accepted) !== digest(pin) ||
    s.pendingSql !== null ||
    s.phase === 'replay' ||
    (s.phase === 'audit' && a === null) ||
    (s.start === null &&
      (a !== null ||
        s.milestone !== 0 ||
        s.pending ||
        s.logical !== 0 ||
        s.chargedBytes !== 0 ||
        s.observedBytes !== 0 ||
        s.uncertainAttempts !== 0)) ||
    (s.canonicalAtPause !== null && s.canonicalAtPause !== p.canonicalDigest) ||
    (finished
      ? digest(s.audited) !== digest(pin) ||
        a !== null ||
        s.stopHeader !== null ||
        !['milestone-audited', 'complete'].includes(s.phase)
      : s.milestone !== 0 ||
        s.audited !== null ||
        digest(s.stopHeader) !== digest(pin.header) ||
        !['milestone-pending', 'audit'].includes(s.phase)) ||
    (a &&
      (digest(a.pin) !== digest(pin) ||
        (a.finalizing && a.sources.some((source) => source.count !== a.count)) ||
        a.canonical !== p.canonicalDigest ||
        a.inventory !== p.inventoryDigest ||
        String(a.count) !== p.admission.counts.accounts ||
        a.binding !==
          digest({
            pin,
            canonical: a.canonical,
            schema: a.schema,
            inventory: { count: a.count, digest: a.inventory },
            instance: p.instance,
            profile: p.profile,
            endpoints: p.endpoints,
          })))
  )
    throw Error('BLOCKED_UNCERTAIN: audit-only admission/progress changed.');
}
export class ReconstructionPause extends Error {}
export async function rootIdentity(root: string) {
  const s = await safePath(root);
  if (s.uid !== process.getuid!()) throw Error('Operation root ownership mismatch.');
  return `${s.dev}:${s.ino}`;
}
export const cadence = {
  cadence: {
    rollingMilliseconds: 60000,
    http: 12,
    logical: 360,
    spacingMilliseconds: 2100,
    quarantineMilliseconds: 60000,
  },
};

/** Small, checked cumulative record. Detailed comparisons live in a streamed file. */
export class ReconstructionSession {
  readonly controller = new AbortController();
  readonly gate = new AttemptGate(this);
  private poisoned = false;
  private timer: NodeJS.Timeout | undefined;
  clockFailure: unknown;
  waitStarted = 0;
  constructor(
    readonly plan: ReconstructionPlan,
    readonly state: ReconstructionState,
    readonly clock: Clock,
    readonly hooks: SessionHooks = {},
  ) {
    if (clock instanceof ReconstructionClock)
      clock.context = () => ({
        phase: state.phase,
        checkpoint: state.accepted,
        segment: state.segment?.number ?? null,
      });
  }
  static async roots(p: ReconstructionPlan) {
    const ids = await Promise.all([p.storagePath, p.quotaPath].map(rootIdentity));
    if (ids[0] === ids[1] || ids.some((id) => p.excludedRootIdentities.includes(id)))
      throw Error('Old/spent or duplicate roots refused.');
    return ids;
  }
  static async prepare(p: ReconstructionPlan, clock: Clock) {
    reconstructionPlanSchema.parse(p);
    const ids = await this.roots(p);
    for (const root of [p.storagePath, p.quotaPath])
      if ((await readdir(root)).some((n) => n !== '.maintenance.lock'))
        throw Error('Prepare requires new empty operation roots.');
    const state: ReconstructionState = {
      version: 1,
      kind: 'reconstruction-state',
      digest: digest(p),
      storage: ids[0]!,
      quota: ids[1]!,
      start: null,
      deadline: null,
      highWater: clock.now(),
      http: 0,
      logical: 0,
      chargedBytes: 0,
      observedBytes: 0,
      uncertainAttempts: 0,
      pending: false,
      status: 'prepared',
      phase: p.auditOnly ? 'milestone-pending' : 'replay',
      reason: 'NOT_RUN',
      terminal: false,
      accepted: { header: p.admission.checkpoint, revision: p.admission.revision },
      audited: null,
      milestone: 0,
      stopHeader: p.auditOnly ? p.admission.checkpoint : null,
      pendingSql: null,
      canonicalAtPause: p.canonicalDigest,
      audit: null,
      segment: null,
      receipts: [],
      pausedMs: 0,
      lastEnded: null,
      secondary: [],
      fullTask10: 'PENDING',
      productionReady: false,
    };
    const s = new ReconstructionSession(p, state, clock);
    await s.save();
    return s;
  }
  static async load(p: ReconstructionPlan, clock: Clock, hooks: SessionHooks = {}) {
    try {
      await lstat(p.storagePath + '/blocked.json');
      throw Error('BLOCKED_UNCERTAIN: durable failure marker; no automatic recovery.');
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e;
    }
    await safePath(p.storagePath + '/reconstruction.json', false);
    const raw = (await readCanaryJson(p.storagePath + '/reconstruction.json')) as Record<
      string,
      unknown
    >;
    const { checksum, ...payload } = raw;
    if (sha.parse(checksum) !== digest(payload))
      throw Error('BLOCKED_UNCERTAIN: corrupt operation checksum.');
    const state = reconstructionStateSchema.parse(payload);
    assertAuditOnlyState(p, state);
    const ids = await this.roots(p);
    if (
      state.digest !== digest(p) ||
      state.storage !== ids[0] ||
      state.quota !== ids[1] ||
      (state.start === null) !== (state.deadline === null) ||
      (state.start !== null &&
        state.deadline !==
          Math.min(state.start + p.caps.milliseconds, p.expiresAt ?? Number.MAX_SAFE_INTEGER)) ||
      state.http > p.caps.http ||
      state.logical > p.caps.logical ||
      state.observedBytes > state.chargedBytes ||
      state.milestone > p.milestones.length ||
      BigInt(state.accepted.header.number) > BigInt(p.target) ||
      (state.start === null &&
        (state.http !== 0 || state.segment !== null || state.status !== 'prepared'))
    )
      throw Error('BLOCKED_UNCERTAIN: incompatible/corrupt operation record.');
    const milestone = p.milestones[state.milestone],
      audit = state.audit;
    if (
      BigInt(state.accepted.header.number) < BigInt(p.admission.checkpoint.number) ||
      BigInt(state.accepted.revision) < BigInt(p.admission.revision) ||
      (state.milestone === 0
        ? state.audited !== null
        : state.audited?.header.number !== p.milestones[state.milestone - 1]) ||
      (milestone && BigInt(state.accepted.header.number) > BigInt(milestone)) ||
      (audit &&
        (digest(audit.pin) !== digest(state.accepted) ||
          digest(state.stopHeader) !== digest(audit.pin.header) ||
          audit.sources.some(
            (s, i) =>
              s.source !== p.profile.ethereum[i]!.id ||
              s.count > audit.count ||
              s.pages !== Math.ceil(s.count / 10),
          ) ||
          (audit.sources[1].count > 0 && audit.sources[0].count !== audit.count))) ||
      (state.pendingSql &&
        (digest(state.pendingSql.previous) !== digest(state.accepted) ||
          !milestone ||
          BigInt(state.pendingSql.next.header.number) > BigInt(milestone) ||
          BigInt(state.pendingSql.next.header.number) <= BigInt(state.accepted.header.number) ||
          BigInt(state.pendingSql.next.revision) !== BigInt(state.accepted.revision) + 1n)) ||
      (state.status === 'complete' &&
        (state.phase !== 'complete' ||
          state.milestone !== p.milestones.length ||
          state.accepted.header.number !== p.target ||
          digest(state.audited) !== digest(state.accepted) ||
          audit ||
          state.pending ||
          state.pendingSql))
    )
      throw Error('BLOCKED_UNCERTAIN: inconsistent checkpoint/audit progress.');
    const s = new ReconstructionSession(p, state, clock, hooks);
    // Fresh-process admission checks raw UTC, before the ceiling can conceal a gap.
    if (clock instanceof ReconstructionClock) clock.assertContinuity(state.highWater);
    else if (clock.wallNow && clock.wallNow() < state.highWater)
      throw Error('Clock continuity failure: raw UTC below durable high-water.');
    s.time();
    return s;
  }
  time() {
    try {
      const now = this.clock.now();
      if (!Number.isSafeInteger(now) || now < this.state.highWater) {
        this.state.clockDiagnostic = {
          domain: 'injected-effective-ms',
          classification: 'terminal',
          phase: this.state.phase,
          checkpoint: this.state.accepted,
          segment: this.state.segment?.number ?? null,
          previousEffective: this.state.highWater,
          reading: clockValue(now),
        };
        throw Error('Clock rollback or invalid clock.');
      }
      this.state.highWater = now;
      return now;
    } catch (error) {
      this.clockFailure ??= error;
      this.state.clockDiagnostic = this.clock.snapshot?.() ?? this.state.clockDiagnostic;
      this.stop(error instanceof Error ? error.message : 'Invalid clock.');
      throw this.clockFailure;
    }
  }
  waitTime() {
    this.time();
    try {
      return this.clock.waitNow?.() ?? this.state.highWater;
    } catch {
      return this.time();
    }
  }
  deadline() {
    return this.state.segment?.deadline ?? this.state.deadline!;
  }
  stop(reason: string) {
    this.state.terminal = true;
    this.state.reason ||= reason.slice(0, 240);
    this.controller.abort(new CanaryStop(reason));
  }
  secondary(reason: string) {
    if (this.state.secondary.length < 16) this.state.secondary.push(reason.slice(0, 240));
  }
  async save() {
    if (this.poisoned) throw Error('BLOCKED_UNCERTAIN: persistence failed.');
    try {
      // A known clock fault still permits terminal accounting evidence, never work.
      if (!this.clockFailure) {
        try {
          this.time();
        } catch {
          /* time marks this operation terminal */
        }
      }
      this.state.clockDiagnostic = this.clock.snapshot?.() ?? this.state.clockDiagnostic;
      if (this.clockFailure) {
        if (this.state.status === 'complete' || !this.state.reason)
          this.state.reason =
            this.clockFailure instanceof Error ? this.clockFailure.message : 'Invalid clock.';
        this.state.status = 'blocked';
        if (this.state.phase === 'complete') this.state.phase = 'milestone-audited';
        this.state.lastEnded = null;
        if (this.state.segment) this.state.segment.ended = null;
      }
      reconstructionStateSchema.parse(this.state);
      assertAuditOnlyState(this.plan, this.state);
      if (Buffer.byteLength(JSON.stringify(this.state)) > 60000)
        throw Error('Control record too large.');
      await atomicJson(this.plan.storagePath, 'reconstruction.json', {
        ...this.state,
        checksum: digest(this.state),
      });
    } catch (e) {
      this.poisoned = true;
      this.stop('BLOCKED_UNCERTAIN: persistence failed.');
      // If the state replacement failed but a bounded failure receipt can still
      // be persisted, refuse future processes even when the prior page was valid.
      // A host invocation also remains terminal/uncertain when storage is wholly lost.
      await atomicJson(this.plan.storagePath, 'blocked.json', {
        run: this.plan.run,
        reason: 'persistence-failed',
      }).catch(() => {});
      throw e;
    }
    if (this.clockFailure) throw this.clockFailure;
  }
  totals() {
    const { http, logical, chargedBytes, observedBytes } = this.state;
    return { http, logical, chargedBytes, observedBytes };
  }
  check(logical = 0) {
    this.controller.signal.throwIfAborted();
    const s = this.state,
      now = this.time(),
      caps = this.plan.caps;
    if (
      s.terminal ||
      now >= s.deadline! ||
      s.http >= caps.http ||
      s.logical + logical > caps.logical ||
      s.logical >= caps.logical ||
      s.chargedBytes + (logical ? 8388608 : 0) > caps.bytes ||
      s.chargedBytes >= caps.bytes
    ) {
      this.stop('Whole-run allowance exhausted/expired; no renewal.');
      throw this.controller.signal.reason;
    }
    const seg = s.segment!,
      cap = this.plan.segment;
    if (
      now >= seg.deadline ||
      // Leave the existing 15-second request deadline available before an audit
      // dispatch. A hard expiry during requests/finalization remains terminal.
      (this.plan.auditOnly && logical > 0 && seg.deadline - now <= 15000) ||
      s.http - seg.before.http >= cap.http ||
      s.logical - seg.before.logical + logical > cap.logical ||
      s.chargedBytes - seg.before.chargedBytes + (logical ? 8388608 : 0) > cap.bytes
    )
      throw new ReconstructionPause('Segment allowance reached at accepted checkpoint/page.');
  }
  assertStartable(resume: boolean) {
    const s = this.state;
    if (s.terminal || s.status === 'complete' || (resume ? s.start === null : s.start !== null))
      throw Error('Operation cannot run/resume.');
  }
  async start(resume: boolean, invoked: number) {
    this.assertStartable(resume);
    const s = this.state,
      now = this.time();
    this.waitStarted = this.waitTime();
    if (
      !Number.isSafeInteger(invoked) ||
      invoked > now ||
      invoked <= 0 ||
      (s.lastEnded !== null && invoked < s.lastEnded)
    )
      throw Error('Invalid original host invocation.');
    if (s.pending) {
      this.stop('BLOCKED_UNCERTAIN: outstanding response reservation retained.');
      throw this.controller.signal.reason;
    }
    if (s.start === null) {
      s.start = invoked;
      s.deadline = Math.min(
        invoked + this.plan.caps.milliseconds,
        this.plan.expiresAt ?? Number.MAX_SAFE_INTEGER,
      );
      if (!Number.isSafeInteger(s.deadline)) throw Error('Deadline overflow.');
    }
    if (s.lastEnded !== null) s.pausedMs += now - s.lastEnded;
    if (s.segment) {
      s.receipts.push(s.segment);
      s.receipts = s.receipts.slice(-16);
    }
    s.segment = {
      number: (s.segment?.number ?? 0) + 1,
      started: invoked,
      deadline: Math.min(s.deadline!, invoked + this.plan.segment.milliseconds),
      before: this.totals(),
      ended: null,
    };
    s.status = 'running';
    s.reason = '';
    s.canonicalAtPause = null;
    await this.save(); // Before SQL, startup or dispatch; pauses never move the whole deadline.
    this.check();
    this.timer = setTimeout(
      () => this.stop('Segment hard deadline expired.'),
      Math.max(1, this.deadline() - this.time()),
    );
  }
  async close() {
    if (this.timer) clearTimeout(this.timer);
    this.controller.abort(new CanaryStop('Operation process closed.'));
    await this.gate.drain();
  }
}
