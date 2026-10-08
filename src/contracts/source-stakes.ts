import { z } from 'zod';
import { GenerationSelectionSchema } from './saved-generation.ts';
import { AddressSchema, CursorSchema, StakeIdSchema } from './reads.ts';

export const SourceToken = z
  .string()
  .max(180)
  .regex(/^-?(?:0|[1-9][0-9]*)(?:\.[0-9]+)?$/);
const integer = z
  .string()
  .max(180)
  .regex(/^-?(?:0|[1-9][0-9]*)$/);
const entityId = z
  .string()
  .max(256)
  .regex(/^[A-Za-z0-9_.:-]+$/);
const sourceAddress = z.string().regex(/^0x[0-9a-fA-F]{40}$/);
const transaction = z.string().regex(/^0x[0-9a-fA-F]{64}$/);
const hash = z.string().regex(/^[0-9a-f]{64}$/);
const related = {
  id: entityId,
  stakerAddr: sourceAddress,
  stakeId: integer,
  data0: integer,
  data1: integer,
  payout: SourceToken,
  stakedHearts: SourceToken,
  stakedShares: SourceToken,
  timestamp: SourceToken,
  penalty: SourceToken,
  blockNumber: SourceToken,
  transactionHash: transaction,
};
export const SourceEndSchema = z.strictObject({
  ...related,
  servedDays: SourceToken,
  prevUnlocked: z.boolean(),
  daysLate: SourceToken,
  daysEarly: SourceToken,
});
export const SourceGASchema = z.strictObject(related);
export const SourceStartSchema = z.strictObject({
  id: entityId,
  stakerAddr: sourceAddress,
  stakeId: integer,
  data0: integer,
  timestamp: SourceToken,
  stakedHearts: SourceToken,
  stakeShares: SourceToken,
  stakedDays: SourceToken,
  isAutoStake: z.boolean(),
  stakeTShares: SourceToken,
  startDay: SourceToken,
  endDay: SourceToken,
  blockNumber: SourceToken,
  transactionHash: transaction,
  stakeEnd: SourceEndSchema.nullable(),
  stakeGoodAccounting: SourceGASchema.nullable(),
});
export const SourceRecordState = z.enum([
  'end_and_ga_link_present',
  'end_link_present',
  'ga_link_present',
  'no_end_or_ga_link',
]);
export const SourceDiscrepancySchema = z.strictObject({
  startId: entityId,
  page: z.number().int().min(1).max(1912),
  segment: z.enum(['R2', 'R3', 'R4']),
  sourcePage: z.number().int().min(1).max(1912),
  kind: z.literal('source_internal_disagreement'),
  entityId,
  field: z.string().max(40),
  published: z.union([SourceToken, z.boolean()]),
  decodedOrDerived: z.string().max(180),
});
export const SourceStakeRecordSchema = z.strictObject({
  reported: SourceStartSchema,
  recordState: SourceRecordState,
  provenance: z.strictObject({
    segment: z.enum(['R2', 'R3', 'R4']),
    sourcePage: z.number().int().min(1).max(1912),
    sourceAttempt: z.number().int().min(1).max(16000),
    rowInPage: z.number().int().min(0).max(499),
    originalPageSha256: hash,
  }),
  discrepancies: z.array(SourceDiscrepancySchema).max(32),
});
export const SourceStakeSnapshotSchema = z.strictObject({
  source: z.literal('pulsechain/hex'),
  deployment: z.literal('QmSsv8uvNLbfJCQARk7xd9iNouNmaoqZCrqEwRaFCHJMCw'),
  number: z.literal(27720851),
  hash: z.literal('0x8d7a9233e143884558511f15558a03d88567bc2255d63f670707ff45894b3fb8'),
  timestamp: z.literal(1791215285),
  observedAtUtc: z.literal('2026-10-05T15:48:05Z'),
});
const envelope = {
  chain: z.literal('pulsechain'),
  source: z.literal('subgraph'),
  datasetVersion: hash,
  snapshot: SourceStakeSnapshotSchema,
  coverage: z.literal('complete_source_inventory_at_pin'),
  refreshEnabled: z.literal(false),
  inventorySourceStartCount: z.literal(954680),
};
export const SourceStakesResponseSchema = z.strictObject({
  ...envelope,
  address: AddressSchema.nullable(),
  sourceStartCount: z.number().int().min(0).max(954680),
  items: z.array(SourceStakeRecordSchema).max(100),
  nextCursor: CursorSchema.nullable(),
});
export const SourceStakeResponseSchema = z.strictObject({
  ...envelope,
  reportedStakeId: StakeIdSchema,
  presence: z.enum(['present_in_saved_inventory', 'not_present_in_saved_inventory']),
  item: SourceStakeRecordSchema.nullable(),
});
export const SourceAddressResponseSchema = SourceStakesResponseSchema.extend({
  address: AddressSchema,
  liquidBalance: z.null(),
  ranks: z.null(),
});
const selection = {
  generation: GenerationSelectionSchema.optional(),
  chain: z.literal('pulsechain').default('pulsechain'),
  source: z.literal('subgraph'),
  datasetVersion: hash.optional(),
};
const page = {
  limit: z.coerce.number().int().min(1).max(100).default(50),
  cursor: CursorSchema.optional(),
};
// No canonical lifecycle/maturity/amount or link-state filtering is accepted.
export const SourceStakesQuery = z.strictObject({
  ...selection,
  ...page,
  address: AddressSchema.optional(),
});
export const SourceStakeQuery = z.strictObject({ ...selection, address: AddressSchema.optional() });
export const SourceAddressQuery = z.strictObject({ ...selection, ...page });
export type SourceStakeRecord = z.infer<typeof SourceStakeRecordSchema>;
export type SourceStart = z.infer<typeof SourceStartSchema>;

/** Decimal shift only: even fractional source hearts/shares never pass through Number. */
export function sourceUnits(value: string, decimals: 8 | 12): string {
  SourceToken.parse(value);
  const negative = value.startsWith('-');
  const [whole = '0', fraction = ''] = (negative ? value.slice(1) : value).split('.');
  const padded = whole.padStart(decimals + 1, '0');
  const integerPart = padded.slice(0, -decimals).replace(/^0+(?=\d)/, '');
  const fractionPart = (padded.slice(-decimals) + fraction).replace(/0+$/, '');
  const result = integerPart + (fractionPart ? '.' + fractionPart : '');
  return negative && result !== '0' ? '-' + result : result;
}
