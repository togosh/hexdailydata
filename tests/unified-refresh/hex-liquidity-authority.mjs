import 'file:///C:/Code/HEXDailyData-v2-Subgraph-History-R2/tests/mainline/deny-network.mjs';
import fs from 'node:fs/promises';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { OperatingOwner, operatingAdmission } from '../../scripts/unified-refresh/operating.mjs';
import {
  operatingPolicy,
  boundedOperatingConfig,
  validateBoundedOperating,
} from '../../scripts/unified-refresh/operating-authority.mjs';
import { canonical } from '../../dist/services/source-update/generation.js';
const T = process.argv[2],
  W = String.raw`C:\Code\HEXDailyData-v2-Subgraph-History-R2`;
assert.equal(T, operatingPolicy.root);
assert.equal(operatingPolicy.task, 'HDD-HEX-LIQUIDITY-PUBLIC-QUALIFICATION-R1');
const c = boundedOperatingConfig(1791772000, true),
  roots = [],
  cases = [];
assert.equal(c.families.participants.enabled, false);
assert.equal(c.maximumJobsByFamily.participants, 0);
assert.equal(c.participants.maximumActivationBlocks, 0);
assert.equal(c.total.graph.attempts, 96);
assert.equal(c.physicalAttemptSubcaps.graph, 48);
assert.equal(c.aggregate.attempts, 336);
for (const path of [
  ['families', 'participants', 'enabled'],
  ['physicalAttemptSubcaps', 'graph'],
  ['total', 'graph', 'attempts'],
  ['aggregate', 'attempts'],
  ['expiresAt'],
  ['admissionEndsAt'],
  ['dispatchEndsAt'],
]) {
  const bad = structuredClone(c);
  let x = bad;
  for (const k of path.slice(0, -1)) x = x[k];
  const k = path.at(-1);
  x[k] = typeof x[k] === 'boolean' ? !x[k] : x[k] + 1;
  assert.throws(() => validateBoundedOperating(bad));
  cases.push('reject ' + path.join('.'));
}
const py =
  "import sys,json;sys.path.insert(0,r'" +
  W +
  "\\scripts\\unified-refresh');import operating_authority as a;print(json.dumps(a.bounded_config(1791772000)))";
const native = JSON.parse(execFileSync('python', ['-I', '-S', '-c', py, T], { encoding: 'utf8' }));
assert.equal(canonical(native), canonical(boundedOperatingConfig(c.startsAt)));
cases.push('exact Node/Python public config equality');
const schedule = Object.entries(operatingPolicy.public.families)
  .filter(([, v]) => v.enabled)
  .flatMap(([f, v]) =>
    Array.from({ length: v.maximumJobs }, (_, i) => [f, v.offsetSeconds + i * v.periodSeconds]),
  )
  .sort((a, b) => a[1] - b[1]);
