// Explicit foreground operating owner; default is offline and opens no application.
import assert from 'node:assert/strict';
import { readFile, writeFile, mkdir, lstat } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { execFileSync } from 'node:child_process';
import { digest, closeOwned } from './control.mjs';

const R = String.raw`C:\Code\HEXDailyData-Subgraph-First-Launch-Proof-R2\btc-eth-current-reference-freshness-r2`;
const T = join(R, 'operating-refresh-r1');
const read = async (p) => JSON.parse(await readFile(p));
const put = (p, v) => writeFile(p, JSON.stringify(v, null, 2) + '\n');
const save = (n, v) => put(join(T, 'evidence', n + '.json'), v);
const present = async (p) =>
  Boolean(
    await lstat(p).catch((e) => {
      if (e.code === 'ENOENT') return null;
      throw e;
    }),
  );

export async function runReviewedOperating() {
  assert.equal(resolve(process.cwd()), String.raw`C:\Code\HEXDailyData-v2-Subgraph-History-R2`);
  const unused = async () => {
    assert(!(await present(join(T, 'session'))), 'RECOVERY_SESSION_SPENT');
    assert(!(await present(join(T, 'PUBLIC_ADMISSION.json'))), 'RECOVERY_ADMISSION_SPENT');
  };
  await unused();
  const plan = await read(join(T, 'FROZEN_PLAN.json'));
  const reviewPath = join(T, 'evidence/PREFLIGHT_REVIEW.json');
  const review = await read(reviewPath);
  assert.equal(review.verdict, 'PASS');
  assert.equal(review.candidateCommit, plan.commit);
  assert.equal(review.runtimeHash, plan.runtimeHash);
  assert.equal(digest(JSON.stringify(plan.runtimeFiles)), plan.runtimeHash);
  assert.equal(review.planSha256, digest(await readFile(join(T, 'FROZEN_PLAN.json'))));
  assert.equal(execFileSync('git', ['rev-parse', 'HEAD']).toString().trim(), plan.commit);
  const verify = async () => {
    for (const [p, h] of Object.entries(plan.runtimeFiles))
      assert.equal(digest(await readFile(p)), h, 'FROZEN_RUNTIME_CHANGED:' + p);
    for (const [p, h] of Object.entries(plan.inputFiles))
      assert.equal(digest(await readFile(join(T, p))), h, 'FROZEN_INPUT_CHANGED:' + p);
    for (const x of await read(join(T, 'evidence/FROZEN_OLD_FILES.json')))
      assert.equal(digest(await readFile(join(R, x.path))), x.sha256, 'OLD_EVIDENCE_CHANGED');
  };
  await verify();
  const policy = await read(join(T, 'evidence/OPERATING_GATE.json'));
  assert.equal(policy.status, 'PASS');
  assert(policy.noReplayProved && policy.actualSchedulerAndServicePassed);
  for (const [path, hash] of Object.entries(policy.sourceBindings))
    assert.equal(digest(await readFile(path)), hash);
  await mkdir(join(T, 'temp'), { recursive: true });
  const { SavedSourceGenerations, sha } =
    await import('../../dist/services/source-update/generation.js');
  const { ACCEPTED } = await import('../../dist/contracts/saved-generation.js');
  const { ParticipantRegistry } = await import('../../dist/services/source-update/refresh.js');
  const { fixture } = await import('../market-feed/access-fixture.mjs');
  const { createBudget } = await import('./budget.mjs');
  const { finalEvidence, restoreProof } = await import('./final.mjs');
  const { runOperatingTrades, taskId, operatingTaskId, operatingProfileId, responseCookiePolicyId, tradeStorageGuard } =
    await import('../../scripts/trade-refresh.mjs');
  const { checkTradeService } = await import('../../scripts/trade-publication.mjs');
  await verify();
  const ledgerPath = join(T, 'evidence/BASE_ADMISSIONS.json');
  const ledger = (await present(ledgerPath))
    ? await read(ledgerPath)
    : { prior: 8, maximum: 14, additional: [] };
  assert(
    ledger.additional.every((x) => x.status === 'CLOSED'),
    'PRIOR_OWNER_UNCERTAIN',
  );
  assert(ledger.additional.length < 6, 'BASE_ADMISSION_BOUND');
  const ordinal = ledger.prior + ledger.additional.length + 1;
  await tradeStorageGuard(R, 64 * 1024 ** 2, true);
  const entry = {
    ordinal,
    pid: process.pid,
    status: 'OPENING',
    openedAtUtc: new Date().toISOString(),
  };
  ledger.additional.push(entry);
  await put(ledgerPath, ledger);
  const ownerRoot = join(T, 'owners', String(ordinal));
  await mkdir(ownerRoot, { recursive: true });
  const loaded = {
    commit: plan.commit,
    pid: process.pid,
    ordinal,
    runtimeHash: plan.runtimeHash,
    runtimeFiles: plan.runtimeFiles,
    loadedAtUtc: new Date().toISOString(),
    freshProcess: true,
  };
  await put(join(ownerRoot, 'LOADED_RUNTIME.json'), loaded);
  await save('LOADED_RUNTIME', loaded);
  const profile = await read(join(T, 'reference/prior/SELECTED_PROFILE.json'));
  const budget = createBudget(join(T, 'evidence'), {
    attempts: 384,
    bytes: 512 * 1024 ** 2,
    apiSeconds: 2400,
  });
  let base,
    real,
    reader,
    f,
    held,
    heldExport,
    seed,
    origin,
    final,
    failure = null;
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
    assert.equal(seed.metadata.marketStorage.sequence, 25);
    assert.deepEqual(seed.metadata.pair, profile.pair);
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
          evidenceRoot: join(T, 'evidence'),
          webRoot: resolve('dist/web'),
          account: { webRoot: resolve('account/dist/ui'), register: async () => {} },
        },
      ),
    );
    origin = await f.app.listen({ host: '127.0.0.1', port: 0 });
    budget.listening(f);
    f.controls.now = Date.now();
    const smoke = await budget.measuredWire(f, '/api/v2/live');
    assert.equal(smoke.statusCode, 200, smoke.body);
    assert.equal(JSON.parse(smoke.body).datasetVersion, seed.version);
    await verify();
    await unused();
    await save('READY', {
      status: 'PASS',
      pid: process.pid,
      runtimeHash: plan.runtimeHash,
      actualPairedRegistry: true,
      reusedFullPairedProof: true,
      syntheticAccountSeams: true,
      origin,
      ordinaryLoopback: { status: smoke.statusCode, body: JSON.parse(smoke.body) },
      initialPair: real.status(),
      heldOriginalExport: true,
      readyAtUtc: new Date().toISOString(),
    });
    const pre = {
      verdict: 'PASS',
      taskId,
      authorityTaskId: operatingTaskId,
      tradeProfileId: operatingProfileId,
      taskRoot: T,
      synthetic: false,
      runtimeHash: plan.runtimeHash,
      runtimeFiles: plan.runtimeFiles,
      inputFiles: plan.inputFiles,
      initialGeneration: real.status().generation,
      initialProductVersion: seed.version,
      independentReviewSha256: sha(await readFile(reviewPath)),
      scopeSha256: sha(await readFile(join(T, 'packet/SCOPE.json'))),
      readySha256: sha(await readFile(join(T, 'evidence/READY.json'))),
      operatingGateSha256: sha(await readFile(join(T, 'evidence/OPERATING_GATE.json'))),
      responseCookiePolicyId,
    };
    await put(join(T, 'PREFLIGHT.json'), pre);
    await verify();
    await unused();
    console.log('READY_SMOKE_PASS_STARTING_AUTHORIZED_OPERATING_SESSION');
    const trial = await runOperatingTrades({
      registry: real,
      loadedRuntimeFiles: plan.runtimeFiles,
      onSlot: async ({ cycle, sourceResult, publicationResult, selected }, check) => {
        await new Promise((r) => setTimeout(r, 1050));
        check();
        const requestStartedAt = Date.now();
        f.controls.now = requestStartedAt;
        const r = await budget.measuredWire(f, '/api/v2/live');
        assert.equal(r.statusCode, 200, r.body);
        const body = JSON.parse(r.body);
        const measured = checkTradeService(body, selected, requestStartedAt, Date.now());
        check();
        return {
          ...measured, cycle, sourceResult, publicationResult, httpStatus: r.statusCode,
          origin,
          pid: process.pid,
          body,
          readerStatus: reader.status(),
        };
      },
    });
    await save('ACTUAL_TRIAL', trial);
    console.log('OPERATING_PUBLIC_CLOSED ' + trial.status);
    if (!trial.networkClosureKnown || trial.publicationUncertain)
      throw Error('UNKNOWN_CLOSURE_OR_PUBLICATION');
    const p = real.productDaily.capture();
    await put(join(T, 'SELECTED_PROFILE.json'), {
      ...profile,
      selectedProduct: { version: p.version, manifestSha256: p.manifestSha256 },
    });
    final = await finalEvidence({ R: T, real, seed, f, origin, heldExport, save, budget, operating: true });
  } catch (e) {
    failure = { error: String(e), stack: e.stack };
    await save('OWNER_FAILURE', failure);
  } finally {
    const closed = await closeOwned([
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
    if (final && closed.known) {
      try {
        await restoreProof({
          R: T,
          profile,
          final,
          save,
          admittedBase: base,
          budget,
          baseAdmissionCount: ordinal,
        });
      } catch (e) {
        failure = { error: String(e), stack: e.stack };
        await save('RESTORE_FAILURE', failure);
      }
    }
    const baseClosed = await closeOwned([['immutable-base', base ? () => base.close() : null]]);
    entry.status = closed.known && baseClosed.known ? 'CLOSED' : 'UNKNOWN';
    entry.closedAtUtc = new Date().toISOString();
    entry.failure = failure;
    await put(ledgerPath, ledger);
    await save('OWNER_CLOSURE', {
      ...closed,
      base: baseClosed,
      baseAdmissions: ordinal,
      newAdmissions: ledger.additional.length,
      newSeedInitializations: 0,
      pid: process.pid,
      failure,
      closedAtUtc: entry.closedAtUtc,
    });
    console.log('OPERATING_OWNER_CLOSED ' + entry.status);
  }
  if (failure) throw Error(failure.error);
}

if (process.argv[2] === 'run-reviewed') await runReviewedOperating();
else
  console.log(
    'Offline default: no application, base admission or public request. Explicit run-reviewed requires frozen review and deterministic ready gates.',
  );
