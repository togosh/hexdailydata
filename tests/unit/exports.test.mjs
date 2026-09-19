import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { csvLine, datasetRow } from '../../src/worker/exports/datasets.ts';
import { marketObservationSchema } from '../../src/worker/daily/market.ts';
test('pre-aborted and mid-read file verification reject without process crash or open handles', () => {
  const result = spawnSync(process.execPath, ['tests/fixtures/export-abort.mjs'], {
    encoding: 'utf8',
    timeout: 10000,
  });
  assert.equal(result.status, 0, result.stdout + result.stderr);
});
test('CSV quotes, injection guard, null versus exact zero and independent large holder vector', () => {
  assert.equal(
    csvLine(['a,b', 'a"b', 'a\nb', '=1+1', null, '0', '900719925474099312345678']),
    '"a,b","a""b","a\nb",\'=1+1,,0,900719925474099312345678\n',
  );
  assert.deepEqual(
    datasetRow('holders', {
      address: Buffer.alloc(20, 17),
      liquid_hearts: '900719925474099312345678',
      accounted_hearts: '123456789',
      stake_count: '1',
      liquid_rank: '1',
      staker_rank: null,
      ranking_day: null,
    }),
    [
      '0x' + '11'.repeat(20),
      '9007199254740993.12345678',
      '1.23456789',
      '9007199254740994.35802467',
      '1',
      '1',
      null,
      null,
    ],
  );
});
test('market completeness does not confuse absent intervals with a measured zero', () => {
  assert.equal(
    marketObservationSchema.safeParse({
      open: null,
      high: null,
      low: null,
      close: null,
      volume: null,
      liquidity: null,
      intervals: 0,
      expectedIntervals: 1440,
      coverage: 'complete',
      sourceTime: null,
      observedTime: null,
      blockNumber: null,
      blockHash: null,
      poolTime: null,
    }).success,
    false,
  );
});
