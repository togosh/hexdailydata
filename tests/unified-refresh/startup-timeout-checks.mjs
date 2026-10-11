import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { execFileSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import { createHash } from 'node:crypto';
import { settlementEvidence } from '../../scripts/unified-refresh/operating-validation.mjs';
import { OperatingOwner } from '../../scripts/unified-refresh/operating.mjs';
import {
  boundedOperatingConfig,
  RealOperatingClock,
  operatingPolicy,
} from '../../scripts/unified-refresh/operating-authority.mjs';
const T = operatingPolicy.root,
  R = await fs.mkdtemp(join(T, 'fixtures/startup-refusals-'));
const read = async (p) => JSON.parse(await fs.readFile(p)),
  h = (b) => createHash('sha256').update(b).digest('hex');
const p0 = await read(join(T, 'session/PERMIT_00000103.json'));
const old = execFileSync('git', [
  'show',
  'c79aab94ca6b8804a893359fe97ad41f329a5921:scripts/unified-refresh/operating-validation.mjs',
]);
await fs.writeFile(join(R, 'executed-validation.mjs'), old, { flag: 'wx' });
const before = await import(pathToFileURL(join(R, 'executed-validation.mjs')));
const cases = [];
for (const name of [
  'valid',
  'old-mode',
  'missing-body',
  'missing-closure',
  'wrong-nonce',
  'wrong-pid',
  'self-reap',
  'missing-reap',
  'synthetic',
  'started',
  'usable',
  'complete',
  'entities',
  'not-durable',
  'body',
  'status',
  'different-failure',
  'refund',
  'refund-objects',
]) {
  const dir = join(R, name);
  await fs.cp(dirname(p0.requestPath), dir, { recursive: true, errorOnExist: true });
  const p = { ...p0, requestPath: join(dir, 'request.json') },
    c = await read(join(dir, 'capture.json')),
    n = await read(join(dir, 'PHYSICAL_CLOSED.json'));
  if (name === 'old-mode') p.closureMode = 'unified-operating-offline-1';
  if (name === 'missing-body')
    await fs.rename(join(dir, 'response.body'), join(dir, 'body.preserved'));
  if (name === 'missing-closure')
    await fs.rename(join(dir, 'PHYSICAL_CLOSED.json'), join(dir, 'closure.preserved'));
  if (name === 'wrong-nonce') n.nonce = 'wrong';
  if (name === 'wrong-pid') n.native.workerPid++;
  if (name === 'self-reap') n.proofOwnerPid = n.native.ownerPid = n.workerPid;
  if (name === 'missing-reap') n.native.childReaped = false;
  if (name === 'synthetic') n.syntheticResponse = true;
  if (name === 'started') {
    n.physicalStarted = true;
    await fs.writeFile(
      join(dir, 'PHYSICAL_STARTED.json'),
      JSON.stringify({ workerPid: n.workerPid }),
    );
  }
  if (name === 'usable') c.usable = true;
  if (name === 'complete') c.complete = true;
  if (name === 'entities') c.entityRows = 0;
  if (name === 'not-durable') c.bodyDurable = false;
  if (name === 'body') {
    await fs.writeFile(join(dir, 'response.body'), 'x');
    c.responseBytes = 1;
    c.responseSha256 = h(Buffer.from('x'));
  }
  if (name === 'status') c.status = 200;
  if (name === 'different-failure') c.failureKind = 'arbitrary';
  if (name === 'refund') c.chargedBytes--;
  if (name === 'refund-objects') c.chargedEntities--;
  const raw = Buffer.from(JSON.stringify(c));
  await fs.writeFile(join(dir, 'capture.json'), raw);
  if (name !== 'missing-closure')
    await fs.writeFile(join(dir, 'PHYSICAL_CLOSED.json'), JSON.stringify(n));
  const m = {
    permitId: p.id,
    nonce: p.nonce,
    attempt: p.attempt,
    closed: true,
    complete: false,
    bytes: c.chargedBytes,
    objects: c.chargedEntities,
    receiptSha256: h(raw),
  };
  if (name === 'valid') {
    await assert.rejects(
      () => before.settlementEvidence(p, m, 'gas'),
      /OPERATING_ABSENT_CAPTURE_REFUSED/,
    );
    await settlementEvidence(p, m, 'gas');
    const clock = new RealOperatingClock(),
      o = await OperatingOwner.open(
        join(R, 'owner'),
        boundedOperatingConfig(clock.now(), true),
        clock,
        { sourceBinding: '1'.repeat(64) },
      );
    await o.register(
      'gas',
      'a'.repeat(64),
      p.job,
      clock.now() + 600,
      operatingPolicy.public.childAllowances.gas,
    );
    o.state.pending = p;
    o.state.totals.rpc = { attempts: 1, bytes: p.bytes, objects: p.objects, extras: 0 };
    await assert.rejects(() => o.settle(p.job, m), /OPERATING_PRE_NETWORK_TIMEOUT_TERMINAL/);
    assert.equal(o.state.pending, null);
    assert.equal(o.state.status, 'UNKNOWN');
    assert.equal(o.state.totals.rpc.bytes, p.bytes);
    assert.equal(o.state.totals.rpc.objects, p.objects);
    assert.equal(o.state.dispatchEvidence.knownNoNetworkDispatch, 1);
    await o.lock.close();
  } else await assert.rejects(() => settlementEvidence(p, m, 'gas'));
  cases.push({ name, status: 'PASS' });
}
await fs.writeFile(
  join(R, 'RESULT.json'),
  JSON.stringify(
    {
      status: 'PASS',
      cases,
      externalRequests: 0,
      baseAdmissions: 0,
      originalEvidenceUnchanged: true,
    },
    null,
    2,
  ) + '\n',
  { flag: 'wx' },
);
console.log(JSON.stringify({ status: 'PASS', root: R, cases: cases.length }));
