import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, writeFile, cp } from 'node:fs/promises';
import { join } from 'node:path';
import { input, profile, pointer, root, receipt } from './inputs.mjs';
import {
  projectDaily,
  productFiles,
  validateReadings,
} from '../../dist/services/product-daily/project.js';
import {
  ProductDailyStore,
  writeProductGeneration,
  admitProduct,
} from '../../dist/services/product-daily/store.js';
import { ProductQuery } from '../../dist/contracts/product-daily.js';
import { PageCursors } from '../../dist/services/queries/cursor.js';
import { validateAdmittedPair } from '../../dist/services/product-daily/open.js';
await mkdir(join(root, 'scratch'), { recursive: true });
const local = await mkdtemp(join(root, 'scratch/publication-'));
const files = productFiles(projectDaily(input));
await writeProductGeneration(local, files);
const ref = ({ version, manifestSha256 }) => ({ version, manifestSha256 });
const store = new ProductDailyStore(local, profile.pair);
assert.equal((await store.select(pointer)).changed, true);
const original = store.capture();
assert.equal((await store.select(pointer)).changed, false);
const originalBytes = original.csv;
originalBytes[0] ^= 255;
assert.notEqual(originalBytes[0], original.csv[0]);
assert.throws(() => {
  original.version = 'f'.repeat(64);
}, TypeError);
for (const field of [
  'baseObservedAtUtc',
  'observedAtUtc',
  'holderRecordCount',
  'stakeStartRecordCount',
]) {
  const bad = { ...profile.pair, [field]: field.endsWith('Count') ? 1 : '2026-10-08T00:00:00Z' };
  assert.throws(
    () =>
      validateAdmittedPair(bad, {
        localHolderRows: profile.pair.holderRecordCount,
        localStakeRows: profile.pair.stakeStartRecordCount,
      }),
    /PRODUCT_PROFILE_PAIR_FACTS/,
  );
}
const loading = store.load();
await assert.rejects(store.select(pointer), /PRODUCT_SELECTION_BUSY/);
await loading;
const now = Date.parse('2026-10-08T00:02:00Z'),
  time = '2026-10-08T00:01:00Z';
const readings = [
  {
    kind: 'market',
    asset: 'BTC',
    quote: 'USD',
    observation: 'spot',
    value: '60000.0010',
    observedAtUtc: time,
  },
  {
    kind: 'gas',
    chainId: 369,
    unit: 'wei/gas',
    gasPriceWei: '123456789',
    baseFeeWei: '1234',
    priorityFeeWei: null,
    observedAtUtc: time,
  },
  {
    kind: 'liquidity',
    chainId: 369,
    poolAddress: '0x' + '1'.repeat(40),
    dex: 'SyntheticOnly',
    version: 'test',
    quote: 'USD',
    value: '42.000',
    observedAtUtc: time,
  },
];
const next = productFiles(projectDaily({ ...input, readings, now }));
await writeProductGeneration(local, next);
const first = store.read(
  original,
  ProductQuery.parse({ from: '2020-01-01', to: '2020-01-31', limit: '5' }),
  'daily',
  new PageCursors(),
  now,
  'public',
);
const cursor = new PageCursors(),
  q = ProductQuery.parse({ from: '2020-01-01', to: '2020-01-31', limit: '5' }),
  page = store.read(original, q, 'daily', cursor, now, 'public');
assert(page.nextCursor);
assert.equal(
  store.read(original, { ...q, cursor: page.nextCursor }, 'daily', cursor, now, 'public').items[0]
    .dateUtc,
  '2020-01-06',
);
for (const [route, query, access] of [
  ['markets', q, 'public'],
  ['daily', { ...q, metric: 'hexPriceUsd' }, 'public'],
  ['daily', { ...q, asset: 'BTC' }, 'public'],
  ['daily', q, 'paid'],
])
  assert.throws(() =>
    store.read(original, { ...query, cursor: page.nextCursor }, route, cursor, now, access),
  );
