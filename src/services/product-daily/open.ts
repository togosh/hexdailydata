import { ParticipantRegistry } from '../source-update/refresh.ts';
import { open } from 'node:fs/promises';
import { join, isAbsolute } from 'node:path';
import { z } from 'zod';
import { PairSchema, digest } from '../../contracts/product-daily.ts';
import { SavedSourceGenerations } from '../source-update/generation.ts';
import { ProductDailyStore } from './store.ts';
import type { ApiDependencies } from '../../api/dependencies.ts';
import { ACCEPTED, BASE_SNAPSHOT, TARGET_SNAPSHOT } from '../../contracts/saved-generation.ts';

const localPath = z
  .string()
  .min(1)
  .max(4096)
  .refine(
    (p) =>
      isAbsolute(p) &&
      !/^(?:\\\\|\/\/)/.test(p) &&
      !p.includes('\0') &&
      !p.split(/[\\/]/).includes('..'),
    'Absolute local path required',
  );

export const ProductProfileSchema = z.strictObject({
  productRoot: localPath,
  history: localPath,
  historyManifestSha256: digest,
  ledger: localPath,
  ledgerSha256: digest,
  holdersRoot: localPath,
  stakesRoot: localPath,
  overlayRoot: localPath,
  pair: PairSchema,
  participantRoot: localPath.optional(),
});
export type ProductProfile = z.infer<typeof ProductProfileSchema>;
export async function readProductProfile(path: string) {
  localPath.parse(path);
  const handle = await open(path, 'r');
  try {
    const stat = await handle.stat();
    if (!stat.isFile() || stat.size > 16384) throw Error('PRODUCT_PROFILE_BOUND');
    const b = Buffer.alloc(16385);
    const { bytesRead } = await handle.read(b, 0, b.length, 0);
    if (bytesRead > 16384 || bytesRead !== stat.size) throw Error('PRODUCT_PROFILE_BOUND');
    return validateProfile(JSON.parse(b.subarray(0, bytesRead).toString('utf8')));
  } finally {
    await handle.close();
  }
}
function validateProfile(value: unknown) {
  const profile = ProductProfileSchema.parse(value);
  if (
    profile.pair.generation !== ACCEPTED.generation ||
    profile.pair.holderDatasetVersion !== ACCEPTED.familyVersions.tokenHolders ||
    profile.pair.stakeDatasetVersion !== ACCEPTED.familyVersions.stakeStarts ||
    Date.parse(profile.pair.baseObservedAtUtc) !== Date.parse(BASE_SNAPSHOT.observedAtUtc) ||
    Date.parse(profile.pair.observedAtUtc) !== Date.parse(TARGET_SNAPSHOT.observedAtUtc)
  )
    throw Error('PRODUCT_PROFILE_IDENTITY');
  return profile;
}
/** Explicit file-backed composition. No SQL/provider/config discovery or publication. */
export async function openProductDependencies(
  profile: ProductProfile,
): Promise<ApiDependencies> {
  profile = validateProfile(profile);
  const sourceGenerations = await SavedSourceGenerations.activate({
    root: profile.overlayRoot,
    holdersRoot: profile.holdersRoot,
    stakesRoot: profile.stakesRoot,
  });
  try {
    const admission = await sourceGenerations.admit(
      join(profile.overlayRoot, profile.pair.generation),
      { readOnly: true },
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
    if (profile.participantRoot) {
      const participants = await ParticipantRegistry.open(
        profile.participantRoot,
        profile.productRoot,
        sourceGenerations,
      );
      return {
        participants,
        productDaily: participants.productDaily,
        sourceGenerations,
        close: async () => {
          await participants.close();
          await sourceGenerations.close();
        },
      };
    }
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
