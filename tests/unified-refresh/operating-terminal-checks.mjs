// Saved-only timeout receipt replay plus actual network-denied native cancellation.
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import { join } from 'node:path';
import { OperatingOwner } from '../../scripts/unified-refresh/operating.mjs';
import { settlementEvidence } from '../../scripts/unified-refresh/operating-validation.mjs';
import {
  operatingPolicy,
  boundedOperatingConfig,
  RealOperatingClock,
} from '../../scripts/unified-refresh/operating-authority.mjs';
import { sha } from '../../dist/services/source-update/generation.js';
import { runOperating } from '../../scripts/refresh-data.mjs';
import { runFixture } from './operating-fixture.mjs';
const T = operatingPolicy.root,
  read = async (p) => JSON.parse(await fs.readFile(p));
const original = join(T, 'session/gas-00000003/captures/00010');
const permit = await read(join(T, 'session/PERMIT_00000043.json'));
assert.equal(permit.job, 'gas-00000003');
const R = await fs.mkdtemp(join(T, 'fixtures/terminal-checks-')),
  cases = [];
const mutations = [
  ['exact-enclosing-timeout', null],
  [
    'old-mode-unchanged',
    (p, c, t, n) => {
      p.closureMode = 'unified-operating-offline-1';
    },
  ],
  [
    'missing-reap',
    (p, c, t, n) => {
      n.native.childReaped = false;
    },
  ],
  [
    'self-reap',
    (p, c, t, n) => {
      n.proofOwnerPid = n.workerPid;
      n.native.ownerPid = n.workerPid;
    },
  ],
  [
    'wrong-nonce',
    (p, c, t, n) => {
      n.nonce = 'wrong';
    },
  ],
  [
    'synthetic-proof',
    (p, c, t, n) => {
      n.syntheticResponse = true;
    },
  ],
  [
    'http-status-with-fallback',
    (p, c, t, n) => {
      c.status = 200;
    },
  ],
  [
    'different-error',
    (p, c, t, n) => {
      c.failureKind = 'arbitrary';
    },
  ],
  [
    'refunded-incomplete',
    (p, c, t, n) => {
      c.chargedBytes--;
    },
  ],
];
for (const [name, mutate] of mutations) {
  const dir = join(R, name);
  await fs.mkdir(dir);
  for (const e of await fs.readdir(original, { withFileTypes: true }))
    if (e.isFile()) await fs.copyFile(join(original, e.name), join(dir, e.name));
  const p = { ...permit, requestPath: join(dir, 'request.json') },
    capture = await read(join(dir, 'capture.json')),
    transport = await read(join(dir, 'transport.json')),
    native = await read(join(dir, 'PHYSICAL_CLOSED.json'));
  mutate?.(p, capture, transport, native);
  for (const [file, v] of [
    ['capture.json', capture],
    ['transport.json', transport],
    ['PHYSICAL_CLOSED.json', native],
  ])
    await fs.writeFile(join(dir, file), JSON.stringify(v) + '\n');
  const m = {
    permitId: p.id,
    nonce: p.nonce,
    attempt: p.attempt,
    closed: true,
    complete: false,
    bytes: capture.chargedBytes,
    objects: capture.chargedEntities,
    receiptSha256: sha(await fs.readFile(join(dir, 'capture.json'))),
  };
  if (mutate) {
    await assert.rejects(() => settlementEvidence(p, m, 'gas'));
    cases.push({ name, status: 'REFUSED_AS_REQUIRED' });
    continue;
  }
  const clock = new RealOperatingClock(),
    config = boundedOperatingConfig(clock.now(), true),
    o = await OperatingOwner.open(join(R, 'owner'), config, clock, {
      sourceBinding: '1'.repeat(64),
    });
  await o.register(
    'gas',
    'a'.repeat(64),
    p.job,
    clock.now() + 600,
    operatingPolicy.public.childAllowances.gas,
  );
  o.state.pending = p;
  o.state.totals.rpc = { attempts: 1, bytes: p.bytes, objects: p.objects, extras: 0 };
  await o.settle(p.job, m);
  assert.equal(o.state.pending, null);
  assert.equal(o.state.totals.rpc.bytes, p.bytes);
  assert.equal(o.state.totals.rpc.objects, p.objects);
  assert.equal(o.state.dispatchEvidence.observedHttpResponses, 0);
  assert.equal(o.state.dispatchEvidence.knownNoNetworkDispatch, 0);
  o.jobs.clear();
  o.state.active = [];
  await o.close();
  cases.push({
    name,
    status: 'PASS_FULL_CHARGE_NO_DATA',
    chargedBytes: p.bytes,
    chargedObjects: p.objects,
  });
}
await fs.writeFile(
  join(R, 'RESULT.json'),
  JSON.stringify(
    {
      status: 'PASS',
      cases,
      networkRequests: 0,
      baseAdmissions: 0,
      originalEvidenceUnchanged: true,
    },
    null,
    2,
  ) + '\n',
);
const before = new Set(await fs.readdir(join(T, 'fixtures')));
assert.equal(await runFixture(T, 'operating-cancel-retry', runOperating), 0);
const created = (await fs.readdir(join(T, 'fixtures'))).filter(
  (n) => !before.has(n) && n.startsWith('operating-operating-cancel-retry-'),
);
assert.equal(created.length, 1);
const fixture = join(T, 'fixtures', created[0]),
  jobs = await fs.readdir(join(fixture, 'operating'), { withFileTypes: true });
const fixtureResult = await read(join(fixture, 'evidence/RESULT.json'));
assert(fixtureResult.result.chargedPhysicalAttempts >= 1, 'COLLECTOR_MUST_REACH_PHYSICAL_PATH');
const native = [];
for (const e of jobs)
  if (e.isDirectory() && e.name.startsWith('trade-')) {
    const r = await read(join(fixture, 'operating', e.name, 'NATIVE_TERMINATION.json'));
    assert(r.knownClosure && r.childCloseObserved && r.childExitObserved);
    assert(r.ownerPid !== r.childPid);
    assert(
      ['native-cutoff', 'handler-cutoff'].includes(r.cutoffStage),
      'CUTOFF_BEFORE_NORMAL_CLOSURE_REQUIRED',
    );
    const trigger = await read(join(fixture, 'operating', e.name, 'CANCELLATION_TRIGGER.json'));
    assert(
      trigger.triggered &&
        trigger.childPid === r.childPid &&
        trigger.observedControl.type === 'operating-wait' &&
        trigger.observedControl.seconds >= 2,
      'ACTUAL_RETRY_WAIT_CANCELLATION_REQUIRED',
    );
    assert(
      (await read(join(fixture, 'operating', e.name, 'NETWORK_DENIAL.json'))).externalRequests ===
        0,
    );
    native.push(r);
  }
assert(native.length > 0);
await fs.writeFile(
  join(R, 'NATIVE_CANCELLATION_CHECK.json'),
  JSON.stringify(
    { status: 'PASS', fixture, native, networkRequests: 0, baseAdmissions: 0 },
    null,
    2,
  ) + '\n',
);
console.log(
  JSON.stringify({
    status: 'PASS',
    fixture: R,
    timeoutCases: cases.length,
    nativeCancellation: true,
    networkRequests: 0,
    baseAdmissions: 0,
  }),
);
