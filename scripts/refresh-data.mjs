import {
  publishTrade,
  admitTradeMarkets,
  tradeProfile,
  isOperatingAuthority,
  operatingR2TaskId,
} from './trade-publication.mjs';
// One explicit finite operation. Status/default makes no provider requests.
import { readFile, mkdir, open, rename, unlink, statfs, lstat, readdir } from 'node:fs/promises';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  publicAuthority,
  publicR3,
  publicR4,
  validatePublicReady,
  publicAdmission,
} from './unified-refresh/public-profile.mjs';
import { randomBytes } from 'node:crypto';
import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import { canonical, sha } from '../dist/services/source-update/generation.js';
import { ParticipantUpdateSchema } from '../dist/contracts/participant-update.js';
import { validateLedgerSegments } from '../dist/services/product-daily/market.js';
import { durableJson, publishCycle } from './market-refresh.mjs';
import { publishGas } from './gas-publication.mjs';
import { publishProtocol } from './protocol-publication.mjs';
import { publishReference } from './reference-publication.mjs';
import { prepareWindow } from './participant-refresh.mjs';
import {
  profileId,
  profileTask,
  validateProfile,
  unifiedAdmission,
  clipJob,
  counterKeys,
} from './unified-refresh/profile.mjs';
const repo = resolve(dirname(fileURLToPath(import.meta.url)), '..');
import {
  OperatingOwner,
  operatingTask,
  operatingFormat,
  operatingFamilies,
  validateOperating,
  operatingStatus,
} from './unified-refresh/operating.mjs';
import {
  liveOperating,
  liveOperatingFormat,
  boundaryOperatingFormat,
  operatingPolicy,
  boundedOperatingConfig,
  validateOperatingReady,
  RealOperatingClock,
} from './unified-refresh/operating-authority.mjs';
const taskId = 'HDD-UNIFIED-REFRESH-OPERATION-R1';
const order = [
  'market-1',
  'gas-1',
  'protocol-1',
  'participants-1',
  'market-2',
  'gas-2',
  'protocol-2',
];
const same = (a, b) => canonical(a) === canonical(b);
const read = async (p) => JSON.parse(await readFile(p));
async function replace(path, value) {
  const stage = path + '.stage';
  await durableJson(stage, value);
  await rename(stage, path);
}
async function absent(path) {
  if (
    await lstat(path).catch((e) => {
      if (e.code === 'ENOENT') return null;
      throw e;
    })
  )
    throw Error('EXISTING_OR_UNCERTAIN_OPERATION');
}

export async function guardStorage(root, reservation = 512 * 1024 ** 2) {
  let bytes = 0,
    entries = 0;
  async function walk(dir) {
    for (const e of await readdir(dir, { withFileTypes: true })) {
      if (++entries > 100000 || e.isSymbolicLink())
        throw Error('TASK_STORAGE_OWNERSHIP_OR_ENTRY_BOUND');
      const path = join(dir, e.name);
      if (e.isDirectory()) await walk(path);
      else if (e.isFile()) bytes += (await lstat(path)).size;
      else throw Error('TASK_STORAGE_SPECIAL_FILE');
    }
  }
  await walk(root);
  const disk = await statfs(root),
    free = disk.bavail * disk.bsize;
  if (bytes + reservation > 8 * 1024 ** 3 || free - reservation < 10 * 1024 ** 3)
    throw Error('TASK_STORAGE_RESERVE');
  return { bytes, entries, reservation, free };
}

/** Exact words come from accepted append segments; no packed arithmetic reconstruction. */
export function admittedInputs(held, firstGasRound, contexts = {}) {
  const m = held.product.metadata;
  validateLedgerSegments(held.product.rows, m);
  const protocol = m.readings.find((r) => r.kind === 'protocol');
  const segments = m.ledgerSegments ?? [];
  let end = 2498,
    words = [];
  for (const segment of segments) {
    if (segment.from !== end) throw Error('LEDGER_SEED_CHAIN');
    end += segment.words.length;
    words = [...words, ...segment.words].slice(-2);
  }
  if (
    end < 2502 ||
    words.length !== 2 ||
    m.coverage.ledgerDates !== end ||
    !protocol ||
    Number(protocol.globalWords[4]) !== end
  )
    throw Error('ADMITTED_2502_LEDGER_REQUIRED');
  const market = m.readings.find((r) => r.kind === 'market' && r.asset === 'HEX');
  const gas = m.readings.find((r) => r.kind === 'gas');
  if (!market || !gas) throw Error('GENUINE_FEED_SEED_REQUIRED');
  const snapshot = held.sourceGenerations.identity.snapshot;
  return {
    product: { version: held.product.version, manifestSha256: held.product.manifestSha256 },
    participant: {
      generation: held.sourceGenerations.selection,
      base: { number: snapshot.number, hash: snapshot.hash, timestamp: snapshot.timestamp },
    },
    protocol: { number: protocol.blockNumber, end, tail: words },
    market: {
      number: contexts.market?.number ?? null,
      timestamp: Math.floor(Date.parse(market.observedAtUtc) / 1000),
    },
    gas: {
      number: contexts.gas?.number ?? null,
      observedAtUtc: gas.observedAtUtc,
      firstRound: firstGasRound,
    },
  };
}

