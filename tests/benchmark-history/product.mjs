// Focused compiled validator/replay tests using only the small genuine product seed.
import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { admitProduct } from '../../dist/services/product-daily/store.js';
import {
  applyMarketUpdate,
  preserveMarketHistory,
  validateMarketHistory,
  marketCheckpoints,
  marketEvidence,
  benchmarkHistoryOnlyAdvance,
} from '../../dist/services/product-daily/market.js';
import { hash, stable } from '../../dist/history-bootstrap/normalize.js';
const R = process.env.HDD_TASK_ROOT;
assert(R?.endsWith('btc-eth-historical-backfill-r1'));
const backup = JSON.parse(await readFile(join(R, 'seed-backup/BACKUP.json'))),
  p = backup.selected.product;
const seed = await admitProduct(join(R, 'seed-backup/product', p.version), p.manifestSha256);
const original = { ...seed, exceptions: [] },
  update = JSON.parse(await readFile(join(R, 'data/HISTORY_UPDATE.json')));
const next = applyMarketUpdate(original, update);
assert(benchmarkHistoryOnlyAdvance(seed.metadata, next.metadata));
assert.equal(seed.metadata.effectiveAtUtc, next.metadata.effectiveAtUtc);
assert.deepEqual(seed.metadata.readings, next.metadata.readings);
assert.deepEqual(seed.metadata.pair, next.metadata.pair);
assert.equal(next.metadata.benchmarkHistory.buckets.length, 4269);
preserveMarketHistory(seed, next);
validateMarketHistory(next.rows, next.metadata);
assert.equal(applyMarketUpdate(next, update), next);
const changed = structuredClone(update);
changed.benchmarkHistory.buckets[0].value = '9999';
changed.benchmarkHistory.selectionSha256 = hash(stable(changed.benchmarkHistory.buckets));
assert.throws(() => applyMarketUpdate(next, changed), /REPLACEMENT/);
const corrupt = structuredClone(update);
corrupt.benchmarkHistory.buckets[0].value = '9999';
assert.throws(() => applyMarketUpdate(original, corrupt), /IDENTITY/);
const overlap = { ...original, rows: original.rows.map((r) => ({ ...r })) };
overlap.rows.find((r) => r.dateUtc === '2019-12-04').btcPriceUsd = '1';
assert.throws(() => applyMarketUpdate(overlap, update), /OVERLAP/);
const edited = { ...next, rows: next.rows.map((r) => ({ ...r })) };
edited.rows[0].totalHEX = '1';
assert.throws(() => preserveMarketHistory(seed, edited), /ACCEPTED_DAILY/);
const badMarket = { ...next, rows: next.rows.map((r) => ({ ...r })) };
badMarket.rows[0].gasPriceWei = '1';
assert.throws(() => preserveMarketHistory(seed, badMarket), /QUIET_CELL/);
const badTime = {
  ...next,
  metadata: { ...next.metadata, effectiveAtUtc: new Date().toISOString() },
};
assert(!benchmarkHistoryOnlyAdvance(seed.metadata, badTime.metadata));
assert.throws(
  () => applyMarketUpdate(original, { ...update, readings: [seed.metadata.readings[0]] }),
  /ONLY_UPDATE/,
);
const now = Date.now;
try {
  const gas = seed.metadata.readings.find((r) => r.kind === 'gas'),
    refs = seed.metadata.readings.filter((r) => r.kind === 'reference');
  const start = Math.max(...seed.metadata.readings.map((r) => Date.parse(r.observedAtUtc))) + 1000;
  Date.now = () => start + 700000;
  const meta = structuredClone(next.metadata);
  meta.marketStorage.checkpoints = marketCheckpoints(marketEvidence(meta));
  meta.observations = Array.from({ length: 511 }, (_, i) => ({
    ...gas,
    observedAtUtc: new Date(start + i * 1000).toISOString(),
  }));
  const at512 = applyMarketUpdate(
    { ...next, metadata: meta },
    {
      readings: [{ ...gas, observedAtUtc: new Date(start + 511000).toISOString() }],
      liquidityHistory: [],
      receiptSha256: hash('synthetic512'),
    },
  );
  const rotated = applyMarketUpdate(at512, {
    readings: [{ ...gas, observedAtUtc: new Date(start + 512000).toISOString() }],
    liquidityHistory: [],
    receiptSha256: hash('synthetic513'),
  });
  assert.equal(at512.metadata.observations.length, 512);
  assert.equal(rotated.metadata.observations.length, 1);
  const newer = applyMarketUpdate(rotated, {
    readings: refs.map((r) => ({
      ...r,
      roundId: String(BigInt(r.roundId) + 1n),
      observedAtUtc: new Date(start + 600000).toISOString(),
    })),
    liquidityHistory: [],
    receiptSha256: hash('syntheticreferences'),
  });
  for (const product of [at512, rotated, newer]) {
    assert.deepEqual(product.metadata.benchmarkHistory, next.metadata.benchmarkHistory);
    for (const b of update.benchmarkHistory.buckets)
      assert.equal(
        product.rows.find((r) => r.dateUtc === b.dateUtc)[
          b.asset === 'BTC' ? 'btcPriceUsd' : 'ethPriceUsd'
        ],
        b.value,
      );
  }
  await writeFile(
    join(R, 'evidence/PRODUCT_TESTS.json'),
    JSON.stringify(
      {
        status: 'PASS',
        externalRequests: 0,
        synthetic: true,
        actualHistoryBuckets: 4269,
        independentClockPreservation: 'PASS',
        idempotence: 'PASS',
        replacementConflict: 'rejected',
        nonNullOverlap: 'rejected',
        unboundEdit: 'rejected',
        quietCellEdit: 'rejected',
        mixedFeedImport: 'rejected',
        observations: [511, 512, 1],
        subsequentGasAndReferencePreservation: 'PASS',
      },
      null,
      2,
    ) + '\n',
    { flag: 'wx' },
  );
} finally {
  Date.now = now;
}
console.log(
  'PASS actual history validator/replay; quiet fields, no-op/conflicts,512 rotation, later feed preservation',
);
