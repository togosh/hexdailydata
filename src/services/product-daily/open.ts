import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { z } from 'zod';
import { PairSchema, digest } from '../../contracts/product-daily.ts';
import { SavedSourceGenerations } from '../source-update/generation.ts';
import { ProductDailyStore } from './store.ts';
import type { ApiDependencies } from '../../api/dependencies.ts';
import { BASE_SNAPSHOT, TARGET_SNAPSHOT } from '../../contracts/saved-generation.ts';

export const ProductProfileSchema = z.strictObject({
  productRoot: z.string().min(1),
  history: z.string().min(1),
  historyManifestSha256: digest,
  ledger: z.string().min(1),
  ledgerSha256: digest,
  holdersRoot: z.string().min(1),
  stakesRoot: z.string().min(1),
  overlayRoot: z.string().min(1),
  pair: PairSchema,
});
export type ProductProfile = z.infer<typeof ProductProfileSchema>;
export async function readProductProfile(path: string) {
  const b = await readFile(path);
  if (b.length > 16384) throw Error('PRODUCT_PROFILE_BOUND');
  return ProductProfileSchema.parse(JSON.parse(b.toString()));
}
/** Explicit file-backed composition. No SQL/provider/config discovery or publication. */
export async function openProductDependencies(profile: ProductProfile): Promise<ApiDependencies> {
  profile = ProductProfileSchema.parse(profile);
  const sourceGenerations = await SavedSourceGenerations.activate({
    root: profile.overlayRoot,
    holdersRoot: profile.holdersRoot,
    stakesRoot: profile.stakesRoot,
  });
  try {
    const admission = await sourceGenerations.admit(
      join(profile.overlayRoot, profile.pair.generation),
    );
    await sourceGenerations.loadSelection();
    const descriptor = sourceGenerations.descriptor;
    if (
      descriptor.generation !== profile.pair.generation ||
      descriptor.holderDatasetVersion !== profile.pair.holderDatasetVersion ||
      descriptor.stakeDatasetVersion !== profile.pair.stakeDatasetVersion
    )
      throw Error('PRODUCT_PROFILE_PAIR');
    validateAdmittedPair(profile.pair, admission);
    const productDaily = new ProductDailyStore(profile.productRoot, profile.pair);
    await productDaily.load();
    return { productDaily, sourceGenerations, close: () => sourceGenerations.close() };
  } catch (e) {
    await sourceGenerations.close();
    throw e;
  }
}
export function validateAdmittedPair(
  pair: z.infer<typeof PairSchema>,
  admission: { localHolderRows: number; localStakeRows: number },
) {
  if (
    pair.holderRecordCount !== admission.localHolderRows ||
    pair.stakeStartRecordCount !== admission.localStakeRows ||
    Date.parse(pair.baseObservedAtUtc) !== Date.parse(BASE_SNAPSHOT.observedAtUtc) ||
    Date.parse(pair.observedAtUtc) !== Date.parse(TARGET_SNAPSHOT.observedAtUtc)
  )
    throw Error('PRODUCT_PROFILE_PAIR_FACTS');
}
