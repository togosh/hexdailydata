// Small real daily generation replay/restore. Synthetic inputs are explicitly isolated.
import assert from 'node:assert/strict';
import { readFile, writeFile, mkdir, mkdtemp } from 'node:fs/promises';
import { join } from 'node:path';
import { hash } from '../../dist/history-bootstrap/normalize.js';
import { applyMarketUpdate } from '../../dist/services/product-daily/market.js';
import { productFiles } from '../../dist/services/product-daily/project.js';
import {
  admitProduct,
  ProductDailyStore,
  writeProductGeneration,
} from '../../dist/services/product-daily/store.js';
import {
  marketMethodRevision,
  reserveBasedPools,
  ProductQuery,
} from '../../dist/contracts/product-daily.js';
import { PageCursors } from '../../dist/services/queries/cursor.js';
const root = process.env.HDD_TASK_ROOT;
assert(root?.endsWith('pulsex-market-qualification-r2'));
const synthetic = process.argv[2] === 'synthetic';
const refs = JSON.parse(await readFile(join(root, 'reference/INPUT_REFERENCES.json')));
const profile = refs.profile,
  selected = refs.selected;
const baseline = await admitProduct(
  join(profile.productRoot, selected.version),
  selected.manifestSha256,
);
const exceptions = (
  await readFile(join(profile.productRoot, selected.version, 'exceptions.ndjson'), 'utf8')
)
  .trim()
  .split('\n')
  .map(JSON.parse);
const base = { ...baseline, exceptions };
let updates;
if (synthetic) {
  const id = hash(JSON.stringify({ method: marketMethodRevision, pools: reserveBasedPools }));
  updates = ['2026-10-07T23:59:00Z', '2026-10-08T00:01:00Z'].map((time, n) => ({
    methodRevision: marketMethodRevision,
    receiptSha256: String(n + 1).repeat(64),
    liquidityHistory: [],
    readings: [
      {
        kind: 'market',
        chainId: 369,
        asset: 'HEX',
        quote: 'USD',
        observation: 'spot',
        value: n ? '0.002' : '0.00100000000000001',
        observedAtUtc: time,
      },
      {
        kind: 'tracked-liquidity',
        chainId: 369,
        quote: 'USD',
        value: String((n + 1) * 4),
        observedAtUtc: time,
        set: {
          id,
          measure: 'reserve-based source-derived USD estimate',
          methodRevision: marketMethodRevision,
          coverage: 'bounded contemporary HEX-pool cohort',
          pools: reserveBasedPools.map((p) => ({
            address: p.address,
            dex: 'PulseX',
            version: p.venue === 0 ? 'V1' : 'V2',
            valueUsd: String(n + 1),
          })),
        },
      },
    ],
  }));
} else {
  const bytes = await readFile(join(root, 'data/PROPOSED_UPDATES.json'));
  const review = JSON.parse(await readFile(join(root, 'SAVED_REVIEW.json')));
  assert.equal(review.verdict, 'PASS');
  assert.equal(review.updatesSha256, hash(bytes));
  updates = JSON.parse(bytes);
}
await mkdir(join(root, 'scratch'), { recursive: true });
const dir = synthetic
  ? await mkdtemp(join(root, 'scratch/synthetic-publication-'))
  : join(root, 'data/product');
await mkdir(dir, { recursive: true });
const bFiles = { version: baseline.version, manifestSha256: baseline.manifestSha256, files: {} };
for (const name of [
  'MANIFEST.json',
  'daily.ndjson',
  'daily.csv',
  'metadata.json',
  'exceptions.ndjson',
])
  bFiles.files[name] = await readFile(join(profile.productRoot, selected.version, name));
await writeProductGeneration(dir, bFiles);
const store = new ProductDailyStore(dir, profile.pair);
await store.select(selected);
const query = ProductQuery.parse({ from: '2026-10-01', to: '2026-10-07', limit: '2' }),
  cursors = new PageCursors();
