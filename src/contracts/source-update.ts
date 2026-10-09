import { z } from 'zod';
import { AddressSchema, CursorSchema, StakeIdSchema } from './reads.ts';
import {
  SourceStartSchema,
  SourceStakeSnapshotSchema,
  SourceStakeRecordSchema,
  SourceRecordState,
  SourceDiscrepancySchema,
  SourceStakesResponseSchema,
  SourceStakeResponseSchema,
} from './source-stakes.ts';
import {
  SourceHolderSchema,
  SourceHolderRecordSchema,
  SourceHolderTotalsSchema,
  SourceHoldersResponseSchema,
  SourceLiquidBalanceSchema,
} from './source-holders.ts';
import { SourceAddressResponseSchema } from './source-address.ts';
import { ACCEPTED, TARGET_SNAPSHOT } from './saved-generation.ts';
import {
  ParticipantSnapshotSchema,
  ConsecutiveHolderUpdateSchema,
  ConsecutiveStakeUpdateSchema,
} from './participant-update.ts';

const hash = z.string().regex(/^[0-9a-f]{64}$/);
const integer = z.number().int().nonnegative().max(1600000);
const pin = (p: typeof ACCEPTED.base | typeof ACCEPTED.target) =>
  z.strictObject({
    number: z.literal(p.number),
    hash: z.literal(p.hash),
    timestamp: z.literal(p.timestamp),
  });
export const TargetSnapshotSchema = ParticipantSnapshotSchema;
const sourcePage = z.strictObject({
  segment: z.enum(['R2', 'R3', 'R4', 'HOLDER_R2', 'HOLDER_R3']),
  globalPage: integer,
  localPage: integer,
  sourceAttempt: integer,
  firstOrdinal: integer,
  count: z.number().int().min(0).max(500),
  path: z.string().regex(/^pages\/\d{5}\.ndjson$/),
  sha256: hash,
  receiptSha256: hash,
  requestSha256: hash,
  responseSha256: hash,
  part: z.string().regex(/^part-\d{3}\.zip$/),
});
const beforeProvenance = z.strictObject({
  baseDatasetVersion: hash,
  ordinal: integer,
  sourcePage,
  rowInPage: z.number().int().min(0).max(499),
  rowSha256: hash,
});
const capture = {
  segment: z.enum(['SCHEMA_RUN_R1', 'CONTINUATION_R1']),
  attempt: integer,
  capture: z.string().regex(/^captures\/\d{5}\/capture\.json$/),
  responseSha256: hash,
};
const afterProvenance = z
  .array(
    z.union([
      z.strictObject({
        ...capture,
        family: z.enum(['tokenHolders', 'stakeStarts']),
        page: integer,
        row: integer,
      }),
      z.strictObject({ resolvedParent: z.strictObject({ ...capture, requestSha256: hash }) }),
    ]),
  )
  .min(1)
  .max(4);