export async function runUnified({
  taskRoot,
  preflightPath,
  registry,
  onAdoption,
  spawnChild = spawn,
  profile,
  clock,
  onFact,
  signal,
  loadedRuntimeFiles,
}) {
  if (profile !== undefined)
    return runFiniteProfile({
      taskRoot,
      registry,
      onAdoption,
      spawnChild,
      profile,
      clock,
      onFact,
      signal,
      preflightPath,
      loadedRuntimeFiles,
    });
  taskRoot = resolve(taskRoot);
  preflightPath = resolve(preflightPath);
  const pre = await read(preflightPath),
    plan = await read(join(taskRoot, 'REQUEST_PLAN.json'));
  const synthetic = spawnChild !== spawn;
  if (
    pre.verdict !== 'PASS' ||
    pre.taskId !== taskId ||
    pre.taskRoot !== taskRoot ||
    Boolean(pre.synthetic) !== synthetic ||
    !same(plan.order, order)
  )
    throw Error('EXACT_UNUSED_PREFLIGHT_REQUIRED');
  for (const [p, h] of Object.entries(pre.runtimeFiles))
    if (sha(await readFile(join(repo, p))) !== h) throw Error('FROZEN_RUNTIME_CHANGED');
  for (const [p, h] of Object.entries(pre.inputFiles))
    if (sha(await readFile(join(taskRoot, p))) !== h) throw Error('FROZEN_INPUT_CHANGED');
  if (
    !registry ||
    registry.status().generation !== pre.initialGeneration ||
    registry.status().productVersion !== pre.initialProductVersion
  )
    throw Error('GENUINE_INITIAL_SELECTION_CHANGED');
  if (
    !registry.root.startsWith(taskRoot + '\\') ||
    !registry.productDaily.root.startsWith(taskRoot + '\\')
  )
    throw Error('TASK_OWNERSHIP');
  const output = join(taskRoot, 'session');
  const admissionName = synthetic ? 'SYNTHETIC_ADMISSION.json' : 'PUBLIC_ADMISSION.json';
  await absent(output);
  await absent(join(taskRoot, admissionName));
  const disk = await statfs(taskRoot);
  if (disk.bavail * disk.bsize < 20 * 1024 ** 3) throw Error('ADMISSION_DISK');
  await guardStorage(taskRoot, 2560 * 1024 ** 2);
  // Same location as maintained market operators; all coordinated operators take it first.
  const lock = await open(join(registry.productDaily.root, 'MARKET_REFRESH.lock'), 'wx');
  let settled = false;
  const began = performance.now(),
    wall = Date.now() / 1000,
    deadline = began + 3600000;
  let parent = {
    status: 'ADMITTED',
    mode: synthetic ? 'SYNTHETIC_OFFLINE_TEST' : 'OWNER_AUTHORIZED_PUBLIC',
    startedAt: new Date().toISOString(),
    networkSessionCount: synthetic ? 0 : 1,
    networkClosesAtUnixSeconds: wall + 3420,
    job: null,
    pending: null,
    lastClosedMonotonic: null,
    attempts: 0,
    extraAttempts: 0,
    graphAttempts: 0,
    rpcAttempts: 0,
    graphExtras: 0,
    rpcExtras: 0,
    graphChargedBytes: 0,
    rpcChargedBytes: 0,
    chargedEntities: 0,
    observedBytes: 0,
    returnedEntities: 0,
    unknownEntityReservations: 0,
    rpcEndpointAttempts: [0, 0],
  };
  const jobs = [],
    disabled = new Set(),
    lastStarts = {},
    contexts = {};
  let failure = null,
    childOutstanding = false;
  try {
    await lock.writeFile(canonical({ taskId, pid: process.pid, output }));
    await lock.sync();
    await mkdir(output);
    await durableJson(join(taskRoot, admissionName), {
      taskId,
      synthetic,
      recordedAt: parent.startedAt,
      preflightSha256: sha(await readFile(preflightPath)),
      planSha256: sha(await readFile(join(taskRoot, 'REQUEST_PLAN.json'))),
      output,
      maximumParentSessions: 1,
    });
    await durableJson(join(output, 'PARENT_ACCOUNTING.json'), parent);
    for (const name of order) {
      const family = name.split('-')[0];
      if (disabled.has(family)) {
        jobs.push({ job: name, status: 'SKIPPED_DISABLED_FEED' });
        continue;
      }
      await guardStorage(taskRoot, 2560 * 1024 ** 2);
      if (performance.now() - began >= 2700000) throw Error('PARENT_NEW_JOB_CUTOFF');
      if (lastStarts[family] && performance.now() - lastStarts[family] < 60000)
        await new Promise((r) => setTimeout(r, 60000 - (performance.now() - lastStarts[family])));
      await registry.refresh(undefined, true);
      if (performance.now() - began >= 2700000) throw Error('PARENT_NEW_JOB_CUTOFF');
      if (registry.status().error) throw Error('SELECTOR_INTEGRITY: ' + registry.status().error);
      const held = registry.capture();
      let initial;
      try {
        initial = admittedInputs(held, name === 'gas-1', contexts);
      } finally {
        held.release();
      }
      if (family === 'participants' && initial.participant.base.number !== 27750329)
        throw Error('PARTICIPANT_WINDOW_ALREADY_APPLIED');
      parent = await read(join(output, 'PARENT_ACCOUNTING.json'));
      if (parent.pending !== null || parent.status !== 'ADMITTED')
        throw Error('PARENT_NOT_SETTLED');
      const allowance = { ...plan.limits[family] };
      for (const [k, max] of Object.entries(plan.global))
        allowance[k] = Math.min(allowance[k], max - parent[k]);
      const jobBegan = performance.now(),
        elapsed = (jobBegan - began) / 1000;
      const childDeadline = Math.min(began + 3420000, jobBegan + allowance.seconds * 1000);
      const networkDeadline = Math.min(
        began + 3300000,
        childDeadline - (allowance.publication + 5) * 1000,
      );
      allowance.seconds = (childDeadline - jobBegan) / 1000;
      const networkSeconds = (networkDeadline - jobBegan) / 1000;
      if (networkSeconds <= 0) throw Error('PARENT_CONTROL_RESERVE');
      const jobRoot = join(output, name);
      await mkdir(jobRoot);
      await mkdir(join(jobRoot, 'temp'));
      const admission = {
        task: taskId,
        combinedJob: true,
        job: name,
        family,
        jobRoot,
        nonce: randomBytes(32).toString('hex'),
        initial,
        allowance,
        networkSeconds,
        synthetic,
        deadlineUnixSeconds: wall + (childDeadline - began) / 1000,
        networkClosesAtUnixSeconds: wall + (networkDeadline - began) / 1000,
        runtimeFiles: pre.runtimeFiles,
        sourceFiles: pre.marketSourceFiles,
        preflightSha256: sha(await readFile(preflightPath)),
      };
      if (family === 'participants') {
        const participantPlan = { ...plan.participant, base: initial.participant.base };
        await durableJson(join(jobRoot, 'PLAN.json'), participantPlan);
        admission.planSha256 = sha(await readFile(join(jobRoot, 'PLAN.json')));
        await durableJson(join(jobRoot, 'FRONTIER.json'), {
          completedWindows: 0,
          pin: participantPlan.base,
          generation: initial.participant.generation,
          productVersion: initial.product.version,
        });
      }
      await durableJson(join(jobRoot, 'ADMISSION.json'), admission);
      parent.job = name;
      parent.jobAdmissionSha256 = sha(await readFile(join(jobRoot, 'ADMISSION.json')));
      await replace(join(output, 'PARENT_ACCOUNTING.json'), parent);
      if (performance.now() - began >= 2700000 || performance.now() >= networkDeadline)
        throw Error('PARENT_DISPATCH_CUTOFF');
      lastStarts[family] = performance.now();
      childOutstanding = true;
      const result = await runJob({
        jobRoot,
        admission,
        registry,
        onAdoption,
        spawnChild,
        deadline: childDeadline,
        storageGuard: (bytes = 0) => guardStorage(taskRoot, 512 * 1024 ** 2 + bytes),
      });
      childOutstanding = false;
      jobs.push({ job: name, ...result });
      if (result.status === 'QUALIFIED_ADOPTED' && ['gas', 'market'].includes(family)) {
        const receipt = result.publications[0].publication;
        contexts[family] = family === 'market' ? receipt.pin : receipt.contextualBlock;
      }
      await durableJson(join(jobRoot, 'JOB_RESULT.json'), result);
      console.log(
        JSON.stringify({
          job: name,
          status: result.status,
          attempts: result.source.accounting.attempts,
          selected: registry.status(),
        }),
      );
      if (result.status !== 'QUALIFIED_ADOPTED') {
        if (result.source.feedLocalClosedExhaustion && result.publications.length === 0) {
          const p = await read(join(registry.root, 'CURRENT.json'));
          if (p.generation !== initial.participant.generation || !same(p.product, initial.product))
            throw Error('FAILED_JOB_SELECTION_CHANGED');
          disabled.add(family);
        } else throw Error(result.source.failure ?? 'Unqualified combined job');
      }
    }
  } catch (e) {
    failure = String(e);
  } finally {
    try {
      parent = await read(join(output, 'PARENT_ACCOUNTING.json'));
      if (childOutstanding || parent.pending !== null || parent.status !== 'ADMITTED') {
        parent.status = 'CLOSURE_OR_PUBLICATION_UNKNOWN';
        parent.failure = failure;
        await replace(join(output, 'PARENT_ACCOUNTING.json'), parent);
        throw Error('PARENT_UNKNOWN_CLOSURE');
      }
      parent.status = 'CLOSED';
      parent.closedAt = new Date().toISOString();
      parent.elapsedSeconds = (performance.now() - began) / 1000;
      parent.closureReason =
        failure ??
        (disabled.size
          ? 'Known closed feed exhaustion; remaining listed jobs settled'
          : 'All seven listed jobs qualified and adopted');
      await replace(join(output, 'PARENT_ACCOUNTING.json'), parent);
      settled = true;
    } catch (e) {
      failure ??= String(e);
    }
    await lock.close();
    if (settled) await unlink(join(registry.productDaily.root, 'MARKET_REFRESH.lock'));
  }
  const result = {
    status: !failure && !disabled.size && jobs.length === 7 ? 'COMBINED_TRIAL_PASS' : 'PARTIAL',
    jobs,
    failure,
    accounting: parent,
    disabledFeeds: [...disabled],
    networkClosureKnown: settled,
    networkSessionCount: synthetic ? 0 : 1,
    synthetic,
    noAutomaticRestart: true,
    indexer: 'PARKED',
  };
  await durableJson(join(output, 'RESULT.json'), result);
  return result;
}

