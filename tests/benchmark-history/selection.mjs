import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import {
  qualifyBenchmarkHistory,
  selectBenchmarkRows,
} from '../../dist/history-bootstrap/benchmarks.js';
import { parseScalarRows, parseRows } from '../../dist/history-bootstrap/normalize.js';
const R = process.env.HDD_TASK_ROOT;
assert(R?.endsWith('btc-eth-historical-backfill-r1'));
const inputs = await Promise.all(
  [
    'public-session/03.body',
    'public-session/02.body',
    'Coingecko.js',
    'public-session/09.body',
  ].map((p) => readFile(join(R, 'inputs', p))),
);
const result = qualifyBenchmarkHistory(...inputs),
  rows = parseScalarRows(inputs[0]),
  diagnostic = parseScalarRows(inputs[1]);
assert.deepEqual(
  result.buckets,
  selectBenchmarkRows([...rows].reverse(), [...diagnostic].reverse()).buckets,
);
for (const [date, asset] of [
  ['2024-08-29', 'BTC'],
  ['2024-09-01', 'ETH'],
  ['2023-08-14', 'BTC'],
  ['2023-05-10', 'BTC'],
  ['2023-05-10', 'ETH'],
])
  assert(!result.buckets.some((r) => r.dateUtc === date && r.asset === asset));
assert(result.buckets.some((r) => r.dateUtc === '2024-08-29' && r.asset === 'ETH'));
for (const n of [0, 2, 3]) {
  const b = Buffer.from(inputs[n]);
  b[100] ^= 1;
  const test = [...inputs];
  test[n] = b;
  assert.throws(() => qualifyBenchmarkHistory(...test), /BINDING/);
}
const row = (id, day, date, BTC, ETH) => ({
  _id: id,
  currentDay: String(day),
  date,
  priceBTC: BTC,
  priceETH: ETH,
  circulatingHEX: '0',
  stakedHEX: '0',
});
const source = [
  row('a', 1, '2019-12-04T00:00:00.000Z', '1e3', '2.00'),
  row('b', 1, '2019-12-04T00:00:00.000Z', '1000.0', '2'),
  row('c', 2, '2019-12-05T00:00:00.000Z', '-1', 'NaN'),
  row('d', 3, '2019-12-06T00:00:00.000Z', '0', null),
  row('e', 4, '2019-12-07T00:00:00.000Z', '4', '4'),
  row('f', 4, '2019-12-07T01:00:00.000Z', '0', '4'),
  row('g', 5, '2019-12-08T00:00:00.000Z', '5', '5'),
  row('h', 6, '2019-12-08T00:00:00.000Z', '6', '5'),
  row('i', 7, 'invalid', '7', '7'),
  row('j', 8, '2019-12-10T00:00:00.000Z', '1e9999', 'Infinity'),
];
const selected = selectBenchmarkRows(source);
assert.equal(
  selected.buckets.find((r) => r.dateUtc === '2019-12-04' && r.asset === 'BTC').value,
  '1e3',
);
assert(
  !selected.buckets.some((r) => ['2019-12-05', '2019-12-06', '2019-12-10'].includes(r.dateUtc)),
);
assert(!selected.buckets.some((r) => r.dateUtc === '2019-12-07' && r.asset === 'BTC'));
assert(!selected.buckets.some((r) => r.dateUtc === '2019-12-08' && r.asset === 'BTC'));
assert(selected.buckets.some((r) => r.dateUtc === '2019-12-08' && r.asset === 'ETH'));
assert.deepEqual(selected.buckets, selectBenchmarkRows([...source].reverse()).buckets);
assert.throws(() => parseRows(Buffer.from(JSON.stringify([source[8]]))), /SOURCE_DAY_DATE/);
const incompatible = selectBenchmarkRows([
  row('x', 9, '2019-12-11T00:00:00Z', '1', '2'),
  row('y', 9, '2019-12-12T00:00:00Z', '1', '2'),
]);
assert.equal(incompatible.buckets.length, 0);
const latest = selectBenchmarkRows([
  row('x', 9, '2019-12-11T00:00:00Z', '1', '2'),
  row('y', 10, '2019-12-11T01:00:00Z', '3', '0'),
]);
assert.deepEqual(latest.buckets, [{ dateUtc: '2019-12-11', asset: 'BTC', value: '3' }]);
const report = {
  status: 'PASS',
  externalRequests: 0,
  sourceBodies: 2,
  selectedBuckets: result.buckets.length,
  coverage: result.coverage,
  realConflictHolds: 5,
  syntheticCases: [
    'equivalent lexical exponents',
    'stable identity despite order',
    'skeleton positives',
    'negative/invalid/zero/null',
    'explicit conflict no fallback',
    'tied independent assets',
    'invalid timestamps',
    'incompatible day dates',
    'latest whole record including zero',
  ],
  helperAndSourceTampering: 'rejected',
};
await writeFile(join(R, 'evidence/SELECTION_TESTS.json'), JSON.stringify(report, null, 2) + '\n', {
  flag: 'wx',
});
console.log(
  JSON.stringify({ status: 'PASS', buckets: result.buckets.length, coverage: result.coverage }),
);
