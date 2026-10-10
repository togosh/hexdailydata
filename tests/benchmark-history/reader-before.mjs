// Execute before changing reader code. Only actual baseline reducer/preservation functions.
import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { admitProduct } from '../../dist/services/product-daily/store.js';
import {
  applyMarketUpdate,
  preserveMarketHistory,
} from '../../dist/services/product-daily/market.js';
import { productFiles } from '../../dist/services/product-daily/project.js';
import { hash } from '../../dist/history-bootstrap/normalize.js';
const R = process.env.HDD_TASK_ROOT;
assert(R?.endsWith('btc-eth-daily-close-reader-adoption-r1'));
const inputs = JSON.parse(await readFile(join(R, 'INPUTS.json')));
const p = inputs.preserveGenuine;
const seed = await admitProduct(join(R, 'seed-backup/product', p.hdsRollback), p.hdsManifestSha256);
const exceptions = (
  await readFile(join(R, 'seed-backup/product', p.hdsRollback, 'exceptions.ndjson'), 'utf8')
)
  .trim()
  .split('\n')
  .filter(Boolean)
  .map(JSON.parse);
const update = JSON.parse(await readFile(join(R, 'data/HISTORY_UPDATE.json')));
const close = applyMarketUpdate({ ...seed, exceptions }, update);
assert.equal(productFiles(close).version, p.closeProduct);
preserveMarketHistory(seed, close);
const reference = seed.metadata.readings
  .filter((r) => r.kind === 'reference')
  .map((r) => ({ ...r, roundId: String(BigInt(r.roundId) + 1n) }));
const later = applyMarketUpdate(close, {
  readings: reference,
  liquidityHistory: [],
  receiptSha256: hash('SYNTHETIC reader defect same-time round'),
});
assert.equal(later.metadata.marketStorage.sequence, 24);
assert.equal(later.metadata.effectiveAtUtc, seed.metadata.effectiveAtUtc);
preserveMarketHistory(close, later);
let error;
try {
  preserveMarketHistory(seed, later);
} catch (e) {
  error = e.message;
}
assert.equal(error, 'BENCHMARK_UNCERTIFIED_QUIET_CHANGE');
await writeFile(
  join(R, 'evidence/BEFORE_FIX.json'),
  JSON.stringify(
    {
      status: 'REPRODUCED',
      baseCommit: inputs.sourceBase.commit,
      actualFunctions: true,
      cachedSequence: 22,
      missedSequence: 23,
      latestSequence: 24,
      error,
      exactIntermediate: productFiles(close).version,
      validDescendant: productFiles(later).version,
      sourceTimesUnchanged: true,
      externalRequests: 0,
    },
    null,
    2,
  ) + '\n',
  { flag: 'wx' },
);
console.log('REPRODUCED R1-READER-01: valid 22 -> 23 -> 24, cached 22 -> 24 rejected');
