// One task-owned foreground owner keeps the exact admitted base handles between
// offline checks, review and the explicitly commanded unused finite trial.
import assert from 'node:assert/strict';
import { readFile, writeFile, mkdir, lstat } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { SavedSourceGenerations, sha } from '../../dist/services/source-update/generation.js';
import { ACCEPTED } from '../../dist/contracts/saved-generation.js';
import { ParticipantRegistry } from '../../dist/services/source-update/refresh.js';
import { restoreParticipants } from '../../scripts/participant-refresh-backup.mjs';
import { runTrades } from '../../scripts/trade-refresh.mjs';
import { fixture } from '../market-feed/access-fixture.mjs';
import { guard, listening, measuredWire } from './budget.mjs';
import { finalEvidence, restoreProof } from './final.mjs';
const R = process.env.HDD_TASK_ROOT;
assert(R?.endsWith('btc-eth-current-reference-freshness-r2'));
assert(['prepare', 'continue-local'].includes(process.argv[2]));
const reopen = process.argv[2] === 'continue-local';
const inputs = JSON.parse(await readFile(join(R, 'packet/INPUTS.json'))),
  profile = inputs.acceptedSeedProfile;
const save = (name, v) =>
  writeFile(join(R, 'evidence', name + '.json'), JSON.stringify(v, null, 2) + '\n');
const absent = async (p) =>
  assert.equal(
    await lstat(p).catch((e) => {
      if (e.code === 'ENOENT') return null;
      throw e;
    }),
    null,
    'Existing task-owned state',
  );
if (!reopen) {
  await absent(join(R, 'runtime'));
  await absent(join(R, 'evidence/BASE_ADMISSION_STARTED.json'));
} else {
  await absent(join(R, 'evidence/SECOND_FINAL_BASE_ADMISSION.json'));
  assert.equal(
    JSON.parse(await readFile(join(R, 'evidence/ONE_GENUINE_SEED_INITIALIZATION.json'))).status,
    'PASS',
  );
}
await absent(join(R, 'session'));
await absent(join(R, 'PUBLIC_ADMISSION.json'));
await mkdir(join(R, 'temp'), { recursive: true });
await save(reopen ? 'SECOND_FINAL_BASE_ADMISSION' : 'BASE_ADMISSION_STARTED', {
  startedAt: new Date().toISOString(),
  pid: process.pid,
  maximumBaseAdmissions: 2,
  exactAdmissionOrdinal: reopen ? 2 : 1,
  compactSeedInitializations: 1,
});
let base,
  real,
  reader,
  f,
  held,
  heldExport,
  final,
  apiStarted = false,
  offlinePassed = false,
  trialStarted = false;
