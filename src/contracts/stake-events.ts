import { z } from 'zod';
import { UIntStringSchema, TimestampSchema } from './api.ts';
import { AddressSchema, StakeIdSchema } from './reads.ts';
import { integer, hash } from '../services/projections/input.ts';
const kind = z.enum(['stake_start', 'good_accounting', 'stake_end']);
export const StakeEventsQuery = z
  .strictObject({
    chain: z.literal('pulsechain').default('pulsechain'),
    fromBlock: integer.default('0'),
    address: AddressSchema.optional(),
    stakeId: StakeIdSchema.optional(),
    kind: kind.optional(),
    limit: z
      .string()
      .max(3)
      .regex(/^[1-9][0-9]*$/)
      .transform(Number)
      .pipe(z.number().int().min(1).max(100))
      .default(50),
    cursor: z
      .string()
      .min(1)
      .max(2048)
      .regex(/^[A-Za-z0-9_-]+$/)
      .optional(),
  })
  .refine((q) => !(q.address && q.stakeId), 'Select one address OR one stake ID.');

export type StakeEventsSelection = z.infer<typeof StakeEventsQuery>;

const base = {
  eventId: z.string().max(90),
  originChainId: z.union([z.literal(1), z.literal(369)]),
  blockNumber: integer,
  blockHash: hash,
  transactionHash: hash,
  transactionIndex: z.number().int().nonnegative(),
  logIndex: z.number().int().nonnegative(),
  timestamp: TimestampSchema,
  stakeId: StakeIdSchema,
  address: AddressSchema,
};
const settlement = {
  payoutHearts: UIntStringSchema,
  penaltyHearts: UIntStringSchema,
  principalHearts: UIntStringSchema.nullable(),
  stakeShares: UIntStringSchema.nullable(),
};
export const StakeEventSchema = z.discriminatedUnion('kind', [
  z.strictObject({
    ...base,
    kind: z.literal('stake_start'),
    amounts: z.strictObject({
      principalHearts: UIntStringSchema,
      stakeShares: UIntStringSchema,
      stakedDays: z.number().int().min(1).max(5555),
      isAutoStake: z.boolean(),
    }),
  }),
  z.strictObject({
    ...base,
    kind: z.literal('good_accounting'),
    amounts: z.strictObject(settlement),
  }),
  z.strictObject({
    ...base,
    kind: z.literal('stake_end'),
    amounts: z.strictObject({
      ...settlement,
      servedDays: z.number().int().min(0).max(5555),
      previouslyUnlocked: z.boolean(),
    }),
  }),
]);
export const StakeEventsResponseSchema = z.strictObject({
  chain: z.literal('pulsechain'),
  coverageStartBlock: integer,
  cutoff: z.strictObject({
    blockNumber: integer,
    blockHash: hash,
    blockTimestamp: TimestampSchema,
    finality: z.enum(['confirmed', 'finalized']),
  }),
  items: z.array(StakeEventSchema).max(100),
  caughtUp: z.boolean(),
  scannedEvents: z.number().int().min(0).max(200),
  nextCursor: z.string().min(1).max(2048),
});
