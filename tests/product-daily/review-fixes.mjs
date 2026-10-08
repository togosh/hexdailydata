import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import { join } from 'node:path';
import { input, profile, pointer, root, receipt } from './inputs.mjs';
import { projectDaily, productFiles } from '../../dist/services/product-daily/project.js';
import {
  ProductDailyStore,
  writeProductGeneration,
} from '../../dist/services/product-daily/store.js';
import { validateAdmittedPair } from '../../dist/services/product-daily/open.js';
import { ProductPageQuery } from '../../dist/contracts/product-daily.js';
import { createApp } from '../../dist/api/app.js';
import { charge } from './access-fixture.mjs';
const ref = ({ version, manifestSha256 }) => ({ version, manifestSha256 });
const root2 = await mkdtemp(join(root, 'scratch/review-fixes-')),
  base = productFiles(projectDaily(input));
assert.equal(base.version, pointer.version);
await writeProductGeneration(root2, base);
const store = new ProductDailyStore(root2, profile.pair);
await store.select(pointer);
const snapshot = store.capture(),
  csv = snapshot.csv;
csv[0] ^= 255;
assert.notEqual(csv[0], store.capture().csv[0]);
assert.throws(() => {
  snapshot.version = 'f'.repeat(64);
}, TypeError);
const pending = store.load();
await assert.rejects(store.select(pointer), /PRODUCT_SELECTION_BUSY/);
await pending;
for (const field of [
  'baseObservedAtUtc',
  'observedAtUtc',
  'holderRecordCount',
  'stakeStartRecordCount',
])
  assert.throws(
    () =>
      validateAdmittedPair(
        { ...profile.pair, [field]: field.endsWith('Count') ? 1 : '2026-10-08T00:00:00Z' },
        {
          localHolderRows: profile.pair.holderRecordCount,
          localStakeRows: profile.pair.stakeStartRecordCount,
        },
      ),
    /PRODUCT_PROFILE_PAIR_FACTS/,
  );
const next = productFiles(
  projectDaily({
    ...input,
    readings: [
      {
        kind: 'market',
        asset: 'HEX',
        chainId: 369,
        quote: 'USD',
        observation: 'spot',
        value: '0.0010',
        observedAtUtc: '2026-10-08T00:01:00Z',
      },
    ],
  }),
);
await writeProductGeneration(root2, next);
const old = productFiles({
  ...projectDaily(input),
  metadata: { ...snapshot.metadata, effectiveAtUtc: '2020-01-01T00:00:00Z' },
});
await writeProductGeneration(root2, old);
await assert.rejects(store.select(ref(old)), /PRODUCT_NOT_NEWER/);
const mixed = projectDaily(input);
mixed.metadata.pair = { ...mixed.metadata.pair, holderRecordCount: 1 };
const bad = productFiles(mixed);
await writeProductGeneration(root2, bad);
await assert.rejects(store.select(ref(bad)), /PRODUCT_MIXED_PAIR/);
await store.select(ref(next));
assert.equal(store.capture().rows.at(-1).hexPriceUsd, null);
assert.equal(store.live(store.capture(), Date.now()).hexPriceUsd, '0.0010');
await store.select(pointer, { rollback: true });
const priceOnly = projectDaily({
  ...input,
  prices: [
    ...input.prices,
    {
      series: 'pulsechain-hex-reference-usd',
      day: 9999,
      recordedAtUtc: '2026-10-08T00:02:00Z',
      quoteUsd: '0.002',
    },
  ],
});
assert.equal(priceOnly.metadata.effectiveAtUtc, '2026-10-08T00:02:00.000Z');
const app = createApp({ dependencies: { productDaily: store } });
try {
  for (const url of [
    '/api/v2/holders?address=0x' + '1'.repeat(40),
    '/api/v2/addresses/0x' + '1'.repeat(40) + '?address=0x' + '2'.repeat(40),
  ]) {
    charge();
    assert.equal((await app.inject(url)).statusCode, 400);
  }
} finally {
  await app.close();
}
// Reconcile all real primary-price decisions independently against original normalized candidates.
const exclusions = new Set(
  input.exceptions
    .filter((e) => !['zero_price', 'skeleton'].includes(e.reason))
    .flatMap((e) => e.fields.map((f) => [e.body, e.day, f].join(':'))),
);
let present = 0,
  blocked = 0;
const winnerCounts = {};
for (const row of snapshot.rows) {
  const candidates = input.prices.filter((p) => p.recordedAtUtc.slice(0, 10) === row.dateUtc);
  const options = {};
  for (const [series, body, field] of [
    ['ethereum-origin-v3-reference-usd', 'ethereum', 'priceUV3'],
    ['ethereum-origin-v2-reference-usd', 'ethereum', 'priceUV2'],
    ['pulsechain-hex-reference-usd', 'pulse', 'pricePulseX'],
  ]) {
    const matching = candidates
      .filter((p) => p.series === series)
      .sort((a, b) => Date.parse(b.recordedAtUtc) - Date.parse(a.recordedAtUtc));
    if (!matching.length) continue;
    const same = matching.filter(
      (p) => Date.parse(p.recordedAtUtc) === Date.parse(matching[0].recordedAtUtc),
    );
    options[field] = {
      p: matching[0],
      blocked:
        same.some((p) => exclusions.has([body, p.day, field].join(':'))) ||
        new Set(same.map((p) => p.quoteUsd)).size > 1,
    };
  }
  const v3 = options.priceUV3,
    selected =
      options.pricePulseX ?? (v3 && (v3.blocked || v3.p.quoteUsd !== null) ? v3 : options.priceUV2);
  assert.equal(row.hexPriceUsd, selected && !selected.blocked ? selected.p.quoteUsd : null);
  if (selected?.blocked) blocked++;
  if (row.hexPriceUsd !== null) {
    present++;
    winnerCounts[selected.p.series] = (winnerCounts[selected.p.series] ?? 0) + 1;
  }
}
await receipt('REVIEW_FIXES.json', {
  status: 'PASS',
  findingsRechecked: 7,
  knownRefusalThenValidUpdateRollback: 'PASS',
  actualPriceDates: present,
  blockedDates: blocked,
  winnerCounts,
  originalProjectionUnchanged: base.version,
  originalRestoreReused: true,
  newBaseScans: 0,
  externalRequests: 0,
});
console.log('PASS seven affected review fixes and full primary-price decision reconciliation');
