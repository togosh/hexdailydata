import { z } from 'zod';

export const historyMapping = 'hds-pulsechain-record-date-1' as const;
export const historyLimit = 10000;
export const historyBytes = 16 * 1024 * 1024;
export const tokenSchema = z
  .string()
  .max(160)
  .regex(/^-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d{1,3})?$/);
const day = z.number().int().min(0).max(65535);
export const metricDefinitions = {
  circulatingHEX: { unit: 'HEX', meaning: 'Reported circulating supply' },
  stakedHEX: {
    unit: 'HEX',
    meaning: 'Reported locked principal, including good-accounted principal',
  },
  stakedHEXGA: { unit: 'HEX', meaning: 'Reported good-accounted principal subset' },
  totalHEX: {
    unit: 'HEX',
    meaning: 'Reported circulating plus locked total; not ERC20 totalSupply',
  },
  tshareRateHEX: { unit: 'HEX/T-share', meaning: 'Reported HEX per T-share; not raw shareRate' },
  totalTshares: { unit: 'T-share', meaning: 'Reported shares; not an exact ledger denominator' },
  dailyPayoutHEX: { unit: 'HEX', meaning: 'Reported payout; native materialization unproved' },
  payoutPerTshareHEX: { unit: 'HEX/T-share', meaning: 'Reported payout ratio' },
  penaltiesHEX: { unit: 'HEX', meaning: 'Reported source calculation; not an exact event total' },
  averageStakeLength: {
    unit: 'years (365 days)',
    meaning: 'Reported principal-weighted original duration',
  },
  stakedHEXPercent: { unit: 'percent', meaning: 'Reported locked / (circulating + locked)' },
  currentHolders: { unit: 'addresses', meaning: 'Reported current holders' },
  numberOfHolders: { unit: 'addresses', meaning: 'Reported historical-ever holders' },
  currentStakerCount: {
    unit: 'addresses',
    meaning: 'Reported current staker set; not stake records',
  },
  totalStakerCount: { unit: 'addresses', meaning: 'Reported historical staker set' },
  totalTsharesChange: {
    unit: 'T-share',
    meaning: 'Signed reported change from source predecessor',
  },
  currentHoldersChange: { unit: 'addresses', meaning: 'Signed reported current-holder change' },
  stakedSupplyChange: { unit: 'HEX', meaning: 'Signed reported locked-supply change' },
  circulatingSupplyChange: { unit: 'HEX', meaning: 'Signed reported circulating-supply change' },
} as const;
export type Metric = keyof typeof metricDefinitions;
export const metricNames = Object.keys(metricDefinitions) as Metric[];
export const availabilitySchema = z.enum([
  'available',
  'missing',
  'null',
  'sentinel',
  'negative',
  'zero_price',
  'skeleton',
  'era_unproved',
  'date_mismatch',
  'future_period',
  'copied_price',
  'selected_exclusion',
  'invalid_value',
]);
export const reportedValueSchema = z
  .strictObject({
    published: tokenSchema.nullable(),
    value: tokenSchema.nullable(),
    availability: availabilitySchema,
  })
  .refine((v) =>
    v.availability === 'available' ? v.value !== null && v.value === v.published : v.value === null,
  );
export const historyRowSchema = z.strictObject({
  sourceDay: day,
  sourceDayToken: tokenSchema,
  sourceDate: z.iso.datetime({ precision: 3 }),
  sourceRecordDateUtc: z.iso.date(),
  marketPeriodUtc: z.null(),
  dateRelationship: z.enum(['same_nominal_day', 'previous_nominal_day', 'delayed', 'unproved']),
  quality: z.enum(['reported', 'skeleton']),
  metrics: z.strictObject(
    Object.fromEntries(metricNames.map((k) => [k, reportedValueSchema])) as Record<
      Metric,
      typeof reportedValueSchema
    >,
  ),
  referencePriceUsd: reportedValueSchema,
});
export type HistoryRow = z.infer<typeof historyRowSchema>;
const digest = z.string().regex(/^[0-9a-f]{64}$/);
export const provenanceSchema = z
  .strictObject({
    kind: z.enum(['bounded-public-download', 'supplied-snapshot', 'synthetic-fixture']),
    chainId: z.literal(369),
    acquiredAt: z.iso.datetime(),
    statement: z.string().min(20).max(1024),
    url: z
      .enum([
        'https://hexdailystats.com/fulldatapulsechain',
        'https://hexstats.today/fulldatapulsechain',
      ])
      .nullable(),
  })
  .refine((p) => p.kind !== 'bounded-public-download' || p.url !== null);
