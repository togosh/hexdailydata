import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { input, profile, pointer, receipt } from './inputs.mjs';
import { projectDaily, productFiles } from '../../dist/services/product-daily/project.js';
import { admitProduct } from '../../dist/services/product-daily/store.js';
import { productMetrics, ProductQuery } from '../../dist/contracts/product-daily.js';
import { add } from '../../dist/history-bootstrap/normalize.js';
const product = projectDaily(input),
  files = productFiles(product),
  saved = await admitProduct(join(profile.productRoot, pointer.version), pointer.manifestSha256);
assert.equal(files.version, pointer.version);
assert.deepEqual(product.rows, saved.rows);
for (const [name, bytes] of Object.entries(files.files))
  assert(bytes.equals(await readFile(join(profile.productRoot, pointer.version, name))));
const row = (date) => product.rows.find((r) => r.dateUtc === date);
assert.equal(product.rows.length, 2501);
assert.equal(new Set(product.rows.map((r) => r.dateUtc)).size, 2501);
let snapshotFields = 0,
  payouts = 0,
  changes = 0,
  priceDecisions = 0;
const selected = new Map();
for (const r of input.daily) {
  if (!r.recordedAtUtc) continue;
  const d = r.recordedAtUtc.slice(0, 10),
    prior = selected.get(d) ?? [];
  if (!prior.length || Date.parse(prior[0].recordedAtUtc) < Date.parse(r.recordedAtUtc))
    selected.set(d, [r]);
  else if (Date.parse(prior[0].recordedAtUtc) === Date.parse(r.recordedAtUtc)) prior.push(r);
}
for (const [date, observations] of selected) {
  const got = row(date);
  assert.equal(Date.parse(got.snapshotRecordedAtUtc), Date.parse(observations[0].recordedAtUtc));
  for (const [field, [, , kind]] of Object.entries(productMetrics)) {
    if (kind !== 'snapshot') continue;
    const tokens = observations.map((r) => r[field] ?? null);
    assert.equal(got[field], tokens.every((v) => v === tokens[0]) ? tokens[0] : null);
    snapshotFields++;
  }
}
for (const r of input.ledger.items) {
  const got = row(r.nominalDateUtc);
  assert.equal(got.contractDay, r.contractDay);
  assert.equal(got.payoutHearts, r.payoutHearts);
  assert.equal(got.payoutStakeShares, r.stakeShares);
  const n = BigInt(r.payoutHearts) * 10n ** 22n,
    d = BigInt(r.stakeShares);
  let rate = null;
  if (d) {
    const rounded = n / d + ((n % d) * 2n >= d ? 1n : 0n),
      s = rounded.toString().padStart(19, '0');
    rate = s.slice(0, -18) + '.' + s.slice(-18);
  }
  assert.equal(got.payoutPerTshareHEX, rate);
  payouts++;
}
const difference = {
  circulatingSupplyChange: 'circulatingHEX',
  stakedSupplyChange: 'stakedHEX',
  stakedHEXGAChange: 'stakedHEXGA',
  totalTsharesChange: 'totalTshares',
  currentHoldersChange: 'currentHolders',
  holderIndexMaximumChange: 'holderIndexMaximum',
  unendedUnaccountedStakerAddressesChange: 'unendedUnaccountedStakerAddresses',
  historicalStakerAddressesChange: 'historicalStakerAddresses',
  tshareRateChangeHEX: 'tshareRateHEX',
  stakedHEXPercentChange: 'stakedHEXPercent',
  netTotalSupplyChangeHEX: 'totalHEX',
};
for (let i = 0; i < product.rows.length; i++) {
  const r = product.rows[i],
    p = product.rows[i - 1];
  for (const [change, base] of Object.entries(difference)) {
    assert.equal(
      r[change],
      p && p[base] !== null && r[base] !== null ? add(r[base], p[base], true) : null,
    );
    changes++;
  }
  assert.equal(r.estimatedPenaltiesHEX, null);
  assert.equal(r.simpleAnnualizedPayoutRatePercent, null);
}
assert.equal(row('2019-12-03').snapshotRecordedAtUtc, null);
assert.equal(row('2019-12-03').dailyPayoutHEX, '0');
assert.equal(row('2019-12-03').payoutPerTshareHEX, null);
assert.equal(row('2024-09-01').totalTshares, null);
assert.equal(row('2024-09-02').totalTsharesChange, null);
assert.equal(row('2026-10-05').dailyPayoutHEX, null);
assert.equal(row('2023-03-01').hexPriceUsd, null);
assert.equal(row('2020-05-18').hexPriceUsd, null);
// Tiny synthetic observations deliberately use legacy indices unrelated to their dates.
const synth = {
  ...input,
  daily: [
    { day: 9000, recordedAtUtc: '2020-01-01T01:00:00Z', circulatingHEX: '9', stakedHEX: '4' },
    { day: 9001, recordedAtUtc: '2020-01-01T02:00:00Z', circulatingHEX: '10.000', stakedHEX: null },
    { day: 9002, recordedAtUtc: '2020-01-02T02:00:00Z', circulatingHEX: '12.003', stakedHEX: '0' },
    { day: 9003, recordedAtUtc: '2020-01-04T02:00:00Z', circulatingHEX: '15' },
    { day: 9004, recordedAtUtc: '2020-01-04T02:00:00Z', circulatingHEX: '16' },
  ],
  prices: [],
  exceptions: [],
};
const s = projectDaily(synth).rows;
const sr = (d) => s.find((r) => r.dateUtc === d);
assert.equal(sr('2020-01-01').stakedHEX, null);
assert.equal(sr('2020-01-02').circulatingSupplyChange, '2.003');
assert.equal(sr('2020-01-03').circulatingHEX, null);
assert.equal(sr('2020-01-04').circulatingHEX, null);
assert.equal(sr('2020-01-04').circulatingSupplyChange, null);
assert.equal(sr('2020-01-01').contractDay, 29);
const quote = (series, day, quoteUsd) => ({
  series,
  day,
  quoteUsd,
  recordedAtUtc: '2020-06-01T01:00:00Z',
});
for (const [v3, exceptions, expected] of [
  ['0.0300', [], '0.0300'],
  [null, [], '0.02'],
  [
    null,
    [{ body: 'ethereum', day: 181, reason: 'conflict', fields: ['priceUV3'], records: [] }],
    null,
  ],
]) {
  const p = projectDaily({
    ...synth,
    prices: [
      quote('ethereum-origin-v3-reference-usd', 181, v3),
      quote('ethereum-origin-v2-reference-usd', 181, '0.02'),
    ],
    exceptions,
  });
  assert.equal(p.rows.find((r) => r.dateUtc === '2020-06-01').hexPriceUsd, expected);
  priceDecisions++;
}
const conflicts = projectDaily({
  ...synth,
  prices: [
    quote('ethereum-origin-v3-reference-usd', 181, '0.03'),
    quote('ethereum-origin-v3-reference-usd', 182, '0.04'),
    quote('ethereum-origin-v2-reference-usd', 181, '0.02'),
  ],
});
assert.equal(conflicts.rows.find((r) => r.dateUtc === '2020-06-01').hexPriceUsd, null);
for (const invalid of [
  { from: '2019-01-01', to: '2020-01-01' },
  { from: '2020-01-01', to: '2021-01-01' },
  { from: '2020-01-01', to: '2020-01-31', limit: '101' },
  { from: '2020-01-01', to: '2020-01-31', source: 'x' },
])
  assert(!ProductQuery.safeParse(invalid).success);
await receipt('PROJECTION_TESTS.json', {
  status: 'PASS',
  datasetVersion: files.version,
  realRows: product.rows.length,
  snapshotFieldComparisons: snapshotFields,
  exactRationalLedgerChecks: payouts,
  consecutiveDateChangeChecks: changes,
  syntheticPricePriorityCases: priceDecisions + 1,
  coverage: product.metadata.coverage,
  bytesCompared: Object.keys(files.files),
  externalRequests: 0,
});
console.log(
  'PASS full selected projection, original tokens, calendar changes, independent ledger arithmetic, prices, nulls and identical CSV',
);
