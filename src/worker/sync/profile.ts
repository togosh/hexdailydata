import { z } from 'zod';
import { address, hash, headerSchema, uint } from '../../services/projections/input.ts';
import { policySchema } from '../../providers/source.ts';
const provider = z.strictObject({
  id: z.string().min(1).max(80),
  operator: z.string().min(1).max(80).nullable(),
  accountGroup: z.string().min(1).max(80),
  endpointEnv: z.string().regex(/^HDD_V2_PROVIDER_[A-Z0-9_]+$/),
});
export const profileSchema = z.strictObject({
  contract: address,
  codeHash: hash,
  policy: policySchema.shape.finality,
  ethereum: z.tuple([provider, provider]),
  pulsechain: z.tuple([provider, provider]),
  constructor: z.strictObject({
    checkpoint: headerSchema,
    transactionHash: hash,
    balances: z.array(z.strictObject({ address, hearts: uint })).max(10000),
  }),
  fork: z.strictObject({ parent: headerSchema, entry: headerSchema }),
  target: headerSchema,
});
