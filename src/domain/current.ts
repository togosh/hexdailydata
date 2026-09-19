import { displayDay } from './day.ts';
import { UINT256_MAX } from './units.ts';

export interface CurrentInputs {
  currentDay: number;
  dailyDataCount: number;
  totalSupply: bigint;
  lockedHearts: bigint;
  stakeShares: bigint;
  nextStakeShares: bigint;
  stakePenalty: bigint;
}
export type CurrentPayout =
  | { status: 'unavailable'; reason: 'unsafe_inputs' | 'unsupported_era' | 'zero_shares' }
  | {
      status: 'available';
      contractDay: number;
      payoutHearts: bigint;
      stakeShares: bigint;
      pendingRounds: number;
      firstPendingPayout: bigint | null;
    };

/** Post-BPD only. _dailyRoundCalc does not compound staker payouts into supply.
 * The first pending round consumes penalties BEFORE activating next shares.
 * No future transactions/penalties are predicted. See docs/live.md for source rules.
 */
export function estimateCurrentPayout(input: CurrentInputs | null): CurrentPayout {
  if (!input) return { status: 'unavailable', reason: 'unsafe_inputs' };
  const {
    currentDay,
    dailyDataCount,
    totalSupply,
    lockedHearts,
    stakeShares,
    nextStakeShares,
    stakePenalty,
  } = input;
  try {
    displayDay(currentDay);
    displayDay(dailyDataCount);
  } catch {
    return { status: 'unavailable', reason: 'unsafe_inputs' };
  }
  if (
    dailyDataCount > currentDay ||
    [totalSupply, lockedHearts, stakeShares, nextStakeShares, stakePenalty].some(
      (v) => typeof v !== 'bigint' || v < 0n || v > UINT256_MAX,
    ) ||
    [lockedHearts, stakeShares, nextStakeShares, stakePenalty].some((v) => v >= 1n << 72n) ||
    totalSupply + lockedHearts > UINT256_MAX / 10000n ||
    stakeShares + nextStakeShares >= 1n << 72n
  )
    return { status: 'unavailable', reason: 'unsafe_inputs' };
  if (currentDay <= 352 || dailyDataCount <= 352)
    return { status: 'unavailable', reason: 'unsupported_era' };
  const pendingRounds = currentDay - dailyDataCount;
  const base = ((totalSupply + lockedHearts) * 10000n) / 100448995n;
  if (base + stakePenalty >= 1n << 72n) return { status: 'unavailable', reason: 'unsafe_inputs' };
  const shares = stakeShares + (pendingRounds ? nextStakeShares : 0n);
  if (!shares) return { status: 'unavailable', reason: 'zero_shares' };
  return {
    status: 'available',
    contractDay: currentDay,
    payoutHearts: base + (pendingRounds ? 0n : stakePenalty),
    stakeShares: shares,
    pendingRounds,
    firstPendingPayout: pendingRounds ? base + stakePenalty : null,
  };
}