const oldPage = store.read(store.capture(), query, 'daily', cursors, Date.now(), 'public');
let model = base;
const generations = [];
let comparisons = 0;
for (const update of updates) {
  const next = applyMarketUpdate(model, update),
    files = productFiles(next);
  assert.deepEqual(productFiles(applyMarketUpdate(next, update)), files, 'exact update replay');
  for (let i = 0; i < baseline.rows.length; i++)
    for (const [key, value] of Object.entries(baseline.rows[i])) {
      if (['trackedLiquidityUsd', 'liquidityRecordedAtUtc'].includes(key)) continue;
      assert.equal(next.rows[i][key], value, key);
      comparisons++;
    }
  await writeProductGeneration(dir, files);
  const pointer = { version: files.version, manifestSha256: files.manifestSha256 };
  await store.select(pointer);
  assert.equal((await store.select(pointer)).changed, false);
  const broken = structuredClone(update);
  broken.readings[0].value = '999';
  assert.throws(() => applyMarketUpdate(next, broken));
  assert.equal(store.capture().version, files.version);
  const absent = applyMarketUpdate(next, {
    readings: [],
    liquidityHistory: [],
    receiptSha256: 'f'.repeat(64),
  });
  assert.deepEqual(absent.metadata.readings, next.metadata.readings);
  generations.push(pointer);
  model = next;
}
if (generations.length) {
  assert.throws(() =>
    store.read(
      store.capture(),
      { ...query, cursor: oldPage.nextCursor },
      'daily',
      cursors,
      Date.now(),
      'public',
    ),
  );
  const last = generations.at(-1),
    prior = generations.at(-2) ?? selected;
  await assert.rejects(store.select(prior), /PRODUCT_NOT_NEWER/);
  await store.select(prior, { rollback: true });
  await store.select(last);
  const snapshot = store.capture(),
    time = Math.max(...model.metadata.readings.map((r) => Date.parse(r.observedAtUtc)));
  assert.equal(store.live(snapshot, time + 301000).freshness.HEX.status, 'stale');
  assert.equal(store.live(snapshot, time + 1000).freshness.HEX.status, 'fresh');
  assert.equal(store.live(snapshot, time + 1000).freshness.savedState.status, 'stale');
  if (synthetic) {
    assert.equal(snapshot.rows.find((r) => r.dateUtc === '2026-10-07').trackedLiquidityUsd, '4');
    assert.equal(snapshot.rows.find((r) => r.dateUtc === '2026-10-08').trackedLiquidityUsd, '8');
  }
  if (!synthetic) {
    const restored = await mkdtemp(join(root, 'scratch/restore-'));
    const files = { ...last, files: {} };
    for (const name of Object.keys(bFiles.files))
      files.files[name] = await readFile(join(dir, last.version, name));
    await writeProductGeneration(restored, files);
    const reopened = new ProductDailyStore(restored, profile.pair);
    await reopened.select(last);
    assert.deepEqual(reopened.capture().rows, snapshot.rows);
    assert.equal(reopened.capture().csv.toString(), snapshot.csv.toString());
    const index = {
      generation: last,
      files: Object.fromEntries(
        Object.entries(files.files).map(([name, b]) => [
          name,
          { bytes: b.length, sha256: hash(b) },
        ]),
      ),
      restoredOnce: true,
      source: join('data/product', last.version),
      originalBase: selected,
    };
    await writeFile(join(root, 'RESTORE_INDEX.json'), JSON.stringify(index, null, 2) + '\n', {
      flag: 'wx',
    });
  }
}
const receipt = {
  status: 'PASS',
  synthetic,
  base: selected,
  generations,
  selected: generations.at(-1) ?? selected,
  updates: updates.length,
  originalFieldComparisons: comparisons,
  unchangedOriginalRows: baseline.rows.length,
  checks: [
    'idempotent exact replay',
    'immutable reader/writer selection',
    'same-time bad-update rejection',
    'missing group timestamp retention',
    'cursor separation',
    'explicit local rollback',
    'fresh/stale uses observation',
    'true saved-state staleness',
    'no reference-price/ledger rewrite',
    ...(synthetic ? ['synthetic UTC rollover'] : ['actual small restore and reopen']),
  ],
  externalRequests: 0,
  bulkBaseScans: 0,
};
if (!synthetic)
  await writeFile(
    join(root, 'PRODUCT_PROFILE.json'),
    JSON.stringify({ ...profile, productRoot: dir }, null, 2) + '\n',
    { flag: 'wx' },
  );
await writeFile(
  join(root, 'evidence', synthetic ? 'SYNTHETIC_PUBLICATION.json' : 'PUBLICATION.json'),
  JSON.stringify(receipt, null, 2) + '\n',
  { flag: 'wx' },
);
console.log(JSON.stringify(receipt));
