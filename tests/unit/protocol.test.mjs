import test from 'node:test';
import assert from 'node:assert/strict';
import { newStakeTiming, dayStartSeconds, contractDayAt } from '../../src/domain/day.ts';
import { payoutPreset } from '../../src/domain/payout.ts';
import {
  createStake,
  stakeStatus,
  settleStake,
  metricIncludes,
  weightedStakeLength,
  stakedPercent,
} from '../../src/domain/stake.ts';

// Expected literals come from the protocol branches and hand arithmetic recorded in docs/data.md.
const stake = (options = {}) =>
  createStake({
    startSeconds: 1576195200n,
    stakedDays: 10,
    principalHearts: 100n,
    stakeShares: 50n,
    isAutoStake: false,
    ...options,
  });
const end = (day, servedDays, options = {}) => ({
  kind: 'end',
  day,
  servedDays,
  prevUnlocked: false,
  payoutHearts: 0n,
  penaltyHearts: 0n,
  ...options,
});

test('launch-day 0 and 1 floor at lock day 2; day 2 locks on 3', () => {
  for (const [seconds, lock] of [
    [1575331200n, 2],
    [1575417599n, 2],
    [1575417600n, 2],
    [1575504000n, 3],
  ]) {
    assert.equal(newStakeTiming(seconds, 1).lockedDay, lock);
  }
  assert.equal(dayStartSeconds(2), 1575504000n);
  assert.equal(contractDayAt(1575503999n), 1);
  for (const invalid of [0, -1, 1.5, NaN, 5556])
    assert.throws(() => newStakeTiming(1575331200n, invalid));
  assert.throws(() => newStakeTiming(dayStartSeconds(65535), 1));
});

test('before lockedDay is cancellation; on lockedDay is zero-served early end', () => {
  const queued = stake(); // day 10 transaction -> lockedDay 11
  assert.equal(stakeStatus(queued, 10), 'queued');
  const cancelled = settleStake(queued, end(10, 0));
  assert.equal(stakeStatus(cancelled.stake, 10), 'cancelled');
  assert.deepEqual(cancelled.effects, {
    lockedHeartsDelta: -100n,
    accountedSharesDelta: 0n,
    queuedSharesDelta: -50n,
    payoutRecordedHearts: 0n,
    penaltyRecordedHearts: 0n,
    stakerReturnHearts: 100n,
  });
  const early = settleStake(queued, end(11, 0, { penaltyHearts: 12n }));
  assert.equal(stakeStatus(early.stake, 11), 'ended');
  assert.equal(early.effects.accountedSharesDelta, -50n);
  assert.equal(early.effects.queuedSharesDelta, 0n);
  assert.equal(early.effects.stakerReturnHearts, 88n);
  assert.throws(() => settleStake(queued, end(10, 0, { payoutHearts: 1n })));
  assert.throws(() => settleStake(queued, end(11, 1)));
  assert.throws(() => settleStake(cancelled.stake, end(12, 1)));
});

test('GA then end removes shares and records settlement once, returns principal only on end', () => {
  const original = stake();
  assert.equal(stakeStatus(original, 21), 'mature_open');
  const ga = settleStake(original, {
    kind: 'good_accounting',
    day: 21,
    payoutHearts: 30n,
    penaltyHearts: 5n,
  });
  assert.equal(stakeStatus(ga.stake, 25), 'good_accounted');
  assert.deepEqual(ga.effects, {
    lockedHeartsDelta: 0n,
    accountedSharesDelta: -50n,
    queuedSharesDelta: 0n,
    payoutRecordedHearts: 30n,
    penaltyRecordedHearts: 5n,
    stakerReturnHearts: 0n,
  });
  const ended = settleStake(
    ga.stake,
    end(30, 10, { prevUnlocked: true, payoutHearts: 30n, penaltyHearts: 5n }),
  );
  assert.deepEqual(ended.effects, {
    lockedHeartsDelta: -100n,
    accountedSharesDelta: 0n,
    queuedSharesDelta: 0n,
    payoutRecordedHearts: 0n,
    penaltyRecordedHearts: 0n,
    stakerReturnHearts: 125n,
  });
  assert.equal(original.goodAccounting, null);
  assert.throws(() =>
    settleStake(original, {
      kind: 'good_accounting',
      day: 20,
      payoutHearts: 0n,
      penaltyHearts: 0n,
    }),
  );
  assert.throws(() =>
    settleStake(ga.stake, {
      kind: 'good_accounting',
      day: 25,
      payoutHearts: 0n,
      penaltyHearts: 0n,
    }),
  );
  assert.throws(() => settleStake(ga.stake, end(30, 10)));
  assert.throws(() =>
    settleStake(
      ga.stake,
      end(30, 10, { prevUnlocked: true, payoutHearts: 31n, penaltyHearts: 5n }),
    ),
  );
  const capped = settleStake(original, end(15, 4, { penaltyHearts: 200n, payoutHearts: 20n }));
  assert.equal(capped.effects.penaltyRecordedHearts, 120n);
  assert.equal(capped.effects.stakerReturnHearts, 0n);
});