async function owner() {
  const root = await fs.mkdtemp(join(T, 'fixtures/admission-'));
  roots.push(root);
  let now = c.startsAt;
  const o = await OperatingOwner.open(
    root,
    c,
    { mode: 'REAL_EPOCH', now: () => now },
    { sourceBinding: 'b'.repeat(64) },
  );
  return { o, set: (t) => (now = t), root };
}
const { o, set, root } = await owner();
const steps = [];
try {
  await assert.rejects(o.allocate('participants'), /OPERATING_ALLOCATION/);
  await assert.rejects(
    o.register('participants', 'a'.repeat(64), 'participants-00000001', c.startsAt + 600, {}),
    /OPERATING_FAMILY_CONCURRENCY/,
  );
  cases.push('disabled participant allocation and registration');
  for (const [f, t] of schedule) {
    set(c.startsAt + t);
    const id = await o.allocate(f),
      allowance = operatingPolicy.public.childAllowances[f],
      deadline = Math.min(c.startsAt + t + 600, c.dispatchEndsAt);
    if (!steps.length)
      await assert.rejects(
        o.register(f, 'a'.repeat(64), id, deadline, { ...allowance, httpAttempts: 7 }),
        /OPERATING_EXACT_CHILD_ALLOWANCE/,
      );
    const j = await o.register(f, 'a'.repeat(64), id, deadline, allowance);
    steps.push({
      family: f,
      offset: t,
      deadline,
      endpointBefore: structuredClone(o.state.endpointAttempts),
      caps: j.caps,
      endpointCaps: j.endpointCaps,
    });
    // Arithmetic-only worst case. No claimed native completion, transport, receipt or publication.
    for (const p of ['http', 'graph', 'rpc'])
      for (const k of ['attempts', 'bytes', 'objects', 'extras'])
        o.state.totals[p][k] += j.caps[p][k];
    o.state.endpointAttempts.rpc[0] += j.caps.rpc.attempts / 2;
    o.state.endpointAttempts.rpc[1] += j.caps.rpc.attempts / 2;
    o.state.endpointAttempts.graph[0] += j.caps.graph.attempts;
    o.state.rolling.push({ at: c.startsAt + t, cost: structuredClone(j.caps) });
    o.jobs.delete(id);
    o.state.active = o.state.active.filter((x) => x.id !== id);
    o.state.completed++;
  }
  assert.equal(steps.length, 15);
  assert.equal(steps.filter((x) => x.family === 'market').length, 2);
  assert.equal(o.state.totals.graph.attempts, 48);
  assert.equal(o.state.totals.rpc.attempts, 240);
  assert.equal(o.state.totals.http.attempts, 48);
  const zero = () =>
    Object.fromEntries(
      ['http', 'graph', 'rpc'].map((p) => [p, { attempts: 0, bytes: 0, objects: 0, extras: 0 }]),
    );
  o.checkAggregate(zero());
  let extra = zero();
  extra.graph.attempts = 1;
  assert.throws(() => o.checkAggregate(extra), /OPERATING_PHYSICAL_SUBCAP/);
  await assert.rejects(o.allocate('trade'), /OPERATING_JOB_BOUND/);
  cases.push(
    'all 15 exact admissions with full worst-case rolling totals and concentrated graph endpoint',
  );
  cases.push('48 graph and 336 aggregate are independent from 96 admission headroom');
  const saved = o.config.physicalAttemptSubcaps;
  delete o.config.physicalAttemptSubcaps;
  assert.throws(() => o.checkAggregate(extra), /OPERATING_AGGREGATE_RESERVE/);
  o.config.physicalAttemptSubcaps = saved;
} finally {
  o.state.status = 'ARITHMETIC_FIXTURE_CLOSED_NO_NATIVE_OPERATION';
  await o.save();
  await o.lock.close();
}
const active = await owner();
try {
  for (const f of ['trade', 'market', 'gas', 'protocol']) {
    const id = await active.o.allocate(f);
    await active.o.register(
      f,
      'c'.repeat(64),
      id,
      c.startsAt + 600,
      operatingPolicy.public.childAllowances[f],
    );
  }
  assert.equal(active.o.jobs.size, 4);
  await assert.rejects(
    active.o.register(
      'market',
      'c'.repeat(64),
      'market-00000006',
      c.startsAt + 600,
      operatingPolicy.public.childAllowances.market,
    ),
    /OPERATING_FAMILY_CONCURRENCY/,
  );
  cases.push('four active closing liabilities, duplicate/fifth native admission refused');
} finally {
  active.o.state.status = 'ARITHMETIC_FIXTURE_CLOSED_NO_NATIVE_OPERATION';
  await active.o.save();
  await active.o.lock.close();
}
const a = {
  operatingFormat: c.format,
  authorityTaskId: operatingPolicy.task,
  parentMode: 'DENIED_NETWORK_TEST',
  synthetic: true,
  clockMode: 'REAL_EPOCH',
  family: 'participants',
};
assert.throws(() => operatingAdmission(a), /OPERATING_BOUNDARY_MODE/);
cases.push('participant boundary source rejected');
const result = {
  status: 'PASS',
  synthetic: true,
  networkRequests: 0,
  genuineBaseAdmissions: 0,
  kind: 'ACTUAL_REGISTER_ARITHMETIC_NOT_COLLECTOR_COMPLETION',
  roots,
  steps,
  cases,
  totals: o.state.totals,
  endpoints: o.state.endpointAttempts,
};
await fs.writeFile(
  join(T, 'evidence/NEW_AUTHORITY_ADMISSION_' + (process.argv[3] ?? 'final') + '.json'),
  JSON.stringify(result, null, 2) + '\n',
  { flag: 'wx' },
);
console.log(JSON.stringify({ status: result.status, jobs: steps.length, cases: cases.length }));