// Versioned finite extension of this coordinator. There is deliberately no live
// admission for this profile: a future public packet must supply a new binding.
async function runFiniteProfile({
  taskRoot,
  registry,
  onAdoption,
  spawnChild,
  profile,
  clock,
  onFact,
  signal,
  preflightPath,
  loadedRuntimeFiles,
}) {
  profile = validateProfile(profile);
  taskRoot = resolve(taskRoot);
  const authority = publicAuthority(profile.format);
  const live = Boolean(authority),
    publicTask = authority?.task;
  let publicPre;
  if (live) {
    if (spawnChild !== spawn || clock !== undefined || typeof onFact !== 'function')
      throw Error('PUBLIC_REAL_CLOCK_TRANSPORT_REQUIRED');
    publicPre = await validatePublicReady({
      taskRoot,
      registry,
      preflightPath,
      loadedRuntimeFiles,
      repo,
    });
    clock = {
      mode: 'REAL',
      now: () => performance.now() / 1000,
      sleep: (n) => new Promise((r) => setTimeout(r, n * 1000)),
    };
  } else if (spawnChild === spawn || clock?.mode !== 'SYNTHETIC' || typeof onFact !== 'function')
    throw Error('OFFLINE_NATIVE_FIXTURE_REQUIRED');
  for (const root of [registry.root, registry.productDaily.root])
    if (!root.startsWith(taskRoot + '\\')) throw Error('TASK_OWNERSHIP');
  const output = join(taskRoot, 'session'),
    lockPath = join(registry.productDaily.root, 'MARKET_REFRESH.lock');
  await absent(output);
  await absent(join(taskRoot, live ? 'PUBLIC_ADMISSION.json' : 'SYNTHETIC_ADMISSION.json'));
  if (live) {
    const disk = await statfs(taskRoot);
    if (disk.bavail * disk.bsize < 20 * 1024 ** 3) throw Error('ADMISSION_DISK');
  }
  await guardStorage(taskRoot, 128 * 1024 ** 2);
  const profileSha256 = sha(canonical(profile));
  const runtimeFiles = {},
    sourceFiles = {};
  for (const folder of [
    'unified-refresh',
    'trade-feed',
    'market-refresh',
    'gas-feed',
    'protocol-feed',
    'participant-refresh',
  ])
    for (const e of await readdir(join(repo, 'scripts', folder), { withFileTypes: true }))
      if (e.isFile() && /\.(py|json|mjs)$/.test(e.name)) {
        const path = `scripts/${folder}/${e.name}`,
          hash = sha(await readFile(join(repo, path)));
        runtimeFiles[path] = hash;
        if (folder === 'market-refresh' && /\.(py|json)$/.test(e.name)) sourceFiles[e.name] = hash;
      }
  if (live) Object.assign(runtimeFiles, publicPre.runtimeFiles);
  const lock = await open(lockPath, 'wx');
  const parentNonce = live ? randomBytes(32).toString('hex') : undefined;
  let settled = false,
    outstanding = false,
    failure = null,
    cancelled = false;
  const began = clock.now(),
    beganMonotonic = performance.now(),
    wall = Date.now() / 1000,
    contexts = {},
    disabled = new Set(),
    jobs = [];
  let parent = {
    status: 'ADMITTED',
    mode: live ? 'OWNER_AUTHORIZED_PUBLIC' : 'SYNTHETIC_OFFLINE_PROFILE',
    taskId: live ? publicTask : profileTask,
    ...(live ? { nonce: parentNonce, preflightSha256: publicPre.preflightSha256 } : {}),
    profileSha256,
    limits: profile.parent,
    startedAt: new Date().toISOString(),
    networkSessionCount: live ? 1 : 0,
    networkClosesAtUnixSeconds: wall + profile.parent.seconds - profile.parent.closingReserve,
    job: null,
    pending: null,
    lastClosedMonotonic: null,
    attempts: 0,
    extraAttempts: 0,
    ...Object.fromEntries(counterKeys.map((k) => [k, 0])),
    observedBytes: 0,
    returnedEntities: 0,
    unknownEntityReservations: 0,
    rpcEndpointAttempts: [0, 0],
  };
  try {
    await lock.writeFile(
      canonical({ taskId: live ? publicTask : profileTask, pid: process.pid, output }),
    );
    await lock.sync();
    await durableJson(join(taskRoot, live ? 'PUBLIC_ADMISSION.json' : 'SYNTHETIC_ADMISSION.json'), {
      taskId: live ? publicTask : profileTask,
      profileSha256,
      output,
      synthetic: !live,
      networkSessionCount: live ? 1 : 0,
      publicAuthority: live,
      ...(live
        ? {
            nonce: parentNonce,
            preflightSha256: publicPre.preflightSha256,
            scopeSha256: publicPre.scopeSha256,
            startedAt: parent.startedAt,
          }
        : {}),
    });
    await mkdir(output);
    await durableJson(join(output, 'PROFILE.json'), profile);
    await durableJson(join(output, 'PARENT_ACCOUNTING.json'), parent);
    for (const j of profile.jobs) {
      const nextDue =
        profile.jobs.find((x) => x.enabled && x.family === j.family && x.due > j.due)?.due ?? null;
      const skip = async (reason) => {
        const fact = {
          job: j.id,
          family: j.family,
          status: 'SKIPPED',
          reason,
          nextDue,
          due: j.due,
          deadline: j.deadline,
          elapsed: clock.now() - began,
          closure: 'NO_CHILD',
          publication: 'retained',
          operating: await onFact(j, null),
        };
        jobs.push(fact);
        await durableJson(join(output, j.id + '-SKIPPED.json'), fact);
      };
      if (signal?.aborted) {
        cancelled = true;
        await skip('CANCELLED');
        break;
      }
      if (!j.enabled || disabled.has(j.family)) {
        await skip(!j.enabled ? 'DISABLED_PROFILE' : 'DISABLED_CLOSED_FAILURE');
        continue;
      }
      await clock.sleep(Math.max(0, j.due - (clock.now() - began)));
      const elapsed = clock.now() - began;
      if (elapsed > j.due + j.maximumStartLag || elapsed >= j.deadline) {
        await skip('MISSED_DUE_NO_CATCHUP');
        continue;
      }
      parent = await read(join(output, 'PARENT_ACCOUNTING.json'));
      if (parent.pending !== null || parent.status !== 'ADMITTED')
        throw Error('PARENT_NOT_SETTLED');
      const allowance = clipJob(profile, j, parent, elapsed);
      if (!allowance) {
        await skip('PARENT_OR_CLOSURE_RESERVE');
        continue;
      }
      // Preparation consumes the same allowance; it cannot renew the job clock.
      const finishOffset = elapsed + allowance.seconds,
        childDeadline = beganMonotonic + finishOffset * 1000;
      await registry.refresh(undefined, true);
      if (registry.status().error) throw Error('SELECTOR_INTEGRITY');
      const held = registry.capture();
      let initial;
      try {
        initial = admittedInputs(held, !contexts.gas, contexts);
      } finally {
        held.release();
      }
      if (
        j.family === 'participants' &&
        !(
          j.target > initial.participant.base.number &&
          j.target - initial.participant.base.number <= 4096
        )
      )
        throw Error('BOUNDED_PARTICIPANT_TARGET');
      const jobRoot = join(output, j.id);
      await mkdir(jobRoot);
      await mkdir(join(jobRoot, 'temp'));
      const a = {
        task: j.family === 'trade' ? 'HDD-BTC-ETH-CURRENT-REFERENCE-FRESHNESS-R2' : taskId,
        authorityTaskId: live ? publicTask : profileTask,
        unifiedProfileId: profile.format,
        parentMode: live ? 'OWNER_AUTHORIZED_PUBLIC' : 'OFFLINE_ONLY',
        parentProfileSha256: profileSha256,
        synthetic: !live,
        ...(live
          ? {
              parentNonce,
              preflightSha256: publicPre.preflightSha256,
              scopeSha256: publicPre.scopeSha256,
            }
          : {}),
        combinedJob: true,
        job: j.id,
        family: j.family,
        jobRoot,
        nonce: randomBytes(32).toString('hex'),
        initial,
        allowance,
        parentLimits: profile.parent,
        runtimeFiles,
        sourceFiles,
        startedAtUnixSeconds: Date.now() / 1000,
        deadlineUnixSeconds: wall + finishOffset,
        networkClosesAtUnixSeconds: wall + finishOffset - allowance.publication - 5,
        networkSeconds: wall + finishOffset - allowance.publication - 5 - Date.now() / 1000,
        ...(j.family === 'trade'
          ? {
              tradeSlot: j.tradeSlot,
              tradeProfileId: 'unified-single-pair-1',
              responseCookiePolicyId: 'ignore-response-cookies-no-replay-v1',
            }
          : {}),
      };
      if (j.family === 'participants') {
        const plan = {
          combinedJob: true,
          unifiedProfileId: profile.format,
          base: initial.participant.base,
          finalTarget: { number: j.target, hash: null, timestamp: null },
          windows: [
            {
              fromInclusive: initial.participant.base.number,
              targetNumber: j.target,
              newBlockSpan: j.target - initial.participant.base.number,
            },
          ],
          graphqlEndpoint: 'https://graph.pulsechain.com/subgraphs/name/pulsechain/hex',
          rpcEndpoints: ['https://rpc.pulsechain.com/', 'https://rpc-pulsechain.g4mm4.io/'],
          deployment: 'QmSsv8uvNLbfJCQARk7xd9iNouNmaoqZCrqEwRaFCHJMCw',
          maximumBlockStep: 4096,
          limits: { maximumAffectedParents: 50000, maximumChangedKeysPerFamily: 100000 },
        };
        await durableJson(join(jobRoot, 'PLAN.json'), plan);
        a.planSha256 = sha(await readFile(join(jobRoot, 'PLAN.json')));
        await durableJson(join(jobRoot, 'FRONTIER.json'), {
          completedWindows: 0,
          pin: plan.base,
          generation: initial.participant.generation,
          productVersion: initial.product.version,
        });
      }
      await durableJson(join(jobRoot, 'ADMISSION.json'), a);
      parent.job = j.id;
      parent.jobAdmissionSha256 = sha(await readFile(join(jobRoot, 'ADMISSION.json')));
      await replace(join(output, 'PARENT_ACCOUNTING.json'), parent);
      const dispatchOffset = clock.now() - began;
      const dispatchRefusal = signal?.aborted
        ? 'CANCELLED_DURING_PREPARATION'
        : dispatchOffset > j.due + j.maximumStartLag || dispatchOffset >= j.deadline
          ? 'MISSED_DUE_DURING_PREPARATION'
          : finishOffset - dispatchOffset <= allowance.publication + 65 ||
              childDeadline - performance.now() <= (allowance.publication + 65) * 1000
            ? 'PREPARATION_CONSUMED_RESERVE'
            : null;
      if (dispatchRefusal) {
        await durableJson(join(jobRoot, 'DISPATCH_SKIPPED.json'), {
          reason: dispatchRefusal,
          jobAdmissionSha256: parent.jobAdmissionSha256,
          parentProfileSha256: profileSha256,
          dispatchOffset,
          closure: 'NO_CHILD',
        });
        await skip(dispatchRefusal);
        if (signal?.aborted) {
          cancelled = true;
          break;
        }
        continue;
      }
      // No await between the final fence and runJob's synchronous spawn guard.
      outstanding = true;
      const result = await runJob({
        jobRoot,
        admission: a,
        registry,
        onAdoption,
        spawnChild,
        deadline: childDeadline,
        syncFixtureClock: live ? undefined : (t) => clock.synchronize(t),
        signal,
        storageGuard: (n = 0) => guardStorage(taskRoot, 128 * 1024 ** 2 + n),
      });
      outstanding = false;
      await durableJson(join(jobRoot, 'COORDINATOR_RESULT.json'), result);
      if (result.publicationUncertain) {
        // Native closure is already proved by runJob. Only the current in-memory
        // owner may use the existing exact intent/certificate recovery contract.
        const intent = await lstat(join(registry.root, 'INTENT.json')).catch((e) => {
          if (e.code === 'ENOENT') return null;
          throw e;
        });
        if (intent) {
          const recovery = await registry.recoverOwnedFailure();
          await durableJson(join(jobRoot, 'OWNED_RECOVERY.json'), recovery);
        } else {
          await registry.refresh(undefined, true);
          if (registry.status().error) throw Error('PUBLICATION_UNKNOWN');
          await durableJson(join(jobRoot, 'COMMITTED_REPORTING_FAILURE.json'), {
            error: result.error,
            selected: await read(join(registry.root, 'CURRENT.json')),
            sourceClosed: true,
          });
        }
        throw Error('PUBLICATION_FAILURE_SETTLED_NO_RESTART:' + result.error);
      }
      if (result.status === 'QUALIFIED_ADOPTED' && ['market', 'gas'].includes(j.family)) {
        const p = result.publications[0].publication;
        contexts[j.family] = j.family === 'market' ? p.pin : p.contextualBlock;
      }
      const sampled =
        j.family === 'trade' && !result.error && result.source.status === 'COMPLETE_SAMPLED_JOB';
      const exhausted =
        result.source.feedLocalClosedExhaustion === true && result.publications.length === 0;
      if (result.status !== 'QUALIFIED_ADOPTED' && !sampled && !exhausted) {
        const failed = {
          job: j.id,
          family: j.family,
          due: j.due,
          deadline: j.deadline,
          startedOffset: dispatchOffset,
          status: 'TERMINAL_SOURCE_OR_LOCAL_FAILURE',
          closure: 'KNOWN',
          result,
          operating: await onFact(j, result),
        };
        jobs.push(failed);
        await durableJson(join(jobRoot, 'JOB_RESULT.json'), failed);
        throw Error(result.error ?? result.source.failure ?? 'UNQUALIFIED_JOB');
      }
      if (exhausted) {
        const selected = await read(join(registry.root, 'CURRENT.json'));
        if (
          !same(selected.product, initial.product) ||
          selected.generation !== initial.participant.generation
        )
          throw Error('FAILED_JOB_SELECTION_CHANGED');
        disabled.add(j.family);
      }
      const selected = await read(join(registry.root, 'CURRENT.json'));
      const selectionChanged =
        !same(selected.product, initial.product) ||
        selected.generation !== initial.participant.generation;
      const fact = {
        job: j.id,
        family: j.family,
        due: j.due,
        nextDue,
        deadline: j.deadline,
        startedOffset: dispatchOffset,
        completedOffset: clock.now() - began,
        delayedSeconds: Math.max(0, dispatchOffset - j.due),
        status: exhausted ? 'CLOSED_FEED_DISABLED' : sampled ? 'SAMPLED' : 'QUALIFIED',
        closure: 'KNOWN',
        publication: selectionChanged
          ? 'changed'
          : result.publications.length
            ? 'no-op'
            : 'retained',
        result,
        operating: await onFact(j, result),
      };
      jobs.push(fact);
      await durableJson(join(jobRoot, 'JOB_RESULT.json'), fact);
    }
  } catch (e) {
    failure = String(e);
  } finally {
    try {
      parent = await read(join(output, 'PARENT_ACCOUNTING.json'));
      const pending = [];
      for (const [root, names] of [
        [registry.root, ['INTENT.json', 'SELECTION.lock', 'RECOVERY.lock']],
        [
          registry.productDaily.root,
          [
            'PENDING.json',
            'COMMITTED.json',
            'WRITER.lock',
            'SELECTION.lock',
            'RETENTION_PENDING.json',
          ],
        ],
      ])
        for (const n of names)
          if (
            await lstat(join(root, n)).catch((e) => {
              if (e.code === 'ENOENT') return null;
              throw e;
            })
          )
            pending.push(join(root, n));
      if (outstanding || parent.pending !== null || parent.status !== 'ADMITTED' || pending.length)
        throw Error('PARENT_CLOSURE_OR_PUBLICATION_UNKNOWN:' + pending.join(','));
      parent.status = 'CLOSED';
      parent.closedAt = new Date().toISOString();
      parent.elapsedSeconds = clock.now() - began;
      parent.closureReason = failure ?? 'Finite profile exhausted; no automatic restart';
      await replace(join(output, 'PARENT_ACCOUNTING.json'), parent);
      settled = true;
    } catch (e) {
      failure ??= String(e);
      parent.status = 'CLOSURE_OR_PUBLICATION_UNKNOWN';
      try {
        await replace(join(output, 'PARENT_ACCOUNTING.json'), parent);
      } catch (writeError) {
        failure += '; ' + String(writeError);
      }
    } finally {
      await lock.close();
    }
    if (settled) await unlink(lockPath);
  }
  const result = {
    status:
      failure || disabled.size || (live && jobs.some((j) => j.status === 'SKIPPED'))
        ? 'PARTIAL'
        : cancelled
          ? 'CANCELLED'
          : live
            ? 'PUBLIC_PROFILE_COMPLETE'
            : 'OFFLINE_PROFILE_COMPLETE',
    jobs,
    failure,
    accounting: parent,
    disabledFeeds: [...disabled],
    networkClosureKnown: settled,
    networkSessionCount: live ? 1 : 0,
    synthetic: !live,
    publicAuthority: live,
    noAutomaticRestart: true,
    indexer: 'PARKED',
  };
  await durableJson(join(output, 'RESULT.json'), result);
  return result;
}

