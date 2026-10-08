import assert from 'node:assert/strict';
import { readFile, mkdtemp, lstat, writeFile } from 'node:fs/promises';
import { join, basename } from 'node:path';
import { qualifyCompletion, publishCycle } from '../../scripts/market-refresh.mjs';
import {
  ProductDailyStore,
  writeProductGeneration,
} from '../../dist/services/product-daily/store.js';
import { applyMarketUpdate } from '../../dist/services/product-daily/market.js';
import { productFiles } from '../../dist/services/product-daily/project.js';
const R = process.env.HDD_TASK_ROOT,
  p = JSON.parse(await readFile(join(R, 'PRODUCT_PROFILE.json'))),
  ptr = (({ version, manifestSha256 }) => ({ version, manifestSha256 }))(
    JSON.parse(await readFile(join(R, 'INPUTS.json'))).selectedSmallGeneration,
  );
const result = {
  status: 'COMPLETE_FINITE_TRIAL',
  rounds: 3,
  accounting: { status: 'CLOSED', pending: null },
};
assert.equal(
  qualifyCompletion(result, { code: 0, signal: null }, result, result.accounting, 3, 3).complete,
  true,
);
for (const [exit, final, published] of [
  [{ code: 1 }, result, 3],
  [{ code: 0 }, { ...result, rounds: 2 }, 3],
  [{ code: 0 }, result, 2],
  [{ code: 0, signal: 'SIGTERM' }, result, 3],
])
  assert.equal(
    qualifyCompletion(result, exit, final, result.accounting, published, 3).complete,
    false,
  );
const files = { ...ptr, files: {} };
for (const n of [
  'MANIFEST.json',
  'daily.ndjson',
  'daily.csv',
  'metadata.json',
  'exceptions.ndjson',
])
  files.files[n] = await readFile(join(p.productRoot, ptr.version, n));
const dirs = [];
for (const kind of ['unknown', 'late']) {
  const dir = await mkdtemp(join(R, 'scratch/review-' + kind + '-'));
  dirs.push(dir);
  await writeProductGeneration(dir, files);
  const s = new ProductDailyStore(dir, p.pair);
  await s.select(ptr);
  const lease = await s.acquireWriter();
  if (kind === 'unknown') {
    await assert.rejects(s.releaseWriter(lease, true), /UNCERTAIN/);
  } else {
    const original = await readFile(join(dir, 'CURRENT.json')),
      update = JSON.parse(await readFile(join(R, 'evidence/SYNTHETIC_UPDATE_1.json'))),
      exceptions = files.files['exceptions.ndjson'].toString().trim().split('\n').map(JSON.parse);
    const next = productFiles(applyMarketUpdate({ ...s.capture(), exceptions }, update));
    await writeProductGeneration(dir, next);
    await assert.rejects(
      s.select(
        { version: next.version, manifestSha256: next.manifestSha256 },
        {
          writer: lease,
          beforeCommit() {
            throw Error('SYNTHETIC_EXPIRED_OR_CLOSED_CONTROLLER');
          },
        },
      ),
      /EXPIRED/,
    );
    assert.deepEqual(await readFile(join(dir, 'CURRENT.json')), original);
    await assert.rejects(s.releaseWriter(lease), /UNCERTAIN/);
  }
  assert((await lstat(join(dir, 'SELECTION.lock'))).isFile());
}
await assert.rejects(
  publishCycle(null, null, null, { expiresAtUnixSeconds: Date.now() / 1000 - 1 }),
  /DEADLINE/,
);
await writeFile(
  join(R, 'evidence/REVIEW_FIX_TESTS_' + basename(dirs[0]) + '.json'),
  JSON.stringify({
    status: 'PASS',
    synthetic: true,
    checks: [
      'native nonzero/signal/mismatched final/incomplete publication cannot report completion',
      'unknown closure retains writer lock',
      'late precommit refuses pointer mutation and retains lock',
      'expired publication refused before file access',
    ],
    dirs,
  }) + '\n',
  { flag: 'wx' },
);
console.log('PASS reviewed closure/publication corrections');
