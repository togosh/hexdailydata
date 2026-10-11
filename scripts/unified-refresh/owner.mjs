// Foreground owner for one exact qualification. No default or reusable live grant.
import assert from 'node:assert/strict';
import { readFile, writeFile, mkdir, lstat, statfs, realpath } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { execFileSync } from 'node:child_process';
import net from 'node:net';
import tls from 'node:tls';
import https from 'node:https';
import dns from 'node:dns';
import { syncBuiltinESMExports } from 'node:module';
import { publicAuthority, publicProfile } from './public-profile.mjs';
import {
  operatingPolicy,
  liveOperatingFormat,
  verifyPriorOperatingSafety,
} from './operating-authority.mjs';
import { finalProof } from './final-proof.mjs';
import {
  canonical,
  sha,
  SavedSourceGenerations,
} from '../../dist/services/source-update/generation.js';
import { ParticipantRegistry } from '../../dist/services/source-update/refresh.js';
import { ACCEPTED } from '../../dist/contracts/saved-generation.js';
import { restoreParticipants } from '../participant-refresh-backup.mjs';
import { durableJson } from '../market-refresh.mjs';
const W = String.raw`C:\Code\HEXDailyData-v2-Subgraph-History-R2`;
const read = async (p) => JSON.parse(await readFile(p));
async function absent(p) {
  assert(
    !(await lstat(p).catch((e) => {
      if (e.code === 'ENOENT') return null;
      throw e;
    })),
    'EXISTING_OR_UNCERTAIN:' + p,
  );
}
async function put(p, v) {
  await writeFile(p, JSON.stringify(v, null, 2) + '\n');
}

export function readinessRoutes(date) {
  assert(/^\d{4}-\d{2}-\d{2}$/.test(date));
  return [
    '/api/v2/daily?from=' + date + '&to=' + date + '&limit=1',
    '/api/v2/holders?limit=1',
    '/api/v2/stakes?limit=1',
  ];
}

// Preserve the reader's ordinary polling interval; never force reader refresh.
export async function finalOrdinaryAdoption(
  observe,
  save,
  sleep = (ms) => new Promise((r) => setTimeout(r, ms)),
) {
  const samples = [];
  for (let n = 0; n < 5; n++) {
    if (n) await sleep(1050);
    const sample = await observe();
    samples.push(sample);
    if (!sample.adoptionPending) {
      await save('FINAL_ORDINARY_ADOPTION', { status: 'PASS', samples });
      return sample;
    }
  }
  await save('FINAL_ORDINARY_ADOPTION', { status: 'FAIL', samples });
  throw Error('FINAL_ORDINARY_READER_ADOPTION_NOT_OBSERVED');
}

