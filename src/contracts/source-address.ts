import { z } from 'zod';
import { AddressSchema } from './reads.ts';
import { SourceStakesResponseSchema, SourceAddressQuery as StakeAddressQuery } from './source-stakes.ts';
import { HolderVersionSchema, SourceHolderLookupSchema, SourceLiquidBalanceSchema } from './source-holders.ts';

// datasetVersion keeps its accepted stake meaning; the holder selector is separate.
export const SourceAddressQuery = StakeAddressQuery.extend({ holderDatasetVersion: HolderVersionSchema.optional() });
export const SourceAddressResponseSchema = SourceStakesResponseSchema.extend({
  address: AddressSchema,
  holder: SourceHolderLookupSchema,
  liquidBalance: SourceLiquidBalanceSchema.nullable(),
  ranks: z.null(),
});