const entry = {
  operation: z.literal('upsert'),
  id: z
    .string()
    .max(256)
    .regex(/^[A-Za-z0-9_.:-]+$/),
  kind: z.enum(['new', 'replacement', 'unchanged_overlap']),
  beforeProvenance: beforeProvenance.nullable(),
  afterProvenance,
  changedFields: z.array(z.string().max(40)).max(32),
};
export const HolderUpdateSchema = z.strictObject({
  ...entry,
  family: z.literal('tokenHolders'),
  before: SourceHolderSchema.nullable(),
  after: SourceHolderSchema,
});
export const StakeUpdateSchema = z.strictObject({
  ...entry,
  family: z.literal('stakeStarts'),
  before: SourceStartSchema.nullable(),
  after: SourceStartSchema,
});
const baseBindings = z.strictObject({
  tokenHolders: z.strictObject({
    datasetVersion: z.literal(ACCEPTED.baseBindings.tokenHolders.datasetVersion),
    manifestSha256: z.literal(ACCEPTED.baseBindings.tokenHolders.manifestSha256),
  }),
  stakeStarts: z.strictObject({
    datasetVersion: z.literal(ACCEPTED.baseBindings.stakeStarts.datasetVersion),
    manifestSha256: z.literal(ACCEPTED.baseBindings.stakeStarts.manifestSha256),
  }),
});
export const FamilyVersionsSchema = z.strictObject({
  tokenHolders: z.literal(ACCEPTED.familyVersions.tokenHolders),
  stakeStarts: z.literal(ACCEPTED.familyVersions.stakeStarts),
});
export const UpdateBundleSchema = z.strictObject({
  schemaVersion: z.literal(1),
  complete: z.literal(true),
  base: pin(ACCEPTED.base),
  target: pin(ACCEPTED.target),
  deployment: z.literal(ACCEPTED.deployment),
  baseBindings,
  familyVersions: FamilyVersionsSchema,
  generation: z.literal(ACCEPTED.generation),
  changes: z.strictObject({
    tokenHolders: z.array(HolderUpdateSchema).length(1541),
    stakeStarts: z.array(StakeUpdateSchema).length(4278),
  }),
  deletionsSupported: z.literal(false),
  fullB1InventoryProven: z.literal(false),
  dailyUnchangedAtBase: z.literal(true),
});
export type HolderUpdate = z.infer<typeof HolderUpdateSchema>;
export type StakeUpdate = z.infer<typeof StakeUpdateSchema>;
const observation = z.union([
  z.strictObject({ kind: z.literal('retained_base'), snapshot: SourceStakeSnapshotSchema }),
  z.strictObject({ kind: z.literal('observed_update'), snapshot: TargetSnapshotSchema }),
]);
export const UpdatedHolderRecordSchema = z.strictObject({
  reported: SourceHolderSchema,
  anomaly: SourceHolderRecordSchema.shape.anomaly,
  provenance: SourceHolderRecordSchema.shape.provenance.nullable(),
  observation,
  update: z.union([HolderUpdateSchema, ConsecutiveHolderUpdateSchema]).nullable(),
});
export const UpdatedStakeRecordSchema = z.strictObject({
  reported: SourceStartSchema,
  recordState: SourceRecordState,
  provenance: SourceStakeRecordSchema.shape.provenance.nullable(),
  observation,
  update: z.union([StakeUpdateSchema, ConsecutiveStakeUpdateSchema]).nullable(),
  discrepancies: z.array(SourceDiscrepancySchema).max(32).nullable(),
  discrepancyAssessment: z.enum(['base_source_internal', 'unassessed_after_update']),
  historicalBaseDiscrepancies: z.array(SourceDiscrepancySchema).max(32),
});
export type UpdatedHolderRecord = z.infer<typeof UpdatedHolderRecordSchema>;
export type UpdatedStakeRecord = z.infer<typeof UpdatedStakeRecordSchema>;
const envelope = {
  chain: z.literal('pulsechain'),
  source: z.literal('subgraph'),
  generation: hash,
  familyVersions: z.strictObject({ tokenHolders: hash, stakeStarts: hash }),
  baseSnapshot: SourceStakeSnapshotSchema,
  snapshot: TargetSnapshotSchema,
  coverage: z.literal('accepted_base_plus_observed_updates'),
  refreshEnabled: z.literal(false),
  sourceOnly: z.literal(true),
  fullB1InventoryProven: z.literal(false),
  deletionsSupported: z.literal(false),
  reorgSafetyProven: z.literal(false),
  method: z.literal('inclusive_block_overlap_full_object_upserts'),
  bundleRawSha256: hash,
  bundleSemanticSha256: hash,
  selectionStatus: z.enum(['accepted', 'rejected_retained_last_accepted']),
};
export const UpdatedHoldersResponseSchema = z.strictObject({
  ...envelope,
  datasetVersion: hash,
  order: z.literal('source-id-asc'),
  baseTotals: SourceHolderTotalsSchema,
  localViewRowCount: z.number().int().min(664435).max(714435),
  items: z.array(UpdatedHolderRecordSchema).max(100),
  nextCursor: CursorSchema.nullable(),
});
export const UpdatedStakesResponseSchema = z.strictObject({
  ...envelope,
  datasetVersion: hash,
  baseInventorySourceStartCount: z.literal(954680),
  localViewRowCount: z.number().int().min(954715).max(1004715),
  address: AddressSchema.nullable(),
  sourceStartCount: z.number().int().min(0).max(1004715),
  items: z.array(UpdatedStakeRecordSchema).max(100),
  nextCursor: CursorSchema.nullable(),
});
export const UpdatedStakeResponseSchema = z.strictObject({
  ...envelope,
  datasetVersion: hash,
  reportedStakeId: StakeIdSchema,
  presence: z.enum(['present_in_saved_view', 'not_present_in_saved_view']),
  item: UpdatedStakeRecordSchema.nullable(),
});
export const UpdatedHolderLookupSchema = z.discriminatedUnion('state', [
  z.strictObject({
    state: z.literal('present_in_saved_view'),
    item: UpdatedHolderRecordSchema,
    reason: z.null(),
  }),
  z.strictObject({
    state: z.literal('source_anomaly'),
    item: UpdatedHolderRecordSchema,
    reason: z.enum(['negative_reported_balance', 'zero_address_bookkeeping']),
  }),
  z.strictObject({
    state: z.literal('not_present_in_saved_view'),
    item: z.null(),
    reason: z.null(),
  }),
]);
export const UpdatedAddressResponseSchema = UpdatedStakesResponseSchema.extend({
  address: AddressSchema,
  holder: UpdatedHolderLookupSchema,
  holderDatasetVersion: hash,
  liquidBalance: SourceLiquidBalanceSchema.nullable(),
  ranks: z.null(),
});
export const SavedHoldersResponseSchema = z.union([
  SourceHoldersResponseSchema,
  UpdatedHoldersResponseSchema,
]);
export const SavedStakesResponseSchema = z.union([
  SourceStakesResponseSchema,
  UpdatedStakesResponseSchema,
]);
export const SavedStakeResponseSchema = z.union([
  SourceStakeResponseSchema,
  UpdatedStakeResponseSchema,
]);
export const SavedAddressResponseSchema = z.union([
  SourceAddressResponseSchema,
  UpdatedAddressResponseSchema,
]);
