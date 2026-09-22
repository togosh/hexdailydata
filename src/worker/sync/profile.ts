import { z } from 'zod';
import { address, hash, headerSchema, uint } from '../../services/projections/input.ts';
import { policySchema } from '../../providers/source.ts';
import { bindingSchema, commonHistorySchema } from '../../providers/binding.ts';
import { Source } from '../../providers/source.ts';
import { RpcClient, type Transport } from '../../providers/rpc.ts';
import type { ProviderBudget } from '../../providers/budget.ts';
const provider = z.strictObject({
  id: z.string().min(1).max(80),
  operator: z.string().min(1).max(80).nullable(),
  accountGroup: z.string().min(1).max(80),
  endpointEnv: z.string().regex(/^HDD_V2_PROVIDER_[A-Z0-9_]+$/),
});
export const profileSchema = z
  .strictObject({
    commonHistory: z.enum(['ethereum', 'pulsechain']).default('ethereum'),
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
  })
  .superRefine((p, ctx) => {
    const result = commonHistorySchema.safeParse({
      transportChainId: p.commonHistory === 'pulsechain' ? 369 : 1,
      constructor: p.constructor.checkpoint,
      transactionHash: p.constructor.transactionHash,
      ...p.fork,
    });
    if (!result.success)
      ctx.addIssue({ code: 'custom', message: 'Invalid common-history declarations.' });
    if (
      BigInt(p.target.number) < BigInt(p.fork.entry.number) ||
      (p.target.number === p.fork.entry.number
        ? JSON.stringify(p.target) !== JSON.stringify(p.fork.entry)
        : BigInt(p.target.timestamp) <= BigInt(p.fork.entry.timestamp))
    )
      ctx.addIssue({ code: 'custom', message: 'Invalid native target declaration.' });
  });
export type SourceProfile = z.infer<typeof profileSchema>;
export function profileBinding(profile: SourceProfile, originChainId: 1 | 369) {
  const transportChainId = profile.commonHistory === 'pulsechain' ? 369 : 1;
  return bindingSchema.parse({
    version: 1,
    networkChainId: originChainId === 1 ? transportChainId : 369,
    originChainId,
    contract: profile.contract,
    codeHash: profile.codeHash,
    common: {
      transportChainId,
      constructor: profile.constructor.checkpoint,
      transactionHash: profile.constructor.transactionHash,
      ...profile.fork,
    },
  });
}
/** Worker and bounded canary share construction, never a second acquisition engine. */
export function profileSources(
  profile: SourceProfile,
  origin: 1 | 369,
  transport: (source: SourceProfile['ethereum'][number]) => Transport,
  budget: ProviderBudget,
): [Source, Source] {
  const binding = profileBinding(profile, origin);
  return (origin === 1 ? profile.ethereum : profile.pulsechain).map(
    (s) =>
      new Source(
        new RpcClient(
          s.id,
          s.operator,
          binding.networkChainId,
          profile.contract,
          transport(s),
          budget,
        ),
        { codeHash: profile.codeHash, finality: profile.policy, completeness: 'filtered-ranges' },
        binding,
        {
          id: s.id,
          operator: s.operator,
          accountGroup: s.accountGroup,
          endpointAlias: s.endpointEnv,
        },
      ),
  ) as [Source, Source];
}
