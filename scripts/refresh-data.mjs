import { publishTrade, admitTradeMarkets, tradeProfile, operatingTaskId } from './trade-publication.mjs';
// One explicit finite operation. Status/default makes no provider requests.
import { readFile, mkdir, open, rename, unlink, statfs, lstat, readdir } from 'node:fs/promises';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
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
const repo = resolve(dirname(fileURLToPath(import.meta.url)), '..');
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
}) {
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

export async function runJob({
  jobRoot,
  admission,
  registry,
  onAdoption,
  onSlot,
  spawnChild,
  deadline,
  storageGuard = async () => {},
}) {
  const reference = admission.family === 'reference',
    trade = admission.family === 'trade';
  const profile = trade ? tradeProfile(admission) : null;
  const operating = trade && admission.authorityTaskId === operatingTaskId;
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
    error = null,
    stderr = '',
    handler = Promise.resolve(),
    killed = false;
  child.once('exit', () => {
    exitObserved = true;
  });
  const publications = [],
    outcomes = [],
    retainedTrades = [];
  let marketsAccepted = false,
    publicationUncertain = false;
  let begunCycle = 0;
  const serviceChecks = [];
  const observeSlot = async (cycle, sourceResult, publicationResult, check) => {
    if (!operating) return null;
    if (serviceChecks.some(s => s.cycle === cycle)) throw Error('DUPLICATE_SERVICE_SLOT');
    check();
    const selected = registry.productDaily.capture();
    let service;
    try {
      service = await onSlot({ cycle, sourceResult, publicationResult, selected }, check);
      check();
    } catch (e) {
      const failed = { cycle, sourceResult, publicationResult, selectedVersion: selected.version,
        service: { status: 'ERROR', error: String(e) } };
      await durableJson(join(jobRoot, `SERVICE_${cycle}.json`), failed);
      serviceChecks.push(failed);
      throw e;
    }
    const receipt = { cycle, sourceResult, publicationResult, selectedVersion: selected.version, service };
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
        if (m.type === 'closed') {
          if (closedMessage) throw Error('DUPLICATE_CLOSURE');
          closedMessage = m.result;
          return;
        }
        if (!active()) throw Error('EXPIRED_JOB');
        const remaining = m.expiresAtUnixSeconds * 1000 - Date.now();
        if (!(remaining > 0 && remaining <= (admission.family === 'participants' ? 181000 : 31000)))
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
          if (marketsAccepted || begunCycle || m.cycle !== 0) throw Error('TRADE_MARKETS_ORDER');
          await admitTradeMarkets(jobRoot, m.markets);
          marketsAccepted = true;
        } else if (m.type === 'skipped' && trade) {
          if (
            !marketsAccepted ||
            !(m.cycle === begunCycle + 1 || (operating && m.cycle === begunCycle && outcomes.length === begunCycle - 1)) ||
            m.cycle > profile.cycles ||
            !(outcomes.length === begunCycle || (operating && outcomes.length === begunCycle - 1 && m.cycle === begunCycle))
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
              outcomes.length !== begunCycle
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
          if (trade && (m.cycle !== begunCycle || outcomes.length !== begunCycle - 1))
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
              await observeSlot(m.cycle, publication.sourceResult ?? 'UNQUALIFIED', 'retained', check);
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
            ? await observeSlot(m.cycle, 'QUALIFIED', publication.changed ? 'changed' : 'unchanged', check)
            : await onAdoption(selected, check, admission.job);
          check();
          const receipt = { selected, publication, adoption, adoptedAt: new Date().toISOString() };
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
      })
      .catch((e) => {
        error ??= String(e);
        publicationUncertain ||=
          Boolean(e.publicationUncertain) || String(e).includes('PUBLICATION_UNKNOWN');
        if (child.stdin.writable)
          child.stdin.write(JSON.stringify({ ok: false, reason: error }) + '\n');
      });
  });
  try {
    const exit = await Promise.race([completion, cutoff]);
    if (exit === null) {
      const closed = await terminate();
      throw Error(closed ? 'NATIVE_DEADLINE_CLOSED' : 'NATIVE_CLOSURE_UNKNOWN');
    }
    if ((await Promise.race([handler.then(() => true), cutoff])) === null)
      throw Error('PUBLICATION_SETTLEMENT_UNKNOWN');
    clearTimeout(expired);
    lines.close();
    const source = await read(join(jobRoot, 'RESULT.json')),
      accounting = await read(join(jobRoot, 'ACCOUNTING.json'));
    if (
      killed ||
      exit.signal ||
      ![0, 2].includes(exit.code) ||
      !same(source, closedMessage) ||
      !same(source.accounting, accounting) ||
      accounting.status !== 'CLOSED' ||
      accounting.pending !== null
    )
      throw Error('NATIVE_OR_ACCOUNTING_CLOSURE_UNKNOWN: ' + stderr);
    if (error && !trade) throw Error(error);
    const qualified =
      !error &&
      exit.code === 0 &&
      source.status.startsWith('COMPLETE_') &&
      publications.length === (trade ? profile.cycles : reference ? 2 : 1);
    if (operating) {
      // Terminal closure never restarts acquisition. The active failed slot may
      // receive one safe local read; all later original slots remain explicit gaps.
      for (let cycle = 1; cycle <= profile.cycles; cycle++) {
        if (serviceChecks.some(s => s.cycle === cycle)) continue;
        if (cycle === begunCycle && !publicationUncertain && performance.now() < deadline - 2000) {
          try {
            await observeSlot(cycle, 'TERMINAL_ERROR', 'retained_or_refused', () => {
              if (performance.now() >= deadline - 2000) throw Error('SERVICE_CLOSURE_DEADLINE');
            });
            continue;
          } catch (e) { error ??= String(e); if (serviceChecks.some(s => s.cycle === cycle)) continue; }
        }
        const missing = { cycle, sourceResult: 'UNRUN_TERMINAL', publicationResult: 'retained_or_unknown',
          selectedVersion: registry.status().productVersion, service: { status: 'NOT_MEASURED' } };
        await durableJson(join(jobRoot, `SERVICE_${cycle}.json`), missing);
        serviceChecks.push(missing);
      }
    }
    const changed = publications.filter(p => p.publication.changed);
    const separated = changed.some(a => changed.some(b =>
      Date.parse(b.publication.publishedAt) - Date.parse(a.publication.publishedAt) >= 300000));
    const servingPass = operating && !error && !publicationUncertain && source.cycles.length === profile.cycles &&
      serviceChecks.length === profile.cycles && serviceChecks.every(s => s.service.status === 'FRESH') && separated;
    return {
      status: operating ? (servingPass ? 'FINITE_SERVING_PASS' : 'PARTIAL') : qualified ? 'QUALIFIED_ADOPTED' : 'PARTIAL',
      source,
      ...(operating ? { serviceChecks, servingPass, changedPublicationsSeparatedBy300Seconds: separated } : {}),
      ...(trade ? { outcomes, error, publicationUncertain } : {}),
      publications,
      exit,
      stderr,
    };
  } finally {
    clearTimeout(expired);
    lines.close();
    if (!exited) await terminate();
    child.stdin.end();
  }
}

export async function main(args = process.argv.slice(2)) {
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
