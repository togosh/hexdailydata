import { z } from 'zod';

// JSON magnitudes are decimal strings. Bounds are checked before BigInt conversion.
export const UIntStringSchema = z
  .string()
  .max(78)
  .regex(/^(0|[1-9][0-9]*)$/)
  .pipe(z.string().refine((value) => BigInt(value) <= (1n << 256n) - 1n, 'Exceeds uint256'));
export const DecimalStringSchema = z
  .string()
  .max(120)
  .regex(/^(0|[1-9][0-9]*)(\.[0-9]{1,36})?$/);
export const ContractDaySchema = z.number().int().min(0).max(65_535);
export const TimestampSchema = z.iso.datetime({ offset: false });
export const ChainKeySchema = z.enum(['pulsechain', 'ethereum']);
export const FinalitySchema = z.enum(['finalized', 'confirmed', 'provisional']);
export const BlockRefSchema = z.strictObject({
  chainId: z.union([z.literal(1), z.literal(369)]),
  blockNumber: UIntStringSchema,
  blockHash: z.string().regex(/^0x[0-9a-f]{64}$/),
  blockTimestamp: TimestampSchema,
});

export function observationSchema<T extends z.ZodType>(value: T) {
  const metadata = {
    finality: FinalitySchema,
    method: z.string().min(1).max(160),
    notes: z.array(z.string().min(1).max(500)).max(16),
  };
  return z
    .discriminatedUnion('status', [
      z.strictObject({
        ...metadata,
        status: z.enum(['fresh', 'stale']),
        value,
        asOf: BlockRefSchema,
        observedAt: TimestampSchema,
      }),
      z.strictObject({
        ...metadata,
        status: z.literal('unavailable'),
        value: z.null(),
        asOf: BlockRefSchema.nullable(),
        observedAt: TimestampSchema.nullable(),
        reason: z.string().min(1).max(160),
      }),
    ])
    .refine(
      (row) =>
        !row.asOf ||
        (row.observedAt !== null &&
          Date.parse(row.observedAt) >= Date.parse(row.asOf.blockTimestamp)),
      'Observation predates source block',
    );
}

export const PriceValueSchema = z.strictObject({
  usdPerHex: DecimalStringSchema,
  valuation: z.enum(['peg_assumed', 'independent_anchor']),
  kind: z.literal('spot_estimate'),
});
export const ShareRateValueSchema = z.strictObject({
  rawShareRate: UIntStringSchema.refine((value) => BigInt(value) > 0n),
  hexPerTShareBeforeBonuses: DecimalStringSchema,
});
export const PayoutValueSchema = z
  .strictObject({
    contractDay: ContractDaySchema,
    displayDay: z.number().int().min(1).max(65_536),
    hexPerTShare: DecimalStringSchema,
    payoutHearts: UIntStringSchema,
    stakeShares: UIntStringSchema.refine((value) => BigInt(value) > 0n),
    kind: z.enum(['completed', 'current_day_estimate']),
  })
  .refine(
    (value) => value.displayDay === value.contractDay + 1,
    'Display day must be contract day + 1',
  );
export const DailyHeadlineSchema = z
  .strictObject({
    dateUtc: z.iso.date(),
    contractDay: ContractDaySchema,
    displayDay: z.number().int().min(1).max(65_536),
    asOf: BlockRefSchema,
    stakedPercent: DecimalStringSchema,
    weightedStakeLengthDays: DecimalStringSchema.nullable(),
    circulatingHex: DecimalStringSchema,
    stakedHex: DecimalStringSchema,
    holderCount: UIntStringSchema,
    stakerCount: UIntStringSchema,
  })
  .refine((row) => row.displayDay === row.contractDay + 1, 'Display day must be contract day + 1');

