import { z } from 'zod';
import { GenerationSelectionSchema } from './saved-generation.ts';
import { CursorSchema } from './reads.ts';
import { SourceToken, SourceStakeSnapshotSchema } from './source-stakes.ts';

export const HolderVersionSchema = z.string().regex(/^[0-9a-f]{64}$/);
const integer = z.string().max(180).regex(/^-?(?:0|[1-9][0-9]*)$/);
export const SourceHolderSchema = z.strictObject({
  id: z.string().max(256).regex(/^[A-Za-z0-9_.:-]+$/),
  numeralIndex: integer,
  holderAddress: z.string().regex(/^0x[0-9a-fA-F]{40}$/),
  totalSent: SourceToken,
  totalReceived: SourceToken,
  tokenBalance: SourceToken,
  createdTimeStamp: integer,
  createdBlocknumber: integer,
  createdHexDay: integer,
  lastModifiedHexDay: integer,
  lastModifiedTimeStamp: integer,
});
export const SourceHolderRecordSchema = z.strictObject({
  reported: SourceHolderSchema,
  anomaly: z.enum(['negative_reported_balance', 'zero_address_bookkeeping']).nullable(),
  provenance: z.strictObject({
    segment: z.enum(['HOLDER_R2', 'HOLDER_R3']),
    sourcePage: z.number().int().min(1).max(5598),
    sourceAttempt: z.number().int().min(1).max(16000),
    rowInPage: z.number().int().min(0).max(499),
    originalPageSha256: HolderVersionSchema,
  }),
});
export const SourceHolderTotalsSchema = z.strictObject({
  sourceRows: z.literal(664405),
  representedAddresses: z.literal(664405),
  sourcePositiveAddressCountExcludingZeroAddress: z.literal(380242),
  zeroBalanceRows: z.literal(284162),
  negativeBalanceRows: z.literal(1),
  zeroAddressRows: z.literal(1),
  duplicateAddressGroups: z.literal(0),
  duplicateNumeralGroups: z.literal(0),
  ambiguousAddressGroups: z.literal(0),
  sourceOnly: z.literal(true),
  balancesIndependentlyVerified: z.literal(false),
  sumsAreTotalSupply: z.literal(false),
  activeStakerCountAvailable: z.literal(false),
});
export const SourceHolderReplacementSchema = z.enum(['accepted', 'rejected', 'not_configured']);
export const SourceHoldersQuery = z.strictObject({
  generation: GenerationSelectionSchema.optional(),
  chain: z.literal('pulsechain').default('pulsechain'),
  source: z.literal('subgraph'),
  datasetVersion: HolderVersionSchema.optional(),
  order: z.literal('source-id-asc').default('source-id-asc'),
  limit: z.coerce.number().int().min(1).max(100).default(50),
  cursor: CursorSchema.optional(),
});
export const SourceHoldersResponseSchema = z.strictObject({
  chain: z.literal('pulsechain'),
  source: z.literal('subgraph'),
  datasetVersion: HolderVersionSchema,
  snapshot: SourceStakeSnapshotSchema,
  coverage: z.literal('complete_source_inventory_at_pin'),
  refreshEnabled: z.literal(false),
  order: z.literal('source-id-asc'),
  totals: SourceHolderTotalsSchema,
  replacementStatus: SourceHolderReplacementSchema,
  items: z.array(SourceHolderRecordSchema).max(100),
  nextCursor: CursorSchema.nullable(),
});
const holderContext = {
  holderDatasetVersion: HolderVersionSchema,
  snapshot: SourceStakeSnapshotSchema,
  replacementStatus: SourceHolderReplacementSchema,
};
export const SourceHolderLookupSchema = z.discriminatedUnion('state', [
  z.strictObject({ ...holderContext, state: z.literal('present_in_saved_inventory'), item: SourceHolderRecordSchema, reason: z.null() }),
  z.strictObject({ ...holderContext, state: z.literal('source_anomaly'), item: SourceHolderRecordSchema, reason: z.enum(['negative_reported_balance', 'zero_address_bookkeeping']) }),
  z.strictObject({ ...holderContext, state: z.literal('not_present_in_saved_inventory'), item: z.null(), reason: z.null() }),
  z.strictObject({ state: z.literal('unavailable'), holderDatasetVersion: z.null(), snapshot: z.null(), replacementStatus: SourceHolderReplacementSchema,
    item: z.null(), reason: z.enum(['not_configured', 'reader_unavailable']) }),
]);
export const SourceLiquidBalanceSchema = z.strictObject({
  sourceToken: SourceToken,
  // A decimal shift can add eight leading fractional places to a 180-character token.
  sourceReportedHex: z.string().max(190).regex(/^-?(?:0|[1-9][0-9]*)(?:\.[0-9]+)?$/),
  attribution: z.literal('source_reported_at_saved_pin'),
});
export type SourceHolderRecord = z.infer<typeof SourceHolderRecordSchema>;
export type SourceHolderLookup = z.infer<typeof SourceHolderLookupSchema>;

export function holderAnomaly(token: string, address: string): SourceHolderRecord['anomaly'] {
  SourceToken.parse(token);
  if (token.startsWith('-') && /[1-9]/.test(token)) return 'negative_reported_balance';
  return /^0x0{40}$/i.test(address) ? 'zero_address_bookkeeping' : null;
}
