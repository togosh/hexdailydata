import { z } from 'zod';
import { ProtocolReadingSchema, LedgerSegmentSchema } from './protocol-daily.ts';
import { contractDayAt } from '../domain/day.ts';
import { AddressSchema, CursorSchema } from './reads.ts';

export const productSchemaVersion = 'daily-product-1' as const;
export const productMetrics = {
  circulatingHEX: ['Circulating HEX', 'HEX', 'snapshot'],
  stakedHEX: ['Locked principal', 'HEX', 'snapshot'],
  stakedHEXGA: ['Good-accounted locked principal', 'HEX', 'snapshot'],
  totalHEX: ['Circulating plus locked HEX', 'HEX', 'snapshot'],
  tshareRateHEX: ['T-share rate before bonuses', 'HEX/T-share', 'snapshot'],
  totalTshares: ['Recorded total T-shares', 'T-shares', 'snapshot'],
  dailyPayoutHEX: ['Daily payout', 'HEX', 'daily-total'],
  payoutPerTshareHEX: ['Payout per T-share', 'HEX/T-share', 'daily-total'],
  payoutHearts: ['Daily payout hearts', 'hearts', 'daily-total'],
  payoutStakeShares: ['Daily payout denominator', 'shares', 'daily-total'],
  estimatedPenaltiesHEX: ['Estimated penalties', 'HEX', 'held'],
  simpleAnnualizedPayoutRatePercent: ['Simple annualized payout rate', '%', 'held'],
  averageStakeLengthYears: ['Weighted original stake duration', '365-day years', 'snapshot'],
  stakedHEXPercent: ['Locked share of circulating plus locked HEX', '%', 'snapshot'],
  currentHolders: ['Reported positive-balance addresses', 'addresses', 'snapshot'],
  holderIndexMaximum: ['Maximum holder index (proxy)', 'source index', 'snapshot'],
  unendedUnaccountedStakerAddresses: ['Addresses without end/GA links', 'addresses', 'snapshot'],
  historicalStakerAddresses: ['Historical stake-owner addresses', 'addresses', 'snapshot'],
  circulatingSupplyChange: ['Change in circulating HEX', 'HEX', 'change'],
  stakedSupplyChange: ['Change in locked HEX', 'HEX', 'change'],
  stakedHEXGAChange: ['Change in good-accounted HEX', 'HEX', 'change'],
  totalTsharesChange: ['Change in recorded T-shares', 'T-shares', 'change'],
  currentHoldersChange: ['Change in positive-balance addresses', 'addresses', 'change'],
  holderIndexMaximumChange: ['Change in holder-index proxy', 'source index', 'change'],
  unendedUnaccountedStakerAddressesChange: [
    'Change in addresses without end/GA',
    'addresses',
    'change',
  ],
  historicalStakerAddressesChange: [
    'Change in historical stake-owner addresses',
    'addresses',
    'change',
  ],
  tshareRateChangeHEX: ['Change in T-share rate', 'HEX/T-share', 'change'],
  stakedHEXPercentChange: ['Change in locked percentage', 'percentage points', 'change'],
  netTotalSupplyChangeHEX: ['Net change in circulating plus locked HEX', 'HEX', 'change'],
  hexPriceUsd: ['HEX reference price', 'USD/HEX', 'reference-price'],
  btcPriceUsd: ['Bitcoin price', 'USD/BTC', 'market'],
  ethPriceUsd: ['Ethereum price', 'USD/ETH', 'market'],
  plsPriceUsd: ['PulseChain price', 'USD/PLS', 'market'],
  trackedLiquidityUsd: ['Tracked HEX liquidity (USD estimate)', 'USD', 'liquidity'],
  gasPriceWei: ['Suggested gas price', 'PulseChain smallest units/gas', 'gas'],
  baseFeeWei: ['Mined contextual base fee', 'PulseChain smallest units/gas', 'gas'],
  priorityFeeWei: ['Suggested priority fee', 'PulseChain smallest units/gas', 'gas'],
} as const;
export type ProductMetric = keyof typeof productMetrics;
export const metricKeys = Object.keys(productMetrics) as ProductMetric[];
export const ProductMetricSchema = z.enum(metricKeys);
export const precise = z
  .string()
  .max(160)
  .regex(/^-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?$/);
