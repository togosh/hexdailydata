/** Public contracts. Task 01 adds runtime boundary validation; JSON never contains BigInt. */
export type ChainKey = 'pulsechain' | 'ethereum';
export type UIntString = string;
export type DecimalString = string;
export type Finality = 'finalized' | 'confirmed' | 'provisional';

export interface BlockRef {
  chainId: 1 | 369;
  blockNumber: UIntString;
  blockHash: string;
  blockTimestamp: string; // ISO 8601 UTC; used to age current observations.
}

export type Observation<T> =
  | {
      status: 'fresh' | 'stale';
      value: T;
      asOf: BlockRef;
      observedAt: string;
      finality: Finality;
      method: string;
      notes: string[];
    }
  | {
      status: 'unavailable';
      value: null;
      asOf: BlockRef | null;
      observedAt: string | null;
      finality: Finality;
      method: string;
      notes: string[];
      reason: string;
    };

export interface PriceValue {
  usdPerHex: DecimalString;
  valuation: 'peg_assumed' | 'independent_anchor';
  kind: 'spot_estimate';
}

export interface ShareRateValue {
  rawShareRate: UIntString;
  hexPerTShareBeforeBonuses: DecimalString;
}

export interface PayoutValue {
  contractDay: number;
  displayDay: number;
  hexPerTShare: DecimalString;
  payoutHearts: UIntString;
  stakeShares: UIntString;
  kind: 'completed' | 'current_day_estimate';
}

export interface DailyHeadline {
  dateUtc: string;
  contractDay: number;
  displayDay: number;
  asOf: BlockRef;
  stakedPercent: DecimalString;
  weightedStakeLengthDays: DecimalString;
  circulatingHex: DecimalString;
  stakedHex: DecimalString;
  holderCount: UIntString;
  stakerCount: UIntString;
}

export interface HomeResponse {
  schemaVersion: 1;
  chain: ChainKey;
  mode: 'live' | 'demo';
  daily: DailyHeadline | null;
  live: {
    price: Observation<PriceValue>;
    shareRate: Observation<ShareRateValue>;
    latestCompletedPayout: Observation<PayoutValue>;
    todayPayoutEstimate: Observation<PayoutValue>;
  };
  sync: {
    state: 'syncing' | 'current' | 'degraded';
    message: string | null;
  };
}

export interface LiveStakePage {
  address: string;
  asOf: BlockRef;
  finality: 'provisional';
  observedAt: string;
  stakeCount: UIntString;
  items: Array<{
    stakeId: UIntString;
    principalHearts: UIntString;
    stakeShares: UIntString;
    lockedDay: number;
    stakedDays: number;
    unlockedDay: number;
    isAutoStake: boolean;
  }>;
  nextCursor: string | null;
  enumerationComplete: boolean;
}

export interface ApiError {
  error: {
    code: string;
    message: string;
    retryable: boolean;
  };
  requestId: string;
}
