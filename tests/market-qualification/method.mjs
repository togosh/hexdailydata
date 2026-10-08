// Focused R2 method contract, precise sum and immutable history guards.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { validateReadings } from '../../dist/services/product-daily/project.js';
import { marketMethodRevision, reserveBasedPools } from '../../dist/contracts/product-daily.js';
const id = createHash('sha256')
  .update(JSON.stringify({ method: marketMethodRevision, pools: reserveBasedPools }))
  .digest('hex');
const reading = {
  kind: 'tracked-liquidity',
  chainId: 369,
  quote: 'USD',
  value: '10.000000000000000001',
  observedAtUtc: '2026-10-07T23:59:59Z',
  set: {
    id,
    measure: 'reserve-based source-derived USD estimate',
    methodRevision: marketMethodRevision,
    coverage: 'bounded contemporary HEX-pool cohort',
    pools: reserveBasedPools.map((p, i) => ({
      address: p.address,
      dex: 'PulseX',
      version: p.venue === 0 ? 'V1' : 'V2',
      valueUsd: i === 0 ? '1.000000000000000001' : String(i + 1),
    })),
  },
};
validateReadings([reading]);
assert.equal(id, '7aa1cb9c1cc6fd91394f9caa1b8eda5927a610ac5941dca66aae46c92a02c50b');
for (const mutate of [
  (r) => delete r.set.methodRevision,
  (r) => r.set.pools.pop(),
  (r) => (r.set.pools[0].address = '0x' + 'a'.repeat(40)),
  (r) => (r.value = '10'),
  (r) => (r.set.pools[0].version = 'V3'),
  (r) => (r.set.measure = 'two-sided source reserveUSD estimate'),
]) {
  const r = structuredClone(reading);
  mutate(r);
  assert.throws(() => validateReadings([r]));
}
console.log(
  JSON.stringify({
    status: 'PASS',
    label: 'synthetic exact four-pool method contract',
    id,
    negativeCases: 6,
    externalRequests: 0,
  }),
);
