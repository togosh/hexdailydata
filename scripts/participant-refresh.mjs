// Maintained finite participant driver. No default requests, scheduler or outer retry.
import { readFile, open, lstat } from 'node:fs/promises';
import { resolve, join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import { canonical, sha } from '../dist/services/source-update/generation.js';
import {
  ParticipantUpdateSchema,
  ConsecutiveHolderUpdateSchema,
  ConsecutiveStakeUpdateSchema,
} from '../dist/contracts/participant-update.js';
import { SourceHolderSchema } from '../dist/contracts/source-holders.js';
import { SourceStartSchema } from '../dist/contracts/source-stakes.js';
import { participantTaskCapacity } from './participant-refresh-storage.mjs';
import { durableJson } from './market-refresh.mjs';
const repository = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const same = (a, b) => canonical(a) === canonical(b);
async function bounded(path, maximum = 256 * 1024 * 1024) {
  const s = await lstat(path);
  if (!s.isFile() || s.isSymbolicLink() || s.size > maximum) throw Error('PARTICIPANT_FILE_BOUND');
  return readFile(path);
}

export async function prepareWindow(registry, document, deadline = () => {}) {
  const held = registry.capture();
  try {
    const identity = held.sourceGenerations.identity;
    const expected = {
      number: identity.snapshot.number,
      hash: identity.snapshot.hash,
      timestamp: identity.snapshot.timestamp,
    };
    if (!same(expected, document.base)) throw Error('IMMEDIATELY_SELECTED_BASE');
    const changes = { tokenHolders: [], stakeStarts: [] };
    for (const family of Object.keys(changes)) {
      if (!Array.isArray(document.after[family]) || document.after[family].length > 50000)
        throw Error('CHANGED_KEY_LIMIT');
      let previous = '';
      for (const raw of document.after[family]) {
        deadline();
        const after = (family === 'tokenHolders' ? SourceHolderSchema : SourceStartSchema).parse(
          raw,
        );
        if (after.id <= previous) throw Error('CHANGED_ID_ORDER');
        previous = after.id;
        const old = await held.sourceGenerations.bySourceId(
          family,
          after.id,
          new AbortController().signal,
        );
        const before = old?.reported ?? null;
        const changedFields = before
          ? Object.keys(after).filter((k) => !same(before[k], after[k]))
          : Object.keys(after);
        const entry = {
          operation: 'upsert',
          id: after.id,
          family,
          kind: !before ? 'new' : changedFields.length ? 'replacement' : 'unchanged_overlap',
          before,
          after,
          beforeProvenance: before
            ? { generation: identity.generation, rowSha256: sha(canonical(before)) }
            : null,
          afterProvenance: document.provenance[family][after.id],
          changedFields,
        };
        changes[family].push(
          (family === 'tokenHolders'
            ? ConsecutiveHolderUpdateSchema
            : ConsecutiveStakeUpdateSchema
          ).parse(entry),
        );
      }
    }
    return {
      schemaVersion: 2,
      complete: true,
      predecessor: identity.generation,
      base: document.base,
      target: document.target,
      deployment: identity.snapshot.deployment,
      changes,
      sourceCounts: document.sourceCounts,
      fullTargetInventoryProven: false,
      deletionsSupported: false,
      reorgSafetyProven: false,
    };
  } finally {
    held.release();
  }
}

export async function runParticipantRefresh({
  taskRoot,
  preflightPath,
  registry,
  onAdoption,
  spawnChild = spawn,
}) {
  taskRoot = resolve(taskRoot);
  const output = join(taskRoot, 'session');
  const synthetic = spawnChild !== spawn;
  const preflight = JSON.parse(await bounded(preflightPath, 1024 * 1024));
  if (
    preflight.verdict !== 'PASS' ||
    !['HDD-PARTICIPANT-CATCHUP-REFRESH-R1', 'HDD-PARTICIPANT-CATCHUP-REFRESH-R2'].includes(preflight.taskId) ||
    preflight.trialRoot !== output ||
    Boolean(preflight.synthetic) !== synthetic
  )
    throw Error('PUBLIC_PREFLIGHT_REQUIRED');
  for (const [p, h] of Object.entries(preflight.runtimeFiles))
    if (sha(await readFile(join(repository, p))) !== h) throw Error('FROZEN_RUNTIME_CHANGED');
  for (const [p, h] of Object.entries(preflight.inputFiles))
    if (sha(await readFile(join(taskRoot, p))) !== h) throw Error('FROZEN_INPUT_CHANGED');
  if (
    registry.status().generation !== preflight.initialGeneration ||
    registry.status().productVersion !== preflight.initialProductVersion
  )
    throw Error('INITIAL_PAIR_CHANGED');
  const storageReservation = await participantTaskCapacity(taskRoot, 6.25 * 1024 ** 3);
  await durableJson(join(taskRoot, 'evidence/STORAGE_RESERVATION.json'), storageReservation);
  await durableJson(join(taskRoot, 'PUBLIC_DRIVER_ADMISSION.json'), {
    taskId: preflight.taskId,
    preflightSha256: sha(await readFile(preflightPath)),
    beganAt: new Date().toISOString(),
    output,
  });
  const began = performance.now(),
    deadline = began + 5400000;
  let child,
    stopped = false,
    collectorExited = false,
    completion,
    timer,
    emergencyClosure,
    closedMessage,
    handler = Promise.resolve(),
    error = null;
  const publications = [];
  let stderr = '';
  const active = () => {
    if (
      stopped ||
      collectorExited ||
      (child?.exitCode !== null && child?.exitCode !== undefined) ||
      child?.signalCode ||
      performance.now() >= deadline
    )
      throw Error('PUBLIC_DRIVER_DEADLINE');
  };
  const env = Object.fromEntries(
    ['SystemRoot', 'WINDIR', 'COMSPEC']
      .filter((k) => process.env[k])
      .map((k) => [k, process.env[k]]),
  );
  env.TEMP = join(taskRoot, 'temp');
  env.TMP = env.TEMP;
  env.PYTHONIOENCODING = 'utf-8';
  try {
    child = spawnChild(
      'python',
      [
        '-I',
        '-S',
        join(repository, 'scripts/participant-refresh/collector.py'),
        'run',
        output,
        preflightPath,
      ],
      {
        cwd: repository,
        env,
        stdio: ['pipe', 'pipe', 'pipe'],
        windowsHide: true,
      },
    );
    const terminateOwnedTree = () => {
      stopped = true;
      child.stdin.end();
      return new Promise((resolve) => {
        const killer = spawn(
          join(process.env.SystemRoot ?? process.env.SYSTEMROOT, 'System32', 'taskkill.exe'),
          ['/PID', String(child.pid), '/T', '/F'],
          { windowsHide: true, stdio: 'ignore', timeout: 1500 },
        );
        killer.once('error', (e) => resolve({ error: String(e) }));
        killer.once('close', (code, signal) => resolve({ code, signal }));
      });
    };
    timer = setTimeout(
      () => {
        emergencyClosure = terminateOwnedTree();
      },
      Math.max(1, deadline - performance.now() - 4000),
    ).unref();
    child.once('exit', () => {
      collectorExited = true;
    });
    child.stdin.on('error', (e) => {
      error ??= String(e);
    });
    child.stderr.on('data', (b) => {
      if (stderr.length < 16384) stderr += b.toString().slice(0, 16384 - stderr.length);
    });
    completion = new Promise((accept) => {
      child.once('error', (e) => {
        collectorExited = true;
        accept({ code: null, spawnError: String(e) });
      });
      child.once('close', (code, signal) => accept({ code, signal }));
    });
    const lines = createInterface({ input: child.stdout, crlfDelay: Infinity });
    lines.on('line', (line) => {
      handler = handler
        .then(async () => {
          if (line.length > 1024 * 1024) throw Error('COLLECTOR_STDOUT_LIMIT');
          const message = JSON.parse(line);
          if (message.type === 'closed') {
            closedMessage = message.result;
            return;
          }
          active();
          const i = message.window;
          if (!Number.isInteger(i) || i < 1 || i > 7) throw Error('WINDOW_ORDINAL');
          const remaining = message.expiresAtUnixSeconds * 1000 - Date.now();
          if (!Number.isFinite(remaining) || remaining <= 0 || remaining > 181000)
            throw Error('LOCAL_PHASE_DEADLINE');
          const stopAt = performance.now() + Math.min(180000, remaining);
          const check = () => {
            active();
            if (performance.now() >= stopAt) throw Error('LOCAL_PHASE_DEADLINE');
          };
          if (message.type === 'prepare') {
            const raw = await bounded(join(output, `WINDOW_${i}_AFTER.json`));
            if (sha(raw) !== message.afterSha256) throw Error('CAPTURED_AFTER_IDENTITY');
            await participantTaskCapacity(taskRoot, 512 * 1024 ** 2);
            check();
            const draft = await prepareWindow(registry, JSON.parse(raw), check);
            await durableJson(join(output, `WINDOW_${i}_DRAFT.json`), draft);
            check();
            child.stdin.write(JSON.stringify({ ok: true, window: i }) + '\n');
          } else if (message.type === 'qualified') {
            const raw = await bounded(join(output, `WINDOW_${i}_AUDIT.json`), 65536),
              proof = JSON.parse(raw);
            if (
              sha(raw) !== message.auditFileSha256 ||
              sha(canonical(proof)) !== message.proofSha256
            )
              throw Error('SAVED_AUDIT_IDENTITY');
            const draft = JSON.parse(await bounded(join(output, `WINDOW_${i}_DRAFT.json`)));
            const update = ParticipantUpdateSchema.parse({
              ...draft,
              proofSha256: message.proofSha256,
            });
            await durableJson(join(output, `WINDOW_${i}_UPDATE.json`), update);
            await participantTaskCapacity(taskRoot, 512 * 1024 ** 2);
            check();
            const admitted = await registry.publish(update, proof, {
              beforeCommit: check,
              captureReference: {
                output,
                update: `WINDOW_${i}_UPDATE.json`,
                updateSha256: sha(await readFile(join(output, `WINDOW_${i}_UPDATE.json`))),
                audit: `WINDOW_${i}_AUDIT.json`,
                auditSha256: sha(raw),
              },
            });
            check();
            const adoption = await onAdoption(admitted.selected, check);
            check();
            if (registry.status().generation !== admitted.selected.generation)
              throw Error('PAIR_ADOPTION_UNKNOWN');
            const receipt = {
              window: i,
              selected: admitted.selected,
              adoption,
              publication: admitted.publication,
              at: new Date().toISOString(),
            };
            await durableJson(join(output, `ADOPTION_${i}.json`), receipt);
            publications.push(receipt);
            child.stdin.write(
              JSON.stringify({
                ok: true,
                window: i,
                generation: admitted.selected.generation,
                productVersion: admitted.selected.product.version,
              }) + '\n',
            );
          } else throw Error('UNKNOWN_COLLECTOR_PHASE');
        })
        .catch((e) => {
          error ??= e instanceof Error ? e.message : String(e);
          // A refusal closes this public session; it is never a request for a replacement query.
          if (child.stdin.writable)
            child.stdin.write(JSON.stringify({ ok: false, reason: error }) + '\n');
        });
    });
    const settled = await completion;
    await handler;
    clearTimeout(timer);
    if (emergencyClosure) await emergencyClosure;
    stopped = true;
    lines.close();
    const result = JSON.parse(await bounded(join(output, 'RESULT.json'), 2 * 1024 * 1024));
    const accounting = JSON.parse(await bounded(join(output, 'ACCOUNTING.json'), 65536));
    if (
      !same(result, closedMessage) ||
      !same(accounting, result.accounting) ||
      !Number.isInteger(settled.code) ||
      ![0, 2].includes(settled.code) ||
      settled.signal ||
      accounting.status !== 'CLOSED' ||
      accounting.pending !== null
    )
      throw Error('NATIVE_OR_NETWORK_CLOSURE_UNKNOWN');
    const report = {
      status: result.status,
      exit: settled,
      source: result,
      publications,
      error,
      stderr,
      elapsedSeconds: (performance.now() - began) / 1000,
      externalSessionCount: synthetic ? 0 : 1,
      synthetic,
      noAutomaticRestart: true,
    };
    await durableJson(join(taskRoot, 'evidence/DRIVER_RESULT.json'), report);
    return report;
  } finally {
    stopped = true;
    if (child && completion) {
      child.stdin.end();
      const wait = (ms) => new Promise((resolve) => setTimeout(() => resolve(null), ms).unref());
      let closed = await Promise.race([completion, wait(32000)]);
      if (!closed) {
        emergencyClosure ??= new Promise((resolve) => {
          const killer = spawn(
            join(process.env.SystemRoot ?? process.env.SYSTEMROOT, 'System32', 'taskkill.exe'),
            ['/PID', String(child.pid), '/T', '/F'],
            { windowsHide: true, stdio: 'ignore', timeout: 1500 },
          );
          killer.once('error', (e) => resolve({ error: String(e) }));
          killer.once('close', (code, signal) => resolve({ code, signal }));
        });
        await emergencyClosure;
        closed = await Promise.race([completion, wait(2000)]);
      }
      clearTimeout(timer);
      if (!closed) throw Error('OWNED_TREE_CLOSURE_UNKNOWN');
    }
  }
}

export async function main(args = process.argv.slice(2)) {
  if (args.length !== 3 || args[0] !== 'run') {
    console.log('Explicit run TASK_ROOT PREFLIGHT required; no default acquisition.');
    return 2;
  }
  const { openProductDependencies } = await import('../dist/services/product-daily/open.js');
  const profile = JSON.parse(await readFile(join(resolve(args[1]), 'PARTICIPANT_PROFILE.json')));
  const deps = await openProductDependencies(profile);
  try {
    const result = await runParticipantRefresh({
      taskRoot: args[1],
      preflightPath: args[2],
      registry: deps.participants,
      onAdoption: async (selected, check) => {
        await deps.participants.refresh(undefined, true);
        check();
        return { generation: deps.participants.status().generation, mode: 'local-reader' };
      },
    });
    console.log(
      JSON.stringify({
        status: result.status,
        completedWindows: result.source.completedWindows,
        accounting: result.source.accounting,
      }),
    );
    return result.status === 'COMPLETE_SCOPED_CATCHUP' ? 0 : 2;
  } finally {
    await deps.close();
  }
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url))
  process.exitCode = await main();
