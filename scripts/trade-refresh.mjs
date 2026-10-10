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
export async function runTrades({
  taskRoot,
  preflightPath,
  registry,
  onAdoption,
  spawnChild = spawn,
  loadedRuntimeFiles,
}) {
  taskRoot = resolve(taskRoot);
  preflightPath = resolve(preflightPath);
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
  if (
    continuation &&
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
    !registry.root.startsWith(taskRoot + '\\') ||
    !registry.productDaily.root.startsWith(taskRoot + '\\')
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
  await tradeStorageGuard(taskRoot, 64 * 1024 ** 2, true);
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
    await durableJson(marker, {
      taskId,
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
      nonce: randomBytes(32).toString('hex'),
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
      storageGuard: (bytes) => tradeStorageGuard(taskRoot, bytes ?? 0),
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
