import test from 'node:test';
import assert from 'node:assert/strict';
import {
  parseUnits,
  formatUnits,
  rational,
  displayRatio,
  payoutHexPerTShare,
  hexPerTShareBeforeBonuses,
  UINT256_MAX,
} from '../../src/domain/units.ts';
import {
  contractDayAt,
  displayDay,
  newStakeTiming,
  HEX_LAUNCH_SECONDS,
} from '../../src/domain/day.ts';
import { observationStatus } from '../../src/domain/freshness.ts';

test('exact amounts beyond Number safe integer', () => {
  const value = '1234567890123456789.12345678';
  assert.equal(formatUnits(parseUnits(value, 8), 8), value);
  assert.equal(parseUnits('0.00000001', 8), 1n);
  assert.equal(formatUnits(10n, 1), '1');
  assert.equal(formatUnits(0n, 8), '0');
});

test('unsafe forms and excess precision fail', () => {
  const invalid = ['1e6', '01', '-1', '1,000', ' 1', '1.', 'NaN', 'Infinity', '0.000000001'];
  for (const value of invalid) assert.throws(() => parseUnits(value, 8));
  assert.throws(() => parseUnits(String(UINT256_MAX + 1n), 0));
  assert.throws(() => parseUnits('1', 37));
});

test('ratios and explicit display truncation', () => {
  assert.deepEqual(rational(6n, 8n), { numerator: 3n, denominator: 4n });
  assert.deepEqual(rational(0n, 3n), { numerator: 0n, denominator: 1n });
  assert.equal(displayRatio(rational(1n, 3n), 8), '0.33333333');
  assert.throws(() => rational(1n, 0n));
});

test('payout and rate units', () => {
  // 100 HEX distributed over ten T-shares = 10 HEX per T-share.
  assert.equal(displayRatio(payoutHexPerTShare(10_000_000_000n, 10_000_000_000_000n)), '10');
  assert.equal(displayRatio(hexPerTShareBeforeBonuses(100_000n)), '10000');
  assert.throws(() => payoutHexPerTShare(1n, 0n));
});

test('day boundaries and one-based display', () => {
  assert.equal(contractDayAt(HEX_LAUNCH_SECONDS), 0);
  assert.equal(contractDayAt(HEX_LAUNCH_SECONDS + 86_399n), 0);
  assert.equal(contractDayAt(HEX_LAUNCH_SECONDS + 86_400n), 1);
  assert.equal(displayDay(0), 1);
  assert.throws(() => contractDayAt(HEX_LAUNCH_SECONDS - 1n));
});

test('new stake timing has launch floor and duration bound', () => {
  assert.equal(newStakeTiming(HEX_LAUNCH_SECONDS, 1).lockedDay, 2);
  const timing = newStakeTiming(HEX_LAUNCH_SECONDS + 1_000n * 86_400n, 5555);
  assert.equal(timing.lockedDay, 1001);
  assert.equal(timing.maturityDay, 6556);
  assert.throws(() => newStakeTiming(HEX_LAUNCH_SECONDS, 5556));
});

test('freshness follows source time, not poll time', () => {
  assert.equal(observationStatus(1000n, 1060n), 'fresh');
  assert.equal(observationStatus(1000n, 1200n), 'stale');
  assert.equal(observationStatus(1000n, 2801n), 'unavailable');
  assert.equal(observationStatus(1001n, 1000n), 'unavailable');
});