assert.equal((await store.select(ref(next))).changed, true);
const selected = store.capture();
assert.equal((await store.select(ref(next))).changed, false);
assert.throws(() =>
  store.read(selected, { ...q, cursor: page.nextCursor }, 'daily', cursor, now, 'public'),
);
assert.deepEqual(selected.rows.slice(0, original.rows.length), original.rows);
assert.equal(original.version, pointer.version);
const live = store.live(selected, now);
assert.equal(live.btcPriceUsd, '60000.0010');
assert.equal(live.gasPriceWei, '123456789');
assert.equal(live.trackedLiquidityUsd, '42.000');
assert.equal(live.hexPriceUsd, null);
assert.equal(live.freshness.BTC.status, 'fresh');
assert.equal(live.freshness.savedState.status, 'stale');
assert.equal(selected.rows.at(-1).btcPriceUsd, live.btcPriceUsd);
assert.equal(selected.rows.at(-1).gasPriceWei, live.gasPriceWei);
const later = store.live(selected, now + 600000);
assert.equal(later.freshness.BTC.status, 'stale');
assert.equal(later.freshness.BTC.observedAtUtc, time);
assert.equal(later.freshness.savedState.observedAtUtc, live.freshness.savedState.observedAtUtc);
await assert.rejects(async () => {
  await new Promise((resolve) => setTimeout(resolve, 5));
  throw Error('SYNTHETIC_FEED_FAILED');
});
assert.equal(store.capture().version, next.version);
assert.equal((await store.select(pointer, { rollback: true })).changed, true);
assert.equal(store.capture().version, pointer.version);
const refusals = [];
async function failure(name, fn) {
  const directory = await mkdtemp(join(root, 'scratch/refusal-' + name + '-'));
  await writeProductGeneration(directory, files);
  const s = new ProductDailyStore(directory, profile.pair);
  await s.select(pointer);
  await fn(s, directory);
  assert.equal(s.capture().version, pointer.version);
  const reloaded = new ProductDailyStore(directory, profile.pair);
  assert.equal((await reloaded.load()).version, pointer.version);
  refusals.push(name);
}
await failure('older', async (s, d) => {
  const old = productFiles({
    ...projectDaily(input),
    metadata: { ...original.metadata, effectiveAtUtc: '2020-01-01T00:00:00Z' },
  });
  await writeProductGeneration(d, old);
  await assert.rejects(s.select(ref(old)), /PRODUCT_NOT_NEWER/);
});
await failure('mixed-pair', async (s, d) => {
  const p = projectDaily(input);
  p.metadata.pair = { ...p.metadata.pair, generation: 'f'.repeat(64) };
  const f = productFiles(p);
  await writeProductGeneration(d, f);
  await assert.rejects(s.select(ref(f)), /PRODUCT_MIXED_PAIR/);
});
await failure('corrupt', async (s, d) => {
  await writeProductGeneration(d, next);
  await writeFile(join(d, next.version, 'daily.ndjson'), 'corrupted');
  await assert.rejects(s.select(ref(next)), /PRODUCT_FILE_DIGEST/);
});
await failure('incomplete', async (s, d) => {
  await mkdir(join(d, next.version));
  await writeFile(join(d, next.version, 'MANIFEST.json'), next.files['MANIFEST.json']);
  await assert.rejects(s.select(ref(next)), /PRODUCT_MEMBERS/);
});
await failure('interrupted', async (s, d) => {
  await writeProductGeneration(d, next);
  await assert.rejects(
    s.select(ref(next), {
      beforePublish: async () => {
        throw Error('SYNTHETIC_INTERRUPTION');
      },
    }),
    /SYNTHETIC_INTERRUPTION/,
  );
});
// A known validation refusal must not strand publication behind its owned lock.
await assert.rejects(store.select({ version: 'e'.repeat(64), manifestSha256: 'e'.repeat(64) }));
assert.equal((await store.select(ref(next))).changed, true);
await store.select(pointer, { rollback: true });
const hexOnly = projectDaily({
  ...input,
  readings: [
    {
      kind: 'market',
      asset: 'HEX',
      chainId: 369,
      quote: 'USD',
      observation: 'spot',
      value: '0.01',
      observedAtUtc: time,
    },
  ],
  now,
});
assert.equal(hexOnly.rows.at(-1).hexPriceUsd, null);
assert.equal(hexOnly.metadata.readings[0].value, '0.01');
for (const bad of [
  { ...readings[0], quote: 'ETH' },
  { ...readings[0], observation: 'daily-close' },
  { ...readings[0], chainId: 369 },
  { ...readings[1], unit: 'gwei' },
  { ...readings[1], gasPriceWei: '1.5' },
  { ...readings[2], chainId: 1 },
  { ...readings[0], observedAtUtc: '2099-01-01T00:00:00Z' },
])
  assert.throws(() => validateReadings([bad], now));
// Exactly one restoration of the newly selected small product, no holder/stake/base copy.
const restore = join(root, 'scratch/restored-product');
await mkdir(restore);
await cp(join(profile.productRoot, pointer.version), join(restore, pointer.version), {
  recursive: true,
  errorOnExist: true,
  force: false,
});
const restored = new ProductDailyStore(restore, profile.pair);
await restored.select(pointer);
assert.deepEqual(restored.capture().rows, original.rows);
assert(restored.capture().csv.equals(original.csv));
for (let offset = 0; offset < original.rows.length; offset += 100) {
  const from = original.rows[offset].dateUtc,
    to = original.rows[Math.min(offset + 99, original.rows.length - 1)].dateUtc;
  assert.deepEqual(
    restored.read(
      restored.capture(),
      ProductQuery.parse({ from, to }),
      'daily',
      new PageCursors(),
      now,
      'public',
    ).items,
    original.rows.slice(offset, offset + 100),
  );
}
await receipt('PUBLICATION_RESTORE_TESTS.json', {
  status: 'PASS',
  realBaseVersion: pointer.version,
  syntheticVersion: next.version,
  syntheticOnly: true,
  additiveKinds: readings.map((r) => r.kind),
  unchangedHistoricalRows: original.rows.length,
  refusals,
  rollback: 'PASS',
  idempotence: 'PASS',
  cursorContexts: 'PASS',
  interruption: 'previous selected product readable; uncertainty lock retained',
  restoration: {
    directory: restore,
    rows: original.rows.length,
    csvBytes: original.csv.length,
    fullBasesCopied: 0,
  },
  externalRequests: 0,
});
console.log(
  'PASS local publication, idempotence, rollback, refusals, future typed inputs, cursor separation and one small-data restore',
);
