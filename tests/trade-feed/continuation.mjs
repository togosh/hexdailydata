// Foreground continuation owner. The original R2 public entry/session is unchanged.
import assert from 'node:assert/strict';
import { readFile, writeFile, mkdir, readdir, lstat } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { execFileSync } from 'node:child_process';
import { digest, readCommand, closeOwned } from './control.mjs';
const R = resolve(process.env.HDD_TASK_ROOT ?? '');
assert(R.endsWith('btc-eth-current-reference-freshness-r2'));
const C = join(R, 'continuation-r1'),
  repo = process.cwd();
const read = async (p) => JSON.parse(await readFile(p));
const put = (p, v) => writeFile(p, JSON.stringify(v, null, 2) + '\n');
const save = (n, v) => put(join(C, 'evidence', n + '.json'), v);
const present = async (p) =>
  !!(await lstat(p).catch((e) => {
    if (e.code === 'ENOENT') return null;
    throw e;
  }));
const unused = async () => {
  assert(!(await present(join(R, 'session'))));
  assert(!(await present(join(R, 'PUBLIC_ADMISSION.json'))));
};
await unused();
assert.equal((await read(join(C, 'evidence/CHEAP_HARNESS.json'))).status, 'PASS');
const sourceMap = await read(join(C, 'reference/SOURCE_MAP.json'));
const names = new Set(
  sourceMap
    .map((r) => r.path)
    .filter((p) => /\.(ts|mjs|py)$/.test(p) || p === 'package.json' || p === 'package-lock.json'),
);
for (const name of ['control.mjs', 'cheap.mjs', 'continuation.mjs'])
  names.add('tests/trade-feed/' + name);
async function walk(dir) {
  for (const item of await readdir(join(repo, dir), { withFileTypes: true })) {
    assert(!item.isSymbolicLink());
    const p = dir + '/' + item.name;
    if (item.isDirectory()) await walk(p);
    else names.add(p);
  }
}
await walk('dist');
const runtimeFiles = {};
for (const p of [...names].sort()) runtimeFiles[p] = digest(await readFile(join(repo, p)));
const runtimeHash = digest(JSON.stringify(runtimeFiles));
const verifyLoaded = async () => {
  for (const [p, h] of Object.entries(runtimeFiles))
    assert.equal(digest(await readFile(join(repo, p))), h, 'LOADED_RUNTIME_CHANGED:' + p);
};
// All application modules load only after this process binds their exact bytes.
const { SavedSourceGenerations, sha } =
  await import('../../dist/services/source-update/generation.js');
const { ACCEPTED } = await import('../../dist/contracts/saved-generation.js');
const { ParticipantRegistry } = await import('../../dist/services/source-update/refresh.js');
const { fixture } = await import('../market-feed/access-fixture.mjs');
const { createBudget } = await import('./budget.mjs');
const { composed } = await import('./composed.mjs');
const { finalEvidence, restoreProof } = await import('./final.mjs');
const { runTrades, tradeStorageGuard } = await import('../../scripts/trade-refresh.mjs');
await verifyLoaded();
const ledgerPath = join(C, 'evidence/BASE_ADMISSIONS.json'),
  ledger = await read(ledgerPath);
assert(
  ledger.additional.every((x) => x.status === 'CLOSED'),
  'PRIOR_OWNER_NOT_KNOWN_CLOSED',
);
assert(ledger.prior + ledger.additional.length < 7, 'LAST_ADMISSION_RESERVED_FOR_RESTORE');
await tradeStorageGuard(R, 64 * 1024 ** 2, true);
const ordinal = ledger.prior + ledger.additional.length + 1;
const entry = {
  ordinal,
  pid: process.pid,
  openedAtUtc: new Date().toISOString(),
  status: 'OPENING',
  purpose: 'actual paired preflight and original finite trial; reused through restore',
};
ledger.additional.push(entry);
await put(ledgerPath, ledger);
const ownerRoot = join(C, 'owners', String(ordinal));
await mkdir(ownerRoot, { recursive: true });
const profile = await read(join(R, 'SELECTED_PROFILE.json'));
const budget = createBudget(join(C, 'evidence'));
let base, real, reader, f, held, heldExport, seed, origin, final, trial;
let offlinePassed = false,
  trialStarted = false,
  failure = null;
