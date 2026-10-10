// Focused writer guards and both fixed-domain timed families; no base admission.
import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { admitProduct, cachedProductExceptions } from '../../dist/services/product-daily/store.js';
import {
  applyMarketUpdate,
  preserveMarketHistory,
  validateMarketHistory,
  benchmarkHistoryOnlyAdvance,
  marketCheckpoints,
  marketEvidence,
  latestReadings,
} from '../../dist/services/product-daily/market.js';
import { productFiles } from '../../dist/services/product-daily/project.js';
import { hash } from '../../dist/history-bootstrap/normalize.js';
const R = process.env.HDD_TASK_ROOT;
assert(R?.endsWith('btc-eth-daily-close-reader-adoption-r1'));
const p = JSON.parse(await readFile(join(R, 'INPUTS.json'))).preserveGenuine;
const seed = await admitProduct(join(R, 'seed-backup/product', p.hdsRollback), p.hdsManifestSha256);
const original = { ...seed, exceptions: cachedProductExceptions(seed) };
const update = JSON.parse(await readFile(join(R, 'data/HISTORY_UPDATE.json')));
const close = applyMarketUpdate(original, update);
assert.equal(productFiles(close).version, p.closeProduct);
preserveMarketHistory(seed, close);
assert.equal(applyMarketUpdate(close, update), close);
assert.equal(
  applyMarketUpdate(original, { ...update, benchmarkHistory: seed.metadata.benchmarkHistory }),
  original,
);
const rejected = [];
for (const field of ['version', 'manifestSha256']) {
  assert.throws(() => applyMarketUpdate({ ...original, [field]: '0'.repeat(64) }, update));
  rejected.push('predecessor ' + field);
}
for (const [name, mutate] of [
  ['value', (h) => (h.buckets[0].value = '999')],
  ['date', (h) => (h.buckets[0].dateUtc = '2019-12-04')],
  ['field', (h) => (h.sourceField = 'open')],
  ['selection', (h) => (h.selectionSha256 = '0'.repeat(64))],
  ['candles', (h) => (h.candlesSha256 = '0'.repeat(64))],
  ['method', (h) => (h.methodRevision = 'arbitrary')],
]) {
  const u = structuredClone(update);
  mutate(u.benchmarkHistory);
  assert.throws(() => applyMarketUpdate(original, u));
  rejected.push(name);
}
assert.throws(
  () => applyMarketUpdate(original, { ...update, receiptSha256: '0'.repeat(64) }),
  /RECEIPT/,
);
assert.throws(
  () => applyMarketUpdate(original, { ...update, readings: [seed.metadata.readings[0]] }),
  /ONLY_UPDATE/,
);
for (const field of ['totalHEX', 'gasPriceWei', 'btcRecordedAtUtc']) {
  const edited = { ...close, rows: close.rows.map((r) => ({ ...r })) };
  edited.rows[0][field] = field.endsWith('Utc') ? '2019-12-03T00:00:00.000Z' : '1';
  assert.throws(() => preserveMarketHistory(seed, edited));
  rejected.push('quiet ' + field);
}
assert(
  !benchmarkHistoryOnlyAdvance(seed.metadata, {
    ...close.metadata,
    effectiveAtUtc: new Date().toISOString(),
  }),
);
const refs = close.metadata.readings.filter((r) => r.kind === 'reference');
for (const kind of ['market', 'reference'])
  for (const asset of ['BTC', 'ETH']) {
    const ref = refs.find((r) => r.asset === asset);
    const r =
      kind === 'reference'
        ? { ...ref, observedAtUtc: '2026-10-08T18:00:00.000Z' }
        : {
            kind: 'market',
            asset,
            value: '1',
            unit: 'USD',
            observedAtUtc: '2026-10-08T18:00:00.000Z',
            method: 'synthetic-test',
          };
    // Match the existing contract exactly for the market family.
    if (kind === 'market') {
      const market = close.metadata.readings.find((x) => x.kind === 'market');
      Object.assign(r, market, { asset, value: '1', observedAtUtc: '2026-10-08T18:00:00.000Z' });
      delete r.chainId;
      delete r.unit;
      delete r.method;
    }
    const m = structuredClone(close.metadata);
    m.observations.push(r);
    m.observations.sort((a, b) => a.observedAtUtc.localeCompare(b.observedAtUtc));
    assert.throws(() => validateMarketHistory(close.rows, m), /TIMED_OVERLAP/);
    // Isolate the history guard from the separate older-observation guard.
    const metadata = structuredClone(close.metadata),
      rows = structuredClone(close.rows);
    metadata.marketStorage.checkpoints = marketCheckpoints(
      marketEvidence(metadata).filter((x) => x.asset !== asset),
    );
    metadata.observations = [];
    metadata.readings = latestReadings(metadata.marketStorage.checkpoints);
    for (const row of rows)
      if (row.dateUtc > '2026-10-08') {
        row[asset === 'BTC' ? 'btcPriceUsd' : 'ethPriceUsd'] = null;
        row[asset === 'BTC' ? 'btcRecordedAtUtc' : 'ethRecordedAtUtc'] = null;
      }
    validateMarketHistory(rows, metadata);
    assert.throws(
      () =>
        applyMarketUpdate(
          { rows, metadata, exceptions: [] },
          {
            readings: kind === 'reference' ? refs.map((x) => (x.asset === asset ? r : x)) : [r],
            liquidityHistory: [],
            receiptSha256: hash('overlap ' + kind + asset),
          },
        ),
      /TIMED_OVERLAP/,
    );
    rejected.push('timed ' + kind + ' ' + asset);
  }
for (const asset of ['HEX', 'PLS']) {
  const metadata = structuredClone(close.metadata);
  metadata.marketStorage.checkpoints = marketCheckpoints(
    marketEvidence(metadata).filter((r) => r.asset !== asset),
  );
  metadata.observations = [];
  metadata.readings = latestReadings(metadata.marketStorage.checkpoints);
  const next = applyMarketUpdate(
    { ...close, metadata },
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
      receiptSha256: hash('synthetic unaffected ' + asset),
    },
  );
  validateMarketHistory(next.rows, next.metadata);
  assert.deepEqual(next.metadata.benchmarkHistory, close.metadata.benchmarkHistory);
}
const references = refs.map((r) => ({ ...r, roundId: String(BigInt(r.roundId) + 1n) }));
const next = applyMarketUpdate(close, {
  readings: references,
  liquidityHistory: [],
  receiptSha256: hash('guard same-time'),
});
preserveMarketHistory(close, next);
validateMarketHistory(next.rows, next.metadata);
assert.equal(next.metadata.effectiveAtUtc, close.metadata.effectiveAtUtc);
assert.throws(() => preserveMarketHistory(seed, next), /BENCHMARK_UNCERTIFIED_QUIET_CHANGE/);
await writeFile(
  join(R, 'evidence/WRITER_GUARDS.json'),
  JSON.stringify(
    {
      status: 'PASS',
      strictWriterStillRejectsSkippedTransition: true,
      exactRepeat: 'NO_OP',
      rejected,
      legacyReadable: true,
      closeVersion: productFiles(close).version,
      sameTimeReference: true,
    },
    null,
    2,
  ) + '\n',
);
console.log('PASS focused unchanged writer, no-op, quiet and both timed-overlap guards');