export const digest = z.string().regex(/^[0-9a-f]{64}$/);
export const utc = z.iso.datetime({ offset: true });
export const metricShape = Object.fromEntries(
  metricKeys.map((k) => [k, precise.nullable()]),
) as Record<ProductMetric, z.ZodNullable<typeof precise>>;
export const ProductRowSchema = z
  .strictObject({
    contractDay: z.number().int().min(0).max(65535),
    dateUtc: z.iso.date(),
    snapshotRecordedAtUtc: utc.nullable(),
    priceRecordedAtUtc: utc.nullable(),
    btcRecordedAtUtc: utc.nullable(),
    ethRecordedAtUtc: utc.nullable(),
    plsRecordedAtUtc: utc.nullable(),
    gasRecordedAtUtc: utc.nullable(),
    liquidityRecordedAtUtc: utc.nullable(),
    priceEra: z.enum(['ethereum-origin', 'pulsechain']).nullable(),
    ...metricShape,
  })
  .refine(
    (r) =>
      Date.parse(r.dateUtc) >= 1575331200000 &&
      Date.parse(r.dateUtc) <= 1575331200000 + 65535 * 86400000 &&
      contractDayAt(BigInt(Date.parse(r.dateUtc) / 1000)) === r.contractDay,
    'Day/date mismatch',
  );
export type ProductRow = z.infer<typeof ProductRowSchema>;
export const ProductQuery = z
  .strictObject({
    chain: z.literal('pulsechain').default('pulsechain'),
    from: z.iso.date(),
    to: z.iso.date(),
    metric: ProductMetricSchema.optional(),
    asset: z.enum(['HEX', 'BTC', 'ETH', 'PLS']).optional(),
    limit: z
      .string()
      .regex(/^(?:[1-9]\d?|100)$/)
      .transform(Number)
      .default(100),
    cursor: CursorSchema.optional(),
  })
  .refine(
    (q) =>
      Date.parse(q.from) >= 1575331200000 &&
      Date.parse(q.to) >= Date.parse(q.from) &&
      Date.parse(q.to) - Date.parse(q.from) < 366 * 86400000 &&
      Date.parse(q.to) <= 1575331200000 + 65535 * 86400000,
    'An ordered range of at most 366 UTC days is required',
  );