export async function runJob({
  jobRoot,
  admission,
  registry,
  onAdoption,
  onSlot,
  spawnChild,
  deadline,
  storageGuard = async () => {},
  syncFixtureClock,
  signal,
  onControl,
  serializePublication = async (fn) => fn(),
}) {
  const unified = unifiedAdmission(admission);
  const reference = admission.family === 'reference',
    trade = admission.family === 'trade';
  const profile = trade ? tradeProfile(admission) : null;
  const operating = trade && isOperatingAuthority(admission.authorityTaskId);
  if (operating && typeof onSlot !== 'function') throw Error('OPERATING_SERVICE_HOOK_REQUIRED');
  if (trade && admission.task !== 'HDD-BTC-ETH-CURRENT-REFERENCE-FRESHNESS-R2')
    throw Error('EXACT_TRADE_TASK_REQUIRED');
  if (reference && admission.task !== 'HDD-BTC-ETH-REFERENCE-FEED-R1')
    throw Error('EXACT_REFERENCE_TASK_REQUIRED');
  const env = Object.fromEntries(
    ['SystemRoot', 'WINDIR', 'COMSPEC']
      .filter((k) => process.env[k])
      .map((k) => [k, process.env[k]]),
  );
  Object.assign(env, {
    TEMP: join(jobRoot, 'temp'),
    TMP: join(jobRoot, 'temp'),
    PYTHONIOENCODING: 'utf-8',
  });
  if (unified && (signal?.aborted || performance.now() >= deadline - 2000))
    throw Error('OFFLINE_CHILD_DISPATCH_REFUSED');
  const child = spawnChild(
    'python',
    [
      '-I',
      '-S',
      join(
        repo,
        trade
          ? 'scripts/trade-feed/collector.py'
          : reference
            ? 'scripts/reference-feed/collector.py'
            : 'scripts/unified-refresh/job.py',
      ),
      jobRoot,
    ],
    { cwd: repo, env, stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true },
  );
  let exited = false,
    exitObserved = false,
    closedMessage,
    closureProtocolError = false,
    error = null,
    stderr = '',
    handler = Promise.resolve(),
    killed = false,
    cutoffStage = null;
  child.once('exit', () => {
    exitObserved = true;
  });
  const publications = [],
    outcomes = [],
    retainedTrades = [];
  let marketsAccepted = false,
    publicationUncertain = false;
  const firstCycle = unified && trade ? admission.tradeSlot : 1;
  let begunCycle = firstCycle - 1;
  const serviceChecks = [];
  const observeSlot = async (cycle, sourceResult, publicationResult, check) => {
    if (!operating) return null;
    if (serviceChecks.some((s) => s.cycle === cycle)) throw Error('DUPLICATE_SERVICE_SLOT');
    check();
    const selected = registry.productDaily.capture();
    let service;
    try {
      service = await onSlot({ cycle, sourceResult, publicationResult, selected }, check);
      check();
    } catch (e) {
      const failed = {
        cycle,
        sourceResult,
        publicationResult,
        selectedVersion: selected.version,
        service: { status: 'ERROR', error: String(e) },
      };
      await durableJson(join(jobRoot, `SERVICE_${cycle}.json`), failed);
      serviceChecks.push(failed);
      throw e;
    }
    const receipt = {
      cycle,
      sourceResult,
      publicationResult,
      selectedVersion: selected.version,
      service,
    };
    await durableJson(join(jobRoot, `SERVICE_${cycle}.json`), receipt);
    serviceChecks.push(receipt);
    return service;
  };
  const completion = new Promise((done, reject) => {
    child.once('error', reject);
    child.once('close', (code, signal) => {
      exited = true;
      done({ code, signal });
    });
  });
  let killer,
    killClosed = false,
    termination;
  const terminate = () =>
    (termination ??= (async () => {
      killed = true;
      child.stdin.end();
      killer = spawn(
        join(process.env.SystemRoot, 'System32', 'taskkill.exe'),
        ['/PID', String(child.pid), '/T', '/F'],
        { windowsHide: true, stdio: 'ignore' },
      );
      const nativeKill = new Promise((resolve) => {
        killer.once('error', () => {
          killClosed = true;
          resolve();
        });
        killer.once('close', () => {
          killClosed = true;
          resolve();
        });
      });
      await Promise.race([
        Promise.allSettled([completion, nativeKill]),
        new Promise((r) => setTimeout(r, 1900)),
      ]);
      if (!killClosed) {
        killer.kill();
        killer.unref();
      }
      if (!exited) {
        child.stdout.destroy();
        child.stderr.destroy();
        child.stdin.destroy();
        child.unref();
      }
      return exited && killClosed;
    })());
  let expired;
  const cutoff = new Promise((resolve) => {
    if (signal?.aborted) return resolve(null);
    signal?.addEventListener('abort', () => resolve(null), { once: true });
    expired = setTimeout(() => resolve(null), Math.max(1, deadline - performance.now() - 2000));
  });
  const active = () =>
    !exited &&
    !exitObserved &&
    !killed &&
    !error &&
    child.exitCode == null &&
    child.signalCode == null &&
    performance.now() < deadline;
  child.stderr.on('data', (b) => {
    stderr = (stderr + b.toString()).slice(-32768);
  });
  const lines = createInterface({ input: child.stdout });
  lines.on('line', (line) => {
    handler = handler
      .then(async () => {
        if (line.length > 32768) throw Error('IPC_BOUND');
        const m = JSON.parse(line);
        if (m.type?.startsWith('operating-')) {
          if (!admission.operatingFormat || typeof onControl !== 'function')
            throw Error('OPERATING_CONTROL_NOT_ADMITTED');
          const reply = await onControl(m);
          if (!active()) throw Error('OPERATING_CHILD_EXPIRED');
          child.stdin.write(JSON.stringify(reply) + '\n');
          return;
        }
        const dispatchMessage = async () => {
          if (
            unified &&
            !publicAdmission(admission) &&
            !liveOperating(admission) &&
            admission.clockMode !== 'REAL_EPOCH' &&
            m.type !== 'closed'
          ) {
            if (
              typeof syncFixtureClock !== 'function' ||
              !Number.isFinite(m.syntheticClockUnixSeconds)
            )
              throw Error('SYNTHETIC_CLOCK_REQUIRED');
            syncFixtureClock(m.syntheticClockUnixSeconds);
          }
          if (m.type === 'closed') {
            if (closedMessage) {
              closureProtocolError =
                unified || (trade && admission.authorityTaskId === operatingR2TaskId);
              throw Error('DUPLICATE_CLOSURE');
            }
            if (unified || (trade && admission.authorityTaskId === operatingR2TaskId)) {
              if (
                Object.keys(m).sort().join(',') !== 'resultBytes,resultSha256,type' ||
                !Number.isSafeInteger(m.resultBytes) ||
                m.resultBytes < 1 ||
                m.resultBytes > 524288 ||
                typeof m.resultSha256 !== 'string' ||
                !/^[a-f0-9]{64}$/.test(m.resultSha256)
              )
                throw Error('CLOSED_RESULT_IDENTITY');
              const report = await open(join(jobRoot, 'RESULT.json'), 'r');
              try {
                const info = await report.stat();
                if (!info.isFile() || info.size !== m.resultBytes)
                  throw Error('CLOSED_RESULT_SIZE');
                const raw = Buffer.alloc(m.resultBytes + 1);
                const { bytesRead } = await report.read(raw, 0, raw.length, 0);
                if (
                  bytesRead !== m.resultBytes ||
                  sha(raw.subarray(0, bytesRead)) !== m.resultSha256
                )
                  throw Error('CLOSED_RESULT_HASH');
                closedMessage = JSON.parse(raw.subarray(0, bytesRead));
              } finally {
                await report.close();
              }
            } else closedMessage = m.result;
            return;
          }
          if (!active()) throw Error('EXPIRED_JOB');
          const remaining = m.expiresAtUnixSeconds * 1000 - Date.now();
          if (!(
            remaining > 0 && remaining <= (admission.family === 'participants' ? 181000 : 31000)
          ))
            throw Error('IPC_DEADLINE');
          const stopAt = Math.min(deadline, performance.now() + remaining);
          const check = () => {
            if (!active() || performance.now() >= stopAt) throw Error('PUBLICATION_DEADLINE');
          };
          let answer = {
            ok: true,
            ...(admission.family === 'participants' ? { window: m.window } : { cycle: m.cycle }),
          };
          if (m.type === 'markets' && trade) {
            if (marketsAccepted || begunCycle !== firstCycle - 1 || m.cycle !== 0)
              throw Error('TRADE_MARKETS_ORDER');
            await admitTradeMarkets(jobRoot, m.markets);
            marketsAccepted = true;
          } else if (m.type === 'skipped' && trade) {
            if (
              !marketsAccepted ||
              !(
                m.cycle === begunCycle + 1 ||
                (operating && m.cycle === begunCycle && outcomes.length === begunCycle - firstCycle)
              ) ||
              m.cycle > profile.cycles ||
              !(
                outcomes.length === begunCycle - firstCycle + 1 ||
                (operating && outcomes.length === begunCycle - firstCycle && m.cycle === begunCycle)
              )
            )
              throw Error('TRADE_SKIP_ORDER');
            begunCycle = m.cycle;
            outcomes.push({ cycle: m.cycle, status: 'SKIPPED', reason: m.reason });
            await durableJson(join(jobRoot, `OUTCOME_${m.cycle}.json`), outcomes.at(-1));
            await observeSlot(m.cycle, 'SKIPPED', 'retained', check);
          } else if (m.type === 'begin') {
            if (trade) {
              if (
                !marketsAccepted ||
                m.cycle !== begunCycle + 1 ||
                m.cycle > profile.cycles ||
                outcomes.length !== begunCycle - firstCycle + 1
              )
                throw Error('TRADE_CYCLE_ORDER');
              begunCycle = m.cycle;
            } else if (reference) {
              if (m.cycle !== begunCycle + 1 || m.cycle > 2 || publications.length !== begunCycle)
                throw Error('REFERENCE_CYCLE_ORDER');
              begunCycle = m.cycle;
            } else if (m.cycle !== 1) throw Error('ONE_CYCLE_ONLY');
          } else if (m.type === 'prepare' && admission.family === 'participants') {
            await storageGuard(512 * 1024 ** 2);
            check();
            if (m.window !== 1) throw Error('ONE_WINDOW_ONLY');
            const raw = await readFile(join(jobRoot, 'WINDOW_1_AFTER.json'));
            if (sha(raw) !== m.afterSha256) throw Error('CAPTURE_AFTER_IDENTITY');
            const draft = await prepareWindow(registry, JSON.parse(raw), check);
            const draftBytes = Buffer.byteLength(canonical(draft)) + 1;
            if (draftBytes > 256 * 1024 ** 2) throw Error('PARTICIPANT_DRAFT_BOUND');
            await storageGuard(3 * draftBytes + 32 * 1024 ** 2 + 512 * 1024 ** 2);
            check();
            await durableJson(join(jobRoot, 'WINDOW_1_DRAFT.json'), draft);
          } else if (m.type === 'qualified') {
            if (trade && (m.cycle !== begunCycle || outcomes.length !== begunCycle - firstCycle))
              throw Error('TRADE_QUALIFICATION_ORDER');
            if (reference && (m.cycle !== begunCycle || publications.length !== begunCycle - 1))
              throw Error('REFERENCE_QUALIFICATION_ORDER');
            await storageGuard(512 * 1024 ** 2);
            check();
            let selected, publication;
            if (trade) {
              publication = await publishTrade(
                registry.productDaily,
                jobRoot,
                m,
                active,
                (update, beforeCommit, captureReference) =>
                  registry.publishProduct(update, { beforeCommit, captureReference }),
                retainedTrades,
              );
              if (!publication.qualified) {
                outcomes.push({ cycle: m.cycle, status: 'UNQUALIFIED', publication });
                await durableJson(join(jobRoot, `OUTCOME_${m.cycle}.json`), outcomes.at(-1));
                await observeSlot(
                  m.cycle,
                  publication.sourceResult ?? 'UNQUALIFIED',
                  'retained',
                  check,
                );
                check();
                child.stdin.write(JSON.stringify({ ...answer, outcome: 'UNQUALIFIED' }) + '\n');
                return;
              }
              await registry.refresh(undefined, true);
              selected = await read(join(registry.root, 'CURRENT.json'));
              if (selected.product.version !== publication.selected.version)
                throw Error('COORDINATED_PUBLICATION_UNKNOWN');
            } else if (admission.family === 'participants') {
              const raw = await readFile(join(jobRoot, 'WINDOW_1_AUDIT.json')),
                proof = JSON.parse(raw);
              if (
                m.window !== 1 ||
                sha(raw) !== m.auditFileSha256 ||
                sha(canonical(proof)) !== m.proofSha256
              )
                throw Error('PARTICIPANT_SAVED_PROOF');
              const update = ParticipantUpdateSchema.parse({
                ...(await read(join(jobRoot, 'WINDOW_1_DRAFT.json'))),
                proofSha256: m.proofSha256,
              });
              const updateBytes = Buffer.byteLength(canonical(update)) + 1;
              if (updateBytes > 256 * 1024 ** 2) throw Error('PARTICIPANT_UPDATE_BOUND');
              await storageGuard(2 * updateBytes + 32 * 1024 ** 2 + 512 * 1024 ** 2);
              check();
              await durableJson(join(jobRoot, 'WINDOW_1_UPDATE.json'), update);
              publication = await registry.publish(update, proof, {
                beforeCommit: check,
                captureReference: {
                  output: jobRoot,
                  update: 'WINDOW_1_UPDATE.json',
                  updateSha256: sha(await readFile(join(jobRoot, 'WINDOW_1_UPDATE.json'))),
                  audit: 'WINDOW_1_AUDIT.json',
                  auditSha256: sha(raw),
                },
              });
              selected = publication.selected;
              // A final participant job has no following job to refresh the writer.
              // Observe the committed compatible pair before same-API verification.
              await registry.refresh(undefined, true);
              if (
                registry.status().error ||
                registry.status().generation !== selected.generation ||
                registry.status().productVersion !== selected.product.version
              )
                throw Error('COORDINATED_PUBLICATION_UNKNOWN');
              answer = {
                ...answer,
                generation: selected.generation,
                productVersion: selected.product.version,
              };
            } else {
              const publish = {
                market: publishCycle,
                gas: publishGas,
                protocol: publishProtocol,
                reference: publishReference,
              }[admission.family];
              publication = await publish(
                registry.productDaily,
                null,
                jobRoot,
                m,
                active,
                (_s, _w, update, beforeCommit, _fault, captureReference) =>
                  registry.publishProduct(update, { beforeCommit, captureReference }),
              );
              await registry.refresh(undefined, true);
              selected = await read(join(registry.root, 'CURRENT.json'));
              if (selected.product.version !== publication.selected.version)
                throw Error('COORDINATED_PUBLICATION_UNKNOWN');
            }
            check();
            const adoption = operating
              ? await observeSlot(
                  m.cycle,
                  'QUALIFIED',
                  publication.changed ? 'changed' : 'unchanged',
                  check,
                )
              : await onAdoption(selected, check, admission.job);
            check();
            const receipt = {
              selected,
              publication,
              adoption,
              adoptedAt: new Date().toISOString(),
            };
            await durableJson(
              join(jobRoot, reference || trade ? `ADOPTION_${m.cycle}.json` : 'ADOPTION.json'),
              receipt,
            );
            publications.push(receipt);
            if (trade) {
              outcomes.push({ cycle: m.cycle, status: 'QUALIFIED' });
              answer.outcome = 'QUALIFIED';
              await durableJson(join(jobRoot, `OUTCOME_${m.cycle}.json`), outcomes.at(-1));
            }
          } else throw Error('UNEXPECTED_COLLECTOR_PHASE');
          check();
          child.stdin.write(JSON.stringify(answer) + '\n');
        };
        if (m.type === 'qualified') await serializePublication(dispatchMessage);
        else await dispatchMessage();
      })
      .catch((e) => {
        error ??= String(e);
        publicationUncertain ||=
          Boolean(e.publicationUncertain) ||
          String(e).includes('PUBLICATION_UNKNOWN') ||
          (unified && String(e) === 'Error: PRODUCT_PUBLICATION_UNCERTAIN_LOCK_RETAINED');
        if (child.stdin.writable)
          child.stdin.write(JSON.stringify({ ok: false, reason: error }) + '\n');
      });
  });
  try {
    const exit = await Promise.race([completion, cutoff]);
    if (exit === null) {
      cutoffStage = 'native-cutoff';
      const closed = await terminate();
      throw Error(closed ? 'NATIVE_DEADLINE_CLOSED' : 'NATIVE_CLOSURE_UNKNOWN');
    }
    if ((await Promise.race([handler.then(() => true), cutoff])) === null) {
      cutoffStage = 'handler-cutoff';
      throw Error('PUBLICATION_SETTLEMENT_UNKNOWN');
    }
    clearTimeout(expired);
    lines.close();
    let source, accounting;
    try {
      source = await read(join(jobRoot, 'RESULT.json'));
      accounting = await read(join(jobRoot, 'ACCOUNTING.json'));
    } catch (e) {
      if (unified)
        await durableJson(join(jobRoot, 'NATIVE_CLOSURE.json'), {
          exit,
          killed,
          closureProtocolError,
          ipcError: error,
          closedMessageReceived: Boolean(closedMessage),
          savedResultUnavailable: true,
          stderr,
          error: String(e),
        });
      throw Error('SAVED_CLOSURE_UNAVAILABLE: ' + String(e) + ' ' + stderr);
    }
    if (unified || (trade && admission.authorityTaskId === operatingR2TaskId))
      await durableJson(join(jobRoot, 'NATIVE_CLOSURE.json'), {
        exit,
        killed,
        closureProtocolError,
        ipcError: error,
        closedMessageReceived: Boolean(closedMessage),
        resultMatchesClosedMessage: same(source, closedMessage),
        accountingMatchesResult: same(source.accounting, accounting),
        accountingClosed: accounting.status === 'CLOSED',
        pending: accounting.pending,
      });
    if (
      killed ||
      closureProtocolError ||
      exit.signal ||
      ![0, 2].includes(exit.code) ||
      !same(source, closedMessage) ||
      !same(source.accounting, accounting) ||
      accounting.status !== 'CLOSED' ||
      accounting.pending !== null
    )
      throw Error('NATIVE_OR_ACCOUNTING_CLOSURE_UNKNOWN: ' + (error ?? stderr));
    if (
      unified &&
      !publicAdmission(admission) &&
      !liveOperating(admission) &&
      admission.clockMode !== 'REAL_EPOCH'
    ) {
      const closedAt = Date.parse(accounting.closedAtUtc ?? accounting.closedAt) / 1000;
      if (!Number.isFinite(closedAt)) throw Error('SYNTHETIC_CLOSING_CLOCK_REQUIRED');
      syncFixtureClock(closedAt);
    }
    if (error && !trade && !unified) throw Error(error);
    const qualified =
      !error &&
      exit.code === 0 &&
      source.status.startsWith('COMPLETE_') &&
      publications.length === (unified ? 1 : trade ? profile.cycles : reference ? 2 : 1);
    if (operating) {
      // Terminal closure never restarts acquisition. The active failed slot may
      // receive one safe local read; all later original slots remain explicit gaps.
      for (let cycle = 1; cycle <= profile.cycles; cycle++) {
        if (serviceChecks.some((s) => s.cycle === cycle)) continue;
        if (cycle === begunCycle && !publicationUncertain && performance.now() < deadline - 2000) {
          try {
            await observeSlot(cycle, 'TERMINAL_ERROR', 'retained_or_refused', () => {
              if (performance.now() >= deadline - 2000) throw Error('SERVICE_CLOSURE_DEADLINE');
            });
            continue;
          } catch (e) {
            error ??= String(e);
            if (serviceChecks.some((s) => s.cycle === cycle)) continue;
          }
        }
        const missing = {
          cycle,
          sourceResult: 'UNRUN_TERMINAL',
          publicationResult: 'retained_or_unknown',
          selectedVersion: registry.status().productVersion,
          service: { status: 'NOT_MEASURED' },
        };
        await durableJson(join(jobRoot, `SERVICE_${cycle}.json`), missing);
        serviceChecks.push(missing);
      }
    }
    const changed = publications.filter((p) => p.publication.changed);
    const separated = changed.some((a) =>
      changed.some(
        (b) =>
          Date.parse(b.publication.publishedAt) - Date.parse(a.publication.publishedAt) >= 300000,
      ),
    );
    const servingPass =
      operating &&
      !error &&
      !publicationUncertain &&
      source.cycles.length === profile.cycles &&
      serviceChecks.length === profile.cycles &&
      serviceChecks.every((s) => s.service.status === 'FRESH') &&
      separated;
    return {
      status: operating
        ? servingPass
          ? 'FINITE_SERVING_PASS'
          : 'PARTIAL'
        : qualified
          ? 'QUALIFIED_ADOPTED'
          : 'PARTIAL',
      source,
      ...(operating
        ? { serviceChecks, servingPass, changedPublicationsSeparatedBy300Seconds: separated }
        : {}),
      ...(trade || unified ? { outcomes, error, publicationUncertain } : {}),
      publications,
      exit,
      stderr,
      ...(unified
        ? {
            native: {
              known: true,
              exit,
              closedMessageReceived: true,
              accountingClosed: true,
              pending: null,
            },
          }
        : {}),
    };
  } finally {
    clearTimeout(expired);
    lines.close();
    if (!exited) await terminate();
    if (unified)
      await durableJson(join(jobRoot, 'NATIVE_TERMINATION.json'), {
        ownerPid: process.pid,
        childPid: child.pid,
        childCloseObserved: exited,
        childExitObserved: exitObserved,
        childExitCode: child.exitCode,
        childSignalCode: child.signalCode,
        terminationRequested: killed,
        cutoffStage,
        terminatorClosed: killed ? killClosed : null,
        knownClosure: exited && (!killed || killClosed),
        recordedAtUtc: new Date().toISOString(),
        qualification:
          'Enclosing collector handle only; physical/accounting/publication closure is separately required.',
      });
    child.stdin.end();
  }
}

