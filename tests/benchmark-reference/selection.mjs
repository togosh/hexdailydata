import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import {
  validatePage,
  mergeCandles,
  edgeRequest,
  difference,
  statistics,
  hourlyCheck,
  analyze,
} from '../../dist/history-bootstrap/benchmark-reference.js';
const R = process.env.HDD_TASK_ROOT;
assert(R?.endsWith('btc-eth-historical-reference-r1'));
const scope = JSON.parse(await readFile(join(R, 'SCOPE.json'))),
  q = scope.network.normalRequests[0];
const values = (t) => ({
  timestamp: String(t),
  open: '2.00',
  high: '4',
  low: '1',
  close: '3e0',
  volume: '0.00',
});
const payload = (rows, extra = {}) =>
  Buffer.from(JSON.stringify({ data: { pair: 'BTC/USD', ohlc: rows, ...extra } }));
const rows = Array.from({ length: 1000 }, (_, i) => values(q.query.start + i * 86400));
const page = validatePage(payload(rows), q, 1);
assert(page.coverage.continueAcquisition);
assert(page.candles.every((c) => c.zeroVolume));
assert.equal(page.candles[0].open, '2.00');
for (const change of [
  (r) => ({ ...r, open: '0' }),
  (r) => ({ ...r, volume: '-1' }),
  (r) => ({ ...r, low: '4' }),
  (r) => ({ ...r, high: '1' }),
  (r) => ({ ...r, close: 'NaN' }),
  (r) => ({ ...r, timestamp: '1575331200.0' }),
  (r) => ({ ...r, open: '1'.repeat(129) }),
  (r) => ({ ...r, open: '1e999' }),
])
  assert.throws(() => validatePage(payload([change(rows[0])]), q, 1));
for (const identity of [undefined, 'BTC/EUR', 'WBTC/USD', 'BTC/USD PERP', 'ETH/USD'])
  assert.throws(() => validatePage(payload([rows[0]], { pair: identity }), q, 1));
assert.throws(() => validatePage(payload([rows[0]], { market: 'ETH/USD' }), q, 1));
assert.throws(
  () => validatePage(Buffer.from('{"data":{"pair":"BTC/USD","pair":"BTC/USD","ohlc":[]}}'), q, 1),
  /DUPLICATE_JSON_KEY/,
);
assert.throws(
  () =>
    validatePage(Buffer.from('{"data":{"pair":"BTC/USD","pa\\u0069r":"BTC/USD","ohlc":[]}}'), q, 1),
  /DUPLICATE_JSON_KEY/,
);
assert(
  !validatePage(
    payload(
      rows.map((r, i) => (i > 10 ? { ...r, timestamp: String(Number(r.timestamp) + 86400) } : r)),
    ),
    q,
    1,
  ).coverage.continueAcquisition,
);
assert.throws(() => validatePage(payload([...rows, rows[0]]), q, 1), /ROW_BOUND/);
assert.throws(
  () => validatePage(Buffer.from('{"__proto__":{"data":{"pair":"BTC/USD","ohlc":[]}}}'), q, 1),
  /UNEXPECTED_SOURCE_FIELD/,
);
assert.throws(
  () =>
    validatePage(
      payload(rows),
      { ...q, url: q.url.replace('start=1575331200', 'start=1575331201') },
      1,
    ),
  /FROZEN_QUERY/,
);
const numeric = validatePage(
  Buffer.from(
    '{"data":{"market":"btcusd","ohlc":[{"timestamp":1575331200,"open":9007199254740993,"high":9007199254740994,"low":1,"close":2,"volume":0}]}}',
  ),
  q,
  1,
);
assert.equal(numeric.candles[0].open, '9007199254740993');
assert(numeric.candles[0].contributors[0].numericJsonFields.includes('open'));
const equivalent = validatePage(payload([{ ...rows[0], open: '2.0' }]), q, 2);
const union = mergeCandles([page.candles[0], equivalent.candles[0]]);
assert.equal(union.length, 1);
assert.equal(union[0].contributors.length, 2);
assert.deepEqual(union, mergeCandles([equivalent.candles[0], page.candles[0]]));
assert.throws(
  () => mergeCandles([page.candles[0], { ...page.candles[0], close: '2' }]),
  /CONFLICTING_CANDLE/,
);
assert(!validatePage(payload([]), q, 1).coverage.continueAcquisition);
assert(
  !validatePage(
    payload(rows.map((r) => ({ ...r, timestamp: String(Number(r.timestamp) + 86400000) }))),
    q,
    1,
  ).coverage.continueAcquisition,
);
const phase = validatePage(
  payload(rows.map((r) => ({ ...r, timestamp: String(Number(r.timestamp) + 60) }))),
  q,
  1,
);
assert.deepEqual(phase.coverage.phases, [60]);
const daily = scope.network.normalRequests
  .filter((q) => q.asset === 'BTC' && q.id.includes('-daily-'))
  .map((q, i) =>
    validatePage(
      payload(
        Array.from({ length: q.query.limit }, (_, j) => values(q.query.start + (j + 1) * 86400)),
      ),
      q,
      i + 1,
    ),
  );
