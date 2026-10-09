// Explicit finite current refresh. No timers/services installed and no default requests.
import { readFile, open, unlink, lstat } from 'node:fs/promises';
import { resolve, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import { hash } from '../dist/history-bootstrap/normalize.js';
import { ProductDailyStore } from '../dist/services/product-daily/store.js';
import { readProductProfile, ProductProfileSchema } from '../dist/services/product-daily/open.js';
import {
  publishStoredMarket,
  checkMarketCapacity,
  reserveCaptureStorage,
  settleCaptureStorage,
} from '../dist/services/product-daily/storage.js';
const repository = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const runtime = join(repository, 'scripts/market-refresh');
export async function durableJson(path, value) {
  const f = await open(path, 'wx');
  try {
    await f.writeFile(JSON.stringify(value, null, 2) + '\n');
    await f.sync();
  } finally {
    await f.close();
  }
}
export function qualifyCompletion(message, exit, final, accounting, published, maximum) {
  const matches =
    JSON.stringify(final) === JSON.stringify(message) &&
    JSON.stringify(accounting) === JSON.stringify(message?.accounting);
  const settled =
    matches &&
    [0, 2].includes(exit.code) &&
    !exit.signal &&
    message?.accounting?.status === 'CLOSED' &&
    message.accounting.pending === null;
  const complete =
    settled &&
    exit.code === 0 &&
    message?.status === 'COMPLETE_FINITE_TRIAL' &&
    message.rounds === maximum &&
    published === maximum;
  return {
    settled,
    complete,
    error: !matches
      ? 'COLLECTOR_FINAL_RESULT_MISMATCH'
      : message?.status === 'COMPLETE_FINITE_TRIAL' && !complete
        ? 'COLLECTOR_NATIVE_EXIT_OR_PUBLICATION_INCOMPLETE'
        : null,
  };
}
export async function publishCycle(store, writer, output, message, active = () => true) {
  const remaining = message.expiresAtUnixSeconds * 1000 - Date.now();
  // Python has sub-millisecond UTC precision; Node Date.now rounds to milliseconds.
  // Clamp the local envelope to 30s rather than reject that harmless rounding edge.
  if (!Number.isFinite(remaining) || remaining <= 0 || remaining > 31000)
    throw Error('PUBLICATION_DEADLINE');
  const deadline = performance.now() + Math.min(remaining, 30000);
  const assertCurrent = () => {
    if (performance.now() >= deadline || !active())
      throw Error('PUBLICATION_DEADLINE_OR_CONTROLLER_CLOSED');
  };
  assertCurrent();
  if (
    !Number.isInteger(message.cycle) ||
    message.cycle < 1 ||
    message.cycle > 3 ||
    message.update !== `ROUND_${message.cycle}_UPDATE.json`
  )
    throw Error('CYCLE_MESSAGE');
  const bytes = await readFile(join(output, message.update));
  if (bytes.length > 65536 || hash(bytes) !== message.updateSha256)
    throw Error('CHECKED_UPDATE_BINDING');
  const proof = JSON.parse(await readFile(join(output, `ROUND_${message.cycle}_AUDIT.json`)));
  if (proof.status !== 'PASS' || !proof.capturePromotable || proof.sealedRounds !== message.cycle)
    throw Error('CYCLE_NOT_CHECKED');
  const update = JSON.parse(bytes),
    observedAtUtc = new Date(message.pin.timestamp * 1000).toISOString();
  if (
    update.readings.length !== 2 ||
    update.readings[0].kind !== 'market' ||
    update.readings[1].kind !== 'tracked-liquidity' ||
    update.liquidityHistory.length ||
    update.readings.some((r) => Date.parse(r.observedAtUtc) !== Date.parse(observedAtUtc))
  )
    throw Error('CURRENT_ONLY_PAIRED_UPDATE');
  const base = store.capture();
  const result = await publishStoredMarket(store, writer, update, assertCurrent, undefined, {
    output: resolve(output),
    update: message.update,
    updateSha256: hash(bytes),
    audit: `ROUND_${message.cycle}_AUDIT.json`,
    auditSha256: hash(await readFile(join(output, `ROUND_${message.cycle}_AUDIT.json`))),
  });
  const selected = result.selected;
  try {
    assertCurrent();
  } catch (e) {
    e.publicationUncertain = true;
    throw e;
  }
  const publishedAt = new Date().toISOString();
  const receipt = {
    cycle: message.cycle,
    previous: base.version,
    selected,
    changed: result.changed,
    updateSha256: hash(bytes),
    observedAtUtc,
    pin: message.pin,
    sealedAt: message.sealedAt,
    publishedAt,
    ageAtPublicationSeconds: (Date.parse(publishedAt) - Date.parse(observedAtUtc)) / 1000,
    observations: store.capture().metadata.observations.length,
    historicalBuckets: store.capture().metadata.liquidityHistory.length,
    retainedStorage: result.storage,
    retention: result.retention ?? null,
  };
  await durableJson(join(output, `PUBLICATION_${message.cycle}.json`), receipt);
  return receipt;
}

export async function runRefresh(
  config,
  { onPublished = async () => null, onBegin = async () => {}, testLaunchCollector } = {},
) {
  const { mode, profilePath, output, preflightPath } = config;
  const gas = config.feed === 'gas';
  const protocol = config.feed === 'protocol';
  if (config.feed && !['gas', 'market', 'protocol'].includes(config.feed)) throw Error('FEED_KIND');
  const selectedRuntime = protocol
    ? join(repository, 'scripts/protocol-feed')
    : gas
      ? join(repository, 'scripts/gas-feed')
      : runtime;
  const publish = protocol
    ? (await import('./protocol-publication.mjs')).publishProtocol
    : gas
      ? (await import('./gas-publication.mjs')).publishGas
      : publishCycle;
  if (!['once', 'trial'].includes(mode)) throw Error('EXPLICIT_MODE_REQUIRED');
  const preBytes = await readFile(preflightPath),
    pre = JSON.parse(preBytes),
    profileBytes = await readFile(profilePath);
  if (Boolean(pre.synthetic) !== Boolean(testLaunchCollector))
    throw Error('SYNTHETIC_BINDING_REQUIRES_INJECTED_OFFLINE_COLLECTOR');
  if (
    pre.verdict !== 'PASS' ||
    (protocol
      ? pre.feed !== 'protocol'
      : gas
        ? pre.feed !== 'gas'
        : pre.feed && pre.feed !== 'market') ||
    hash(profileBytes) !== pre.profileSha256 ||
    resolve(output) !== pre.trialRoot ||
    resolve(profilePath) !== pre.profilePath
  )
    throw Error('PREFLIGHT_BINDING');
  for (const [path, digest] of Object.entries(pre.runtimeFiles))
    if (hash(await readFile(join(repository, path))) !== digest)
      throw Error('RUNTIME_CHANGED: ' + path);
  if (
    await lstat(output).catch((e) => {
      if (e.code === 'ENOENT') return null;
      throw e;
    })
  )
    throw Error('EXISTING_OR_UNCERTAIN_TRIAL');
  if (profileBytes.length > 16384) throw Error('PROFILE_BOUND');
  const profile =
    gas || protocol
      ? ProductProfileSchema.pick({ productRoot: true, pair: true }).parse(JSON.parse(profileBytes))
      : await readProductProfile(profilePath);
  if (
    profile.productRoot !== pre.productRoot ||
    resolve(profile.productRoot) === resolve(pre.acceptedProductRoot)
  )
    throw Error('NEW_ROOT_REQUIRED');
  const store = new ProductDailyStore(profile.productRoot, profile.pair);
  await store.load();
  if (store.capture().version !== pre.seedVersion) throw Error('SEED_CHANGED');
  await checkMarketCapacity(store.root);
  const lockPath = join(profile.productRoot, 'MARKET_REFRESH.lock'),
    lock = await open(lockPath, 'wx');
  let writer,
    child,
    completion,
    collectorClosed = false,
    watchdog,
    emergencyClosure,
    settled = false,
    closedMessage,
    error,
    unknownPublication = false;
  let captureReservation;
  const publications = [],
    began = new Date().toISOString();
  try {
    await lock.writeFile(
      JSON.stringify({ pid: process.pid, output, preflightSha256: hash(preBytes), began }),
    );
    await lock.sync();
    // Both locks precede spawning any provider worker. Held until cycle publication settles.
    writer = await store.acquireWriter();
    captureReservation = await reserveCaptureStorage(store, writer, output);
    const env = Object.fromEntries(
      Object.entries(process.env).filter(([k]) =>
        ['SYSTEMROOT', 'WINDIR', 'PATH', 'PATHEXT', 'COMSPEC', 'TEMP', 'TMP'].includes(
          k.toUpperCase(),
        ),
      ),
    );
    env.PYTHONIOENCODING = 'utf-8';
    child = (testLaunchCollector ?? spawn)(
      'python',
      [
        '-I',
        '-S',
        join(selectedRuntime, 'collector.py'),
        mode,
        resolve(output),
        resolve(preflightPath),
      ],
      { cwd: repository, env, stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true },
    );
    completion = new Promise((resolve) => {
      child.once('error', (e) => {
        collectorClosed = true;
        resolve({ code: null, spawnError: String(e) });
      });
      child.once('close', (code, signal) => {
        collectorClosed = true;
        resolve({ code, signal });
      });
    });
    child.stdin.on('error', (e) => {
      error ??= e;
    });
    // Independent parent bound. This task is Windows-only; target only our own
    // child PID and its descendants. Normal physical requests reap well before it.
    watchdog = setTimeout(
      () => {
        if (collectorClosed) return;
        error ??= Error('WHOLE_TRIAL_PARENT_CUTOFF');
        child.stdin.end();
        emergencyClosure = new Promise((resolve) => {
          const killer = spawn(
            join(process.env.SystemRoot ?? process.env.SYSTEMROOT, 'System32', 'taskkill.exe'),
            ['/PID', String(child.pid), '/T', '/F'],
            { windowsHide: true, stdio: 'ignore', timeout: 1500 },
          );
          killer.once('error', (e) => resolve({ error: String(e) }));
          killer.once('close', (code, signal) => resolve({ code, signal }));
        });
      },
      protocol ? 1796000 : gas ? 1196000 : 2696000,
    );
    let stderr = '';
    child.stderr.on('data', (b) => {
      stderr += b.toString();
      if (stderr.length > 16384) stderr = stderr.slice(-16384);
    });
    for await (const line of createInterface({ input: child.stdout, crlfDelay: Infinity })) {
      let message;
      try {
        if (line.length > 32768) throw Error('IPC_BOUND');
        message = JSON.parse(line);
        if (message.type === 'closed') {
          closedMessage = message.result;
          continue;
        }
        if (error) throw error;
        if (message.type === 'begin') {
          if (!writer) writer = await store.acquireWriter();
          await onBegin(message);
          child.stdin.write(JSON.stringify({ ok: true, cycle: message.cycle }) + '\n');
        } else if (message.type === 'qualified') {
          const accounting = JSON.parse(await readFile(join(output, 'ACCOUNTING.json')));
          if (
            accounting.mode !==
              (testLaunchCollector ? 'SYNTHETIC_OFFLINE_TEST' : 'OWNER_AUTHORIZED_PUBLIC') ||
            accounting.status !== (testLaunchCollector ? 'SYNTHETIC_OFFLINE_TEST' : 'ADMITTED') ||
            accounting.pending !== null
          )
            throw Error('PUBLIC_ACCOUNTING_NOT_SETTLED');
          const receipt = await publish(
            store,
            writer,
            output,
            message,
            () => !collectorClosed && !error,
          );
          await store.releaseWriter(writer);
          writer = undefined;
          const adoption = await onPublished(receipt);
          const done = { ...receipt, adoption };
          await durableJson(join(output, `ADOPTION_${message.cycle}.json`), done);
          publications.push(done);
          child.stdin.write(
            JSON.stringify({
              ok: true,
              cycle: message.cycle,
              version: receipt.selected.version,
              adoption,
            }) + '\n',
          );
        } else if (message.type === 'no-advance') {
          await store.releaseWriter(writer);
          writer = undefined;
          child.stdin.write(
            JSON.stringify({ ok: true, cycle: message.cycle, status: 'NO_ADVANCE' }) + '\n',
          );
        } else throw Error('UNEXPECTED_COLLECTOR_MESSAGE');
      } catch (e) {
        error = e;
        unknownPublication ||=
          e.publicationUncertain === true || Boolean(writer && store.writerUncertain(writer));
        child.stdin.write(
          JSON.stringify({ ok: false, cycle: message?.cycle, error: String(e) }) + '\n',
        );
      }
    }
    child.stdin.end();
    const exit = await completion;
    clearTimeout(watchdog);
    if (emergencyClosure) await emergencyClosure;
    const finalBytes = await readFile(join(output, 'RESULT.json'));
    const completionProof = qualifyCompletion(
      closedMessage,
      exit,
      JSON.parse(finalBytes),
      JSON.parse(await readFile(join(output, 'ACCOUNTING.json'))),
      publications.length,
      mode === 'once' ? 1 : 3,
    );
    settled = completionProof.settled;
    if (completionProof.error) error ??= Error(completionProof.error);
    let captureStorage = null;
    if (settled && !unknownPublication) {
      writer ??= await store.acquireWriter();
      captureStorage = await settleCaptureStorage(
        store,
        writer,
        output,
        closedMessage.accounting.storageChargedBytes,
        captureReservation,
      );
    }
    const result = {
      status: error ? 'PARTIAL' : (closedMessage?.status ?? 'UNKNOWN'),
      began,
      completedAt: new Date().toISOString(),
      exit,
      publications,
      collector: closedMessage ?? null,
      error: error ? String(error) : null,
      stderr,
      externalSessionCount: testLaunchCollector ? 0 : 1,
      synthetic: Boolean(testLaunchCollector),
      automaticRestart: false,
      captureStorage,
    };
    await durableJson(join(output, 'JOB_RESULT.json'), result);
    return result;
  } finally {
    // Ending stdin wakes the bounded collector; await its native close before releasing ownership.
    if (child) {
      child.stdin.end();
      await completion;
      clearTimeout(watchdog);
      if (emergencyClosure) await emergencyClosure;
    } else settled = true; // Failed before any provider process was spawned.
    if (writer) {
      try {
        await store.releaseWriter(writer, !settled || unknownPublication);
      } catch (e) {
        unknownPublication = true;
        error ??= e;
      }
    }
    await lock.close();
    if (settled && !unknownPublication) await unlink(lockPath);
  }
}

export async function main(args = process.argv.slice(2)) {
  const [mode, ...rest] = args;
  if (!['once', 'trial'].includes(mode) || rest.length !== 6) {
    console.log(
      'Explicit once|trial --profile FILE --output NEW_DIRECTORY --preflight FILE; no default requests.',
    );
    return 2;
  }
  const options = {};
  for (let i = 0; i < rest.length; i += 2) {
    if (!['--profile', '--output', '--preflight'].includes(rest[i]) || options[rest[i]])
      throw Error('ARGUMENTS');
    options[rest[i]] = rest[i + 1];
  }
  const result = await runRefresh({
    mode,
    profilePath: options['--profile'],
    output: options['--output'],
    preflightPath: options['--preflight'],
  });
  console.log(JSON.stringify(result));
  return result.status === 'COMPLETE_FINITE_TRIAL' ? 0 : 2;
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url))
  process.exitCode = await main();
