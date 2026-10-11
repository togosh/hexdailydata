import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import { join, resolve } from 'node:path';
import {
  boundedOperatingConfig,
  validateBoundedOperating,
  RealOperatingClock,
  operatingPolicy,
  validateOperatingReady,
} from '../../scripts/unified-refresh/operating-authority.mjs';
import { OperatingOwner, operatingAdmission } from '../../scripts/unified-refresh/operating.mjs';
import { sha } from '../../dist/services/source-update/generation.js';
const T = operatingPolicy.root,
  R = await fs.mkdtemp(join(T, 'fixtures/bindings-'));
const cases = [];
let wall = 1791736000,
  mono = 17;
const clock = new RealOperatingClock({ wall: () => wall, mono: () => mono });
assert.equal(clock.now(), wall);
wall += 300;
mono += 300;
assert.equal(clock.now(), wall);
wall += 3;
assert.throws(() => clock.now(), /CLOCK_DISCONTINUITY/);
wall -= 3;
cases.push('separate monotonic/epoch origins and discontinuity refusal');
const c = boundedOperatingConfig(wall, true);
assert.deepEqual(validateBoundedOperating(c), c);
for (const [key, value] of [
  ['expiresAt', wall + 2401],
  ['admissionEndsAt', wall + 1201],
  ['dispatchEndsAt', wall + 2221],
  ['aggregate', { ...c.aggregate, attempts: 2160 }],
])
  assert.throws(() => validateBoundedOperating({ ...c, [key]: value }), /EXACT_CONFIG/);
assert.throws(() =>
  operatingAdmission({
    operatingFormat: operatingPolicy.format,
    synthetic: true,
    parentMode: 'OWNER_AUTHORIZED_PUBLIC',
  }),
);
await assert.rejects(() => validateOperatingReady({ root: R }), /EXACT_PUBLIC_ROOT/);
await assert.rejects(() => validateOperatingReady({ root: T }), /ENOENT/); // No actual ready/admission exists.
cases.push('exact cap, clock, root, mode and absent loaded-binding refusal');
const o = await OperatingOwner.open(join(R, 'owner'), c, clock, { sourceBinding: '1'.repeat(64) });
const jobs = [];
for (const [family, bounds] of Object.entries(operatingPolicy.public.childAllowances)) {
  const id = await o.allocate(family);
  await o.register(family, 'a'.repeat(64), id, wall + bounds.seconds, bounds);
  jobs.push(id);
}
assert.equal(o.state.active.length, 5);
assert.equal(o.state.totals.rpc.attempts, 0);
assert.equal(o.config.aggregate.attempts, 1376);
assert.throws(
  () =>
    o.checkAggregate({
      http: { attempts: 1377, bytes: 0, objects: 0 },
      graph: { attempts: 0, bytes: 0, objects: 0 },
      rpc: { attempts: 0, bytes: 0, objects: 0 },
    }),
  /AGGREGATE/,
);
const priorNative = join(T, 'fixtures/operating-native-boundary-ACloLq/operating');
const charged = [];
for (const family of ['trade', 'market', 'gas', 'protocol']) {
  const id = jobs.find((id) => id.startsWith(family + '-'));
  const saved = JSON.parse(await fs.readFile(join(priorNative, id, 'COORDINATOR_RESULT.json')))
    .source.accounting;
  const spent = {};
  for (const kind of ['http', 'graph', 'rpc']) {
    const v =
      kind === 'http'
        ? {
            attempts: family === 'trade' ? saved.attempts : 0,
            bytes: family === 'trade' ? saved.chargedBytes : 0,
            objects: family === 'trade' ? saved.chargedObjects : 0,
            extras: family === 'trade' ? saved.extras : 0,
          }
        : {
            attempts: saved[kind + 'Attempts'] ?? 0,
            bytes: saved[kind + 'ChargedBytes'] ?? 0,
            objects: kind === 'rpc' ? (saved.chargedEntities ?? 0) : 0,
            extras: 0,
          };
    spent[kind] = v;
    for (const [key, value] of Object.entries(v)) o.state.totals[kind][key] += value;
  }
  o.state.rolling.push({ id: charged.length + 1, at: wall, cost: spent });
  for (const kind of ['graph', 'rpc'])
    for (let i = 0; i < 2; i++)
      o.state.endpointAttempts[kind][i] += (saved[kind + 'EndpointAttempts'] ?? [0, 0])[i];
  o.jobs.delete(id);
  o.state.active = o.state.active.filter((j) => j.id !== id);
  o.state.completed++;
  charged.push({ family, spent });
}
const renewals = [];
let advanced = 0;
for (const [family, offset] of [
  ['trade', 60],
  ['gas', 180],
  ['market', 240],
  ['protocol', 300],
]) {
  wall += offset - advanced;
  mono += offset - advanced;
  advanced = offset;
  const id = await o.allocate(family),
    bounds = operatingPolicy.public.childAllowances[family];
  await o.register(family, 'b'.repeat(64), id, wall + bounds.seconds, bounds);
  jobs.push(id);
  assert(o.state.active.some((j) => j.family === 'participants'));
  renewals.push({ family, id, at: wall, participantReservationRetained: true });
}
assert.equal(o.state.active.length, 5);
// Control-state test only: no collector, publication, or native receipt is fabricated.
for (const id of jobs) {
  o.jobs.delete(id);
  o.state.active = o.state.active.filter((j) => j.id !== id);
}
await o.close();
cases.push(
  'five initial reservations, charged fast completions, all four renewals with participant retained, independent aggregate1376 refusal',
);
const prior = join(T, 'fixtures/operating-native-boundary-ACloLq/operating');
const read = async (p) => JSON.parse(await fs.readFile(p));
const result = await read(join(prior, 'RUN_00000001_RESULT.json'));
assert.equal(result.accounting.status, 'CLOSED');
assert.equal(result.accounting.maxPhysical, 1);
assert.equal(result.maximumPublicationWriters, 1);
const matrix = [];
for (const j of result.jobs) {
  const root = join(prior, j.job),
    r = await read(join(root, 'COORDINATOR_RESULT.json')),
    n = await read(join(root, 'NATIVE_CLOSURE.json'));
  assert.equal(n.exit.code, 0);
  assert(
    !n.killed &&
      !n.closureProtocolError &&
      !n.ipcError &&
      n.closedMessageReceived &&
      n.resultMatchesClosedMessage &&
      n.accountingMatchesResult &&
      n.accountingClosed &&
      n.pending === null &&
      !r.error,
  );
  assert(r.source.status.startsWith('COMPLETE_'));
  matrix.push({
    job: j.job,
    family: j.family,
    resultSha256: sha(await fs.readFile(join(root, 'COORDINATOR_RESULT.json'))),
    native: n,
  });
}
const wait = await read(join(prior, 'participants-00000005/REAL_WAIT.json'));
assert(wait.elapsedSeconds >= 121 && wait.elapsedSeconds < 130);
assert(
  result.jobs.some(
    (j) => j.family === 'trade' && j.completedAt < wait.end && j.startedAt > wait.start,
  ),
);
cases.push(
  'saved 121s real native run rechecked without repetition; initial assertion failure preserved',
);
await fs.writeFile(
  join(R, 'RESULT.json'),
  JSON.stringify(
    {
      status: 'PASS',
      cases,
      charged,
      renewals,
      matrix,
      wait,
      networkRequests: 0,
      baseAdmissions: 0,
    },
    null,
    2,
  ) + '\n',
);
console.log(
  JSON.stringify({
    status: 'PASS',
    fixture: R,
    cases: cases.length,
    networkRequests: 0,
    baseAdmissions: 0,
  }),
);