// The same runJob parser, native emitters and typed publishers; jobs only overlap
// while waiting outside the physical permit and serialized publication owners.
export async function runOperating({
  taskRoot,
  registry,
  onAdoption,
  spawnChild,
  clock,
  onFact,
  signal,
  configuration,
  until,
  resume = false,
  mode = 'OFFLINE_ONLY',
  loadedRuntimeFiles,
}) {
  const live = mode === 'OWNER_AUTHORIZED_PUBLIC',
    boundary = mode === 'DENIED_NETWORK_TEST';
  if (live) {
    if (
      clock !== undefined ||
      (spawnChild !== undefined && spawnChild !== spawn) ||
      configuration !== undefined ||
      until !== undefined ||
      resume
    )
      throw Error('OPERATING_PUBLIC_INJECTION_REFUSED');
    clock = new RealOperatingClock();
    spawnChild = spawn;
  }
  if (
    (!live && !boundary && clock?.mode !== 'SYNTHETIC') ||
    (boundary && clock?.mode !== 'REAL_EPOCH') ||
    !['OFFLINE_ONLY', 'OWNER_AUTHORIZED_PUBLIC', 'DENIED_NETWORK_TEST'].includes(mode) ||
    typeof spawnChild !== 'function' ||
    typeof onFact !== 'function'
  )
    throw Error('OPERATING_OFFLINE_INJECTION_REQUIRED');
  const root = resolve(taskRoot),
    output = join(root, live ? 'session' : 'operating');
  if (
    boundary &&
    !root.startsWith(join(operatingPolicy.root, 'fixtures') + '\\') &&
    !root.startsWith(join(operatingPolicy.root, 'fixtures') + '/')
  )
    throw Error('OPERATING_BOUNDARY_ROOT');
  let c = live
    ? null
    : validateOperating(
        configuration ?? (await read(join(dirname(root), 'OPERATING_CONFIG.json'))),
      );
  const runtimeFiles = {},
    sourceFiles = {};
  for (const folder of [
    'unified-refresh',
    'trade-feed',
    'market-refresh',
    'gas-feed',
    'protocol-feed',
    'participant-refresh',
  ])
    for (const e of await readdir(join(repo, 'scripts', folder), { withFileTypes: true }))
      if (e.isFile() && /\.(py|mjs|json)$/.test(e.name)) {
        const p = `scripts/${folder}/${e.name}`;
        runtimeFiles[p] = sha(await readFile(join(repo, p)));
        if (folder === 'market-refresh' && /\.(py|json)$/.test(e.name))
          sourceFiles[e.name] = runtimeFiles[p];
      }
  runtimeFiles['scripts/refresh-data.mjs'] = sha(
    await readFile(join(repo, 'scripts/refresh-data.mjs')),
  );
  const allowanceRaw = await readFile(join(repo, 'config/unified-refresh-offline.json'));
  runtimeFiles['config/unified-refresh-offline.json'] = sha(allowanceRaw);
  runtimeFiles['config/repeatable-operating-public-1.json'] = sha(
    await readFile(join(repo, 'config/repeatable-operating-public-1.json')),
  );
  let readiness;
  if (live) {
    readiness = await validateOperatingReady({ root, registry, loadedRuntimeFiles, repo });
    Object.assign(runtimeFiles, readiness.runtimeFiles);
    c = validateOperating(boundedOperatingConfig(clock.now()));
  }
  const sourceBinding = sha(canonical(runtimeFiles));
  const original = JSON.parse(allowanceRaw).jobs;
  const bounds =
    live || boundary
      ? operatingPolicy.public.childAllowances
      : Object.fromEntries(original.map((j) => [j.family, j.bounds]));
  const parentLimits = {};
  for (const p of ['graph', 'rpc', 'http']) {
    parentLimits[p + 'Attempts'] = c.total[p].attempts;
    parentLimits[p + 'Extras'] = c.total[p].extras;
    parentLimits[p + 'ChargedBytes'] = c.total[p].bytes;
  }
  Object.assign(parentLimits, { attempts: 0, extras: 0, chargedBytes: 0, chargedEntities: 0 });
  for (const p of ['graph', 'rpc', 'http']) {
    parentLimits.attempts += c.total[p].attempts;
    parentLimits.extras += c.total[p].extras;
    parentLimits.chargedBytes += c.total[p].bytes;
    parentLimits.chargedEntities += c.total[p].objects;
  }
  if (c.aggregate)
    Object.assign(parentLimits, {
      attempts: c.aggregate.attempts,
      chargedBytes: c.aggregate.bytes,
      chargedEntities: c.aggregate.objects,
    });
  if (
    !resolve(registry.root).startsWith(root + '\\') &&
    !resolve(registry.root).startsWith(root + '/')
  )
    throw Error('OPERATING_OWNED_SYNTHETIC_REGISTRY');
  const parentNonce = live ? randomBytes(32).toString('hex') : null;
  if (live) {
    await absent(output);
    await mkdir(output);
    await durableJson(join(root, 'PUBLIC_ADMISSION.json'), {
      taskId: operatingPolicy.task,
      output,
      synthetic: false,
      nonce: parentNonce,
      startsAt: c.startsAt,
      admissionEndsAt: c.admissionEndsAt,
      expiresAt: c.expiresAt,
      clockOrigin: clock.origin,
      preflightSha256: readiness.preflightSha256,
      scopeSha256: readiness.scopeSha256,
      sourceBindingSha256: sourceBinding,
    });
    await durableJson(join(output, 'CONFIG.json'), c);
  }
  const owner = await OperatingOwner.open(output, c, clock, { resume, sourceBinding });
  const pending = new Map(),
    jobs = [],
    disabled = new Set(owner.state.disabled);
  const contexts = owner.state.contexts;
  let probe = clock.now(),
    failure = null;
  const cancel = new AbortController();
  if (signal?.aborted) cancel.abort();
  signal?.addEventListener('abort', () => cancel.abort(), { once: true });
  const stopStarts = boundary
    ? Math.min(until ?? c.admissionEndsAt, c.admissionEndsAt)
    : (c.admissionEndsAt ?? Math.min(until ?? c.expiresAt - 1800, c.expiresAt - 90));
  const start = async (family) => {
    const startTime = clock.now(),
      nativeStart = performance.now();
    let id;
    try {
      id = await owner.allocate(family);
    } catch (e) {
      if (String(e) !== 'Error: OPERATING_JOB_BOUND') throw e;
      disabled.add(family);
      await owner.exclusive(async () => {
        owner.state.disabled = [...disabled];
        owner.state.feeds[family].quarantine = 'OPERATING_JOB_BOUND';
        await owner.save();
      });
      return; // Preserve already-admitted jobs' closing opportunities.
    }
    const jobRoot = join(output, id);
    const allowance = {
      ...bounds[family],
      seconds: Math.min(
        bounds[family].seconds,
        c.families[family].deadline,
        c.expiresAt - startTime,
      ),
    };
    if (allowance.seconds < bounds[family].seconds) {
      disabled.add(family);
      return;
    }
    await registry.refresh(undefined, true);
    if (registry.status().error) throw Error('OPERATING_SELECTOR_INTEGRITY');
    const held = registry.capture();
    let initial;
    try {
      initial = admittedInputs(held, !contexts.gas, contexts);
    } finally {
      held.release();
    }
    const span = c.participants.maximumWindowBlocks;
    if (
      family === 'participants' &&
      owner.state.participantBlocks + span > c.participants.maximumActivationBlocks
    ) {
      disabled.add(family);
      return;
    }
    await mkdir(jobRoot);
    await mkdir(join(jobRoot, 'temp'));
    const a = {
      task: family === 'trade' ? 'HDD-BTC-ETH-CURRENT-REFERENCE-FRESHNESS-R2' : taskId,
      authorityTaskId: live || boundary ? operatingPolicy.task : operatingTask,
      operatingFormat: c.format,
      activation: owner.state.activation,
      parentMode: mode,
      parentProfileSha256: owner.state.configSha256,
      sourceBindingSha256: sourceBinding,
      synthetic: !live,
      ...(live || boundary ? { clockMode: 'REAL_EPOCH', activationExpiresAt: c.expiresAt } : {}),
      ...(live
        ? {
            parentNonce,
            preflightSha256: readiness.preflightSha256,
            scopeSha256: readiness.scopeSha256,
          }
        : {}),
      combinedJob: true,
      job: id,
      family,
      jobRoot,
      nonce: randomBytes(32).toString('hex'),
      initial,
      allowance,
      parentLimits,
      runtimeFiles,
      sourceFiles,
      startedAtUnixSeconds: startTime,
      deadlineUnixSeconds: startTime + allowance.seconds,
      networkClosesAtUnixSeconds: Math.min(
        c.dispatchEndsAt ?? Infinity,
        startTime + allowance.seconds - allowance.publication - 5,
      ),
      networkSeconds:
        Math.min(
          c.dispatchEndsAt ?? Infinity,
          startTime + allowance.seconds - allowance.publication - 5,
        ) - startTime,
      ...(family === 'trade'
        ? {
            tradeSlot: 1,
            tradeProfileId: 'unified-single-pair-1',
            responseCookiePolicyId: 'ignore-response-cookies-no-replay-v1',
          }
        : {}),
    };
    if (family === 'participants') {
      const plan = {
        combinedJob: true,
        operatingFormat: c.format,
        base: initial.participant.base,
        finalTarget: {
          number: initial.participant.base.number + span,
          hash: null,
          timestamp: null,
        },
        windows: [
          {
            fromInclusive: initial.participant.base.number,
            targetNumber: initial.participant.base.number + span,
            newBlockSpan: span,
          },
        ],
        graphqlEndpoint: 'https://graph.pulsechain.com/subgraphs/name/pulsechain/hex',
        rpcEndpoints: ['https://rpc.pulsechain.com/', 'https://rpc-pulsechain.g4mm4.io/'],
        deployment: 'QmSsv8uvNLbfJCQARk7xd9iNouNmaoqZCrqEwRaFCHJMCw',
        maximumBlockStep: 4096,
        limits: { maximumAffectedParents: 50000, maximumChangedKeysPerFamily: 100000 },
      };
      await durableJson(join(jobRoot, 'PLAN.json'), plan);
      a.planSha256 = sha(await readFile(join(jobRoot, 'PLAN.json')));
      await durableJson(join(jobRoot, 'FRONTIER.json'), {
        completedWindows: 0,
        pin: plan.base,
        generation: initial.participant.generation,
        productVersion: initial.product.version,
      });
      await owner.exclusive(async () => {
        owner.state.participantBlocks += span;
        await owner.save();
      });
    }
    await durableJson(join(jobRoot, 'ADMISSION.json'), a);
    try {
      await owner.register(
        family,
        sha(await readFile(join(jobRoot, 'ADMISSION.json'))),
        id,
        a.deadlineUnixSeconds,
        allowance,
      );
    } catch (e) {
      if (
        !/OPERATING_(ACTIVE_RESERVATIONS|ROLLING_ADMISSION_RESERVE|ENDPOINT_ADMISSION_RESERVE|JOB_BOUND)/.test(
          String(e),
        )
      )
        throw e;
      disabled.add(family);
      await owner.exclusive(async () => {
        owner.state.disabled = [...disabled];
        owner.state.feeds[family].quarantine = String(e);
        await owner.save();
      });
      await owner.receipt('REFUSED_' + id + '.json', {
        job: id,
        family,
        reason: String(e),
        nativeStarted: false,
      });
      return;
    }
    // Coalesce missed ticks; never enqueue a catch-up burst for a family.
    await owner.scheduleNext(family, startTime);
    if (
      cancel.signal.aborted ||
      clock.now() >= a.deadlineUnixSeconds ||
      performance.now() >= nativeStart + allowance.seconds * 1000
    )
      throw Error('OPERATING_PREPARATION_CANCELLED_OR_EXPIRED');
    const p = runJob({
      jobRoot,
      admission: a,
      registry,
      onAdoption,
      spawnChild,
      deadline: nativeStart + allowance.seconds * 1000,
      signal: cancel.signal,
      syncFixtureClock: (t) => {
        if (t > clock.now() + 0.002) throw Error('CHILD_CLOCK_AHEAD');
      },
      onControl: (m) => owner.control(id, m),
      serializePublication: (fn) => owner.publication(id, fn),
      storageGuard: (n) => owner.storage(n),
    })
      .then(async (result) => {
        await durableJson(join(jobRoot, 'COORDINATOR_RESULT.json'), result);
        if (['market', 'gas'].includes(family) && result.publications.length) {
          const p = result.publications.at(-1).publication;
          contexts[family] = family === 'market' ? p.pin : p.contextualBlock;
        }
        const changed = result.publications.some((p) =>
          family === 'participants'
            ? p.selected.generation !== initial.participant.generation
            : p.publication.previous !== p.publication.selected.version,
        );
        const resultRaw = await readFile(join(jobRoot, 'COORDINATOR_RESULT.json'));
        const fact = {
          job: id,
          family,
          startedAt: startTime,
          completedAt: clock.now(),
          status: result.status,
          publication: changed ? 'changed' : result.publications.length ? 'no-op' : 'retained',
          receipt: {
            file: id + '/COORDINATOR_RESULT.json',
            bytes: resultRaw.length,
            sha256: sha(resultRaw),
          },
        };
        if (result.publicationUncertain) throw Error('OPERATING_PUBLICATION_UNKNOWN');
        if (live || boundary) {
          if (!result.native?.known || result.error)
            throw Error('OPERATING_TERMINAL_CHILD:' + String(result.error));
          if (
            result.status === 'PARTIAL' &&
            !result.source.status.startsWith('COMPLETE_') &&
            result.source.feedLocalClosedExhaustion !== true &&
            result.source.feedLocalClosedReserveRefusal !== true
          )
            throw Error(
              'OPERATING_TERMINAL_SOURCE:' +
                String(result.source.failure ?? result.source.accounting?.closureReason),
            );
        }
        if (
          result.status === 'PARTIAL' &&
          !(family === 'trade' && !result.error && result.source.status.startsWith('COMPLETE_'))
        )
          disabled.add(family);
        await owner.exclusive(async () => {
          owner.state.disabled = [...disabled];
          owner.state.contexts = contexts;
          await owner.save();
        });
        await owner.receipt('JOB_' + id + '.json', fact);
        jobs.push(fact);
        if (jobs.length > 64) jobs.shift();
        await owner.finish(id, result, fact);
        await onFact({ id, family }, result);
      })
      .catch(async (e) => {
        failure ??= String(e);
        cancel.abort();
        await owner
          .exclusive(async () => {
            owner.state.status = 'UNKNOWN';
            await owner.save();
          })
          .catch(() => {});
      })
      .finally(() => pending.delete(id));
    pending.set(id, p);
  };
  try {
    let spins = 0;
    while (pending.size || clock.now() < stopStarts) {
      if (++spins > 200000) throw Error('OPERATING_PUMP_BOUND');
      if (signal?.aborted || failure || owner.state.status !== 'RUNNING') break;
      for (const f of operatingFamilies)
        if (
          clock.now() < stopStarts &&
          c.families[f].enabled &&
          !disabled.has(f) &&
          !Array.from(owner.jobs.values()).some((j) => j.family === f) &&
          clock.now() >= owner.state.due[f]
        )
          await start(f);
      await owner.pump();
      if (clock.now() >= probe) {
        await onFact(
          { id: 'timeline-' + Math.floor(probe - c.startsAt), family: 'timeline' },
          null,
        );
        probe += 20;
      }
      const idle = owner.idleTime();
      if (idle !== null) {
        const due = operatingFamilies
          .filter(
            (f) =>
              c.families[f].enabled &&
              !disabled.has(f) &&
              !Array.from(owner.jobs.values()).some((j) => j.family === f),
          )
          .map((f) => owner.state.due[f])
          .filter((n) => n > clock.now() && n < stopStarts);
        const next = Math.min(
          idle,
          probe,
          ...due,
          clock.now() < stopStarts ? stopStarts : Infinity,
          c.expiresAt,
        );
        if (next > clock.now())
          await clock.sleep(Math.min(next - clock.now(), live || boundary ? 0.05 : Infinity));
        if (clock.now() >= c.expiresAt) throw Error('OPERATING_EXPIRED');
      }
      await new Promise((r) => setTimeout(r, live || boundary ? 20 : 2));
    }
    if (signal?.aborted) throw Error('OPERATING_CANCELLED');
    if (failure) throw Error(failure);
    if (owner.state.status !== 'RUNNING') throw Error('OPERATING_TERMINAL_PROTECTION');
    await Promise.all(pending.values());
    if (live || boundary) {
      for (const [base, names] of [
        [output, ['PHYSICAL_ACTIVE.lock']],
        [registry.root, ['INTENT.json', 'SELECTION.lock', 'RECOVERY.lock']],
        [
          registry.productDaily.root,
          [
            'PENDING.json',
            'COMMITTED.json',
            'WRITER.lock',
            'SELECTION.lock',
            'RETENTION_PENDING.json',
          ],
        ],
      ])
        for (const n of names) await absent(join(base, n));
    }
    await owner.close(!live && !boundary && until ? 'PAUSED' : 'CLOSED');
  } catch (e) {
    failure ??= String(e);
    cancel.abort();
    await owner
      .exclusive(async () => {
        owner.state.status = 'UNKNOWN';
        await owner.save();
      })
      .catch((e) => {
        failure += '; state write: ' + String(e);
      });
  } finally {
    // No reset/recovery on uncertain native or publication state.
    if (failure || signal?.aborted) {
      cancel.abort();
      for (const q of owner.queue.splice(0)) q.reject(Error('OPERATING_STOPPED'));
      for (const q of owner.waiters.splice(0)) q.reject(Error('OPERATING_STOPPED'));
    }
    await Promise.allSettled(pending.values());
    await owner.lock.close().catch(() => {});
  }
  const result = {
    status: failure ? 'PARTIAL' : live ? 'FINITE_OPERATING_CLOSED' : 'OFFLINE_OPERATING_COMPLETE',
    failure,
    mode,
    networkSessionCount: live ? 1 : 0,
    externalRequests: live ? null : 0,
    chargedPhysicalAttempts: Object.values(owner.state.totals).reduce((n, v) => n + v.attempts, 0),
    dispatchEvidence: {
      ...owner.state.dispatchEvidence,
      unknownDispatchReservations:
        Object.values(owner.state.totals).reduce((n, v) => n + v.attempts, 0) -
        (owner.state.dispatchEvidence?.observedHttpResponses ?? 0) -
        (owner.state.dispatchEvidence?.knownNoNetworkDispatch ?? 0),
    },
    ...(live ? {} : { genuineBaseAdmissions: 0 }),
    networkClosureKnown:
      owner.state.status === 'CLOSED' &&
      owner.state.pending === null &&
      owner.state.active.length === 0,
    jobs,
    jobReferences: 'JOB_<monotonic-job-id>.json',
    recentJobLimit: 64,
    accounting: owner.state,
    maximumPublicationWriters: owner.maxWriters,
  };
  await durableJson(
    join(output, `RUN_${String(owner.state.run).padStart(8, '0')}_RESULT.json`),
    result,
  );
  return result;
}