export async function runReviewedPublic(runUnified, profileId = publicProfile) {
  const operating = profileId === liveOperatingFormat;
  const authority = operating
    ? { ...operatingPolicy, profileHash: sha(canonical(operatingPolicy)) }
    : publicAuthority(profileId);
  assert(authority, 'EXACT_PUBLIC_OWNER_AUTHORITY');
  const { task: publicTask, root: T, profileHash: publicProfileHash, packetHashes } = authority;
  assert.equal(resolve(process.cwd()), W);
  assert.equal(await realpath(T), T);
  await absent(join(T, 'session'));
  await absent(join(T, 'PUBLIC_ADMISSION.json'));
  const plan = await read(join(T, 'FROZEN_PLAN.json')),
    review = await read(join(T, 'evidence/PREFLIGHT_REVIEW.json'));
  assert.equal(review.verdict, 'PASS');
  assert.equal(review.candidateCommit, plan.commit);
  assert.equal(review.planSha256, sha(await readFile(join(T, 'FROZEN_PLAN.json'))));
  assert.equal(
    execFileSync('git', ['rev-parse', 'HEAD'], { cwd: W }).toString().trim(),
    plan.commit,
  );
  const verify = async () => {
    for (const [p, h] of Object.entries(plan.runtimeFiles))
      assert.equal(sha(await readFile(join(W, p))), h, 'LOADED_SOURCE_CHANGED:' + p);
    for (const [p, h] of Object.entries(plan.inputFiles))
      assert.equal(sha(await readFile(join(T, p))), h, 'INPUT_CHANGED:' + p);
  };
  await verify();
  if (operating)
    await durableJson(
      join(T, 'evidence/PRIOR_OWNER_SAFETY.json'),
      await verifyPriorOperatingSafety(),
    );
  const deny = () => {
    throw Error('OWNER_EXTERNAL_NETWORK_DENIED');
  };
  tls.connect = https.get = https.request = globalThis.fetch = deny;
  for (const o of [dns, dns.promises])
    for (const k of Object.keys(o))
      if (k === 'lookup' || k.startsWith('resolve') || k === 'reverse') o[k] = deny;
  dns.lookup = (host, options, callback) => {
    assert.equal(host, '127.0.0.1');
    const cb = typeof options === 'function' ? options : callback;
    queueMicrotask(() =>
      options?.all ? cb(null, [{ address: host, family: 4 }]) : cb(null, host, 4),
    );
  };
  const connect = net.Socket.prototype.connect;
  net.Socket.prototype.connect = function (...a) {
    const o = Array.isArray(a[0]) ? a[0][0] : a[0];
    assert(o?.host === '127.0.0.1' && Number.isInteger(o.port), 'LITERAL_LOOPBACK_ONLY');
    return connect.apply(this, a);
  };
  syncBuiltinESMExports();
  process.env.HDD_TASK_ROOT = T;
  const { fixture } = await import('../../tests/market-feed/access-fixture.mjs');
  const { createBudget } = await import('../../tests/trade-feed/budget.mjs');
  const { previews, restoreProof } = await import('../../tests/trade-feed/final.mjs');
  const { closeOwned } = await import('../../tests/trade-feed/control.mjs');
  const localLineage = await read(join(T, 'evidence/LOCAL_LIMIT_LINEAGE.json'));
  assert.equal(localLineage.status, 'PASS');
  const budget = createBudget(join(T, 'evidence'), {
    attempts: localLineage.remaining.attempts,
    bytes: localLineage.remaining.chargedBytes,
    apiSeconds: localLineage.remaining.listenerSeconds,
  });
  const profile = await read(join(T, 'reference/source_reference_reference_SELECTED_PROFILE.json'));
  profile.productRoot = join(T, 'runtime/product');
  profile.participantRoot = join(T, 'runtime/participants');
  await mkdir(join(T, 'temp'), { recursive: true });
  const admissionsPath = join(T, 'evidence/BASE_ADMISSIONS.json');
  const ledger = await read(admissionsPath).catch((e) => {
    if (e.code === 'ENOENT') return { maximum: 8, entries: [] };
    throw e;
  });
  assert(
    ledger.entries.length < 8 && ledger.entries.every((e) => e.status === 'CLOSED'),
    'BASE_ADMISSION_OWNERSHIP',
  );
  const entry = {
    ordinal: ledger.entries.length + 1,
    pid: process.pid,
    status: 'OPENING',
    openedAtUtc: new Date().toISOString(),
  };
  ledger.entries.push(entry);
  await put(admissionsPath, ledger);
  const attemptEvidence = join(T, 'evidence', 'owner-attempt-' + entry.ordinal);
  await mkdir(attemptEvidence);
  const save = async (n, v) => {
    await put(join(attemptEvidence, n + '.json'), v);
    await put(join(T, 'evidence', n + '.json'), v);
  };
  let base,
    real,
    reader,
    f,
    held,
    heldExport,
    seed,
    final,
    result,
    failure = null;
  try {
    const disk = await statfs(T);
    assert(disk.bavail * disk.bsize > 20 * 1024 ** 3);
    base = await SavedSourceGenerations.activate({
      root: profile.overlayRoot,
      holdersRoot: profile.holdersRoot,
      stakesRoot: profile.stakesRoot,
    });
    await base.admit(join(base.root, ACCEPTED.generation), { readOnly: true });
    await base.loadSelection();
    entry.status = 'ADMITTED';
    await put(admissionsPath, ledger);
    const restoreMarker = join(T, 'INITIAL_RESTORE.json');
    const prior = await read(restoreMarker).catch((e) => {
      if (e.code === 'ENOENT') return null;
      throw e;
    });
    if (!prior) {
      await absent(join(T, 'runtime'));
      await durableJson(restoreMarker, {
        status: 'ADMITTED',
        backupSha256: plan.seedBackupSha256,
        pid: process.pid,
      });
      const restored = await restoreParticipants(
        join(T, 'seed-backup'),
        join(T, 'runtime'),
        plan.seedBackupSha256,
        base,
      );
      real = restored.registry;
      await put(restoreMarker, {
        status: 'COMPLETE',
        receipt: restored.receipt,
        backupSha256: plan.seedBackupSha256,
        pid: process.pid,
      });
    } else {
      assert(
        prior.status === 'COMPLETE' && prior.backupSha256 === plan.seedBackupSha256,
        'INITIAL_RESTORE_UNCERTAIN',
      );
      real = await ParticipantRegistry.open(profile.participantRoot, profile.productRoot, base);
    }
    seed = real.productDaily.capture();
    const expected = operating
      ? plan.initialSelection
      : (await read(join(T, 'packet/INPUTS.json'))).initialSelection;
    assert.equal(seed.version, expected.version);
    assert.equal(seed.manifestSha256, expected.manifestSha256);
    assert.equal(sha(seed.csv), expected.csvSha256);
    assert.equal(seed.metadata.marketStorage.sequence, expected.sequence);
    assert.equal(real.status().generation, expected.participantGeneration);
    assert.equal(seed.metadata.coverage.ledgerDates, expected.ledgerPeriods);
    assert.equal(seed.rows.length, expected.reportingRows);
    if (expected.participantFrontier !== undefined) {
      const heldInitial = real.capture();
      try {
        const snapshot = heldInitial.sourceGenerations.identity.snapshot;
        assert.equal(snapshot.number, expected.participantFrontier);
        assert.equal(snapshot.hash, expected.participantHash);
        assert.equal(
          new Date(snapshot.timestamp * 1000).toISOString(),
          expected.participantObservedAtUtc,
        );
      } finally {
        heldInitial.release();
      }
    }
    await save('INITIAL_SELECTION', {
      ...real.status(),
      sequence: expected.sequence,
      csvSha256: sha(seed.csv),
      pid: process.pid,
    });
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
          webRoot: join(W, 'dist/web'),
          account: { webRoot: join(W, 'account/dist/ui'), register: async () => {} },
        },
      ),
    );
    const origin = await f.app.listen({ host: '127.0.0.1', port: 0 });
    budget.listening(f);
    const observe = async () => {
      f.controls.now = Date.now();
      const queryStartedAtUtc = new Date().toISOString();
      const response = await budget.measuredWire(f, '/api/v2/live');
      assert.equal(response.statusCode, 200);
      const body = JSON.parse(response.body);
      const selectedVersion = real.productDaily.capture().version;
      if (!operating) assert.equal(body.datasetVersion, selectedVersion);
      return {
        status: 'MEASURED',
        pid: process.pid,
        origin,
        sourceAndFreshness: body,
        participant: reader.status(),
        selectedVersion,
        adoptionPending: body.datasetVersion !== selectedVersion,
        queryStartedAtUtc,
        measuredAtUtc: new Date().toISOString(),
      };
    };
    const ready = await observe();
    assert.equal(ready.adoptionPending, false, 'BASELINE_API_PAIR');
    for (const path of readinessRoutes(seed.metadata.through)) {
      const response = await f.inject(path);
      assert.equal(response.statusCode, 200, path + ': ' + response.body.slice(0, 500));
    }
    assert(
      [401, 403].includes(
        (await f.inject('/api/v2/downloads/' + seed.bundleId + '/daily')).statusCode,
      ),
    );
    await verify();
    await durableJson(join(T, 'evidence/READY.json'), {
      ...ready,
      status: 'PASS',
      runtimeHash: sha(canonical(plan.runtimeFiles)),
      actualPairedRegistry: true,
      freshProcess: true,
      readyAtUtc: new Date().toISOString(),
      initialPair: real.status(),
      initialCsvSha256: sha(seed.csv),
    });
    await durableJson(join(T, 'PREFLIGHT.json'), {
      verdict: 'PASS',
      taskId: publicTask,
      taskRoot: T,
      synthetic: false,
      profileSha256: publicProfileHash,
      runtimeFiles: plan.runtimeFiles,
      scopeSha256: packetHashes['packet/SCOPE.json'],
      reviewSha256: sha(await readFile(join(T, 'evidence/PREFLIGHT_REVIEW.json'))),
      readySha256: sha(await readFile(join(T, 'evidence/READY.json'))),
      initialGeneration: real.status().generation,
      initialProductVersion: seed.version,
      initialManifestSha256: seed.manifestSha256,
    });
    await verify();
    console.log('READY_PASS_STARTING_ONE_AUTHORIZED_PUBLIC_PARENT');
    result = await runUnified({
      taskRoot: T,
      registry: real,
      ...(operating
        ? { mode: 'OWNER_AUTHORIZED_PUBLIC' }
        : {
            profile: await read(join(T, 'packet/PUBLIC_PROFILE.json')),
            preflightPath: join(T, 'PREFLIGHT.json'),
          }),
      loadedRuntimeFiles: plan.runtimeFiles,
      onAdoption: async (selected, check) => {
        check();
        const served = await observe();
        check();
        return served;
      },
      onFact: async (job) => {
        const value = await observe();
        if (operating) await durableJson(join(T, 'evidence', `SERVED_${job.id}.json`), value);
        return value;
      },
    });
    await save('PUBLIC_RESULT', result);
    console.log('PUBLIC_PARENT_CLOSED ' + result.status);
    if (!result.networkClosureKnown) throw Error('PUBLIC_PARENT_CLOSURE_UNKNOWN');
    if (operating) await finalOrdinaryAdoption(observe, save);
    final = await finalProof({ T, real, seed, f, heldExport, save });
    heldExport = null;
    if (final.backup) await previews({ R: T, origin, save, f, budget });
  } catch (e) {
    failure = { error: String(e), stack: e.stack };
    await save('OWNER_FAILURE', failure);
  } finally {
    const cleanup = await closePublicResources({
      closeApplication: () =>
        closeOwned([
          [
            'held-export',
            heldExport
              ? async () => {
                  heldExport.stream.destroy();
                  await heldExport.released;
                }
              : null,
          ],
          ['held-view', held ? async () => held.release() : null],
          ['api', f ? () => f.close() : null],
          ['reader', reader ? () => reader.close() : null],
          ['writer', real ? () => real.close() : null],
        ]),
      shouldRestore: Boolean(final && !failure),
      restore: () =>
        restoreProof({
          R: T,
          profile,
          final,
          save,
          admittedBase: base,
          budget,
          baseAdmissionCount: entry.ordinal,
        }),
      reportFailure: (e) => save('RESTORE_FAILURE', e),
      closeBase: () => closeOwned([['base', base ? () => base.close() : null]]),
    });
    const { closed, baseClosed } = cleanup;
    if (!cleanup.ok)
      failure ??= { error: 'OWNED_FINALIZATION_OR_CLOSURE_FAILED', details: cleanup.errors };
    entry.status = closed.known && baseClosed.known ? 'CLOSED' : 'UNKNOWN';
    entry.closedAtUtc = new Date().toISOString();
    entry.failure = failure;
    await put(admissionsPath, ledger);
    await save('OWNER_CLOSURE', {
      status: entry.status,
      closed,
      baseClosed,
      failure,
      finalProofCompleted: Boolean(final && !failure),
      baseAdmissions: ledger.entries.length,
      localAccounting: budget.snapshot(),
      pid: process.pid,
    });
    console.log('PUBLIC_OWNER_CLOSED ' + entry.status);
  }
  return !failure && ['PUBLIC_PROFILE_COMPLETE', 'FINITE_OPERATING_CLOSED'].includes(result?.status)
    ? 0
    : 2;
}

// Unconditional base closure also applies when a restore failure receipt cannot be written.
export async function closePublicResources({
  closeApplication,
  shouldRestore,
  restore,
  reportFailure,
  closeBase,
}) {
  let closed = { known: false },
    baseClosed = { known: false },
    restored = false;
  const errors = [];
  const record = (e) => errors.push({ error: String(e), stack: e?.stack });
  try {
    try {
      closed = await closeApplication();
      if (!closed.known) record(Error('APPLICATION_CLOSURE_UNKNOWN'));
    } catch (e) {
      record(e);
    }
    if (shouldRestore && closed.known) {
      try {
        await restore();
        restored = true;
      } catch (e) {
        record(e);
        try {
          await reportFailure({ error: String(e), stack: e.stack });
        } catch (report) {
          record(report);
        }
      }
    }
  } finally {
    try {
      baseClosed = await closeBase();
      if (!baseClosed.known) record(Error('BASE_CLOSURE_UNKNOWN'));
    } catch (e) {
      record(e);
    }
  }
  return {
    closed,
    baseClosed,
    restored,
    errors,
    ok: closed.known && baseClosed.known && (!shouldRestore || restored) && errors.length === 0,
  };
}
