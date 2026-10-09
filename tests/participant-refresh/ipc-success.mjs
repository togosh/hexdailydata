// Bridge-only empty fixture. The real bulk reader was already validated in COMPOSED_TESTS.
// This injects empty base indices, not claimed real participant coverage, through the actual
// descriptor fork, product journal/certificate, paired registry and Node/Python IPC.
import assert from 'node:assert/strict';
import { readFile, writeFile, mkdir, mkdtemp } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { spawn } from 'node:child_process';
import { setTimeout as delay } from 'node:timers/promises';
import {
  SavedSourceGenerations,
  canonical,
  sha,
} from '../../dist/services/source-update/generation.js';
import { ParticipantRegistry, participantPair } from '../../dist/services/source-update/refresh.js';
import { ProductDailyStore } from '../../dist/services/product-daily/store.js';
import { restoreStorage } from '../../dist/services/product-daily/storage.js';
import { ACCEPTED } from '../../dist/contracts/saved-generation.js';
import { runParticipantRefresh, prepareWindow } from '../../scripts/participant-refresh.mjs';
const R = process.env.HDD_TASK_ROOT,
  root = await mkdtemp(join(R, 'evidence/fixtures/bridge-'));
await mkdir(join(root, 'evidence'));
await mkdir(join(root, 'temp'));
const base = new SavedSourceGenerations(
  join(root, 'empty-base'),
  { root: join(root, 'holder-fixture') },
  { root: join(root, 'stake-fixture') },
);
base.selected = ACCEPTED.generation;
base.overlay = {
  holders: new Map(),
  stakes: new Map(),
  addresses: new Map(),
  numeric: new Map(),
  newHolders: [],
  newStakes: [],
  owners: new Map(),
  index: '',
  files: {},
};
const inputs = JSON.parse(await readFile(join(R, 'INPUTS.json')));
await restoreStorage(
  join(R, 'seed-backup', inputs.bundledGenuineSeed ? 'product' : ''),
  join(root, 'product'),
  inputs.bundledGenuineSeed
    ? JSON.parse(await readFile(join(R, 'seed-backup/BACKUP.json'))).productBackupSha256
    : inputs.bundledBackup.originalBackupManifestSha256,
);
const store = new ProductDailyStore(join(root, 'product'), participantPair(base));
await store.load();
const reg = await ParticipantRegistry.initialize(join(root, 'participants'), store, base);
const plan = JSON.parse(await readFile(join(R, 'SCOPE.json')));
const windows = inputs.bundledGenuineSeed ? 2 : 1;
plan.windows = plan.windows.slice(0, windows);
const n = plan.windows.at(-1).targetNumber;
plan.finalTarget = {
  number: n,
  hash: '0x' + n.toString(16).padStart(64, '0'),
  timestamp: plan.base.timestamp + (n - plan.base.number) * 10,
};
await writeFile(join(root, 'SCOPE.json'), JSON.stringify(plan));
const preflight = {
  verdict: 'PASS',
  taskId: plan.taskId,
  trialRoot: join(root, 'session'),
  synthetic: true,
  runtimeFiles: {},
  inputFiles: {},
  initialGeneration: ACCEPTED.generation,
  initialProductVersion: store.capture().version,
};
await writeFile(join(root, 'PREFLIGHT.json'), JSON.stringify(preflight));
let report;
try {
  report = await runParticipantRefresh({
    taskRoot: root,
    preflightPath: join(root, 'PREFLIGHT.json'),
    registry: reg,
    spawnChild: (_command, args, options) =>
      spawn(
        'python',
        [
          '-I',
          '-S',
          '-B',
          resolve('tests/participant-refresh/ipc_collector.py'),
          args.at(-2),
          args.at(-1),
        ],
        options,
      ),
    onAdoption: async (selected) => {
      await reg.refresh(undefined, true);
      assert.equal(reg.status().generation, selected.generation);
      return { synthetic: true, selected: reg.status() };
    },
  });
  assert.equal(report.status, 'COMPLETE_SCOPED_CATCHUP');
  assert.equal(report.source.completedWindows, windows);
  assert.equal(report.publications.length, windows);
  assert.equal(report.error, null);
  assert.equal(report.externalSessionCount, 0);
  const held = reg.capture(),
    snapshot = held.sourceGenerations.identity.snapshot;
  held.release();
  const b = { number: snapshot.number, hash: snapshot.hash, timestamp: snapshot.timestamp },
    target = {
      number: b.number + 1,
      hash: '0x' + sha('stage-expiry-fixture'),
      timestamp: b.timestamp + 10,
    };
  const draft = await prepareWindow(reg, {
    base: b,
    target,
    after: { tokenHolders: [], stakeStarts: [] },
    provenance: { tokenHolders: {}, stakeStarts: {} },
    sourceCounts: {
      tokenHolders: 0,
      stakeStarts: 0,
      stakeEnds: 0,
      stakeGoodAccountings: 0,
      affectedParents: 0,
    },
  });
  const proof = {
    format: 'participant-window-proof-1',
    complete: true,
    base: b,
    target,
    deployment: ACCEPTED.deployment,
    captureLedgerSha256: sha('synthetic'),
    afterSha256: { tokenHolders: sha('[]'), stakeStarts: sha('[]') },
    families: plan.families,
    explicitEmptyAndRepeats: true,
    parentChecks: true,
    witnessChecks: true,
    closingHeadersAndMetadata: true,
    networkClosureKnown: true,
  };
  const old = await readFile(join(reg.root, 'CURRENT.json'));
  let expired = false;
  await assert.rejects(
    reg.publish({ ...draft, proofSha256: sha(canonical(proof)) }, proof, {
      beforeCommit: () => {
        if (expired) throw Error('SYNTHETIC_STAGE_DEADLINE');
      },
      fault: async (phase) => {
        if (phase === 'participant-stage') {
          await delay(20);
          expired = true;
        }
      },
    }),
    /SYNTHETIC_STAGE_DEADLINE/,
  );
  assert((await readFile(join(reg.root, 'CURRENT.json'))).equals(old));
  assert.equal(reg.status().generation, JSON.parse(old).generation);
  const recovery = await reg.recoverOwnedFailure();
  assert.equal(recovery.outcome, 'COMPLETED_SAVED_PUBLICATION');
  const receipt = {
    status: 'PASS',
    synthetic: true,
    emptyInjectedBaseIndices: true,
    realBaseEvidence: 'COMPOSED_TESTS.json',
    newBulkReadinessPasses: 0,
    externalRequests: 0,
    root,
    bridge: report,
    delayedStage: { pointerUnchangedAtRefusal: true, recovery },
  };
  await writeFile(
    join(R, 'evidence/IPC_SUCCESS_AND_STAGE_TEST.json'),
    JSON.stringify(receipt, null, 2) + '\n',
  );
  console.log(
    'Actual Node/Python execute + paired publication/ack PASS; staged-expiry recovery PASS',
  );
} finally {
  await reg.close();
  await base.close();
}
