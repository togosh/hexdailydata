// Whole accepted daily data, explicitly synthetic market inputs. No base census scan.
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
import { ProductQuery } from '../../dist/contracts/product-daily.js';
import { PageCursors } from '../../dist/services/queries/cursor.js';

const root = process.env.HDD_TASK_ROOT;
assert(root?.endsWith('pulsex-market-feed-r1'));
const refs = JSON.parse(await readFile(join(root, 'reference/accepted-INPUT_REFERENCES.json')));
const selected = refs.selected,
  profile = refs.profile;
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
await mkdir(join(root, 'scratch'), { recursive: true });
const dir = await mkdtemp(join(root, 'scratch/market-publication-'));
const address = '0x' + '1'.repeat(40);
const setId = hash(JSON.stringify([{ address, venue: 0 }]));
const liquidity = (time, value = '42.000') => ({
  kind: 'tracked-liquidity',
  chainId: 369,
  quote: 'USD',
  value,
  observedAtUtc: time,
  set: {
    id: setId,
    coverage: 'bounded contemporary HEX-pool cohort',
    measure: 'two-sided source reserveUSD estimate',
    pools: [{ address, dex: 'PulseX', version: 'V1', valueUsd: value }],
  },
});
const price = (time, value = '0.00100000000000001') => ({
  kind: 'market',
  chainId: 369,
  asset: 'HEX',
  quote: 'USD',
  observation: 'spot',
  value,
  observedAtUtc: time,
});
const firstTime = '2026-10-07T23:59:00Z',
  secondTime = '2026-10-08T00:01:00Z';
const firstUpdate = {
  readings: [price(firstTime), liquidity(firstTime)],
  liquidityHistory: [
    {
      dateUtc: '2026-10-06',
      value: null,
      setId,
      meaning: 'source UTC-day bucket, not a verified close',
    },
  ],
  receiptSha256: '1'.repeat(64),
};
const first = applyMarketUpdate(base, firstUpdate),
  firstFiles = productFiles(first);
assert.deepEqual(
  productFiles(applyMarketUpdate(first, firstUpdate)),
  firstFiles,
  'identical replay must be byte-identical',
);
const second = applyMarketUpdate(first, {
    readings: [price(secondTime, '0.002'), liquidity(secondTime, '43.5')],
    liquidityHistory: [],
    receiptSha256: '2'.repeat(64),
  }),
  secondFiles = productFiles(second);
assert.equal(second.rows.find((r) => r.dateUtc === '2026-10-07').trackedLiquidityUsd, '42.000');
assert.equal(second.rows.find((r) => r.dateUtc === '2026-10-08').trackedLiquidityUsd, '43.5');
assert.equal(second.metadata.observations.length, 4);
let comparisons = 0;
for (let i = 0; i < baseline.rows.length; i++)
  for (const [key, value] of Object.entries(baseline.rows[i])) {
    if (['trackedLiquidityUsd', 'liquidityRecordedAtUtc'].includes(key)) continue;
    assert.equal(second.rows[i][key], value, key);
    comparisons++;
  }
const missing = applyMarketUpdate(second, {
  readings: [],
  liquidityHistory: [],
  receiptSha256: '3'.repeat(64),
});
assert.deepEqual(
  missing.metadata.readings,
  second.metadata.readings,
  'missing new group retains old original time',
);
for (const broken of [
  { ...firstUpdate, readings: [price('2026-10-07T23:58:00Z')] },
  { ...firstUpdate, readings: [price(firstTime, '99')] },
  { ...firstUpdate, readings: [{ ...liquidity(secondTime), value: '999' }] },
  { ...firstUpdate, readings: [{ ...liquidity(secondTime), chainId: 1 }] },
  { ...firstUpdate, readings: [{ ...price(secondTime), quote: 'USDC' }] },
])
  assert.throws(() => applyMarketUpdate(first, broken));
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
await writeProductGeneration(dir, firstFiles);
await writeProductGeneration(dir, secondFiles);
const store = new ProductDailyStore(dir, profile.pair);
const pointer = ({ version, manifestSha256 }) => ({ version, manifestSha256 });
await store.select(selected);
const cursors = new PageCursors(),
  query = ProductQuery.parse({ from: '2026-10-01', to: '2026-10-07', limit: '2' });
const oldPage = store.read(store.capture(), query, 'daily', cursors, Date.now(), 'public');
await store.select(pointer(firstFiles));
await assert.rejects(store.select(selected), /PRODUCT_NOT_NEWER/);
await store.select(pointer(secondFiles));
assert.equal((await store.select(pointer(secondFiles))).changed, false);
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
const snap = store.capture(),
  fresh = store.live(snap, Date.parse(secondTime) + 1000),
  stale = store.live(snap, Date.parse(secondTime) + 301000);
assert.equal(fresh.freshness.HEX.status, 'fresh');
assert.equal(stale.freshness.HEX.status, 'stale');
assert.equal(fresh.freshness.savedState.status, 'stale');
assert.equal(fresh.btcPriceUsd, null);
assert.equal(fresh.trackedSet.poolCount, 1);
const corrupted = structuredClone(second);
corrupted.rows[0].payoutHearts = '123';
const corruptFiles = productFiles(corrupted);
await writeProductGeneration(dir, corruptFiles);
await assert.rejects(
  store.select(pointer(corruptFiles)),
  /PRODUCT_NOT_NEWER|ACCEPTED_DAILY_FIELD_CHANGED/,
);
const lost = structuredClone(second);
lost.metadata.observations.splice(0, 1);
await assert.rejects(
  writeProductGeneration(dir, productFiles(lost)),
  /MARKET_ROW_HISTORY_MISMATCH|MARKET_LATEST_HISTORY_MISMATCH/,
);
assert.equal(store.capture().version, secondFiles.version);
await store.select(pointer(firstFiles), { rollback: true });
await store.select(pointer(secondFiles));
const receipt = {
  status: 'PASS',
  label: 'synthetic market observations on actual accepted daily dataset',
  comparisons,
  originalRows: baseline.rows.length,
  round1: firstFiles.version,
  round2: secondFiles.version,
  assertions: [
    'day rollover retains both daily observations',
    'spot never changes reference HEX quotes',
    'all original non-market fields exact',
    'pool total/identity/chain/quote guards',
    'same-time conflict and older rejection',
    'failed/missing group retains timestamp',
    'idempotent generation',
    'actual immutable reader/publication/rollback',
    'cursor separation',
    'per-group stale behavior',
    'corrupt history rejected',
  ],
  externalRequests: 0,
  baseCensusScans: 0,
};
await writeFile(
  join(root, 'evidence/PRODUCT_MARKET_TESTS.json'),
  JSON.stringify(receipt, null, 2) + '\n',
  { flag: 'wx' },
);
console.log(JSON.stringify(receipt));
