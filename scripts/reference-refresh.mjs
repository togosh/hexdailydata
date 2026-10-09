// Two finite reference cycles over the maintained native coordinator extension.
import { readFile, mkdir, open, unlink, lstat, statfs } from 'node:fs/promises';
import { resolve, join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { sha } from '../dist/services/source-update/generation.js';
import { durableJson } from './market-refresh.mjs';
import { runJob, guardStorage } from './refresh-data.mjs';
const repo = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const taskId = 'HDD-BTC-ETH-REFERENCE-FEED-R1';
const read = async (p) => JSON.parse(await readFile(p));
async function absent(p) {
  if (
    await lstat(p).catch((e) => {
      if (e.code === 'ENOENT') return null;
      throw e;
    })
  )
    throw Error('EXISTING_OR_UNCERTAIN_REFERENCE_SESSION');
}
export async function runReferences({
  taskRoot,
  preflightPath,
  registry,
  onAdoption,
  spawnChild = spawn,
}) {
  taskRoot = resolve(taskRoot);
  preflightPath = resolve(preflightPath);
  const pre = await read(preflightPath),
    synthetic = spawnChild !== spawn;
  if (
    pre.verdict !== 'PASS' ||
    pre.taskId !== taskId ||
    pre.taskRoot !== taskRoot ||
    Boolean(pre.synthetic) !== synthetic
  )
    throw Error('EXACT_UNUSED_PREFLIGHT');
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
    marker = join(taskRoot, synthetic ? 'SYNTHETIC_ADMISSION.json' : 'PUBLIC_ADMISSION.json');
  await absent(output);
  await absent(marker);
  const disk = await statfs(taskRoot);
  if (disk.bavail * disk.bsize < 20 * 1024 ** 3) throw Error('ADMISSION_DISK');
  await guardStorage(taskRoot);
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
      family: 'reference',
      job: 'reference-two-cycles',
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
      deadline: began + 1140000,
      storageGuard: (bytes) => guardStorage(taskRoot, 512 * 1024 ** 2 + (bytes ?? 0)),
    });
    settled =
      result.source.accounting.status === 'CLOSED' && result.source.accounting.pending === null;
    if (performance.now() >= began + 1200000) throw Error('WHOLE_OPERATION_DEADLINE');
  } catch (e) {
    result = { status: 'PARTIAL', failure: String(e), closureUncertain: !settled };
  } finally {
    await lock.close();
    if (settled) await unlink(lockPath);
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
export async function main(args = process.argv.slice(2)) {
  if (args.length !== 3 || args[0] !== 'run') {
    console.log(
      'No requests. Explicit run TASK_ROOT PREFLIGHT required; consumed sessions never resume.',
    );
    return 0;
  }
  const { openProductDependencies } = await import('../dist/services/product-daily/open.js');
  const deps = await openProductDependencies(await read(join(resolve(args[1]), 'PROFILE.json')));
  try {
    const result = await runReferences({
      taskRoot: args[1],
      preflightPath: args[2],
      registry: deps.participants,
      onAdoption: async (selected, check) => {
        await deps.participants.refresh(undefined, true);
        check();
        return { mode: 'local-reader', ...deps.participants.status() };
      },
    });
    console.log(JSON.stringify(result));
    return result.status === 'QUALIFIED_ADOPTED' ? 0 : 2;
  } finally {
    await deps.close();
  }
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url))
  process.exitCode = await main();
