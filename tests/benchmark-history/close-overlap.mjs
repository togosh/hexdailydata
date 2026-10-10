// Independent-review correction: every supported timed benchmark kind obeys the close domain.
import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { admitProduct } from '../../dist/services/product-daily/store.js';
import {
  applyMarketUpdate,
  validateMarketHistory,
  marketEvidence,
  marketCheckpoints,
  latestReadings,
} from '../../dist/services/product-daily/market.js';
import { readingKey } from '../../dist/services/product-daily/project.js';
import { hash } from '../../dist/history-bootstrap/normalize.js';
const R = process.env.HDD_TASK_ROOT;
assert(R?.endsWith('btc-eth-daily-close-integration-r1'));
const pointer = JSON.parse(await readFile(join(R, 'runtime/product/CURRENT.json')));
const selected = await admitProduct(
  join(R, 'runtime/product', pointer.version),
  pointer.manifestSha256,
);
const order = (a, b) =>
  Date.parse(a.observedAtUtc) - Date.parse(b.observedAtUtc) ||
  readingKey(a).localeCompare(readingKey(b));
const cases = [];
for (const asset of ['BTC', 'ETH']) {
  const spot = {
    kind: 'market',
    asset,
    quote: 'USD',
    observation: 'spot',
    value: '1',
    observedAtUtc: '2026-10-08T18:00:00.000Z',
  };
  const overlap = structuredClone(selected.metadata);
  overlap.observations.push(spot);
  overlap.observations.sort(order);
  // Keep the latest oracle readings. An earlier spot sample must still be refused.
  assert.throws(() => validateMarketHistory(selected.rows, overlap), /BENCHMARK_TIMED_OVERLAP/);
  const metadata = structuredClone(selected.metadata),
    rows = structuredClone(selected.rows);
  metadata.marketStorage.checkpoints = marketCheckpoints(
    marketEvidence(metadata).filter((r) => r.asset !== asset),
  );
  metadata.observations = [];
  metadata.readings = latestReadings(metadata.marketStorage.checkpoints);
  // Clearly synthetic earlier-reference-free state, isolating replay from the
  // updater's separate older-observation guard. Fixed close buckets stay exact.
  for (const row of rows)
    if (row.dateUtc > '2026-10-08') {
      row[asset === 'BTC' ? 'btcPriceUsd' : 'ethPriceUsd'] = null;
      row[asset === 'BTC' ? 'btcRecordedAtUtc' : 'ethRecordedAtUtc'] = null;
    }
  validateMarketHistory(rows, metadata);
  const base = { rows, metadata, exceptions: [] };
  assert.throws(
    () =>
      applyMarketUpdate(base, {
        readings: [spot],
        liquidityHistory: [],
        receiptSha256: hash('synthetic-market-overlap-' + asset),
      }),
    /BENCHMARK_TIMED_OVERLAP/,
  );
  assert.deepEqual(base.rows, rows);
  cases.push({ asset, kind: 'market', replay: 'REJECTED', reducer: 'REJECTED', synthetic: true });
}
// The same date and timestamp do not introduce a new restriction on PLS or HEX.
for (const asset of ['HEX', 'PLS']) {
  const metadata = structuredClone(selected.metadata);
  metadata.marketStorage.checkpoints = marketCheckpoints(
    marketEvidence(metadata).filter((r) => r.asset !== asset),
  );
  metadata.observations = [];
  metadata.readings = latestReadings(metadata.marketStorage.checkpoints);
  validateMarketHistory(selected.rows, metadata);
  const next = applyMarketUpdate(
    { rows: selected.rows, metadata, exceptions: [] },
    {
      readings: [
        {
          kind: 'market',
          chainId: 369,
          asset,
          quote: 'USD',
          observation: 'spot',
          value: '1',
          observedAtUtc: '2026-10-08T18:00:00.000Z',
        },
      ],
      liquidityHistory: [],
      receiptSha256: hash('synthetic-unaffected-' + asset),
    },
  );
  validateMarketHistory(next.rows, next.metadata);
  assert.deepEqual(next.metadata.benchmarkHistory, selected.metadata.benchmarkHistory);
  cases.push({ asset, kind: 'market', reducer: 'ACCEPTED_UNCHANGED_BENCHMARKS', synthetic: true });
}
await writeFile(
  join(R, 'evidence/REVIEW_OVERLAP_RECHECK.json'),
  JSON.stringify(
    {
      status: 'PASS',
      selectedVersion: selected.version,
      sourceDataWrites: 0,
      externalRequests: 0,
      apiRequests: 0,
      cases,
    },
    null,
    2,
  ) + '\n',
  { flag: 'wx' },
);
console.log(
  'PASS both market BTC/ETH overlap guards; same-date HEX/PLS unaffected; no API or restore rerun',
);