export const selectionSchema = z
  .strictObject({
    source: z.literal('hexdailystats'),
    chainId: z.literal(369),
    mappingVersion: z.literal(historyMapping),
    sha256: digest,
    fromSourceDay: day,
    toSourceDay: day,
    fromDate: z.iso.date(),
    toDate: z.iso.date(),
    excludeSourceDays: z
      .array(z.strictObject({ sourceDay: day, reason: z.string().min(5).max(160) }))
      .max(100),
    excludePriceSourceDays: z
      .array(z.strictObject({ sourceDay: day, reason: z.string().min(5).max(160) }))
      .max(100),
    provenance: provenanceSchema,
  })
  .refine(
    (s) =>
      s.toSourceDay >= s.fromSourceDay &&
      s.toSourceDay - s.fromSourceDay < historyLimit &&
      s.toDate >= s.fromDate &&
      Date.parse(s.toDate) - Date.parse(s.fromDate) < historyLimit * 86400000 &&
      new Set(s.excludeSourceDays.map((e) => e.sourceDay)).size === s.excludeSourceDays.length &&
      s.excludeSourceDays.every(
        (e) => e.sourceDay >= s.fromSourceDay && e.sourceDay <= s.toSourceDay,
      ) &&
      new Set(s.excludePriceSourceDays.map((e) => e.sourceDay)).size ===
        s.excludePriceSourceDays.length &&
      s.excludePriceSourceDays.every(
        (e) => e.sourceDay >= s.fromSourceDay && e.sourceDay <= s.toSourceDay,
      ),
  );
export type HistorySelection = z.infer<typeof selectionSchema>;
export const summarySchema = z.strictObject({
  records: z.number().int().min(1).max(historyLimit),
  prices: z.number().int().min(0).max(historyLimit),
  firstRecordDateUtc: z.iso.date(),
  lastRecordDateUtc: z.iso.date(),
  firstAvailablePrice: z
    .strictObject({
      sourceDay: day,
      sourceRecordDateUtc: z.iso.date(),
      sourceDate: z.iso.datetime(),
    })
    .nullable(),
});
export const historyMetadataSchema = z.strictObject({
  selection: selectionSchema,
  summary: summarySchema,
  dateBasis: z.literal('sourceRecordDateUtc'),
  priceKind: z.literal('source_reported_daily_reference'),
  marketPeriod: z.literal('unproved'),
  contentSha256: digest,
});
export type HistoryMetadata = z.infer<typeof historyMetadataSchema>;
export const reportedHistoryResponseSchema = z.strictObject({
  chain: z.literal('pulsechain'),
  chainId: z.literal(369),
  source: z.literal('hexdailystats'),
  sourceReported: z.literal(true),
  revision: z.uuid(),
  metadata: historyMetadataSchema,
  fieldDefinitions: z.record(z.string(), z.strictObject({ unit: z.string(), meaning: z.string() })),
  coverage: z.strictObject({
    from: z.iso.date(),
    to: z.iso.date(),
    records: z.number().int().min(0).max(historyLimit),
    prices: z.number().int().min(0).max(historyLimit),
    missingRecordDates: z.array(z.iso.date()).max(366),
    missingPriceDates: z.array(z.iso.date()).max(366),
  }),
  items: z.array(historyRowSchema).max(64),
  continuation: z.strictObject({ afterSourceDay: day, revision: z.uuid() }).nullable(),
});