try {
  base = await SavedSourceGenerations.activate({
    root: profile.overlayRoot,
    holdersRoot: profile.holdersRoot,
    stakesRoot: profile.stakesRoot,
  });
  await base.admit(join(base.root, ACCEPTED.generation), { readOnly: true });
  await base.loadSelection();
  if (reopen)
    real = await ParticipantRegistry.open(
      join(R, 'runtime/participants'),
      join(R, 'runtime/product'),
      base,
    );
  else {
    const restored = await restoreParticipants(
      join(R, 'reference/seed/real-backup'),
      join(R, 'runtime'),
      '6739a5c4ba6b4e8f73ae1180cce3c0e6c53baf714cccab54138c8a2127c37f24',
      base,
    );
    real = restored.registry;
    await save('ONE_GENUINE_SEED_INITIALIZATION', restored.receipt);
  }
  const seed = real.productDaily.capture();
  assert.equal(seed.version, inputs.preserveAcceptedInputsAndExistingCells.closeProduct);
  assert.equal(sha(seed.csv), inputs.preserveAcceptedInputsAndExistingCells.closeCsvSha256);
  if (!reopen)
    await writeFile(
      join(R, 'PROFILE.json'),
      JSON.stringify(
        {
          ...profile,
          productRoot: real.productDaily.root,
          participantRoot: real.root,
          selectedProduct: { version: seed.version, manifestSha256: seed.manifestSha256 },
        },
        null,
        2,
      ) + '\n',
      { flag: 'wx' },
    );
  reader = await ParticipantRegistry.open(real.root, real.productDaily.root, base);
  held = reader.capture();
  heldExport = reader.productDaily.openExport(
    held.product,
    held.product.bundleId,
    'daily',
    new AbortController().signal,
  );
  f = guard(
    await fixture(
      { participants: reader, productDaily: reader.productDaily, sourceGenerations: base },
      {
        webRoot: resolve('dist/web'),
        account: { webRoot: resolve('account/dist/ui'), register: async () => {} },
      },
    ),
  );
  f.controls.now = Date.now();
  const baseline = await f.inject('/api/v2/live');
  assert.equal(baseline.statusCode, 200, baseline.body);
  await save(reopen ? 'REOPENED_NORMAL_API' : 'INITIAL_NORMAL_API', baseline.json());
  async function offline() {
    try {
      const { composed } = await import('./composed.mjs?fixture=' + Date.now());
      await composed({ R, real, base, save });
      offlinePassed = true;
      await save('OFFLINE_APPLICATION_READY', {
        status: 'PASS',
        pid: process.pid,
        seedVersion: seed.version,
        selectedPair: real.status(),
        externalRequests: 0,
        apiPrepared: true,
      });
      console.log('OFFLINE_PATH_PASS_WAITING_FOR_PREFLIGHT');
    } catch (e) {
      await save('COMPOSED_FAILURE_' + Date.now(), {
        status: 'FAIL',
        error: String(e),
        stack: e.stack,
      });
      console.log('OFFLINE_PATH_FAILED ' + String(e));
    }
  }
  await offline();
  let commandOrdinal = 0;
  const ownerDeadline = Date.now() + 3 * 3600000;
  while (Date.now() < ownerDeadline) {
    const command = await readFile(join(R, 'LOCAL_COMMAND.json'), 'utf8')
      .then((raw) => JSON.parse(raw.replace(/^\uFEFF/, '')))
      .catch((e) => {
        if (e.code === 'ENOENT') return null;
        throw e;
      });
    if (!command || command.ordinal <= commandOrdinal) {
      await new Promise((r) => setTimeout(r, 500));
      continue;
    }
    commandOrdinal = command.ordinal;
    const line = command.command;
    if (line.trim() === 'close') break;
    if (line.trim() === 'offline' && !trialStarted) {
      await offline();
      continue;
    }
    if (line.trim() !== 'trial' || !offlinePassed || trialStarted) {
      console.log('REFUSED_COMMAND');
      continue;
    }
    trialStarted = true;
    try {
      const origin = await f.app.listen({ host: '127.0.0.1', port: 0 });
      apiStarted = true;
      listening(f);
      await save('ALREADY_RUNNING_API', {
        origin,
        pid: process.pid,
        openedAt: new Date().toISOString(),
      });
      const r = await measuredWire(f, '/api/v2/live');
      assert.equal(r.statusCode, 200);
      const trial = await runTrades({
        taskRoot: R,
        preflightPath: join(R, 'PREFLIGHT.json'),
        registry: real,
        onAdoption: async (selected, check) => {
          await new Promise((r) => setTimeout(r, 1050));
          check();
          f.controls.now = Date.now();
          const response = await measuredWire(f, '/api/v2/live');
          assert.equal(response.statusCode, 200, response.body);
          const body = JSON.parse(response.body);
          assert.equal(body.datasetVersion, selected.product.version);
          assert.equal(reader.status().productVersion, selected.product.version);
          assert.equal(body.freshness.BTC.status, 'fresh');
          assert.equal(body.freshness.ETH.status, 'fresh');
          check();
          return {
            origin,
            pid: process.pid,
            body,
            readerStatus: reader.status(),
            servedAt: new Date().toISOString(),
          };
        },
      });
      await save('ACTUAL_TRIAL', trial);
      console.log('PUBLIC_SESSION_CLOSED ' + trial.status);
      if (!trial.networkClosureKnown || trial.publicationUncertain)
        throw Error('STOP_UNKNOWN_CLOSURE_OR_PUBLICATION');
      const selected = real.productDaily.capture();
      await writeFile(
        join(R, 'SELECTED_PROFILE.json'),
        JSON.stringify(
          {
            ...profile,
            productRoot: real.productDaily.root,
            participantRoot: real.root,
            selectedProduct: { version: selected.version, manifestSha256: selected.manifestSha256 },
          },
          null,
          2,
        ) + '\n',
      );
      final = await finalEvidence({ R, real, seed, f, origin, heldExport, save });
      console.log('FINAL_APPLICATION_EVIDENCE_PASS');
      break;
    } catch (e) {
      await save('OPERATION_FAILURE_' + Date.now(), {
        error: String(e),
        stack: e.stack,
        trialStarted,
      });
      console.log('OPERATION_FAILED ' + String(e));
      break;
    }
  }
} finally {
  if (heldExport && !heldExport.stream.destroyed) heldExport.stream.destroy();
  if (held) held.release();
  if (f) await f.close();
  if (reader) await reader.close();
  if (real) await real.close();
  if (final) {
    await restoreProof({ R, profile, final, save, admittedBase: base });
    console.log('FINAL_RESTORE_PASS');
  }
  if (base) await base.close();
  await save('INITIAL_RESOURCES_CLOSED', {
    closedAt: new Date().toISOString(),
    pid: process.pid,
    apiStarted,
    trialStarted,
    closed: true,
  });
}
await save('OPERATION_CLOSURE', {
  closedAt: new Date().toISOString(),
  pid: process.pid,
  ownedProcessesClosed: true,
  baseAdmissions: reopen ? 2 : 1,
  externalSessionAdmitted: trialStarted,
  indexer: 'PARKED',
  paidReconstruction: 'PARKED',
});