export type ProductQueryValue = z.infer<typeof ProductQuery>;
export const ProductLatestQuery = z.strictObject({
  chain: z.literal('pulsechain').default('pulsechain'),
});
export const ProductPageQuery = z.strictObject({
  chain: z.literal('pulsechain').default('pulsechain'),
  limit: z
    .string()
    .regex(/^(?:[1-9]\d?|100)$/)
    .transform(Number)
    .default(50),
  cursor: CursorSchema.optional(),
  order: z.literal('source-id-asc').optional(),
});
export const ProductLookupQuery = ProductPageQuery.extend({ address: AddressSchema.optional() });
export const ProductStakeQuery = z.strictObject({
  chain: z.literal('pulsechain').default('pulsechain'),
  address: AddressSchema.optional(),
});
export const PairSchema = z.strictObject({
  generation: digest,
  holderDatasetVersion: digest,
  stakeDatasetVersion: digest,
  baseObservedAtUtc: utc,
  observedAtUtc: utc,
  coverage: z.literal('accepted_base_plus_observed_updates'),
  holderRecordCount: z.number().int().nonnegative(),
  stakeStartRecordCount: z.number().int().nonnegative(),
});
export type ProductPair = z.infer<typeof PairSchema>;
export const marketMethodRevision = 'pulsex-four-pool-derived-usd-2' as const;
export const reserveBasedPools = [
  { address: '0x19bb45a7270177e303dee6eaa6f5ad700812ba98', venue: 1 },
  { address: '0x6f1747370b1cacb911ad6d4477b718633db328c8', venue: 0 },
  { address: '0xc475332e92561cd58f278e4e2ed76c17d5b50f05', venue: 1 },
  { address: '0xf1f4ee610b2babb05c635f726ef8b0c568c8dc65', venue: 0 },
] as const;
export const LiquidityMeasureSchema = z.enum([
  'two-sided source reserveUSD estimate',
  'reserve-based source-derived USD estimate',
]);
export const TrackedSetSchema = z.strictObject({
  id: digest,
  measure: LiquidityMeasureSchema,
  methodRevision: z.literal(marketMethodRevision).optional(),
  coverage: z.literal('bounded contemporary HEX-pool cohort'),
  pools: z
    .array(
      z.strictObject({
        address: AddressSchema,
        dex: z.literal('PulseX'),
        version: z.enum(['V1', 'V2']),
        valueUsd: precise,
      }),
    )
    .min(1)
    .max(12),
});
export const LiquidityBucketSchema = z.strictObject({
  dateUtc: z.iso.date(),
  value: precise.nullable(),
  setId: digest,
  meaning: z.literal('source UTC-day bucket, not a verified close'),
});
export const ReadingSchema = z.discriminatedUnion('kind', [
  ProtocolReadingSchema,
  z.strictObject({
    kind: z.literal('market'),
    asset: z.enum(['HEX', 'BTC', 'ETH', 'PLS']),
    quote: z.literal('USD'),
    observation: z.literal('spot'),
    chainId: z.literal(369).optional(),
    value: precise,
    observedAtUtc: utc,
  }),
  z.strictObject({
    kind: z.literal('gas'),
    chainId: z.literal(369),
    unit: z.literal('wei/gas'),
    gasPriceWei: precise,
    baseFeeWei: precise.nullable(),
    priorityFeeWei: precise.nullable(),
    observedAtUtc: utc,
  }),
  z.strictObject({
    kind: z.literal('liquidity'),
    chainId: z.literal(369),
    poolAddress: AddressSchema,
    dex: z.string().min(1).max(40),
    version: z.string().min(1).max(40),
    quote: z.literal('USD'),
    value: precise,
    observedAtUtc: utc,
  }),
  z.strictObject({
    kind: z.literal('tracked-liquidity'),
    chainId: z.literal(369),
    quote: z.literal('USD'),
    value: precise,
    observedAtUtc: utc,
    set: TrackedSetSchema,
  }),
]);
export type ProductReading = z.infer<typeof ReadingSchema>;
export const ProductMetadataSchema = z.strictObject({
  schemaVersion: z.literal(productSchemaVersion),
  methodRevision: z.literal('utc-recorded-snapshot-primary-price-1'),
  inputHashes: z.record(z.string(), digest),
  pair: PairSchema,
  ledgerObservedAtUtc: utc,
  ledgerSegments: z.array(LedgerSegmentSchema).max(10000).optional(),
  from: z.iso.date(),
  through: z.iso.date(),
  rows: z.number().int().min(1).max(65536),
  effectiveAtUtc: utc,
  readings: z.array(ReadingSchema).max(8),
  observations: z.array(ReadingSchema).max(4096).optional(),
  // Internal storage only. Public Daily/Live/CSV contracts do not expose this.
  marketStorage: z
    .strictObject({
      format: z.literal('market-journal-1'),
      seedVersion: digest,
      seedMetadataSha256: digest,
      sequence: z.number().int().min(0).max(1000000),
      head: digest,
      checkpoints: z.array(ReadingSchema).max(60006),
    })
    .optional(),
  liquidityHistory: z.array(LiquidityBucketSchema).max(4096).optional(),
  coverage: z.strictObject({
    snapshotDates: z.number().int().nonnegative(),
    ledgerDates: z.number().int().nonnegative(),
    priceDates: z.number().int().nonnegative(),
    structuralDates: z.number().int().nonnegative(),
    gaps: z
      .array(z.strictObject({ field: z.string(), from: z.iso.date(), to: z.iso.date() }))
      .max(10000),
  }),
  priceSegments: z
    .array(
      z.strictObject({
        era: z.enum(['ethereum-origin', 'pulsechain']),
        from: z.iso.date(),
        to: z.iso.date(),
      }),
    )
    .max(2),
  methods: z.array(z.string()).max(20),
  credits: z.string(),
});
export type ProductMetadata = z.infer<typeof ProductMetadataSchema>;
export const ProductDailyResponseSchema = z.strictObject({
  schemaVersion: z.literal(productSchemaVersion),
  datasetVersion: digest,
  chain: z.literal('pulsechain'),
  from: z.iso.date(),
  to: z.iso.date(),
  metric: ProductMetricSchema.nullable(),
  asset: z.enum(['HEX', 'BTC', 'ETH', 'PLS']).nullable(),
  units: z.record(z.string(), z.string()),
  coverage: ProductMetadataSchema.shape.coverage,
  priceSegments: ProductMetadataSchema.shape.priceSegments,
  methods: ProductMetadataSchema.shape.methods,
  credits: z.string(),
  items: z.array(ProductRowSchema).max(100),
  nextCursor: CursorSchema.nullable(),
});
export const freshnessSchema = z.strictObject({
  status: z.enum(['fresh', 'stale', 'unavailable']),
  observedAtUtc: utc.nullable(),
  baseObservedAtUtc: utc.nullable(),
  ageSeconds: z.number().nonnegative().nullable(),
  staleAfterSeconds: z.number().positive(),
  reason: z.string(),
});
export const ProductLiveResponseSchema = z.strictObject({
  schemaVersion: z.literal(productSchemaVersion),
  datasetVersion: digest,
  chain: z.literal('pulsechain'),
  servedAtUtc: utc,
  hexPriceUsd: precise.nullable(),
  btcPriceUsd: precise.nullable(),
  ethPriceUsd: precise.nullable(),
  plsPriceUsd: precise.nullable(),
  trackedLiquidityUsd: precise.nullable(),
  gasPriceWei: precise.nullable(),
  baseFeeWei: precise.nullable(),
  priorityFeeWei: precise.nullable(),
  tshareRateHEX: precise.nullable(),
  currentDayPayoutHEX: precise.nullable(),
  circulatingHEX: precise.nullable(),
  lockedPrincipalHEX: precise.nullable(),
  totalHEX: precise.nullable(),
  activeTshares: precise.nullable(),
  queuedTshares: precise.nullable(),
  latestMaterializedPayout: z
    .strictObject({
      contractDay: z.number().int().nonnegative(),
      dateUtc: z.iso.date(),
      dailyPayoutHEX: precise,
      payoutPerTshareHEX: precise.nullable(),
      observedAtUtc: utc,
    })
    .nullable(),
  savedHolderRecordCount: z.number().int().nonnegative(),
  savedStakeStartRecordCount: z.number().int().nonnegative(),
  positiveBalanceAddressCount: z.null(),
  activeStakerCount: z.null(),
  coverage: z.literal('accepted_base_plus_observed_updates'),
  freshness: z.record(z.string(), freshnessSchema),
  pool: z
    .object({
      chainId: z.literal(369),
      address: AddressSchema,
      dex: z.string(),
      version: z.string(),
    })
    .nullable(),
  trackedSet: z
    .strictObject({
      id: digest,
      poolCount: z.number().int().min(1).max(12),
      measure: LiquidityMeasureSchema,
      methodRevision: z.literal(marketMethodRevision).optional(),
      coverage: z.literal('bounded contemporary HEX-pool cohort'),
    })
    .nullable()
    .optional(),
});
export const ProductHomeResponseSchema = z.strictObject({
  schemaVersion: z.literal(productSchemaVersion),
  datasetVersion: digest,
  chain: z.literal('pulsechain'),
  daily: ProductRowSchema,
  dailyThroughDateUtc: z.iso.date(),
  live: ProductLiveResponseSchema,
  methods: z.array(z.string()),
  credits: z.string(),
  liquidityHistory: z
    .array(z.strictObject({ dateUtc: z.iso.date(), value: precise.nullable() }))
    .max(90)
    .optional(),
});
export const ProductDownloadsSchema = z.strictObject({
  status: z.literal('release_gated'),
  datasetVersion: digest,
  reason: z.string(),
  datasets: z.array(z.literal('daily')),
});
