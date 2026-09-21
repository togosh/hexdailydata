import { z } from 'zod';
import { ContractDaySchema, UIntStringSchema } from './api.ts';
import { ChainQuery, CutoffSchema } from './reads.ts';
import { historyLimit, historyMetadataSchema, tokenSchema } from './history.ts';

// Fixed columns keep a single multi-series response small; no caller-selected SQL/fields.
export const archiveChartFields = [
  'price',
  'payoutPerTshareHEX',
  'tshareRateHEX',
  'totalTshares',
  'stakedHEX',
  'stakedHEXPercent',
  'averageStakeLength',
  'currentStakerCount',
  'circulatingHEX',
  'penaltiesHEX',
  'currentHolders',
] as const;
export const nativeChartFields = [
  'payout',
  'rate',
  'locked',
  'percent',
  'duration',
  'stakers',
  'circulating',
  'holders',
  'starts',
  'ends',
  'penalties',
] as const;
const row = z.strictObject({
  day: ContractDaySchema,
  date: z.iso.date(),
  values: z.array(tokenSchema.nullable()).length(archiveChartFields.length),
});
export const ChartsQuery = ChainQuery.extend({
  chain: z.literal('pulsechain').default('pulsechain'),
});
export const ArchiveChartsSchema = z.strictObject({
  chain: z.literal('pulsechain'),
  source: z.literal('hexdailystats'),
  revision: z.uuid(),
  metadata: historyMetadataSchema,
  items: z.array(row).max(historyLimit),
});
export const NativeChartsSchema = z.strictObject({
  chain: z.literal('pulsechain'),
  source: z.literal('native'),
  cutoff: CutoffSchema,
  truncated: z.boolean(),
  items: z
    .array(
      row.extend({
        originChainId: z.union([z.literal(1), z.literal(369)]),
        values: z.array(tokenSchema.nullable()).length(nativeChartFields.length),
      }),
    )
    .max(historyLimit),
});
export const MaturitiesSchema = z.strictObject({
  chain: z.literal('pulsechain'),
  cutoff: CutoffSchema,
  items: z
    .array(
      z.strictObject({
        day: ContractDaySchema,
        date: z.iso.date(),
        principalHearts: UIntStringSchema,
        stakeShares: UIntStringSchema,
        count: UIntStringSchema,
      }),
    )
    .max(5556),
});
export type ArchiveCharts = z.infer<typeof ArchiveChartsSchema>;
export type NativeCharts = z.infer<typeof NativeChartsSchema>;
export type Maturities = z.infer<typeof MaturitiesSchema>;
