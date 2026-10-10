// Explicit unused admission only; reuses the existing native runJob coordinator.
import { readFile, mkdir, open, unlink, lstat, statfs, readdir } from 'node:fs/promises';
import { resolve, join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { sha } from '../dist/services/source-update/generation.js';
import { durableJson } from './market-refresh.mjs';
import { runJob } from './refresh-data.mjs';
const repo = resolve(dirname(fileURLToPath(import.meta.url)), '..');
export const taskId = 'HDD-BTC-ETH-CURRENT-REFERENCE-FRESHNESS-R2';
export async function tradeStorageGuard(root, reserve = 0, initial = false) {
  let bytes = reserve;
  const stack = [root];
  while (stack.length)
    for (const entry of await readdir(stack.pop(), { withFileTypes: true })) {
      if (entry.isSymbolicLink()) throw Error('TASK_STORAGE_LINK');
      const path = join(entry.parentPath, entry.name);
      if (entry.isDirectory()) stack.push(path);
      else bytes += (await lstat(path)).size;
      if (bytes > 4 * 1024 ** 3) throw Error('TASK_STORAGE_BOUND');
    }
  const disk = await statfs(root);
  if (disk.bavail * disk.bsize - reserve < (initial ? 10 : 5) * 1024 ** 3)
    throw Error('TASK_FREE_SPACE');
  return { bytes, freeBytes: disk.bavail * disk.bsize };
}
export const recoveryTaskId = 'HDD-BTC-ETH-CURRENT-REFERENCE-TRANSPORT-RECOVERY-R1';
const recoveryRoot = String.raw`C:\Code\HEXDailyData-Subgraph-First-Launch-Proof-R2\btc-eth-current-reference-freshness-r2\transport-recovery-r1`;
export const isolationTaskId = 'HDD-BTC-ETH-CURRENT-REFERENCE-WORKER-STDIN-ISOLATION-R1';
const isolationRoot = join(dirname(recoveryRoot), 'worker-stdin-isolation-r1');
export const cookieTaskId = 'HDD-BTC-ETH-CURRENT-REFERENCE-RESPONSE-COOKIE-HANDLING-R1';
export const responseCookiePolicyId = 'ignore-response-cookies-no-replay-v1';
const cookieRoot = join(dirname(recoveryRoot), 'response-cookie-handling-r1');
export async function runCookieTrades(options) {
  return runFiniteTrades(
    { ...options, taskRoot: cookieRoot, preflightPath: join(cookieRoot, 'PREFLIGHT.json') },
    cookieTaskId,
  );
}
export async function runIsolationTrades(options) {
  return runFiniteTrades(
    { ...options, taskRoot: isolationRoot, preflightPath: join(isolationRoot, 'PREFLIGHT.json') },
    isolationTaskId,
  );
}
export async function runTrades(options) {
  return runFiniteTrades(options, false);
}
export async function runRecoveryTrades(options) {
  return runFiniteTrades(
    { ...options, taskRoot: recoveryRoot, preflightPath: join(recoveryRoot, 'PREFLIGHT.json') },
    true,
  );
}
async function runFiniteTrades(
  { taskRoot, preflightPath, registry, onAdoption, spawnChild = spawn, loadedRuntimeFiles },
  recovery,
) {
  taskRoot = resolve(taskRoot);
  preflightPath = resolve(preflightPath);
  const isolated = recovery === isolationTaskId,
    cookies = recovery === cookieTaskId,
    authorityId = cookies ? cookieTaskId : isolated ? isolationTaskId : recoveryTaskId,
    authorityRoot = cookies ? cookieRoot : isolated ? isolationRoot : recoveryRoot;
  // Refuse spent/uncertain state before any interpretation of an old preflight.
  for (const name of ['session', 'PUBLIC_ADMISSION.json'])
    if (
      await lstat(join(taskRoot, name)).catch((e) => {
        if (e.code === 'ENOENT') return null;
        throw e;
      })
    )
      throw Error('EXISTING_OR_UNCERTAIN_TRADE_SESSION');
  const pre = JSON.parse(await readFile(preflightPath)),
    synthetic = spawnChild !== spawn;
  if (
    pre.verdict !== 'PASS' ||
    pre.taskId !== taskId ||
    pre.taskRoot !== taskRoot ||
    Boolean(pre.synthetic) !== synthetic ||
    !pre.independentReviewSha256
  )
    throw Error('EXACT_UNUSED_PREFLIGHT');
  const continuation = preflightPath === join(taskRoot, 'continuation-r1/PREFLIGHT.json');
  if (recovery) {
    const scope = JSON.parse(await readFile(join(taskRoot, 'packet/SCOPE.json')));
    const ready = JSON.parse(await readFile(join(taskRoot, 'evidence/READY.json')));
    if (
      synthetic ||
      pre.authorityTaskId !== authorityId ||
      scope.taskId !== authorityId ||
      taskRoot !== authorityRoot ||
      resolve(isolated || cookies ? scope.paths.taskRoot : scope.paths.newRoot) !== authorityRoot ||
      resolve(scope.network.sessionPath) !== join(authorityRoot, 'session') ||
      pre.scopeSha256 !== sha(await readFile(join(taskRoot, 'packet/SCOPE.json'))) ||
      pre.readySha256 !== sha(await readFile(join(taskRoot, 'evidence/READY.json'))) ||
      ready.status !== 'PASS' ||
      ready.pid !== process.pid ||
      ready.runtimeHash !== pre.runtimeHash ||
      sha(JSON.stringify(pre.runtimeFiles)) !== pre.runtimeHash
    )
      throw Error('EXACT_RECOVERY_READY_AUTHORITY');
    if (isolated) {
      const gate = await readFile(join(taskRoot, 'evidence/CAUSAL_GATE.json'));
      if (pre.causalGateSha256 !== sha(gate) || JSON.parse(gate).status !== 'PASS')
        throw Error('EXACT_CAUSAL_GATE_REQUIRED');
    }
    if (cookies) {
      const gate = await readFile(join(taskRoot, 'evidence/POLICY_GATE.json'));
      if (
        pre.policyGateSha256 !== sha(gate) || JSON.parse(gate).status !== 'PASS' ||
        pre.responseCookiePolicyId !== responseCookiePolicyId ||
        scope.network.responseCookiePolicy.id !== responseCookiePolicyId
      ) throw Error('EXACT_RESPONSE_COOKIE_POLICY_REQUIRED');
    }
  } else if (pre.authorityTaskId) throw Error('RECOVERY_AUTHORITY_IN_OLD_ENTRY');
  if (
    (continuation || recovery) &&
    (!loadedRuntimeFiles || JSON.stringify(loadedRuntimeFiles) !== JSON.stringify(pre.runtimeFiles))
  )
    throw Error('LOADED_RUNTIME_BINDING');
  if (!continuation && preflightPath !== join(taskRoot, 'PREFLIGHT.json'))
    throw Error('EXACT_PREFLIGHT_PATH');
  if (
    sha(
      await readFile(
        join(
          taskRoot,
          continuation
            ? 'continuation-r1/evidence/PREFLIGHT_REVIEW.json'
            : 'evidence/PREFLIGHT_REVIEW.json',
        ),
      ),
    ) !== pre.independentReviewSha256
  )
    throw Error('PREFLIGHT_REVIEW_BINDING');
  for (const [p, h] of Object.entries(pre.runtimeFiles))
    if (sha(await readFile(join(repo, p))) !== h) throw Error('FROZEN_RUNTIME_CHANGED');
  for (const [p, h] of Object.entries(pre.inputFiles))
    if (sha(await readFile(join(taskRoot, p))) !== h) throw Error('FROZEN_INPUT_CHANGED');
  if (
    registry.status().generation !== pre.initialGeneration ||
    registry.status().productVersion !== pre.initialProductVersion ||
    (recovery
      ? registry.root !== join(dirname(taskRoot), 'runtime/participants') ||
        registry.productDaily.root !== join(dirname(taskRoot), 'runtime/product')
      : !registry.root.startsWith(taskRoot + '\\') ||
        !registry.productDaily.root.startsWith(taskRoot + '\\'))
  )
    throw Error('GENUINE_OWNED_SELECTION_REQUIRED');
  const output = join(taskRoot, 'session'),
    marker = join(taskRoot, 'PUBLIC_ADMISSION.json');
  for (const p of [output, marker])
    if (
      await lstat(p).catch((e) => {
        if (e.code === 'ENOENT') return null;
        throw e;
      })
    )
      throw Error('EXISTING_OR_UNCERTAIN_TRADE_SESSION');
  const storageRoot = recovery ? dirname(taskRoot) : taskRoot;
  await tradeStorageGuard(storageRoot, 64 * 1024 ** 2, true);
  const lockPath = join(registry.productDaily.root, 'MARKET_REFRESH.lock'),
    lock = await open(lockPath, 'wx');
  let settled = false,
    result;
  const began = performance.now(),
    wall = Date.now() / 1000;
  try {
    await lock.writeFile(JSON.stringify({ taskId, output, pid: process.pid }));
    await lock.sync();
    await mkdir(output);
    await mkdir(join(output, 'temp'));
    const nonce = randomBytes(32).toString('hex');
    const authority = recovery
      ? { authorityTaskId: authorityId, scopeSha256: pre.scopeSha256, nonce,
          ...(cookies ? { responseCookiePolicyId } : {}) }
      : {};
    await durableJson(marker, {
      taskId,
      ...authority,
      recordedAt: new Date().toISOString(),
      preflightSha256: sha(await readFile(preflightPath)),
      output,
      networkSessionCount: synthetic ? 0 : 1,
    });
    const admission = {
      task: taskId,
      family: 'trade',
      job: 'trade-three-slots',
      jobRoot: output,
      nonce,
      ...authority,
      synthetic,
      startedAtUnixSeconds: wall,
      runtimeFiles: pre.runtimeFiles,
      preflightSha256: sha(await readFile(preflightPath)),
    };
    await durableJson(join(output, 'ADMISSION.json'), admission);
    result = await runJob({
      jobRoot: output,
      admission,
      registry,
      onAdoption,
      spawnChild,
      deadline: began + 598000,
      storageGuard: (bytes) => tradeStorageGuard(storageRoot, bytes ?? 0),
    });
    settled =
      result.source.accounting.status === 'CLOSED' && result.source.accounting.pending === null;
    if (performance.now() >= began + 600000) throw Error('WHOLE_OPERATION_DEADLINE');
  } catch (e) {
    result = { status: 'PARTIAL', failure: String(e), closureUncertain: !settled };
  } finally {
    await lock.close();
    if (settled && !result?.publicationUncertain) await unlink(lockPath);
  }
  result = {
    ...result,
    networkClosureKnown: settled,
    networkSessionCount: synthetic ? 0 : 1,
    noAutomaticRestart: true,
    elapsedSeconds: (performance.now() - began) / 1000,
    indexer: 'PARKED',
  };
  await durableJson(join(output, 'TRIAL_FINAL.json'), result);
  return result;
}
// Application-owned caller supplies its already-running API and admitted paired handles.
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url))
  console.log(
    'No requests. runTrades requires the exact unused reviewed preflight and already-running local application.',
  );
