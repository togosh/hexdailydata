// Narrow rerun after the virtual-clock fixture correction; no base-reader campaign.
import assert from 'node:assert/strict';
import { readFile, readdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { admitProduct } from '../../dist/services/product-daily/store.js';
import {
  applyMarketUpdate,
  marketEvidence,
  marketCheckpoints,
} from '../../dist/services/product-daily/market.js';
import { sha } from '../../dist/services/source-update/generation.js';
const R = process.env.HDD_TASK_ROOT;
const receipts = [];
for (const name of (await readdir(join(R, 'evidence'))).filter(
  (n) => n.startsWith('COMPOSED_composed-') && n.endsWith('.json'),
)) {
  const r = JSON.parse(await readFile(join(R, 'evidence', name)));
  if (r.cases.length >= 3) receipts.push({ name, ...r });
}
assert.equal(receipts.length, 1);
const prior = receipts[0],
  root = join(prior.root, 'synthetic/product'),
  pointer = JSON.parse(await readFile(join(root, 'CURRENT.json')));
const product = await admitProduct(join(root, pointer.version), pointer.manifestSha256);
const meta = structuredClone(product.metadata),
  refs = meta.readings.filter((r) => r.kind === 'reference'),
  gas = meta.readings.find((r) => r.kind === 'gas');
const start = Math.max(...meta.readings.map((r) => Date.parse(r.observedAtUtc))) + 1000,
  actual = Date.now;
try {
  Date.now = () => start + 600000;
  meta.marketStorage.checkpoints = marketCheckpoints(marketEvidence(meta));
  meta.observations = Array.from({ length: 511 }, (_, i) => ({
    ...gas,
    observedAtUtc: new Date(start + i * 1000).toISOString(),
  }));
  const a = applyMarketUpdate(
    { rows: product.rows, metadata: meta, exceptions: [] },
    {
      readings: [{ ...gas, observedAtUtc: new Date(start + 511000).toISOString() }],
      liquidityHistory: [],
      receiptSha256: sha('synthetic boundary 512'),
    },
  );
  assert.equal(a.metadata.observations.length, 512);
  const b = applyMarketUpdate(a, {
    readings: [{ ...gas, observedAtUtc: new Date(start + 512000).toISOString() }],
    liquidityHistory: [],
    receiptSha256: sha('synthetic boundary rotation'),
  });
  assert.equal(b.metadata.observations.length, 1);
  assert.deepEqual(
    b.metadata.readings.filter((r) => r.kind === 'reference'),
    refs,
  );
  marketEvidence(b.metadata);
  // Higher round, identical quote/time may advance out of an immutable checkpoint.
  const c = applyMarketUpdate(b, {
    readings: refs.map((r) => ({ ...r, roundId: String(BigInt(r.roundId) + 1n) })),
    liquidityHistory: [],
    receiptSha256: sha('synthetic same-time next round'),
  });
  marketEvidence(c.metadata);
  assert.equal(c.metadata.readings.filter((r) => r.kind === 'reference').length, 2);
  const one = { ...refs[0], observedAtUtc: '2026-10-08T23:59:59.000Z', roundId: '1' },
    two = { ...refs[1], observedAtUtc: '2026-10-09T00:00:00.000Z', roundId: '1' };
  // Isolated saved-date projection without modifying any selected root.
  const m = structuredClone(product.metadata);
  m.readings = m.readings.filter((r) => r.kind !== 'reference');
  m.observations = marketEvidence(m).filter((r) => r.kind !== 'reference');
  delete m.marketStorage;
  const midnight = applyMarketUpdate(
    {
      rows: product.rows.map((r) => ({
        ...r,
        btcPriceUsd: null,
        ethPriceUsd: null,
        btcRecordedAtUtc: null,
        ethRecordedAtUtc: null,
      })),
      metadata: m,
      exceptions: [],
    },
    {
      readings: [one, two],
      liquidityHistory: [],
      receiptSha256: sha('synthetic independent UTC dates'),
    },
  );
  assert.equal(midnight.rows.find((r) => r.dateUtc === '2026-10-08').btcPriceUsd, one.value);
  assert.equal(midnight.rows.find((r) => r.dateUtc === '2026-10-08').ethPriceUsd, null);
  assert.equal(midnight.rows.find((r) => r.dateUtc === '2026-10-09').ethPriceUsd, two.value);
  await writeFile(
    join(R, 'evidence/ROTATION_RECHECK.json'),
    JSON.stringify(
      {
        status: 'PASS',
        synthetic: true,
        externalRequests: 0,
        reusedComposedEvidence: prior.name,
        unrelatedCasesNotRepeated: prior.cases,
        nativeTwoCycleStatus: prior.native.status,
        activeBefore: 511,
        atBoundary: a.metadata.observations.length,
        after: b.metadata.observations.length,
        quietReferences: refs,
        higherRoundSameTimeCheckpoint: 'PASS',
        independentUtcDates: 'PASS',
        virtualNow: new Date(Date.now()).toISOString(),
      },
      null,
      2,
    ) + '\n',
  );
} finally {
  Date.now = actual;
}
console.log(
  'PASS rotation, same-time next round checkpoint, UTC boundary; reused composed/native/access results',
);