test('auto-stake creation and served duration boundaries are distinct', () => {
  assert.throws(() => stake({ isAutoStake: true, stakedDays: 349 }));
  const auto = stake({ isAutoStake: true, stakedDays: 350 });
  assert.throws(() => settleStake(auto, end(10, 0)));
  assert.throws(() => settleStake(auto, end(360, 349)));
  assert.equal(stakeStatus(settleStake(auto, end(361, 350)).stake, 361), 'ended');
  const longer = stake({ isAutoStake: true, stakedDays: 5555 });
  assert.equal(settleStake(longer, end(361, 350)).effects.accountedSharesDelta, -50n);
  assert.throws(() =>
    stake({ isAutoStake: true, stakedDays: 350, startSeconds: dayStartSeconds(0) }),
  );
  assert.throws(() =>
    stake({ isAutoStake: true, stakedDays: 350, startSeconds: dayStartSeconds(351) }),
  );
  assert.equal(
    stake({ isAutoStake: true, stakedDays: 350, startSeconds: dayStartSeconds(350) }).lockedDay,
    351,
  );
});

test('metric inclusion sets and original principal-weighted duration remain distinct', () => {
  const statuses = ['queued', 'open', 'mature_open', 'good_accounted', 'ended', 'cancelled'];
  assert.deepEqual(statuses.filter(metricIncludes.lockedPrincipal), [
    'queued',
    'open',
    'mature_open',
    'good_accounted',
  ]);
  assert.deepEqual(statuses.filter(metricIncludes.accountedShares), ['open', 'mature_open']);
  assert.deepEqual(statuses.filter(metricIncludes.accountedPrincipal), [
    'queued',
    'open',
    'mature_open',
  ]);
  assert.deepEqual(statuses.filter(metricIncludes.scheduledMaturity), ['queued', 'open']);
  const mature = stake();
  const open = stake({ principalHearts: 300n, stakedDays: 30 });
  const queued = stake({ startSeconds: dayStartSeconds(21), principalHearts: 900n });
  const ga = settleStake(stake(), {
    kind: 'good_accounting',
    day: 21,
    payoutHearts: 0n,
    penaltyHearts: 0n,
  }).stake;
  assert.deepEqual(weightedStakeLength([mature, open, queued, ga], 21), {
    numerator: 190n,
    denominator: 13n,
  });
  assert.equal(weightedStakeLength([ga], 21), null);
  assert.deepEqual(stakedPercent(300n, 100n), { numerator: 25n, denominator: 1n });
  assert.equal(stakedPercent(0n, 0n), null);
});

const payoutRows = () =>
  Array.from({ length: 30 }, (_, index) => ({
    contractDay: index + 1,
    status: 'completed',
    payoutHearts: index < 15 ? 1n : 2n,
    stakeShares: index < 15 ? 30000n : 70000n,
  }));

test('30-day preset is exact mean of ratios: (1/3 + 2/7)/2 = 13/42, not 3/10', () => {
  assert.deepEqual(payoutPreset(payoutRows(), 30, 30, 31), {
    status: 'available',
    value: { numerator: 13n, denominator: 42n },
    fromDay: 1,
    toDay: 30,
    count: 30,
  });
  assert.deepEqual(
    payoutPreset(
      [{ contractDay: 5, status: 'completed', payoutHearts: 0n, stakeShares: 1n }],
      1,
      5,
      10,
    ).value,
    { numerator: 0n, denominator: 1n },
  );
});

test('missing, pending and zero-denominator payout days never become zero', () => {
  assert.equal(payoutPreset(payoutRows().slice(1), 30, 30, 31).reason, 'missing_days');
  for (const [change, reason] of [
    [{ stakeShares: 0n }, 'zero_shares'],
    [{ status: 'pending' }, 'pending_days'],
    [{ payoutHearts: null }, 'pending_days'],
  ]) {
    const rows = payoutRows();
    rows[9] = { ...rows[9], ...change };
    assert.deepEqual(payoutPreset(rows, 30, 30, 31), {
      status: 'unavailable',
      value: null,
      reason,
    });
  }
  const duplicate = payoutRows();
  duplicate[1] = duplicate[0];
  assert.throws(() => payoutPreset(duplicate, 30, 30, 31));
  assert.throws(() => payoutPreset(payoutRows(), 30, 30, 30));
  assert.throws(() => payoutPreset(payoutRows().reverse(), 30, 30, 31));
  assert.throws(() =>
    payoutPreset(
      [{ contractDay: 5, status: 'completed', payoutHearts: -1n, stakeShares: 1n }],
      1,
      5,
      6,
    ),
  );
});
