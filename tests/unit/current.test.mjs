import test from 'node:test';
import assert from 'node:assert/strict';
import { estimateCurrentPayout } from '../../src/domain/current.ts';
import { decodeCurrent, decodeStake, decodeReserves } from '../../src/providers/live-abi.ts';
import { word } from '../../src/providers/abi.ts';
const base = {
  currentDay: 400,
  dailyDataCount: 400,
  totalSupply: 1004489950000n,
  lockedHearts: 0n,
  stakeShares: 100n,
  nextStakeShares: 50n,
  stakePenalty: 77n,
};
test('post-claim literal vectors: no pending, first pending penalty, next shares and multiple rounds without compounding', () => {
  assert.deepEqual(estimateCurrentPayout(base), {
    status: 'available',
    contractDay: 400,
    payoutHearts: 100000077n,
    stakeShares: 100n,
    pendingRounds: 0,
    firstPendingPayout: null,
  });
  for (const [dailyDataCount, pendingRounds] of [
    [399, 1],
    [397, 3],
  ])
    assert.deepEqual(estimateCurrentPayout({ ...base, dailyDataCount }), {
      status: 'available',
      contractDay: 400,
      payoutHearts: 100000000n,
      stakeShares: 150n,
      pendingRounds,
      firstPendingPayout: 100000077n,
    });
  // 100448995 * (10^12 + 1) + 10044, times 10000, leaves remainder 100440000.
  assert.equal(
    estimateCurrentPayout({ ...base, totalSupply: 100448995000100459039n, stakePenalty: 0n })
      .payoutHearts,
    10000000000010000n,
  );
  assert.equal(
    estimateCurrentPayout({ ...base, totalSupply: 0n, lockedHearts: 10044n, stakePenalty: 3n })
      .payoutHearts,
    3n,
  );
});
test('missing/unsafe/zero denominator and claim/BPD era are explicitly unavailable', () => {
  for (const input of [
    null,
    { ...base, dailyDataCount: 401 },
    { ...base, totalSupply: 1 },
    { ...base, stakeShares: 1n << 72n },
  ])
    assert.equal(estimateCurrentPayout(input).reason, 'unsafe_inputs');
  assert.equal(estimateCurrentPayout({ ...base, stakeShares: 0n }).reason, 'zero_shares');
  assert.equal(
    estimateCurrentPayout({ ...base, stakeShares: 0n, dailyDataCount: 399 }).stakeShares,
    50n,
  );
  for (const day of [0, 350, 351, 352])
    assert.equal(estimateCurrentPayout({ ...base, dailyDataCount: day }).reason, 'unsupported_era');
});
test('live ABI strict seven/thirteen words and width/boolean padding', () => {
  const good = [1099511627775n, 9007199254740993123n, 9007199254740993001n, 390, 365, 0, 1];
  assert.equal(decodeStake('0x' + good.map(word).join('')).principalHearts, '9007199254740993123');
  for (const [i, value] of [
    [0, 1n << 40n],
    [1, 1n << 72n],
    [3, 65536],
    [6, 2],
  ]) {
    const w = [...good];
    w[i] = value;
    assert.throws(() => decodeStake('0x' + w.map(word).join('')));
  }
  assert.throws(() => decodeStake('0x' + good.slice(1).map(word).join('')));
  assert.throws(() =>
    decodeCurrent('0x' + [0, 0, 1n << 40n, ...Array(10).fill(0)].map(word).join('')),
  );
  assert.throws(() => decodeReserves('0x' + [1n << 112n, 1, 0].map(word).join('')));
});
