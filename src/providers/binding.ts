import { z } from 'zod';
import {
  address,
  hash,
  headerSchema,
  integer,
  digest,
  type Header,
} from '../services/projections/input.ts';

const chain = z.union([z.literal(1), z.literal(369)]);
/** Declared identities, not evidence of a live observation. Shared history ends at parent. */
export const commonHistorySchema = z
  .strictObject({
    transportChainId: chain,
    constructor: headerSchema,
    transactionHash: hash,
    parent: headerSchema,
    entry: headerSchema,
  })
  .superRefine((v, ctx) => {
    const c = v.constructor,
      p = v.parent,
      e = v.entry;
    if (
      BigInt(c.number) > BigInt(p.number) ||
      (c.number === p.number
        ? digest(c) !== digest(p)
        : BigInt(c.timestamp) >= BigInt(p.timestamp) || c.hash === p.hash) ||
      BigInt(e.number) !== BigInt(p.number) + 1n ||
      e.parentHash !== p.hash ||
      e.hash === p.hash ||
      BigInt(e.timestamp) <= BigInt(p.timestamp) ||
      (BigInt(p.number) === BigInt(c.number) + 1n && p.parentHash !== c.hash)
    )
      ctx.addIssue({
        code: 'custom',
        message: 'Contradictory constructor/common-parent/entry binding.',
      });
  });
export const bindingSchema = z
  .strictObject({
    version: z.literal(1),
    networkChainId: chain,
    originChainId: chain,
    contract: address,
    codeHash: hash,
    common: commonHistorySchema.nullable(),
  })
  .superRefine((v, ctx) => {
    if (
      (v.networkChainId !== v.originChainId &&
        !(
          v.networkChainId === 369 &&
          v.originChainId === 1 &&
          v.common?.transportChainId === 369
        )) ||
      (v.originChainId === 1 && v.common && v.networkChainId !== v.common.transportChainId)
    )
      ctx.addIssue({ code: 'custom', message: 'Unsupported transport/origin binding.' });
  });
export type SourceBinding = z.infer<typeof bindingSchema>;
export const sourceHistorySchema = z
  .strictObject({
    binding: bindingSchema,
    providers: z.tuple([providerIdentity(), providerIdentity()]),
  })
  .superRefine(({ providers: [a, b] }, ctx) => {
    if (
      a.id === b.id ||
      (a.operator !== null && a.operator.toLowerCase() === b.operator?.toLowerCase()) ||
      (a.endpointAlias !== null && a.endpointAlias === b.endpointAlias)
    )
      ctx.addIssue({ code: 'custom', message: 'Incompatible source identities.' });
  });
function providerIdentity() {
  return z.strictObject({
    id: z.string().min(1).max(80),
    operator: z.string().min(1).max(80).nullable(),
    accountGroup: z.string().min(1).max(80).nullable(),
    endpointAlias: z.string().min(1).max(80).nullable(),
  });
}
export type SourceIdentity = z.infer<ReturnType<typeof providerIdentity>>;

export function assertEventRange(binding: SourceBinding, from: string, to = from) {
  integer.parse(from);
  integer.parse(to);
  const c = binding.common;
  if (
    BigInt(from) > BigInt(to) ||
    (c &&
      (binding.originChainId === 1
        ? BigInt(from) < BigInt(c.constructor.number) || BigInt(to) > BigInt(c.parent.number)
        : BigInt(from) < BigInt(c.entry.number)))
  )
    throw new Error('Event interval outside source binding.');
}
/** Native state/header verification may observe the inherited parent; native events may not. */
export function assertObservation(binding: SourceBinding, number: string) {
  if (binding.originChainId === 369 && number === binding.common?.parent.number) return;
  assertEventRange(binding, number);
}
export function assertDeclaredHeader(binding: SourceBinding, h: Header) {
  assertObservation(binding, h.number);
  if (binding.common)
    for (const declared of [
      binding.common.constructor,
      binding.common.parent,
      binding.common.entry,
    ]) {
      if (declared.number === h.number && digest(declared) !== digest(h))
        throw new Error('Header differs from declared source binding.');
    }
}
