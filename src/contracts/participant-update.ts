import { z } from 'zod';
import { ACCEPTED } from './saved-generation.ts';
import { SourceHolderSchema } from './source-holders.ts';
import { SourceStartSchema } from './source-stakes.ts';

const hash = z.string().regex(/^[0-9a-f]{64}$/);
const count = z.number().int().nonnegative().max(50000);
export const ParticipantPinSchema = z.strictObject({
  number: z.number().int().min(ACCEPTED.target.number).max(Number.MAX_SAFE_INTEGER),
  hash: z.string().regex(/^0x[0-9a-f]{64}$/),
  timestamp: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
});
export const ParticipantSnapshotSchema = ParticipantPinSchema.extend({
  source: z.literal('pulsechain/hex'),
  deployment: z.literal(ACCEPTED.deployment),
  observedAtUtc: z.iso.datetime({ offset: true }),
}).refine((v) => Date.parse(v.observedAtUtc) === v.timestamp * 1000, 'Snapshot time');
const entry = {
  operation: z.literal('upsert'),
  id: z.string().regex(/^[A-Za-z0-9_.:-]{1,256}$/),
  kind: z.enum(['new', 'replacement', 'unchanged_overlap']),
  beforeProvenance: z.strictObject({ generation: hash, rowSha256: hash }).nullable(),
  afterProvenance: z
    .array(
      z.strictObject({
        window: z.number().int().positive().max(4096),
        attempt: z.number().int().positive().max(2248),
        capture: z.string().regex(/^captures\/\d{5}\/capture\.json$/),
        responseSha256: hash,
        family: z.enum(['tokenHolders', 'stakeStarts', 'resolvedParent']),
      }),
    )
    .min(1)
    .max(2),
  changedFields: z.array(z.string().max(40)).max(32),
};
export const ConsecutiveHolderUpdateSchema = z.strictObject({
  ...entry,
  family: z.literal('tokenHolders'),
  before: SourceHolderSchema.nullable(),
  after: SourceHolderSchema,
});
export const ConsecutiveStakeUpdateSchema = z.strictObject({
  ...entry,
  family: z.literal('stakeStarts'),
  before: SourceStartSchema.nullable(),
  after: SourceStartSchema,
});
export const ParticipantUpdateSchema = z
  .strictObject({
    schemaVersion: z.literal(2),
    complete: z.literal(true),
    predecessor: hash,
    base: ParticipantPinSchema,
    target: ParticipantPinSchema,
    deployment: z.literal(ACCEPTED.deployment),
    proofSha256: hash,
    changes: z.strictObject({
      tokenHolders: z.array(ConsecutiveHolderUpdateSchema).max(50000),
      stakeStarts: z.array(ConsecutiveStakeUpdateSchema).max(50000),
    }),
    sourceCounts: z.strictObject({
      tokenHolders: count,
      stakeStarts: count,
      stakeEnds: count,
      stakeGoodAccountings: count,
      affectedParents: count,
    }),
    fullTargetInventoryProven: z.literal(false),
    deletionsSupported: z.literal(false),
    reorgSafetyProven: z.literal(false),
  })
  .refine(
    (v) =>
      v.target.number > v.base.number &&
      v.target.number - v.base.number <= 4096 &&
      v.target.timestamp > v.base.timestamp &&
      v.target.hash !== v.base.hash,
    'Consecutive bounded pin',
  );
export type ParticipantUpdate = z.infer<typeof ParticipantUpdateSchema>;
export const ParticipantProofSchema = z.strictObject({
  format: z.literal('participant-window-proof-1'),
  complete: z.literal(true),
  base: ParticipantPinSchema,
  target: ParticipantPinSchema,
  deployment: z.literal(ACCEPTED.deployment),
  captureLedgerSha256: hash,
  afterSha256: z.strictObject({ tokenHolders: hash, stakeStarts: hash }),
  families: z.tuple([
    z.literal('tokenHolders'),
    z.literal('stakeStarts'),
    z.literal('stakeEnds'),
    z.literal('stakeGoodAccountings'),
  ]),
  explicitEmptyAndRepeats: z.literal(true),
  parentChecks: z.literal(true),
  witnessChecks: z.literal(true),
  closingHeadersAndMetadata: z.literal(true),
  networkClosureKnown: z.literal(true),
});
export const ParticipantDescriptorSchema = z.strictObject({
  format: z.literal('participant-consecutive-1'),
  generation: hash,
  predecessor: hash,
  base: ParticipantPinSchema,
  target: ParticipantPinSchema,
  deployment: z.literal(ACCEPTED.deployment),
  updateSha256: hash,
  updateFileSha256: hash,
  proofSha256: hash,
  indexSha256: hash,
  familyVersions: z.strictObject({ tokenHolders: hash, stakeStarts: hash }),
  holderRecordCount: z.number().int().min(664435).max(714435),
  stakeStartRecordCount: z.number().int().min(954715).max(1004715),
  changedHolderKeys: count,
  changedStakeKeys: count,
});
export type ParticipantDescriptor = z.infer<typeof ParticipantDescriptorSchema>;
export const participantLimits = Object.freeze({
  keysPerFamily: 50000,
  overlayBytes: 256 * 1024 * 1024,
  indexBytes: 32 * 1024 * 1024,
  segments: 4096,
});
