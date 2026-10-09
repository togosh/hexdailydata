// Narrow transition tests over the genuine compact seed; no restore or provider calls.
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
import { benchmarkCloseBinding } from '../../dist/contracts/product-daily.js';
import { readingKey } from '../../dist/services/product-daily/project.js';
import {
  selectSavedCloses,
  closeBodies,
} from '../../dist/history-bootstrap/benchmark-reference.js';
const R = process.env.HDD_TASK_ROOT;
assert(R?.endsWith('btc-eth-daily-close-integration-r1'));
const save = (name, value) =>
  writeFile(join(R, 'evidence', name + '.json'), JSON.stringify(value, null, 2) + '\n', {
    flag: 'wx',
  });
const backup = JSON.parse(await readFile(join(R, 'seed-backup/BACKUP.json'))),
  p = backup.selected.product;
const seed = await admitProduct(join(R, 'seed-backup/product', p.version), p.manifestSha256);
const original = { ...seed, exceptions: [] },
  update = JSON.parse(await readFile(join(R, 'data/HISTORY_UPDATE.json')));
assert.equal(
  hash(stable(seed.metadata.benchmarkHistory)),
  benchmarkCloseBinding.predecessorHistory,
);
validateMarketHistory(seed.rows, seed.metadata);
assert.equal(
  applyMarketUpdate(original, { ...update, benchmarkHistory: seed.metadata.benchmarkHistory }),
  original,
);
const next = applyMarketUpdate(original, update);
assert(benchmarkHistoryOnlyAdvance(seed.metadata, next.metadata));
preserveMarketHistory(seed, next);
validateMarketHistory(next.rows, next.metadata);
assert.equal(applyMarketUpdate(next, update), next);
const rejected = [];
function rejects(name, base, u, pattern) {
  assert.throws(() => applyMarketUpdate(base, u), pattern);
  rejected.push(name);
}
for (const key of ['version', 'manifestSha256'])
  rejects(
    'wrong predecessor ' + key,
    { ...original, [key]: '0'.repeat(64) },
    update,
    /REPLACEMENT/,
  );
rejects(
  'absent predecessor',
  { ...original, metadata: { ...original.metadata, benchmarkHistory: undefined } },
  update,
  /PREDECESSOR/,
);
for (const [name, mutate] of [
  ['value', (h) => (h.buckets[0].value = '999')],
  ['date', (h) => (h.buckets[0].dateUtc = '2019-12-04')],
  ['field', (h) => (h.sourceField = 'open')],
  ['body', (h) => (h.candlesSha256 = '0'.repeat(64))],
  ['digest', (h) => (h.selectionSha256 = '0'.repeat(64))],
  ['method', (h) => (h.methodRevision = 'arbitrary')],
]) {
  const u = structuredClone(update);
  mutate(u.benchmarkHistory);
  rejects(name, original, u);
}
rejects('different receipt', original, { ...update, receiptSha256: '0'.repeat(64) }, /RECEIPT/);
rejects(
  'live reading mixed with history',
  original,
  { ...update, readings: [seed.metadata.readings[0]] },
  /ONLY_UPDATE/,
);
rejects(
  'return to HDS through general reducer',
  next,
  { ...update, benchmarkHistory: seed.metadata.benchmarkHistory },
  /REPLACEMENT/,
);
for (const field of ['totalHEX', 'gasPriceWei', 'btcRecordedAtUtc']) {
  const edited = { ...next, rows: next.rows.map((r) => ({ ...r })) };
  edited.rows[0][field] = field.endsWith('Utc') ? '2019-12-03T00:00:00.000Z' : '1';
  assert.throws(() => preserveMarketHistory(seed, edited), /ACCEPTED_DAILY|QUIET_CELL/);
  rejected.push('unrelated field ' + field);
}
const wrongClock = { ...next.metadata, effectiveAtUtc: new Date().toISOString() };
assert(!benchmarkHistoryOnlyAdvance(seed.metadata, wrongClock));
const overlap = structuredClone(next.metadata);
overlap.observations.push(
  ...seed.metadata.readings
    .filter((r) => r.kind === 'reference')
    .map((r) => ({ ...r, observedAtUtc: '2026-10-08T18:00:00.000Z' })),
);
overlap.observations.sort(
  (a, b) =>
    Date.parse(a.observedAtUtc) - Date.parse(b.observedAtUtc) ||
    readingKey(a).localeCompare(readingKey(b)),
);
assert.throws(() => validateMarketHistory(next.rows, overlap), /TIMED_OVERLAP/);
const normalized = await readFile(join(R, 'inputs/reference/candidate/DAILY_CANDLES.json'));
const bodies = await Promise.all(
  closeBodies.map((b) =>
    readFile(
      join(R, 'inputs/reference/session', String(b.attempt).padStart(2, '0'), 'response.body'),
    ),
  ),
);
const corrupt = bodies.map((b) => Buffer.from(b));
corrupt[0][20] ^= 1;
assert.throws(() => selectSavedCloses(normalized, corrupt), /BODY_IDENTITY/);
assert.throws(
  () => selectSavedCloses(Buffer.concat([normalized, Buffer.from(' ')]), bodies),
  /INPUT_IDENTITY/,
);
// Focused new-representation checkpoint and subsequent ordinary reference/gas updates.
const now = Date.now;
try {
  const gas = seed.metadata.readings.find((r) => r.kind === 'gas');
  const refs = seed.metadata.readings.filter((r) => r.kind === 'reference');
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
  const newer = applyMarketUpdate(rotated, {
    readings: refs.map((r) => ({
      ...r,
      roundId: String(BigInt(r.roundId) + 1n),
      observedAtUtc: new Date(start + 600000).toISOString(),
    })),
    liquidityHistory: [],
    receiptSha256: hash('syntheticreference'),
  });
  assert.equal(at512.metadata.observations.length, 512);
  assert.equal(rotated.metadata.observations.length, 1);
  for (const product of [at512, rotated, newer]) {
    assert.deepEqual(product.metadata.benchmarkHistory, next.metadata.benchmarkHistory);
    validateMarketHistory(product.rows, product.metadata);
    for (const b of update.benchmarkHistory.buckets)
      assert.equal(
        product.rows.find((r) => r.dateUtc === b.dateUtc)[
          b.asset === 'BTC' ? 'btcPriceUsd' : 'ethPriceUsd'
        ],
        b.value,
      );
  }
  await save('CLOSE_PRODUCT_TESTS', {
    status: 'PASS',
    externalRequests: 0,
    legacyReadable: true,
    exactRepeat: 'NO_OP',
    rejected,
    explicitTimedOverlap: 'REJECTED',
    rawBodyTamper: 'REJECTED',
    syntheticCheckpointObservations: [511, 512, 1],
    subsequentGasAndReferencePreservation: 'PASS',
    buckets: 5004,
    historyBytes: Buffer.byteLength(stable(update.benchmarkHistory)),
    updateBytes: Buffer.byteLength(stable(update)),
  });
} finally {
  Date.now = now;
}
console.log(
  'PASS exact saved close transition, refusal guards, legacy compatibility, replay/checkpoint/later feeds',
);
