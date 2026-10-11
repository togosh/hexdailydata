import assert from 'node:assert/strict';
import { productCalculator } from '../../dist/services/product-daily/calculator.js';
import { qualifiedProductAmountPrice } from '../../src/web/calculator-amount.ts';
import { openDependencies } from '../../dist/api/dependencies.js';
import { ProductDailyStore } from '../../dist/services/product-daily/store.js';
import { HomeResponseSchema } from '../../dist/contracts/api.js';
import { ProductHomeResponseSchema } from '../../dist/contracts/product-daily.js';
import { calculator as oldCalculator } from '../../dist/services/queries/history.js';
import { template, syntheticBase, now } from './fixture.mjs';
import { participantPair } from '../../dist/services/source-update/refresh.js';

export async function checkCalculator(root) {
  const seed = template(participantPair(syntheticBase(root)));
  const snapshot = {
    ...seed,
    version: 'a'.repeat(64),
    manifestSha256: 'b'.repeat(64),
    csv: Buffer.alloc(0),
  };
  const store = new ProductDailyStore(root, seed.metadata.pair);
  const home = store.home(snapshot, now);
  assert.equal(
    HomeResponseSchema.safeParse(home).success,
    false,
    'baseline legacy Home consumer mismatch',
  );
  ProductHomeResponseSchema.parse(home);
  let dbCalls = 0;
  await assert.rejects(
    oldCalculator(
      {
        read: async () => {
          dbCalls++;
          throw Error('SYNTHETIC_SQL_DENIED');
        },
      },
      'pulsechain',
      new AbortController().signal,
      now,
    ),
    /SYNTHETIC_SQL_DENIED/,
  );
  assert.equal(dbCalls, 1);
  const calc = productCalculator(snapshot, now);
  assert.equal(calc.datasetVersion, snapshot.version);
  assert.equal(calc.shareRate.value.rawShareRate, '123456');
  for (const p of calc.presets) {
    assert.equal(p.status, 'available');
    assert.equal(p.count, p.window);
    assert.equal(p.value.numerator, '70000');
    assert.equal(p.value.denominator, '3');
    assert.equal(p.toDay, 2497);
  }
  const variants = [
    ['missing_days', (s) => s.rows.splice(364, 1)],
    ['pending_days', (s) => (s.rows[364].payoutHearts = null)],
    ['zero_shares', (s) => (s.rows[364].payoutStakeShares = '0')],
  ];
  for (const [reason, change] of variants) {
    const changed = structuredClone(snapshot);
    change(changed);
    assert.equal(productCalculator(changed, now).presets[0].reason, reason);
  }
  let changed = structuredClone(snapshot);
  changed.rows.at(-1).payoutHearts = '999999';
  assert.deepEqual(
    productCalculator(changed, now).presets,
    calc.presets,
    'current day excluded',
  );
  changed = structuredClone(snapshot);
  changed.metadata.readings[0].globalWords[2] = String(1n << 40n);
  assert.throws(() => productCalculator(changed, now), /SHARE_RATE_BOUND/);
  changed = structuredClone(snapshot);
  changed.rows[364].payoutHearts = String(1n << 72n);
  assert.throws(() => productCalculator(changed, now), /PAYOUT_WORD/);
  changed = structuredClone(snapshot);
  changed.metadata.readings = changed.metadata.readings.filter((r) => r.kind !== 'protocol');
  assert.equal(productCalculator(changed, now).shareRate.status, 'unavailable');
  assert.equal(productCalculator(snapshot, now + 121000).shareRate.status, 'stale');
  assert.equal(productCalculator(snapshot, now + 1801000).shareRate.status, 'unavailable');
  assert.equal(productCalculator(snapshot, now - 1000).shareRate.status, 'unavailable');
  assert(qualifiedProductAmountPrice(home, snapshot.version, now));
  assert(qualifiedProductAmountPrice(home, snapshot.version, now + 300000));
  for (const [label, h, v, t, e] of [
    ['aging', home, snapshot.version, now + 300001],
    ['future', home, snapshot.version, now - 1],
    ['generation', home, 'b'.repeat(64), now],
    ['error', home, snapshot.version, now, 'failed'],
    ['null', { ...home, live: { ...home.live, hexPriceUsd: null } }, snapshot.version, now],
    ['invalid', { ...home, live: { ...home.live, hexPriceUsd: '-1' } }, snapshot.version, now],
    ['stale', store.home(snapshot, now + 301000), snapshot.version, now + 301000],
  ])
    assert.equal(qualifiedProductAmountPrice(h, v, t, e), null, label);
  const old = productCalculator(snapshot, now);
  changed = structuredClone(snapshot);
  changed.version = 'c'.repeat(64);
  changed.metadata.readings[0].globalWords[2] = '123457';
  const next = productCalculator(changed, now);
  assert.equal(old.shareRate.value.rawShareRate, '123456');
  assert.equal(next.shareRate.value.rawShareRate, '123457');
  assert.equal(
    qualifiedProductAmountPrice(home, next.datasetVersion, now),
    null,
    'held generation cannot mix price',
  );
  const legacy = await openDependencies({
    HDD_V2_API_MODE: 'legacy-sql',
    HDD_V2_DB_HOST: 'db',
    HDD_V2_DB_NAME: 'hexdailydata_v2',
    HDD_V2_DB_INSTANCE: '11111111-1111-4111-8111-111111111111',
    HDD_V2_API_PASSWORD: 'SYNTHETIC-NOT-A-REAL-PASSWORD',
  });
  assert(legacy.db);
  assert(!legacy.productDaily);
  assert(!legacy.addresses);
  await legacy.close();
  return {
    baselineMismatchReproduced: true,
    exactRational: '70000/3',
    cases: 26,
    legacy: 'explicit composition only; zero SQL connection/query',
    genuineAdmissions: 0,
  };
}
