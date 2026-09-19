import { displayDay, newStakeTiming } from './day.ts';
import { rational, UINT256_MAX, type Rational } from './units.ts';

export type StakeStatus =
  'queued' | 'open' | 'mature_open' | 'good_accounted' | 'ended' | 'cancelled';
export interface Settlement {
  day: number;
  payoutHearts: bigint;
  penaltyHearts: bigint;
}
export interface Stake {
  startDay: number;
  lockedDay: number;
  stakedDays: number;
  principalHearts: bigint;
  stakeShares: bigint;
  isAutoStake: boolean;
  goodAccounting: Settlement | null;
  end: Settlement | null;
}

function unsigned(value: bigint, positive = false) {
  if (typeof value !== 'bigint' || value < (positive ? 1n : 0n) || value > UINT256_MAX) {
    throw new RangeError('Invalid unsigned stake amount.');
  }
}

export function createStake(input: {
  startSeconds: bigint;
  stakedDays: number;
  principalHearts: bigint;
  stakeShares: bigint;
  isAutoStake: boolean;
}): Stake {
  unsigned(input.principalHearts, true);
  unsigned(input.stakeShares, true);
  if (typeof input.isAutoStake !== 'boolean') throw new TypeError('Invalid auto-stake flag.');
  if (input.isAutoStake && input.stakedDays < 350)
    throw new RangeError('Auto-stake term is at least 350 days.');
  const timing = newStakeTiming(input.startSeconds, input.stakedDays);
  if (input.isAutoStake && (timing.transactionDay < 1 || timing.transactionDay >= 351)) {
    throw new RangeError('Auto-stakes originate only in the historical claim phase.');
  }
  return {
    startDay: timing.transactionDay,
    lockedDay: timing.lockedDay,
    stakedDays: input.stakedDays,
    principalHearts: input.principalHearts,
    stakeShares: input.stakeShares,
    isAutoStake: input.isAutoStake,
    goodAccounting: null,
    end: null,
  };
}

/** Typed states come from createStake/settleStake or a validated ingestion boundary. */
export function stakeStatus(stake: Stake, day: number): StakeStatus {
  displayDay(day);
  if (
    day < stake.startDay ||
    (stake.goodAccounting && day < stake.goodAccounting.day) ||
    (stake.end && day < stake.end.day)
  )
    throw new RangeError('Cannot query a state before its events.');
  if (stake.end) return stake.end.day < stake.lockedDay ? 'cancelled' : 'ended';
  if (stake.goodAccounting) return 'good_accounted';
  if (day < stake.lockedDay) return 'queued';
  return day < stake.lockedDay + stake.stakedDays ? 'open' : 'mature_open';
}

export const metricIncludes = {
  lockedPrincipal: (status: StakeStatus) =>
    ['queued', 'open', 'mature_open', 'good_accounted'].includes(status),
  accountedShares: (status: StakeStatus) => status === 'open' || status === 'mature_open',
  accountedPrincipal: (status: StakeStatus) => ['queued', 'open', 'mature_open'].includes(status),
  scheduledMaturity: (status: StakeStatus) => status === 'queued' || status === 'open',
};

/** Original duration, principal weighted; queued stakes count, GA rows do not. */
export function weightedStakeLength(stakes: readonly Stake[], day: number): Rational | null {
  displayDay(day);
  let numerator = 0n;
  let denominator = 0n;
  for (const stake of stakes) {
    if (metricIncludes.accountedPrincipal(stakeStatus(stake, day))) {
      numerator += stake.principalHearts * BigInt(stake.stakedDays);
      denominator += stake.principalHearts;
    }
  }
  return denominator === 0n ? null : rational(numerator, denominator);
}

export function stakedPercent(circulatingHearts: bigint, lockedHearts: bigint): Rational | null {
  unsigned(circulatingHearts);
  unsigned(lockedHearts);
  const allocated = circulatingHearts + lockedHearts;
  return allocated === 0n ? null : rational(lockedHearts * 100n, allocated);
}

export type SettlementEvent = Settlement &
  ({ kind: 'good_accounting' } | { kind: 'end'; servedDays: number; prevUnlocked: boolean });

/** Event amounts are protocol evidence, not a penalty/payout estimator. Task02 persists effects.
 * GA settles reward/penalty once and removes accounted shares, but principal stays locked
 * until StakeEnd. Transfer events, including penalty beneficiaries, own supply changes.
 */
export function settleStake(stake: Stake, event: SettlementEvent) {
  const status = stakeStatus(stake, event.day);
  if (stake.end) throw new Error('Stake already ended.');
  unsigned(event.payoutHearts);
  unsigned(event.penaltyHearts);
  const servedDays = Math.min(Math.max(event.day - stake.lockedDay, 0), stake.stakedDays);
  if (event.kind === 'good_accounting') {
    if (status !== 'mature_open')
      throw new Error('Good accounting requires a mature, locked stake.');
  } else {
    if (
      typeof event.prevUnlocked !== 'boolean' ||
      event.prevUnlocked !== (stake.goodAccounting !== null)
    ) {
      throw new Error('StakeEnd prevUnlocked disagrees with prior accounting.');
    }
    if (event.servedDays !== servedDays)
      throw new Error('StakeEnd servedDays disagrees with timing.');
    if (stake.isAutoStake && servedDays < 350)
      throw new Error('Auto-stake has not served 350 days.');
    if (status === 'queued' && (event.payoutHearts !== 0n || event.penaltyHearts !== 0n)) {
      throw new Error('Pre-lock cancellation has no payout or penalty.');
    }
    if (
      stake.goodAccounting &&
      (event.payoutHearts !== stake.goodAccounting.payoutHearts ||
        event.penaltyHearts !== stake.goodAccounting.penaltyHearts)
    ) {
      throw new Error('StakeEnd must retain the prior GA settlement.');
    }
  }
  const firstSettlement = stake.goodAccounting === null;
  const grossReturn = stake.principalHearts + event.payoutHearts;
  const cappedPenalty = event.penaltyHearts > grossReturn ? grossReturn : event.penaltyHearts;
  const settlement = {
    day: event.day,
    payoutHearts: event.payoutHearts,
    penaltyHearts: event.penaltyHearts,
  };
  return {
    stake: {
      ...stake,
      ...(event.kind === 'good_accounting' ? { goodAccounting: settlement } : { end: settlement }),
    },
    effects: {
      lockedHeartsDelta: event.kind === 'end' ? -stake.principalHearts : 0n,
      accountedSharesDelta: metricIncludes.accountedShares(status) ? -stake.stakeShares : 0n,
      queuedSharesDelta: status === 'queued' ? -stake.stakeShares : 0n,
      payoutRecordedHearts: firstSettlement ? event.payoutHearts : 0n,
      penaltyRecordedHearts: firstSettlement ? cappedPenalty : 0n,
      stakerReturnHearts: event.kind === 'end' ? grossReturn - cappedPenalty : 0n,
    },
  };
}