const edge = edgeRequest('BTC', daily, scope.network.conditionalRequests[0].alternatives);
assert.equal(edge.id, 'btc-boundary-early');
assert.equal(
  edgeRequest(
    'BTC',
    [
      { ...daily[0], coverage: { ...daily[0].coverage, continueAcquisition: false } },
      ...daily.slice(1),
    ],
    scope.network.conditionalRequests[0].alternatives,
  ),
  null,
);
assert.equal(
  edgeRequest(
    'BTC',
    daily.map((p) => ({ ...p, coverage: { ...p.coverage, phases: [60] } })),
    scope.network.conditionalRequests[0].alternatives,
  ),
  null,
);
const interior = structuredClone(daily);
interior[1].candles.splice(50, 1);
assert.equal(edgeRequest('BTC', interior, scope.network.conditionalRequests[0].alternatives), null);
assert.deepEqual(difference('101', '100'), { numerator: '1', denominator: '1', percent: '1' });
assert.equal(difference('90', '100').percent, '-10');
assert.equal(difference('1', '3').percent, '-66.666666666667');
const comparisons = [0, 1, 5, 10, 11].map((n, i) => ({
  asset: 'BTC',
  dateUtc: `2020-01-${String(i + 1).padStart(2, '0')}`,
  convention: 'same-label-close',
  hds: '100',
  reference: String(100 + n),
  referenceLabel: '',
  zeroVolume: false,
  ...difference(String(100 + n), '100'),
  outsideSameLabelHighLow: false,
}));
const stats = statistics(comparisons);
assert.equal(stats.medianAbsolutePercent, '5');
assert.equal(stats.p95AbsolutePercent, '11');
assert.deepEqual(stats.strictlyAbove, { 1: 3, 5: 2, 10: 1 });
assert.equal(stats.signedMeanPercent, '5.4');
const hourlyQ = scope.network.normalRequests[3],
  anchor = Date.parse('2020-01-15') / 1000;
const hours = validatePage(
  payload(
    Array.from({ length: 50 }, (_, i) => ({
      ...values(hourlyQ.query.start + i * 3600),
      volume: '0.1',
    })),
  ),
  hourlyQ,
  4,
).candles;
const day = validatePage(payload([{ ...values(anchor), volume: '2.4' }]), q, 5).candles;
const check = hourlyCheck('BTC', [...hours, ...day]);
assert(check.groups.every((g) => g.matches));
assert.match(check.inference, /ambiguous/);
assert(hourlyCheck('BTC', [...hours.slice(1), ...day]).groups[1].missing.length === 1);
const history = JSON.parse(await readFile(join(R, 'inputs/data/BENCHMARK_HISTORY.json')));
const result = analyze(
  [...page.candles.filter((c) => c.timestamp !== String(anchor)), ...day, ...hours],
  history,
  JSON.parse(await readFile(join(R, 'INPUTS.json'))).heldHdsCells,
);
assert.equal(result.gaps.length, 735);
assert.equal(result.gaps.filter((g) => g.category === 'held-HDS-conflict').length, 5);
assert.equal(result.gaps.filter((g) => g.category === 'additional-endpoint').length, 2);
assert.equal(result.assets.BTC.originalHdsGaps, 404);
assert.equal(result.assets.ETH.originalHdsGaps, 329);
assert.equal(result.assets.BTC.shared143DayWitness.length, 143);
await writeFile(
  join(R, `evidence/SELECTION_TESTS${process.env.HDD_TEST_SUFFIX ?? ''}.json`),
  JSON.stringify(
    {
      status: 'PASS',
      synthetic: true,
      externalRequests: 0,
      cases: [
        'exact numeric lexemes including >safe integer',
        'same/different duplicate keys',
        'identity and OHLC failures',
        'stable exact duplicate aggregation',
        'page and conditional-edge boundaries',
        'phase/missing hours/ambiguous grouping',
        'exact differences and nearest-rank thresholds',
        'actual HDS gap and conflict categories',
      ],
      frozenConventions: ['same-label-open', 'same-label-close', 'previous-label-close'],
    },
    null,
    2,
  ) + '\n',
  { flag: 'wx' },
);
console.log('PASS strict candle/edge/exact math/actual HDS gap focused fixtures');