const started = Date.now(),
  refused = new Set();
const loaded = {
  pid: process.pid,
  ordinal,
  loadedAtUtc: new Date().toISOString(),
  runtimeHash,
  runtimeFiles,
  commit: execFileSync('git', ['rev-parse', 'HEAD']).toString().trim(),
  freshProcess: true,
};
await put(join(ownerRoot, 'LOADED_RUNTIME.json'), loaded);
await save('LOADED_RUNTIME', loaded);
try {
  base = await SavedSourceGenerations.activate({
    root: profile.overlayRoot,
    holdersRoot: profile.holdersRoot,
    stakesRoot: profile.stakesRoot,
  });
  await base.admit(join(base.root, ACCEPTED.generation), { readOnly: true });
  await base.loadSelection();
  entry.status = 'ADMITTED';
  await put(ledgerPath, ledger);
  real = await ParticipantRegistry.open(profile.participantRoot, profile.productRoot, base);
  seed = real.productDaily.capture();
  assert.equal(seed.version, profile.selectedProduct.version);
  assert.equal(seed.metadata.marketStorage.sequence, 23);
  reader = await ParticipantRegistry.open(real.root, real.productDaily.root, base);
  held = reader.capture();
  heldExport = reader.productDaily.openExport(
    held.product,
    held.product.bundleId,
    'daily',
    new AbortController().signal,
  );
  f = budget.guard(
    await fixture(
      { participants: reader, productDaily: reader.productDaily, sourceGenerations: base },
      {
        evidenceRoot: join(C, 'evidence'),
        webRoot: resolve('dist/web'),
        account: { webRoot: resolve('account/dist/ui'), register: async () => {} },
      },
    ),
  );
  async function offline() {
    offlinePassed = false;
    await verifyLoaded();
    await composed({ R: C, real, base, save, budget });
    assert.equal(
      real.productDaily.capture().version,
      seed.version,
      'GENUINE_SEED_CHANGED_IN_PREFLIGHT',
    );
    if (!origin) {
      origin = await f.app.listen({ host: '127.0.0.1', port: 0 });
      budget.listening(f);
    }
    f.controls.now = Date.now();
    const response = await budget.measuredWire(f, '/api/v2/live');
    assert.equal(response.statusCode, 200, response.body);
    for (const url of ['/api/v2/holders?limit=1', '/api/v2/stakes?limit=1']) {
      const r = await f.inject(url);
      assert.equal(r.statusCode, 200, r.body);
    }
    await verifyLoaded();
    await unused();
    offlinePassed = true;
    await save('PAIRED_PREFLIGHT', {
      status: 'PASS',
      actualPairedRegistry: true,
      syntheticTrades: true,
      syntheticAccountSeams: true,
      realBaseAdmissionOrdinal: ordinal,
      reusedHandles: true,
      loadedRuntimeHash: runtimeHash,
      ownerPid: process.pid,
      commit: loaded.commit,
      origin,
      ordinaryLoopback: { status: response.statusCode, body: JSON.parse(response.body) },
      selectedPair: real.status(),
      originalPublicUnused: true,
      readyAtUtc: new Date().toISOString(),
    });
    console.log('ACTUAL_PAIRED_PREFLIGHT_PASS_WAITING_FOR_REVIEW');
  }
  try {
    await offline();
  } catch (e) {
    await save('PAIRED_FAILURE_' + Date.now(), { error: String(e), stack: e.stack });
    console.log('PAIRED_PREFLIGHT_FAILED ' + String(e));
  }
  let last = 0;
  while (Date.now() - started < 3 * 3600000) {
    const c = await readCommand(C, last);
    if (c.refusal && !refused.has(c.refusal.sha256)) {
      refused.add(c.refusal.sha256);
      await save('COMMAND_REFUSAL_' + c.refusal.sha256, c.refusal);
    }
    if (!c.command) {
      await new Promise((r) => setTimeout(r, 500));
      continue;
    }
    last = c.command.ordinal;
    await put(join(ownerRoot, 'COMMAND_' + last + '.json'), c.command);
    if (c.command.command === 'close') break;
    await verifyLoaded();
    if (c.command.command === 'offline' && !trialStarted) {
      try {
        await offline();
      } catch (e) {
        await save('PAIRED_FAILURE_' + Date.now(), { error: String(e), stack: e.stack });
        console.log('PAIRED_PREFLIGHT_FAILED ' + String(e));
      }
      continue;
    }
    if (c.command.command !== 'trial' || !offlinePassed || trialStarted) {
      await save('COMMAND_REJECTED_' + last, { command: c.command, offlinePassed, trialStarted });
      continue;
    }
    await unused();
    trialStarted = true;
    trial = await runTrades({
      taskRoot: R,
      preflightPath: join(C, 'PREFLIGHT.json'),
      registry: real,
      loadedRuntimeFiles: runtimeFiles,
      onAdoption: async (selected, check) => {
        await new Promise((r) => setTimeout(r, 1050));
        check();
        f.controls.now = Date.now();
        const response = await budget.measuredWire(f, '/api/v2/live');
        assert.equal(response.statusCode, 200, response.body);
        const body = JSON.parse(response.body);
        assert.equal(body.datasetVersion, selected.product.version);
        assert.equal(body.freshness.BTC.status, 'fresh');
        assert.equal(body.freshness.ETH.status, 'fresh');
        check();
        return {
          origin,
          pid: process.pid,
          body,
          readerStatus: reader.status(),
          servedAtUtc: new Date().toISOString(),
        };
      },
    });
    await save('ACTUAL_TRIAL', trial);
    console.log('ORIGINAL_PUBLIC_SESSION_CLOSED ' + trial.status);
    if (!trial.networkClosureKnown || trial.publicationUncertain)
      throw Error('STOP_UNKNOWN_CLOSURE_OR_PUBLICATION');
    const p = real.productDaily.capture();
    await put(join(C, 'SELECTED_PROFILE.json'), {
      ...profile,
      selectedProduct: { version: p.version, manifestSha256: p.manifestSha256 },
    });
    final = await finalEvidence({ R: C, real, seed, f, origin, heldExport, save, budget });
    console.log('FINAL_GENUINE_EVIDENCE_PASS');
    break;
  }
} catch (e) {
  failure = { error: String(e), stack: e.stack };
  await save('OWNER_FAILURE_' + Date.now(), failure);
  console.log('OWNER_FAILED ' + String(e));
} finally {
  const closure = await closeOwned([
    [
      'held-export',
      heldExport
        ? async () => {
            if (!heldExport.stream.destroyed) heldExport.stream.destroy();
            await heldExport.released;
          }
        : null,
    ],
    ['held-view', held ? async () => held.release() : null],
    ['api', f ? () => f.close() : null],
    ['reader', reader ? () => reader.close() : null],
    ['writer', real ? () => real.close() : null],
  ]);
  if (final && closure.known) {
    try {
      await restoreProof({
        R: C,
        profile,
        final,
        save,
        admittedBase: base,
        budget,
        baseAdmissionCount: ordinal,
      });
      console.log('GENUINE_RESTORE_PASS_REUSED_BASE');
    } catch (e) {
      failure = { error: String(e), stack: e.stack };
      await save('RESTORE_FAILURE_' + Date.now(), failure);
    }
  }
  const baseClosed = await closeOwned([['immutable-base', base ? () => base.close() : null]]);
  entry.status = closure.known && baseClosed.known ? 'CLOSED' : 'UNKNOWN';
  entry.closedAtUtc = new Date().toISOString();
  entry.failure = failure;
  await put(ledgerPath, ledger);
  await save('OWNER_CLOSURE', {
    ...closure,
    base: baseClosed,
    baseAdmissions: ordinal,
    logicalSeedInitializations: 1,
    trialStarted,
    publicSessionExists: await present(join(R, 'session')),
    failure,
    closedAtUtc: entry.closedAtUtc,
    pid: process.pid,
  });
  console.log('CONTINUATION_OWNER_CLOSED ' + entry.status);
}
if (failure) process.exitCode = 2;
