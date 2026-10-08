import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  usdCents,
  exactPrice,
  usdToHearts,
  hexHearts,
  currentUsdEquivalent,
  qualifiedAmountPrice,
  defaultAmountFields,
  readAmountFields,
  AMOUNT_SESSION_KEY,
  formatAmount,
  ungroupAmount,
} from '../../src/web/calculator-amount.ts';
import { quoteStake, payoutScenario, UINT72_MAX } from '../../src/domain/calculator.ts';
import { formatUnits } from '../../src/domain/units.ts';
import { HomeResponseSchema } from '../../src/contracts/api.ts';
import { CalculatorResponseSchema } from '../../src/contracts/reads.ts';

const fixture = JSON.parse(
  readFileSync(new URL('../browser/calculator-amount-fixture.json', import.meta.url)),
);
const vectors = [
  ['100', '0.01', '1000000000000', '10000'],
  ['1', '3', '33333333', '0.33333333'],
  ['0.01', '1000000', '1', '0.00000001'],
  ['100', '0.000001', '10000000000000000', '100000000'],
  ['1.23', '0.0042', '29285714285', '292.85714285'],
  ['123.45', '0.07', '176357142857', '1763.57142857'],
  ['1', '0.123456789012345678901234567890123456', '810000007', '8.10000007'],
  ['47223664828696.45', '1', '4722366482869645000000', '47223664828696.45'],
];
test('display grouping and padding preserve exact digits and canonical value round trips', () => {
  for (const [raw, displayed] of [
    ['100', '100.00'],
    ['1234.5', '1,234.50'],
    ['10000.12345678', '10,000.12345678'],
    ['0.00000001', '0.00000001'],
    ['9007199254740993.01', '9,007,199,254,740,993.01'],
    ['47223664828696.45213695', '47,223,664,828,696.45213695'],
    ['1000.00000000', '1,000.00000000'],
  ]) {
    assert.equal(formatAmount(raw, 2), displayed);
    if ((raw.split('.')[1] ?? '').length <= 2)
      assert.equal(usdCents(ungroupAmount(displayed)), usdCents(raw));
    else assert.equal(hexHearts(ungroupAmount(displayed)), hexHearts(raw));
  }
  assert.equal(formatAmount('5555'), '5,555');
  assert.equal(ungroupAmount('5,555'), '5555');
  assert.equal(ungroupAmount('1,234.'), '1234.');
  for (const bad of [
    '',
    '1.',
    '1,23',
    '1,234,56',
    '1,234.5,6',
    '01,234',
    ' 1,234',
    '-1,234',
    '1e3',
    '00.5',
  ]) {
    assert.equal(ungroupAmount(bad), bad);
    assert.equal(formatAmount(bad, 2), bad);
    assert.throws(() => usdCents(ungroupAmount(bad)));
  }
  assert.equal(formatAmount('1'.repeat(101), 2), '1'.repeat(101));
  assert.equal(formatAmount('1234.001', 2), '1,234.001');
  assert.throws(() => usdCents(ungroupAmount('1,234.001')));
});
test('all supplied successful vectors and independent one-heart floor inequalities', () => {
  for (const [usd, price, hearts, hex] of vectors) {
    const result = usdToHearts(usd, price);
    assert.equal(result, BigInt(hearts));
    assert.equal(formatUnits(result, 8), hex);
    // Independent cross multiplication from decimal tokens, not helper outputs.
    const [u, uf = ''] = usd.split('.'),
      [p, pf = ''] = price.split('.');
    const cents = BigInt(u + uf.padEnd(2, '0')),
      pn = BigInt(p + pf),
      scale = 10n ** BigInt(pf.length);
    const budget = cents * scale * 100000000n;
    assert.ok(result * pn * 100n <= budget && budget < (result + 1n) * pn * 100n);
  }
});
test('supplied dust/zero/overflow vectors; exact HEX and uint72 boundaries', () => {
  for (const [usd, price] of [
    ['0.01', '1000001'],
    ['47223664828696.46', '1'],
    ['1', '0.000000000000000000000000000000000001'],
    ['0.00', '0.01'],
  ])
    assert.throws(() => usdToHearts(usd, price));
  assert.equal(hexHearts('0.00000001'), 1n);
  assert.equal(hexHearts('47223664828696.45213695'), UINT72_MAX);
  assert.throws(() => hexHearts('47223664828696.45213696'));
  assert.throws(() => hexHearts('0'));
  assert.throws(() => hexHearts('1.000000001'));
});
test('canonical input, price precision and length bounds before magnitude work', () => {
  for (const text of [
    '',
    '-1',
    '+1',
    '1e2',
    '1,000',
    '1,23',
    ' 100',
    '100 ',
    '00.01',
    '.5',
    '1.',
    '0.001',
    '9'.repeat(101),
  ])
    assert.throws(() => usdCents(text), text);
  for (const text of [
    '0',
    '0.00000000',
    '-0.01',
    'NaN',
    'Infinity',
    '1e-2',
    '0,01',
    '0.' + '0'.repeat(36) + '1',
    '9'.repeat(121),
  ])
    assert.throws(() => exactPrice(text), text);
  assert.doesNotThrow(() => exactPrice('9'.repeat(120)));
  assert.throws(() => hexHearts('1'.repeat(101)));
  assert.equal(usdCents('9007199254740993.01'), 900719925474099301n);
  assert.equal(currentUsdEquivalent(1000000000000n, '0.01'), '100');
});
test('USD quote equals unchanged HEX engine; future zero/blank never changes principal', () => {
  const hearts = usdToHearts('100', '0.01');
  const derived = quoteStake(hearts, 365, 100000n, 1789819200n);
  assert.deepEqual(derived, quoteStake(1000000000000n, 365, 100000n, 1789819200n));
  assert.equal(derived.stakeShares, 1200006666666n);
  for (const future of [
    null,
    { numerator: 0n, denominator: 1n },
    { numerator: 5n, denominator: 1n },
  ]) {
    const scenario = payoutScenario(derived, { numerator: 6n, denominator: 1n }, future);
    assert.equal(derived.principalHearts, 1000000000000n);
    if (future?.numerator === 0n) assert.equal(scenario.usd.numerator, 0n);
    if (future === null) assert.equal(scenario.usd, null);
  }
  // Accepted conversion still respects the engine's independent share-output bound.
  assert.throws(() => quoteStake(UINT72_MAX, 5555, 1n, 1789819200n), /shares/);
});
test('synthetic wire responses validate real schemas and both valuation classifications qualify', () => {
  assert.match(fixture.description, /SYNTHETIC/);
  HomeResponseSchema.parse(fixture.home);
  CalculatorResponseSchema.parse(fixture.calculator);
  for (const valuation of ['peg_assumed', 'independent_anchor']) {
    const home = structuredClone(fixture.home);
    home.live.price.value.valuation = valuation;
    HomeResponseSchema.parse(home);
    assert.ok(qualifiedAmountPrice(home, fixture.at));
  }
});
test('freshness boundary, source chain, future timestamps and retained fetch errors refuse conversion', () => {
  const h = fixture.home;
  assert.ok(qualifiedAmountPrice(h, fixture.at + 120000));
  assert.equal(qualifiedAmountPrice(h, fixture.at + 121000), null);
  assert.equal(qualifiedAmountPrice(h, fixture.at + 1801000), null);
  assert.equal(qualifiedAmountPrice(h, fixture.at, 'Data unavailable'), null);
  assert.equal(qualifiedAmountPrice(undefined, fixture.at), null);
  for (const edit of [
    (h) => (h.chain = 'ethereum'),
    (h) => (h.live.price.asOf.chainId = 1),
    (h) => (h.live.price.status = 'stale'),
    (h) => (h.live.price.value.usdPerHex = '0'),
    (h) => (h.live.price.value.usdPerHex = '1e-2'),
    (h) => (h.live.price.observedAt = 'invalid'),
    (h) => (h.live.price.observedAt = new Date(fixture.at + 1000).toISOString()),
    (h) => (h.live.price.asOf.blockTimestamp = new Date(fixture.at + 1000).toISOString()),
  ]) {
    const home = structuredClone(h);
    edit(home);
    assert.equal(qualifiedAmountPrice(home, fixture.at), null);
  }
});
test('new versioned persistence retains labelled drafts and choices without untrusted keys', () => {
  assert.equal(AMOUNT_SESSION_KEY, 'calculator-amount-v1');
  const saved = {
    ...defaultAmountFields(),
    unit: 'HEX',
    usd: '12.34',
    hex: '9.12345678',
    days: '5555',
    preset: '1',
    future: '0',
    futureMode: 'custom',
    extra: 'ignored',
  };
  const restored = readAmountFields(JSON.stringify(saved));
  const { extra, ...expected } = saved;
  assert.deepEqual(restored, expected);
  for (const value of [
    null,
    '{broken',
    JSON.stringify({ amount: '10000', days: '365', preset: '30', future: '' }),
    JSON.stringify({ ...saved, unit: 'EUR' }),
    JSON.stringify({ ...saved, usd: 100 }),
    JSON.stringify({ ...saved, hex: '1'.repeat(101) }),
    JSON.stringify({ ...saved, version: 2 }),
    JSON.stringify({ ...saved, days: '1'.repeat(6) }),
    ' '.repeat(1025),
  ])
    assert.deepEqual(readAmountFields(value), defaultAmountFields());
  const unfinished = readAmountFields(JSON.stringify({ ...saved, usd: '1.' }));
  assert.equal(unfinished.usd, '1.');
  assert.throws(() => usdCents(unfinished.usd));
});
