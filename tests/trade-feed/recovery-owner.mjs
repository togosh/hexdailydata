// Explicit offline recovery/final proof owner. No provider collector is imported.
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { execFileSync } from 'node:child_process';
import net from 'node:net';
import tls from 'node:tls';
import dns from 'node:dns';
import https from 'node:https';
import { syncBuiltinESMExports } from 'node:module';
import { closeOwned, digest } from './control.mjs';
const R = String.raw`C:\Code\HEXDailyData-Subgraph-First-Launch-Proof-R2\btc-eth-current-reference-freshness-r2`;
const T = join(R, 'operating-refresh-r1'),
  C = join(T, 'offline-recovery-r1');
const read = async (p) => JSON.parse(await fs.readFile(p));
const put = (p, v) => fs.writeFile(p, JSON.stringify(v, null, 2) + '\n');
const save = (n, v) => put(join(C, 'evidence', n + '.json'), v);
export function literalLookup(host, options, callback) {
  if (host !== '127.0.0.1') throw Error('OFFLINE_DNS_DENIED');
  if (typeof options === 'function') {
    callback = options;
    options = {};
  }
  process.nextTick(() =>
    options?.all
      ? callback(null, [{ address: '127.0.0.1', family: 4 }])
      : callback(null, '127.0.0.1', 4),
  );
}
export async function finishRecoveryProof(resources, baseClose, restore, initialFailure) {
  const closed = await closeOwned(resources);
  let failure = initialFailure,
    restoreCompleted = false,
    baseClosed;
  try {
    if (!closed.known)
      failure = { error: 'APPLICATION_CLOSURE_UNKNOWN', prior: failure, details: closed.errors };
    if (!failure) {
      if (!restore) throw Error('REQUIRED_RESTORE_UNAVAILABLE');
      await restore();
      restoreCompleted = true;
    }
  } catch (e) {
    failure = { error: String(e), stack: e.stack };
  } finally {
    baseClosed = await closeOwned([['base', baseClose]]);
    if (!baseClosed.known)
      failure = { error: 'BASE_CLOSURE_UNKNOWN', prior: failure, details: baseClosed.errors };
  }
  return { closed, baseClosed, restoreCompleted, failure: failure ?? null };
}
async function run() {
  assert.equal(resolve(process.cwd()), String.raw`C:\Code\HEXDailyData-v2-Subgraph-History-R2`);
  const review = await read(join(C, 'PREFLIGHT_REVIEW.json')),
    plan = await read(join(C, 'RECOVERY_PLAN.json'));
  assert.equal(review.verdict, 'PASS');
  assert.equal(
    review.candidateCommit,
    execFileSync('git', ['rev-parse', 'HEAD']).toString().trim(),
  );
  assert.equal(review.planSha256, digest(await fs.readFile(join(C, 'RECOVERY_PLAN.json'))));
  for (const [p, h] of Object.entries(review.sourceBindings))
    assert.equal(digest(await fs.readFile(p)), h, 'SOURCE_CHANGED:' + p);
  for (const [p, h] of Object.entries(review.inputBindings))
    assert.equal(digest(await fs.readFile(join(C, p))), h, 'INPUT_CHANGED:' + p);
  for (const f of await read(join(C, 'evidence/ORIGINAL_FREEZE.json')))
    assert.equal(digest(await fs.readFile(f.path)), f.sha256);
  const deny = () => {
    throw Error('OFFLINE_EXTERNAL_NETWORK_DENIED');
  };
  tls.connect = https.get = https.request = deny;
  globalThis.fetch = deny;
  for (const o of [dns, dns.promises])
    for (const k of Object.keys(o))
      if (k === 'lookup' || k.startsWith('resolve') || k === 'reverse') o[k] = deny;
  dns.lookup = literalLookup;
  dns.promises.lookup = (host, options) =>
    new Promise((done, reject) => {
      try {
        literalLookup(host, options, (error, address, family) =>
          error ? reject(error) : done(options?.all ? address : { address, family }),
        );
      } catch (error) {
        reject(error);
      }
    });
  const connect = net.Socket.prototype.connect;
  net.Socket.prototype.connect = function (...args) {
    const first = Array.isArray(args[0]) ? args[0][0] : args[0];
    if (
      !first ||
      typeof first !== 'object' ||
      first.host !== '127.0.0.1' ||
      !Number.isInteger(first.port)
    )
      throw Error('LITERAL_LOOPBACK_ONLY');
    return connect.apply(this, args);
  };
  syncBuiltinESMExports();
  await fs.mkdir(join(C, 'temp'), { recursive: true });
  const { abortClosedTradePublication } =
    await import('../../scripts/trade-publication-recovery.mjs');
  if (process.argv[2] === 'recover-reviewed') {
    const f = await fs.open(join(C, 'RECOVERY_ADMISSION.json'), 'wx');
    try {
      await f.writeFile(
        JSON.stringify({
          pid: process.pid,
          atUtc: new Date().toISOString(),
          reviewSha256: digest(await fs.readFile(join(C, 'PREFLIGHT_REVIEW.json'))),
          planSha256: review.planSha256,
          externalRequests: 0,
        }) + '\n',
      );
      await f.sync();
    } finally {
      await f.close();
    }
    const receipt = await abortClosedTradePublication(plan);
    await save('RECOVERY_RESULT', receipt);
    console.log('OFFLINE_RECOVERY_ABORT_SETTLED');
  } else {
    const receipt = await read(join(C, 'evidence/RECOVERY_RESULT.json'));
    assert.equal(receipt.outcome, 'ABORTED_BEFORE_PRODUCT');
    assert.deepEqual(receipt.selected, plan.selected);
  }
  // Reuse exact external bases once for the application and final restore.
  const { SavedSourceGenerations, sha } =
    await import('../../dist/services/source-update/generation.js');
  const { ACCEPTED } = await import('../../dist/contracts/saved-generation.js');
  const { ParticipantRegistry } = await import('../../dist/services/source-update/refresh.js');
  const { fixture } = await import('../market-feed/access-fixture.mjs');
  const { createBudget } = await import('./budget.mjs');
  const { finalEvidence, restoreProof, previews } = await import('./final.mjs');
  const { backupParticipants } = await import('../../scripts/participant-refresh-backup.mjs');
  const profile = await read(join(C, 'reference/SELECTED_PROFILE.json'));
  const path = join(C, 'evidence/BASE_ADMISSIONS.json');
  const ledger = await read(path).catch((e) => {
    if (e.code === 'ENOENT') return { prior: 9, maximum: 14, additional: [] };
    throw e;
  });
  assert(ledger.additional.every((a) => a.status === 'CLOSED'));
  assert(ledger.additional.length < 5);
  const ordinal = 10 + ledger.additional.length,
    entry = { ordinal, status: 'OPENING', pid: process.pid, atUtc: new Date().toISOString() };
  ledger.additional.push(entry);
  await put(path, ledger);
  const budget = createBudget(join(C, 'evidence'), {
    attempts: 378,
    bytes: 533331968,
    apiSeconds: 2095.2533651,
  });
  let base, registry, f, held, heldExport, final, failure;
  try {
    base = await SavedSourceGenerations.activate({
      root: profile.overlayRoot,
      holdersRoot: profile.holdersRoot,
      stakesRoot: profile.stakesRoot,
    });
    await base.admit(join(base.root, ACCEPTED.generation), { readOnly: true });
    await base.loadSelection();
    entry.status = 'ADMITTED';
    await put(path, ledger);
    registry = await ParticipantRegistry.open(profile.participantRoot, profile.productRoot, base);
    const seed = registry.productDaily.capture();
    assert.equal(seed.version, plan.selected.version);
    assert.equal(seed.metadata.marketStorage.sequence, 28);
    held = registry.capture();
    heldExport = registry.productDaily.openExport(
      held.product,
      held.product.bundleId,
      'daily',
      new AbortController().signal,
    );
    f = budget.guard(
      await fixture(
        { participants: registry, productDaily: registry.productDaily, sourceGenerations: base },
        {
          evidenceRoot: join(C, 'evidence'),
          webRoot: resolve('dist/web'),
          account: { webRoot: resolve('account/dist/ui'), register: async () => {} },
        },
      ),
    );
    const origin = await f.app.listen({ host: '127.0.0.1', port: 0 });
    budget.listening(f);
    f.controls.now = Date.now();
    const smoke = await budget.measuredWire(f, '/api/v2/live');
    assert.equal(smoke.statusCode, 200);
    const body = JSON.parse(smoke.body);
    assert.equal(body.datasetVersion, plan.selected.version);
    assert.equal(body.freshness.BTC.status, 'stale');
    assert.equal(body.freshness.ETH.status, 'stale');
    await save('RECOVERED_PAIRED_API', {
      status: 'PASS_SAVED_STALE',
      origin,
      pid: process.pid,
      body,
      measuredAtUtc: new Date().toISOString(),
      externalRequests: 0,
    });
    final = await finalEvidence({
      R: C,
      real: registry,
      seed,
      f,
      origin,
      heldExport,
      save,
      budget,
      operating: true,
    });
    final.backup = await backupParticipants(registry, join(C, 'real-backup'));
    await save('GENUINE_BACKUP', final.backup);
    await previews({ R: C, origin, save, f, budget });
    await save('SELECTED_IDENTITY', {
      version: seed.version,
      manifestSha256: seed.manifestSha256,
      csvSha256: sha(seed.csv),
      sequence: 28,
      pricesUnchanged: true,
    });
  } catch (e) {
    failure = { error: String(e), stack: e.stack };
    await save('FINAL_PROOF_FAILURE', failure);
  } finally {
    const settled = await finishRecoveryProof(
      [
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
        ['registry', registry ? () => registry.close() : null],
      ],
      base ? () => base.close() : null,
      final?.backup
        ? () =>
            restoreProof({
              R: C,
              profile,
              final,
              save,
              admittedBase: base,
              budget,
              baseAdmissionCount: ordinal,
            })
        : null,
      failure,
    );
    const { closed, baseClosed } = settled;
    failure = settled.failure;
    entry.status = closed.known && baseClosed.known ? 'CLOSED' : 'UNKNOWN';
    entry.closedAtUtc = new Date().toISOString();
    entry.failure = failure ?? null;
    await put(path, ledger);
    await save('OWNER_CLOSURE', {
      closed,
      baseClosed,
      ordinal,
      failure: failure ?? null,
      restoreCompleted: settled.restoreCompleted,
      pid: process.pid,
      atUtc: entry.closedAtUtc,
    });
  }
  if (failure) throw Error(failure.error);
  console.log('OFFLINE_FINAL_PROOF_PASS');
}
if (['recover-reviewed', 'finalize-reviewed'].includes(process.argv[2])) await run();
else
  console.log(
    'Offline default. Explicit reviewed owner entry only; no providers, bases or mutation.',
  );
