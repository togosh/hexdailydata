// Independent integer oracle. No estimator, fixture generator, SQL or production imports.
import assert from 'node:assert/strict';
// Cohorts are fixed by the address schedule declared BEFORE the run. Keep actual
// millisecond arrival buckets separately: OS timers can straddle a minute boundary.
export function ordinaryArrivalCohort(path) {
  assert.match(path, /^\/api\/v2\/addresses\/0x[0-9a-f]{40}$/);
  const index = Number(BigInt(path.split('/').at(-1)) - 1012000n);
  assert.ok(index >= 0 && index < 100, 'Address outside the predeclared ordinary cohort');
  return Math.floor(index / 10);
}
export const payoutInputs = {
  totalSupply: '901633645423948312402060',
  lockedHearts: '480030000000016000',
  stakeShares: '1750210024504908000',
  nextStakeShares: '0',
  stakePenalty: '0',
  basePayoutHearts: '89760392869430730732',
};
export function payoutOracle(inputs, pending) {
  const [s, l, a, n, p] = [
    'totalSupply',
    'lockedHearts',
    'stakeShares',
    'nextStakeShares',
    'stakePenalty',
  ].map((k) => BigInt(inputs[k]));
  const base = ((s + l) * 10000n) / 100448995n;
  assert.ok([l, a, n, p, a + n, base + p].every((v) => v >= 0n && v < 1n << 72n));
  return {
    payoutHearts: String(base + (pending ? 0n : p)),
    stakeShares: String(a + (pending ? n : 0n)),
    firstPendingPayout: pending ? String(base + p) : null,
  };
}
function ratio(payout, shares) {
  const scaled = (BigInt(payout) * 1000000000000n) / BigInt(shares);
  const text = scaled.toString().padStart(9, '0');
  return (text.slice(0, -8) + '.' + text.slice(-8)).replace(/\.?0+$/, '');
}
export function checkHome(home, startDay, now) {
  assert.equal(Object.keys(home.live).length, 4);
  for (const value of Object.values(home.live)) {
    assert.equal(value.status, 'fresh');
    assert.ok(Date.parse(value.observedAt) <= now && Date.parse(value.asOf.blockTimestamp) <= now);
    assert.ok(now - Date.parse(value.asOf.blockTimestamp) <= 120000);
    assert.equal(value.finality, 'provisional');
  }
  const today = home.live.todayPayoutEstimate.value;
  const expected = payoutOracle(payoutInputs, today.contractDay - (startDay + 54));
  assert.equal(today.payoutHearts, expected.payoutHearts);
  assert.equal(today.stakeShares, expected.stakeShares);
  assert.equal(today.hexPerTShare, ratio(expected.payoutHearts, expected.stakeShares));
  assert.equal(today.kind, 'current_day_estimate');
  const latest = home.live.latestCompletedPayout.value;
  assert.equal(latest.contractDay, startDay + 53);
  assert.equal(latest.payoutHearts, String((startDay + 54) * 100));
  assert.equal(latest.stakeShares, String((startDay + 54) * 50));
  assert.equal(latest.hexPerTShare, '20000');
  assert.equal(home.live.shareRate.value.rawShareRate, '100000');
  assert.equal(home.live.shareRate.value.hexPerTShareBeforeBonuses, '10000');
  assert.equal(home.live.price.value.usdPerHex, '25');
  return expected;
}
export function checkAddress(live, i, startDay, now) {
  assert.equal(live.balanceHearts, String(1000000000000n + BigInt(i) * 100000003n));
  const ids = [i, i + 500000].filter((n) => n % 10 >= 3 || n % 10 === 1);
  assert.equal(live.page.stakeCount, String(ids.length));
  assert.deepEqual(
    live.page.items,
    ids.map((n) => ({
      stakeId: String(1000000 + n),
      principalHearts: String(100000000000n + BigInt(n % 10000) * 100000000n),
      stakeShares: String(1000000000000n + BigInt(n % 10000) * 300000007n),
      lockedDay: startDay + 24 + (n % 10 === 1 ? -2 : n % 2),
      stakedDays: n % 10 === 1 ? 1 : 1 + (n % 5555),
      unlockedDay: n % 10 === 1 ? startDay + 24 : 0,
      isAutoStake: false,
    })),
  );
  assert.equal(live.page.enumerationComplete, true);
  assert.equal(live.page.nextCursor, null);
  assert.ok(Date.parse(live.expiresAt) > now);
  assert.ok(now - Date.parse(live.page.asOf.blockTimestamp) <= 60000);
  return true;
}
