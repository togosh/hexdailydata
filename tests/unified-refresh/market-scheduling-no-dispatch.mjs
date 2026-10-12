import '../mainline/deny-network.mjs';
// Negative checks over the actual enclosing no-dispatch output, never public evidence.
import fs from 'node:fs/promises';
import assert from 'node:assert/strict';
import { join, dirname } from 'node:path';
import { createHash } from 'node:crypto';
import { settlementEvidence } from '../../scripts/unified-refresh/operating-validation.mjs';
const T = process.argv[2];
assert(T.endsWith('hex-liquidity-scheduling-r1'));
const source = process.argv[3];
assert(source.startsWith(T + '\\fixtures\\operating-scheduling-overload-'));
const read = async (p) => JSON.parse(await fs.readFile(p));
const h = (b) => createHash('sha256').update(b).digest('hex');
const permits = await Promise.all(
  (await fs.readdir(source)).filter((n) => /^PERMIT_/.test(n)).map((n) => read(join(source, n))),
);
const p0 = permits.find((p) => p.dispatchAllowed === false);
assert(p0);
const m0 = await read(join(source, 'SETTLEMENT_' + String(p0.id).padStart(8, '0') + '.json'));
const root = await fs.mkdtemp(join(T, 'fixtures/no-dispatch-negative-')),
  results = [];
for (const name of [
  'valid',
  'missing-proof',
  'wrong-nonce',
  'wrong-request',
  'wrong-reason',
  'fake-reap',
  'usable',
  'complete',
  'body',
  'status',
  'refund',
  'foreign-owner',
  'unexpected-start',
]) {
  const dir = join(root, name);
  await fs.cp(dirname(p0.requestPath), dir, { recursive: true, errorOnExist: true });
  const p = { ...p0, requestPath: join(dir, 'request.json') },
    m = { ...m0 };
  const c = await read(join(dir, 'capture.json')),
    proof = await read(join(dir, 'NATIVE_NO_DISPATCH.json')),
    physical = await read(join(dir, 'PHYSICAL_CLOSED.json'));
  if (name === 'missing-proof')
    await fs.rename(join(dir, 'NATIVE_NO_DISPATCH.json'), join(dir, 'MISSING_PROOF.preserved'));
  if (name === 'wrong-nonce') proof.nonce = 'wrong';
  if (name === 'wrong-request') proof.requestSha256 = '0'.repeat(64);
  if (name === 'wrong-reason') proof.reason = 'arbitrary';
  if (name === 'fake-reap') c.childReaped = true;
  if (name === 'usable') c.usable = true;
  if (name === 'complete') c.complete = true;
  if (name === 'status') c.status = 200;
  if (name === 'body') {
    await fs.writeFile(join(dir, 'response.body'), 'x');
    c.responseBytes = 1;
    c.responseSha256 = h(Buffer.from('x'));
  }
  if (name === 'refund') {
    m.bytes--;
    c.chargedBytes--;
  }
  if (name === 'foreign-owner') proof.ownerPid++;
  if (name === 'unexpected-start')
    await fs.writeFile(join(dir, 'PHYSICAL_STARTED.json'), JSON.stringify({ workerPid: 123 }));
  const raw = Buffer.from(JSON.stringify(c));
  await fs.writeFile(join(dir, 'capture.json'), raw);
  m.receiptSha256 = h(raw);
  if (name !== 'missing-proof')
    await fs.writeFile(join(dir, 'NATIVE_NO_DISPATCH.json'), JSON.stringify(proof));
  await fs.writeFile(join(dir, 'PHYSICAL_CLOSED.json'), JSON.stringify(physical));
  let error = null;
  try {
    await settlementEvidence(p, m, 'market');
  } catch (e) {
    error = String(e);
  }
  if (name === 'valid') assert.equal(error, null);
  else assert(error, name);
  results.push({ case: name, status: 'PASS', refusal: error });
}
await fs.writeFile(
  join(root, 'RESULT.json'),
  JSON.stringify(
    { status: 'PASS', synthetic: true, networkRequests: 0, realBaseAdmissions: 0, cases: results },
    null,
    2,
  ) + '\n',
  { flag: 'wx' },
);
console.log(JSON.stringify({ status: 'PASS', root, cases: results.length }));
