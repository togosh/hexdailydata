import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { resolve, join } from 'node:path';
import { ReconstructionClock } from '../../dist/operator/reconstruction-clock.js';
import { reconstructionPlanSchema } from '../../dist/operator/reconstruction-plan.js';
import { digest } from '../../dist/services/projections/input.js';
import {
  normalClockBoundary,
  replayClockFloor,
} from '../../scripts/operator/reconstruction-boundary.mjs';
import { coordinate } from '../../scripts/operator/reconstruction-job.mjs';
import { jobFixture } from './job-fixture.mjs';
const root = resolve(
  process.env.HDD_V2_AUDIT_CLOCK_EVIDENCE ?? 'artifacts/task-10/target-only-audit-20260928/clock',
);
mkdirSync(root, { recursive: true });
const old = JSON.parse(readFileSync('config/reconstruction.synthetic.example.json'));
const p = reconstructionPlanSchema.parse({
  ...old,
  auditOnly: true,
  target: old.admission.checkpoint.number,
  milestones: [old.admission.checkpoint.number],
  methods: old.methods.filter((m) => m !== 'eth_getLogs'),
});
function auditState() {
  const pin = { header: p.admission.checkpoint, revision: p.admission.revision };
  const a = {
    pin,
    canonical: p.canonicalDigest,
    schema: '1'.repeat(64),
    inventory: p.inventoryDigest,
    count: Number(p.admission.counts.accounts),
    sources: p.profile.ethereum.map((s) => ({ source: s.id, count: 0, after: null, pages: 0 })),
    bytes: 0,
    commitment: digest([]),
    finalizing: false,
  };
  a.binding = digest({
    pin,
    canonical: a.canonical,
    schema: a.schema,
    inventory: { count: a.count, digest: a.inventory },
    instance: p.instance,
    profile: p.profile,
    endpoints: p.endpoints,
  });
  return {
    accepted: pin,
    audited: null,
    milestone: 0,
    phase: 'audit',
    stopHeader: pin.header,
    audit: a,
    pending: false,
    pendingSql: null,
    terminal: false,
    status: 'paused',
    canonicalAtPause: p.canonicalDigest,
  };
}
test('normal audit-only clock boundary requires exact clean pin and healthy clocks', () => {
  const s = auditState();
  assert(normalClockBoundary(p, s));
  for (const patch of [{ terminal: true }, { pending: true }, { status: 'blocked' }])
    assert(!normalClockBoundary(p, { ...s, ...patch }));
  for (const patch of [
    { accepted: { ...s.accepted, revision: '999' } },
    { pendingSql: {} },
    { canonicalAtPause: 'f'.repeat(64) },
  ])
    assert.throws(() => normalClockBoundary(p, { ...s, ...patch }));
  const healthy = {
    domain: 'reconstruction-ceiling-epoch-ms',
    failed: false,
    effective: 1000,
    rawWall: 1000,
    anomalies: { count: 0, first: null, last: null },
  };
  assert.equal(
    replayClockFloor(
      { highWater: 1000, clockDiagnostic: healthy },
      { highWater: 1000, clock: healthy },
    ),
    1000,
  );
  assert.throws(() =>
    replayClockFloor(
      { highWater: 1000, clockDiagnostic: { ...healthy, failed: true } },
      { highWater: 1000, clock: healthy },
    ),
  );
});
test('actual coordinator waits at a normal audit pause, revalidates before dispatch and fails closed', async () => {
  const results = [];
  for (const mode of ['progress', 'changed-boundary', 'expiry', 'cancel', 'frozen', 'terminal']) {
    const f = jobFixture(join(root, mode + '-' + randomUUID()));
    Object.assign(f.options.plan, p);
    f.options.operation = p.run;
    Object.assign(f.state(), {
      digest: digest(f.options.plan),
      ...auditState(),
      start: null,
      status: 'prepared',
      segment: null,
    });
    let wall = Date.now(),
      mono = 0n,
      floor,
      checked = 0;
    const clock = new ReconstructionClock({
      wall: () => wall,
      monotonic: () => mono,
      sleep: async (ms, signal) => {
        signal.throwIfAborted();
        if (mode === 'cancel') process.emit('SIGINT');
        if (mode !== 'frozen') mono += BigInt(ms) * 1000000n;
        wall += mode === 'expiry' ? p.caps.milliseconds + 1000 : ms;
      },
    });
    const snapshot = f.adapter.snapshot;
    f.adapter.snapshot = async (...args) => {
      const r = await snapshot(...args);
      floor = wall + 186;
      Object.assign(r.state, auditState(), { highWater: floor, digest: digest(f.options.plan) });
      if (mode === 'terminal') Object.assign(r.state, { status: 'blocked', terminal: true });
      return r;
    };
    f.adapter.boundary = async (previous, next, refresh) => {
      if (next === 'resume') {
        checked++;
        assert(normalClockBoundary(p, previous));
        if (refresh && mode === 'changed-boundary') throw Error('Synthetic changed audit prefix');
      }
      return { normalSeal: true, highWater: floor };
    };
    const launch = f.adapter.launch;
    f.adapter.launch = async (...args) => {
      if (args[1] === 2) {
        assert(wall >= floor);
        assert.equal(checked, 2);
        f.events.push('next-dispatch');
        throw Error('Synthetic dispatch reached');
      }
      return launch(...args);
    };
    const result = await coordinate(f.options, f.adapter, clock);
    assert.equal(f.events.includes('next-dispatch'), mode === 'progress', JSON.stringify(result));
    assert.notEqual(result.outcome, 'SCOPED_INTERVAL_COMPLETE');
    if (mode === 'progress') assert.equal(result.error, 'Synthetic dispatch reached');
    else if (mode === 'changed-boundary')
      assert.equal(result.error, 'Synthetic changed audit prefix');
    results.push({ mode, result, checked, clock: clock.snapshot(), events: f.events });
  }
  writeFileSync(join(root, 'audit-handoff.json'), JSON.stringify(results, null, 2));
});
