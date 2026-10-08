// Reviewer regressions: real immutable reader/writer, synthetic market values only.
import assert from 'node:assert/strict';
import { readFile, writeFile, mkdtemp } from 'node:fs/promises';
import { join } from 'node:path';
import { hash } from '../../dist/history-bootstrap/normalize.js';
import { applyMarketUpdate } from '../../dist/services/product-daily/market.js';
import { productFiles } from '../../dist/services/product-daily/project.js';
import {
  admitProduct,
  writeProductGeneration,
  ProductDailyStore,
} from '../../dist/services/product-daily/store.js';
const root = process.env.HDD_TASK_ROOT;
const p = JSON.parse(await readFile(join(root, 'PRODUCT_PROFILE.json')));
const pointer = JSON.parse(await readFile(join(p.productRoot, 'CURRENT.json')));
const base = {
  ...(await admitProduct(join(p.productRoot, pointer.version), pointer.manifestSha256)),
  exceptions: [],
};
const address = '0x' + '1'.repeat(40),
  other = '0x' + '2'.repeat(40);
const liquidity = (address, time = '2026-10-06T23:59:00Z') => ({
  kind: 'tracked-liquidity',
  chainId: 369,
  quote: 'USD',
  value: '42',
  observedAtUtc: time,
  set: {
    id: hash(JSON.stringify([{ address, venue: 0 }])),
    coverage: 'bounded contemporary HEX-pool cohort',
    measure: 'two-sided source reserveUSD estimate',
    pools: [{ address, dex: 'PulseX', version: 'V1', valueUsd: '42' }],
  },
});
const update = (readings) => ({ readings, liquidityHistory: [], receiptSha256: '4'.repeat(64) });
const first = applyMarketUpdate(base, update([liquidity(address)]));
assert.throws(
  () => applyMarketUpdate(first, update([liquidity(other, '2026-10-08T00:01:00Z')])),
  /LIQUIDITY_COHORT_DRIFT/,
);
const legacy = {
  kind: 'liquidity',
  chainId: 369,
  poolAddress: address,
  dex: 'PulseX',
  version: 'V1',
  quote: 'USD',
  value: '42',
  observedAtUtc: '2026-10-06T23:58:00Z',
};
const old = applyMarketUpdate(base, update([legacy]));
assert.throws(() => applyMarketUpdate(old, update([liquidity(address)])), /LIQUIDITY_COHORT_DRIFT/);
const futurePrice = {
  kind: 'market',
  asset: 'HEX',
  chainId: 369,
  quote: 'USD',
  observation: 'spot',
  value: '0.002',
  observedAtUtc: '2026-10-08T13:00:00Z',
};
const newer = applyMarketUpdate(first, update([futurePrice]));
const bucket = {
  dateUtc: '2026-10-07',
  value: '40',
  setId: liquidity(address).set.id,
  meaning: 'source UTC-day bucket, not a verified close',
};
assert.throws(
  () => applyMarketUpdate(newer, { ...update([]), liquidityHistory: [bucket] }),
  /INCOMPLETE_UTC_HISTORY_DAY/,
);
const legitimate = applyMarketUpdate(first, update([liquidity(address, '2026-10-08T00:01:00Z')]));
assert.equal(legitimate.rows.find((r) => r.dateUtc === '2026-10-06').trackedLiquidityUsd, '42');
const dir = await mkdtemp(join(root, 'scratch/cohort-'));
const files = productFiles(newer);
await writeProductGeneration(dir, files);
const store = new ProductDailyStore(dir, p.pair);
await store.select({ version: files.version, manifestSha256: files.manifestSha256 });
const forged = structuredClone(newer);
forged.metadata.liquidityHistory = [bucket];
await assert.rejects(
  writeProductGeneration(dir, productFiles(forged)),
  /INCOMPLETE_UTC_HISTORY_DAY/,
);
const drift = structuredClone(legitimate);
drift.metadata.observations[1] = liquidity(other, '2026-10-08T00:01:00Z');
drift.metadata.readings = [drift.metadata.observations[1]];
await assert.rejects(writeProductGeneration(dir, productFiles(drift)), /LIQUIDITY_COHORT_DRIFT/);
assert.equal(store.capture().version, files.version);
const result = {
  status: 'PASS',
  label: 'synthetic cohort/time regressions on actual saved daily reader',
  checks: [
    'changed cohort rejected',
    'mixed legacy/tracked rejected; legacy alone remains readable',
    'unrelated later price cannot qualify history date',
    'same set next day retains prior value',
    'actual writer/admission reject forged metadata',
    'selected pointer unchanged on rejection',
  ],
  baseCensusScans: 0,
  externalRequests: 0,
};
await writeFile(join(root, 'evidence/COHORT_TESTS.json'), JSON.stringify(result, null, 2) + '\n', {
  flag: 'wx',
});
console.log(JSON.stringify(result));
