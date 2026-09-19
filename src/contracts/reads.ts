import { z } from 'zod';
import {
  ChainKeySchema,
  UIntStringSchema,
  ContractDaySchema,
  TimestampSchema,
  BlockRefSchema,
  FinalitySchema,
  DecimalStringSchema,
  DailyHeadlineSchema,
  HomeResponseSchema,
  AddressResultSchema,
  LiveStakePageSchema,
} from './api.ts';
import { marketObservationSchema } from '../worker/daily/market.ts';
import { bundleSchema } from '../worker/exports/manifest.ts';

export const AddressSchema = z
  .string()
  .max(42)
  .regex(/^0x[0-9a-fA-F]{40}$/)
  .transform((s) => s.toLowerCase());
export const StakeIdSchema = z
  .string()
  .max(13)
  .regex(/^(0|[1-9][0-9]*)$/)
  .pipe(z.string().refine((s) => BigInt(s) < 1n << 40n));
export const CursorSchema = z
  .string()
  .min(1)
  .max(2048)
  .regex(/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/);
export const ChainQuery = z.strictObject({ chain: ChainKeySchema.default('pulsechain') });
const page = {
  limit: z.coerce.number().int().min(1).max(100).default(50),
  cursor: CursorSchema.optional(),
};
export const StakesQuery = ChainQuery.extend({ ...page, address: AddressSchema.optional() });
export const HoldersQuery = ChainQuery.extend({
  ...page,
  order: z.enum(['liquid', 'staker']).default('liquid'),
});
export const AddressQuery = ChainQuery.extend({ ...page });
export const StakeQuery = ChainQuery.extend({ address: AddressSchema.optional() });
export const RangeQuery = ChainQuery.extend({ from: z.iso.date(), to: z.iso.date() }).refine(
  (q) => {
    const a = Date.parse(q.from),
      b = Date.parse(q.to);
    return (
      a >= 1575331200000 &&
      b >= a &&
      b - a < 366 * 86400000 &&
      b <= 1575331200000 + 65535 * 86400000
    );
  },
  'Use a real, ordered range of at most 366 days within the protocol horizon.',
);
export const MarketQuery = RangeQuery.safeExtend({
  source: z
    .string()
    .max(64)
    .regex(/^[a-z][a-z0-9_-]*$/)
    .optional(),
});
export const CutoffSchema = z.strictObject({
  asOf: BlockRefSchema,
  revision: UIntStringSchema,
  finality: FinalitySchema,
  contractDay: ContractDaySchema,
});
const coverage = z.strictObject({
  fromDay: ContractDaySchema,
  toDay: ContractDaySchema,
  expected: z.number().int().min(1).max(366),
  count: z.number().int().min(0).max(366),
  missingDays: z.array(ContractDaySchema).max(366),
});
export const DailyRowSchema = DailyHeadlineSchema.safeExtend({
  originChainId: z.union([z.literal(1), z.literal(369)]),
  circulatingHearts: UIntStringSchema,
  lockedHearts: UIntStringSchema,
  rawShareRate: UIntStringSchema,
  payout: z.strictObject({
    status: z.enum(['pending', 'materialized']),
    payoutHearts: UIntStringSchema.nullable(),
    stakeShares: UIntStringSchema.nullable(),
    hexPerTShare: DecimalStringSchema.nullable(),
    blockNumber: UIntStringSchema.nullable(),
    blockHash: z
      .string()
      .regex(/^0x[0-9a-f]{64}$/)
      .nullable(),
  }),
});
export const DailyResponseSchema = z.strictObject({
  chain: ChainKeySchema,
  cutoff: CutoffSchema.nullable(),
  coverage,
  items: z.array(DailyRowSchema).max(366),
});
export const MarketSourceSchema = z.strictObject({
  source: z.string().max(64),
  method: z.enum(['sampled-ohlc', 'source-reported']),
  qualification: z.enum(['peg_assumed', 'source_reported_usd']),
  fromDay: ContractDaySchema,
  throughDay: ContractDaySchema.nullable(),
  dirtyDay: ContractDaySchema.nullable(),
  version: UIntStringSchema,
  captureStatus: z.enum(['ready', 'byte_pressure', 'capture_error']),
});
export const MarketResponseSchema = z.strictObject({
  chain: ChainKeySchema,
  sources: z.array(MarketSourceSchema).max(4),
  items: z
    .array(
      z.strictObject({
        source: z.string().max(64),
        contractDay: ContractDaySchema,
        displayDay: z.number().int().min(1).max(65536),
        dateUtc: z.iso.date(),
        state: z.enum(['accepted', 'pending_correction']),
        observation: marketObservationSchema,
      }),
    )
    .max(1464),
  coverage: z.array(coverage.extend({ source: z.string().max(64) })).max(4),
});
export const StakeSchema = z.strictObject({
  stakeId: StakeIdSchema,
  address: AddressSchema,
  originChainId: z.union([z.literal(1), z.literal(369)]),
  principalHearts: UIntStringSchema,
  stakeShares: UIntStringSchema,
  startDay: ContractDaySchema,
  lockedDay: ContractDaySchema,
  stakedDays: z.number().int().min(1).max(5555),
  maturityDay: ContractDaySchema,
  status: z.enum(['queued', 'open', 'mature_open', 'good_accounted', 'ended', 'cancelled']),
  isAutoStake: z.boolean(),
  startBlock: UIntStringSchema,
  startedAt: TimestampSchema,
  gaDay: ContractDaySchema.nullable(),
  gaBlock: UIntStringSchema.nullable(),
  gaOriginChainId: z.union([z.literal(1), z.literal(369)]).nullable(),
  goodAccountedAt: TimestampSchema.nullable(),
  endDay: ContractDaySchema.nullable(),
  endBlock: UIntStringSchema.nullable(),
  endOriginChainId: z.union([z.literal(1), z.literal(369)]).nullable(),
  endedAt: TimestampSchema.nullable(),
  payoutHearts: UIntStringSchema.nullable(),
  penaltyHearts: UIntStringSchema.nullable(),
});
export const StakesResponseSchema = z.strictObject({
  chain: ChainKeySchema,
  cutoff: CutoffSchema,
  items: z.array(StakeSchema).max(100),
  nextCursor: CursorSchema.nullable(),
});
export const HoldersResponseSchema = z.strictObject({
  chain: ChainKeySchema,
  cutoff: CutoffSchema,
  rankAsOf: BlockRefSchema,
  rankingDay: ContractDaySchema,
  order: z.enum(['liquid', 'staker']),
  items: z
    .array(
      z.strictObject({
        address: AddressSchema,
        liquidHearts: UIntStringSchema,
        accountedHearts: UIntStringSchema,
        stakeCount: UIntStringSchema,
        liquidRank: UIntStringSchema.nullable(),
        stakerRank: UIntStringSchema.nullable(),
      }),
    )
    .max(100),
  nextCursor: CursorSchema.nullable(),
});
export const StakeRecentSchema = z.strictObject({
  outcome: z.enum([
    'observed',
    'not_current_at_block',
    'indexing',
    'incompatible_owner',
    'unavailable',
    'quota',
    'absent',
  ]),
  live: LiveStakePageSchema.shape.items.element.nullable(),
  observation: BlockRefSchema.nullable(),
  observedAt: TimestampSchema.nullable(),
  expiresAt: TimestampSchema.nullable(),
  finality: z.literal('provisional'),
});
export const StakeResponseSchema = z.strictObject({
  chain: ChainKeySchema,
  cutoff: CutoffSchema.nullable(),
  indexed: StakeSchema.nullable(),
  recent: StakeRecentSchema,
});
// A mean of 365 rational values may require far more digits than uint256.
const rationalInteger = z
  .string()
  .max(30000)
  .regex(/^(0|[1-9][0-9]*)$/);
export const CalculatorResponseSchema = z.strictObject({
  chain: ChainKeySchema,
  calculationVersion: z.literal('hex-native-1'),
  shareRate: HomeResponseSchema.shape.live.shape.shareRate,
  presets: z
    .array(
      z.strictObject({
        window: z.union([z.literal(1), z.literal(30), z.literal(365)]),
        fromDay: z.number().int().min(-364).max(65535).nullable(),
        toDay: ContractDaySchema.nullable(),
        count: z.number().int().min(0).max(365),
        status: z.enum(['available', 'unavailable']),
        reason: z.enum(['missing_days', 'pending_days', 'zero_shares']).nullable(),
        value: z
          .strictObject({
            numerator: rationalInteger,
            denominator: rationalInteger,
            hexPerTShare: DecimalStringSchema,
          })
          .nullable(),
      }),
    )
    .length(3),
});
export const DownloadsResponseSchema = z.strictObject({
  status: z.enum(['available', 'rebuilding']),
  bundles: z.array(bundleSchema.safeExtend({ slot: z.enum(['current', 'prior']) })).max(2),
});
export { AddressResultSchema };