export async function main(args = process.argv.slice(2)) {
  if (args[0] === 'operating-public-qualification-r4' && args.length === 1) {
    const { runReviewedPublic } = await import('./unified-refresh/owner.mjs');
    return runReviewedPublic(runOperating, liveOperatingFormat);
  }
  if (args[0] === 'operating-plan' && args.length === 2) {
    console.log(JSON.stringify(validateOperating(await read(resolve(args[1]))), null, 2));
    return 0;
  }
  if (args[0] === 'operating-status' && args.length === 2) {
    console.log(JSON.stringify(await operatingStatus(args[1]), null, 2));
    return 0;
  }
  if (args[0] === 'operating-offline' && args.length === 2) {
    const { runFixture } = await import('../tests/unified-refresh/operating-fixture.mjs');
    return runFixture(resolve(args[1]), 'repeatable', runOperating);
  }
  if (args[0]?.startsWith('operating-')) throw Error('NO_OPERATING_PUBLIC_AUTHORITY');
  if (
    args.length === 1 &&
    ['public-qualification-r2', 'public-qualification-r3', 'public-qualification-r4'].includes(
      args[0],
    )
  ) {
    const { runReviewedPublic } = await import('./unified-refresh/owner.mjs');
    return runReviewedPublic(
      runUnified,
      args[0] === 'public-qualification-r4'
        ? publicR4.profile
        : args[0] === 'public-qualification-r3'
          ? publicR3.profile
          : undefined,
    );
  }
  if (args[0] === 'plan' && args.length === 2) {
    console.log(JSON.stringify(validateProfile(await read(resolve(args[1]))), null, 2));
    return 0;
  }
  if (args[0] === 'status' && args.length === 2) {
    console.log(JSON.stringify(await read(join(resolve(args[1]), 'session/RESULT.json')), null, 2));
    return 0;
  }
  if (args[0] === 'run-fixture' && (args.length === 2 || args.length === 3)) {
    const { runFixture } = await import('../tests/unified-refresh/operating-fixture.mjs');
    return await runFixture(resolve(args[1]), args[2] ?? 'mixed', runUnified);
  }
  if (args.length !== 3 || args[0] !== 'run') {
    console.log(
      'No provider requests. Explicit run TASK_ROOT PREFLIGHT is the finite operating entry; every consumed parent stays closed.',
    );
    return 0;
  }
  const { openProductDependencies } = await import('../dist/services/product-daily/open.js');
  const deps = await openProductDependencies(await read(join(resolve(args[1]), 'PROFILE.json')));
  try {
    const result = await runUnified({
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
    return result.status === 'COMBINED_TRIAL_PASS' ? 0 : 2;
  } finally {
    await deps.close();
  }
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url))
  process.exitCode = await main();
