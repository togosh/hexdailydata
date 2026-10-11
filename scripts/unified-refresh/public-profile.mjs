// One exact new grant. Historical/offline profiles are not public authority.
import { readFile, lstat } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { canonical, sha } from '../../dist/services/source-update/generation.js';
export const publicTask = 'HDD-UNIFIED-REFRESH-PUBLIC-QUALIFICATION-R2';
export const publicProfile = 'unified-five-feed-public-qualification-2';
export const publicRoot = String.raw`C:\Code\HEXDailyData-Subgraph-First-Launch-Proof-R2\unified-refresh-public-qualification-r2`;
export const packetHashes = Object.freeze({
  'packet/SCOPE.json': '74da822b99a6fab67e859044d0f6ea3efac43f6fcd0afb64abec96c9d9bec8c5',
  'packet/INPUTS.json': '15ba1c74180836f3a2126017819a2832b9b134438762d8d569b3bd260dc3eb03',
  'packet/PUBLIC_PROFILE.json': '3f1b44f0fe4719d893f9bcfabc4f3d72f6d789c1b9b2df496f87a7b8eee5bbad',
});
export const publicProfileHash = '4be3bc10f5702140177c7753e6d5281d8c766a821f82ea6c55728ea95bde17c4';
export function exactPublicProfile(p) {
  if (
    p.format !== publicProfile ||
    p.mode !== 'OWNER_AUTHORIZED_PUBLIC' ||
    sha(canonical(p)) !== publicProfileHash
  )
    throw Error('EXACT_PUBLIC_PROFILE_REQUIRED');
  return p;
}
export function publicAdmission(a) {
  if (a.unifiedProfileId !== publicProfile) return false;
  if (
    a.authorityTaskId !== publicTask ||
    a.synthetic !== false ||
    a.parentMode !== 'OWNER_AUTHORIZED_PUBLIC' ||
    a.parentProfileSha256 !== publicProfileHash ||
    !/^[a-f0-9]{64}$/.test(a.parentNonce ?? '') ||
    !/^[a-f0-9]{64}$/.test(a.preflightSha256 ?? '')
  )
    throw Error('EXACT_PUBLIC_CHILD_AUTHORITY');
  if (
    a.family === 'trade' &&
    (!Number.isInteger(a.tradeSlot) ||
      a.tradeSlot < 1 ||
      a.tradeSlot > 16 ||
      a.tradeProfileId !== 'unified-single-pair-1' ||
      a.responseCookiePolicyId !== 'ignore-response-cookies-no-replay-v1')
  )
    throw Error('EXACT_PUBLIC_TRADE_PROFILE');
  return true;
}
export async function validatePublicReady({
  taskRoot,
  registry,
  preflightPath,
  loadedRuntimeFiles,
  repo,
}) {
  if (
    resolve(taskRoot) !== publicRoot ||
    resolve(preflightPath) !== join(publicRoot, 'PREFLIGHT.json')
  )
    throw Error('EXACT_PUBLIC_ROOT');
  for (const path of ['session', 'PUBLIC_ADMISSION.json']) {
    if (
      await lstat(join(publicRoot, path)).catch((e) => {
        if (e.code === 'ENOENT') return null;
        throw e;
      })
    )
      throw Error('PUBLIC_SESSION_SPENT_OR_UNCERTAIN');
  }
  const read = async (p) => JSON.parse(await readFile(join(publicRoot, p)));
  const pre = await read('PREFLIGHT.json'),
    plan = await read('FROZEN_PLAN.json'),
    ready = await read('evidence/READY.json'),
    review = await read('evidence/PREFLIGHT_REVIEW.json');
  for (const [path, hash] of Object.entries(packetHashes))
    if (sha(await readFile(join(publicRoot, path))) !== hash) throw Error('EXACT_PACKET_BINDING');
  if (
    pre.taskId !== publicTask ||
    pre.taskRoot !== publicRoot ||
    pre.verdict !== 'PASS' ||
    pre.synthetic !== false ||
    pre.profileSha256 !== publicProfileHash ||
    pre.scopeSha256 !== packetHashes['packet/SCOPE.json'] ||
    review.verdict !== 'PASS' ||
    review.candidateCommit !== plan.commit ||
    review.planSha256 !== sha(await readFile(join(publicRoot, 'FROZEN_PLAN.json'))) ||
    pre.reviewSha256 !== sha(await readFile(join(publicRoot, 'evidence/PREFLIGHT_REVIEW.json'))) ||
    pre.readySha256 !== sha(await readFile(join(publicRoot, 'evidence/READY.json'))) ||
    ready.status !== 'PASS' ||
    ready.pid !== process.pid ||
    ready.actualPairedRegistry !== true ||
    ready.freshProcess !== true ||
    !Number.isFinite(Date.parse(ready.readyAtUtc)) ||
    Date.now() - Date.parse(ready.readyAtUtc) < 0 ||
    Date.now() - Date.parse(ready.readyAtUtc) > 120000 ||
    canonical(pre.runtimeFiles) !== canonical(plan.runtimeFiles) ||
    canonical(loadedRuntimeFiles) !== canonical(plan.runtimeFiles) ||
    ready.runtimeHash !== sha(canonical(plan.runtimeFiles))
  )
    throw Error('PUBLIC_LOADED_PREFLIGHT_BINDING');
  for (const [path, hash] of Object.entries(plan.runtimeFiles))
    if (sha(await readFile(join(repo, path))) !== hash) throw Error('PUBLIC_RUNTIME_CHANGED');
  for (const [path, hash] of Object.entries(plan.inputFiles))
    if (sha(await readFile(join(publicRoot, path))) !== hash) throw Error('PUBLIC_INPUT_CHANGED');
  const selected = registry.productDaily.capture(),
    state = registry.status();
  if (
    selected.version !== pre.initialProductVersion ||
    selected.manifestSha256 !== pre.initialManifestSha256 ||
    state.generation !== pre.initialGeneration ||
    selected.metadata.marketStorage.sequence !== 44
  )
    throw Error('PUBLIC_INITIAL_PAIR_CHANGED');
  return { ...pre, preflightSha256: sha(await readFile(preflightPath)) };
}