const CompletedPayoutSchema = PayoutValueSchema.refine((value) => value.kind === 'completed');
const EstimatedPayoutSchema = PayoutValueSchema.refine(
  (value) => value.kind === 'current_day_estimate',
);
export const HomeResponseSchema = z
  .strictObject({
    schemaVersion: z.literal(1),
    chain: ChainKeySchema,
    mode: z.enum(['development', 'live']),
    daily: DailyHeadlineSchema.nullable(),
    live: z.strictObject({
      price: observationSchema(PriceValueSchema),
      shareRate: observationSchema(ShareRateValueSchema),
      latestCompletedPayout: observationSchema(CompletedPayoutSchema),
      todayPayoutEstimate: observationSchema(EstimatedPayoutSchema).refine(
        (row) => row.finality === 'provisional',
        'Today payout is always provisional',
      ),
    }),
    sync: z.strictObject({
      state: z.enum(['uninitialized', 'syncing', 'current', 'degraded']),
      message: z.string().max(500).nullable(),
    }),
  })
  .refine((home) => {
    const expected = home.chain === 'pulsechain' ? 369 : 1;
    // A serving PulseChain history may refer to its common Ethereum-era source.
    const allowed = (block: BlockRef | null) =>
      !block ||
      block.chainId === expected ||
      (expected === 369 && block.chainId === 1 && BigInt(block.blockNumber) <= 17_232_999n);
    return (
      allowed(home.daily?.asOf ?? null) &&
      Object.values(home.live).every((row) => allowed(row.asOf))
    );
  }, 'Source chain does not match serving history');

export const LiveStakePageSchema = z
  .strictObject({
    address: z.string().regex(/^0x[0-9a-f]{40}$/),
    asOf: BlockRefSchema,
    finality: z.literal('provisional'),
    observedAt: TimestampSchema,
    stakeCount: UIntStringSchema,
    items: z
      .array(
        z.strictObject({
          stakeId: UIntStringSchema,
          principalHearts: UIntStringSchema,
          stakeShares: UIntStringSchema,
          lockedDay: ContractDaySchema,
          stakedDays: z.number().int().min(1).max(5555),
          unlockedDay: ContractDaySchema,
          isAutoStake: z.boolean(),
        }),
      )
      .max(100),
    nextCursor: z.string().min(1).max(2048).nullable(),
    enumerationComplete: z.boolean(),
  })
  .refine(
    (page) =>
      BigInt(page.items.length) <= BigInt(page.stakeCount) &&
      (!page.enumerationComplete || page.nextCursor === null) &&
      Date.parse(page.observedAt) >= Date.parse(page.asOf.blockTimestamp) &&
      new Set(page.items.map((item) => item.stakeId)).size === page.items.length,
    'Inconsistent stake page',
  );
export const ApiErrorSchema = z.strictObject({
  error: z.strictObject({ code: z.string(), message: z.string(), retryable: z.boolean() }),
  requestId: z.string(),
});
export const StatusResponseSchema = z.strictObject({
  mode: z.literal('development'),
  chain: z.literal('pulsechain'),
  state: z.literal('uninitialized'),
  productionReady: z.literal(false),
  chainSyncImplemented: z.literal(false),
  liveProvidersEnabled: z.literal(false),
});

export type UIntString = z.infer<typeof UIntStringSchema>;
export type DecimalString = z.infer<typeof DecimalStringSchema>;
export type ChainKey = z.infer<typeof ChainKeySchema>;
export type Finality = z.infer<typeof FinalitySchema>;
export type BlockRef = z.infer<typeof BlockRefSchema>;
export type PriceValue = z.infer<typeof PriceValueSchema>;
export type ShareRateValue = z.infer<typeof ShareRateValueSchema>;
export type PayoutValue = z.infer<typeof PayoutValueSchema>;
export type DailyHeadline = z.infer<typeof DailyHeadlineSchema>;
export type HomeResponse = z.infer<typeof HomeResponseSchema>;
export type LiveStakePage = z.infer<typeof LiveStakePageSchema>;
export type ApiError = z.infer<typeof ApiErrorSchema>;
export type StatusResponse = z.infer<typeof StatusResponseSchema>;
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

export const IndexedAddressSchema = z.strictObject({
  asOf: BlockRefSchema,
  finality: z.enum(['confirmed', 'finalized']),
  liquidHearts: UIntStringSchema.nullable(),
  accountedHearts: UIntStringSchema.nullable(),
  stakeCount: UIntStringSchema.nullable(),
  rankingDay: ContractDaySchema.nullable(),
  // Task05 owns ranks. A live observation cannot fabricate one from this baseline.
  rank: z.null(),
});
export const AddressResultSchema = z.strictObject({
  outcome: z.enum(['available', 'partial', 'unavailable', 'expired', 'quota']),
  reason: z.string().max(160).nullable(),
  indexed: IndexedAddressSchema.nullable(),
  live: z
    .strictObject({
      balanceHearts: UIntStringSchema,
      page: LiveStakePageSchema,
      offset: UIntStringSchema,
      expiresAt: TimestampSchema,
    })
    .nullable(),
});
export type IndexedAddress = z.infer<typeof IndexedAddressSchema>;
export type AddressResult = z.infer<typeof AddressResultSchema>;
