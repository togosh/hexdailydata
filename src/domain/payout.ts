import { displayDay } from './day.ts';
import { payoutHexPerTShare, rational, UINT256_MAX, type Rational } from './units.ts';

export interface DailyPayout {
  contractDay: number;
  status: 'completed' | 'pending';
  payoutHearts: bigint | null;
  stakeShares: bigint | null;
}

export type PayoutPreset =
  | { status: 'available'; value: Rational; fromDay: number; toDay: number; count: number }
  | { status: 'unavailable'; value: null; reason: 'missing_days' | 'pending_days' | 'zero_shares' };

/** Consecutive completed days ending at the explicit ledger cutoff, not wall-clock yesterday. */
export function payoutPreset(
  rows: readonly DailyPayout[],
  window: 1 | 30 | 365,
  lastCompletedDay: number,
  currentDay: number,
): PayoutPreset {
  displayDay(lastCompletedDay);
  displayDay(currentDay);
  if (![1, 30, 365].includes(window) || lastCompletedDay >= currentDay || rows.length > window) {
    throw new RangeError('Invalid completed payout window.');
  }
  const fromDay = lastCompletedDay - window + 1;
  let previous = -1;
  for (const row of rows) {
    displayDay(row.contractDay);
    if (
      row.contractDay <= previous ||
      row.contractDay < fromDay ||
      row.contractDay > lastCompletedDay
    ) {
      throw new RangeError('Duplicate, unordered or out-of-range payout day.');
    }
    previous = row.contractDay;
    if (!['completed', 'pending'].includes(row.status))
      throw new TypeError('Invalid payout status.');
    for (const amount of [row.payoutHearts, row.stakeShares]) {
      if (amount !== null && (typeof amount !== 'bigint' || amount < 0n || amount > UINT256_MAX)) {
        throw new RangeError('Invalid payout amount.');
      }
    }
  }
  if (fromDay < 0 || rows.length !== window) {
    return { status: 'unavailable', value: null, reason: 'missing_days' };
  }
  let sum = rational(0n, 1n);
  for (const row of rows) {
    if (row.status !== 'completed' || row.payoutHearts === null || row.stakeShares === null) {
      return { status: 'unavailable', value: null, reason: 'pending_days' };
    }
    if (row.stakeShares === 0n)
      return { status: 'unavailable', value: null, reason: 'zero_shares' };
    const daily = payoutHexPerTShare(row.payoutHearts, row.stakeShares);
    sum = rational(
      sum.numerator * daily.denominator + daily.numerator * sum.denominator,
      sum.denominator * daily.denominator,
    );
  }
  return {
    status: 'available',
    value: rational(sum.numerator, sum.denominator * BigInt(window)),
    fromDay,
    toDay: lastCompletedDay,
    count: window,
  };
}
