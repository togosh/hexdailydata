// One real base readiness pass shared by focused fixtures and the reviewed finite trial.
import assert from 'node:assert/strict';
import net from 'node:net';
import { readFile, writeFile, mkdir, mkdtemp, rename } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { createInterface } from 'node:readline';
import {
  SavedSourceGenerations,
  canonical,
  sha,
} from '../../dist/services/source-update/generation.js';
import { ParticipantRegistry, participantPair } from '../../dist/services/source-update/refresh.js';
import { ProductDailyStore } from '../../dist/services/product-daily/store.js';
import { restoreStorage } from '../../dist/services/product-daily/storage.js';
import { preserveParticipantProduct } from '../../dist/services/product-daily/market.js';
import { ACCEPTED } from '../../dist/contracts/saved-generation.js';
import { prepareWindow, runParticipantRefresh } from '../../scripts/participant-refresh.mjs';
import {
  backupParticipants,
  restoreParticipants,
} from '../../scripts/participant-refresh-backup.mjs';
import { fixture, auth, keys, wire, until, charge } from '../market-feed/access-fixture.mjs';
import { PageCursors } from '../../dist/services/queries/cursor.js';
const R = process.env.HDD_TASK_ROOT;
assert(R?.endsWith('participant-catchup-refresh-r1'));
const inputs = JSON.parse(await readFile(join(R, 'INPUTS.json')));
const profile = JSON.parse(await readFile(join(R, 'BASE_PROFILE.json')));
const runRoot = await mkdtemp(join(R, 'scratch/composed-'));
const receipt = {
  synthetic: true,
  cases: [],
  baseReadinessPasses: 1,
  baseMetrics: null,
  results: [],
  closed: false,
};
const save = async (name, v) =>
  writeFile(join(R, 'evidence', name + '.json'), JSON.stringify(v, null, 2) + '\n');
const signal = new AbortController().signal;
let base, real, appFixture;
const registries = [],
  leases = [];
async function fresh(label) {
  const p = join(runRoot, label);
  await mkdir(p);
  const product = join(p, 'product');
  await restoreStorage(
    join(R, 'seed-backup'),
    product,
    inputs.bundledBackup.originalBackupManifestSha256,
  );
  const store = new ProductDailyStore(product, participantPair(base));
  await store.load();
  const reg = await ParticipantRegistry.initialize(join(p, 'participants'), store, base);
  registries.push(reg);
  return reg;
}
function pin(reg) {
  const h = reg.capture();
  try {
    const { number, hash, timestamp } = h.sourceGenerations.identity.snapshot;
    return { number, hash, timestamp };
  } finally {
    h.release();
  }
}
async function update(reg, rows, ordinal = 1) {
  const b = pin(reg),
    t = {
      number: b.number + 1,
      hash: '0x' + sha(canonical([b, rows, ordinal])),
      timestamp: b.timestamp + 10,
    };
  const after = { tokenHolders: rows.tokenHolders ?? [], stakeStarts: rows.stakeStarts ?? [] };
  for (const f of Object.keys(after))
    after[f].sort((a, b) => a.id.localeCompare(b.id, 'en', { sensitivity: 'variant' }));
  const provenance = Object.fromEntries(
    Object.entries(after).map(([f, rs]) => [
      f,
      Object.fromEntries(
        rs.map((r) => [
          r.id,
          [
            {
              window: ordinal,
              attempt: ordinal,
              capture: `captures/${String(ordinal).padStart(5, '0')}/capture.json`,
              responseSha256: 'a'.repeat(64),
              family: f,
            },
          ],
        ]),
      ),
    ]),
  );
  const sourceCounts = {
    tokenHolders: after.tokenHolders.length,
    stakeStarts: after.stakeStarts.length,
    stakeEnds: 0,
    stakeGoodAccountings: 0,
    affectedParents: 0,
  };
  const draft = await prepareWindow(reg, { base: b, target: t, after, provenance, sourceCounts });
  const proof = {
    format: 'participant-window-proof-1',
    complete: true,
    base: b,
    target: t,
    deployment: ACCEPTED.deployment,
    captureLedgerSha256: 'b'.repeat(64),
    afterSha256: Object.fromEntries(Object.entries(after).map(([f, r]) => [f, sha(canonical(r))])),
    families: ['tokenHolders', 'stakeStarts', 'stakeEnds', 'stakeGoodAccountings'],
    explicitEmptyAndRepeats: true,
    parentChecks: true,
    witnessChecks: true,
    closingHeadersAndMetadata: true,
    networkClosureKnown: true,
  };
  return { update: { ...draft, proofSha256: sha(canonical(proof)) }, proof };
}
const publish = async (reg, u, options) => {
  const r = await reg.publish(u.update, u.proof, options);
  await reg.refresh(undefined, true);
  assert.equal(reg.status().error, null);
  return r;
};
try {
  const start = performance.now();
  base = await SavedSourceGenerations.activate({
    root: profile.overlayRoot,
    holdersRoot: profile.holdersRoot,
    stakesRoot: profile.stakesRoot,
  });
  await base.admit(join(profile.overlayRoot, ACCEPTED.generation), { readOnly: true });
  await base.loadSelection();
  receipt.baseMetrics = {
    ...base.metrics,
    milliseconds: performance.now() - start,
    rss: process.memoryUsage().rss,
  };
  await save('BASE_READINESS', receipt.baseMetrics);
  const bundle = JSON.parse(
    await readFile(join(profile.overlayRoot, ACCEPTED.generation, 'BUNDLE.json')),
  );
  const hr = bundle.changes.tokenHolders.find((x) => x.kind === 'replacement').after;
  const sr = bundle.changes.stakeStarts.find((x) => x.kind === 'replacement').after;
  const reg = await fresh('main-synthetic'),
    seed = reg.productDaily.capture();
  const observer = await ParticipantRegistry.open(reg.root, reg.productDaily.root, base);
  registries.push(observer);
  const held = reg.capture();
  leases.push(held);
  const h1 = { ...hr, tokenBalance: '123.456' },
    s1 = { ...sr, stakedDays: '777' };
  const newH = {
    ...hr,
    id: '0x000000000000000000000000000000000000000001-participant-fixture',
    holderAddress: '0x' + sha('participant synthetic address').slice(0, 40),
    numeralIndex: '999999999',
  };
  const newS = {
    ...sr,
    id: '0x000-participant-fixture',
    stakeId: '999999999',
    stakeEnd: null,
    stakeGoodAccounting: null,
  };
  assert.equal(await base.bySourceId('tokenHolders', newH.id, signal), null);
  const first = await update(reg, { tokenHolders: [h1, newH], stakeStarts: [s1, newS] });
  const bad = structuredClone(first);
  bad.update.changes.tokenHolders.find((x) => x.id === hr.id).before.tokenBalance = '999999';
  await assert.rejects(reg.publish(bad.update, bad.proof), /BEFORE_SELECTED/);
  const ancestry = structuredClone(first);
  ancestry.update.predecessor = 'f'.repeat(64);
  await assert.rejects(reg.publish(ancestry.update, ancestry.proof), /ANCESTRY/);
  const proofBad = structuredClone(first);
  proofBad.proof.afterSha256.tokenHolders = 'e'.repeat(64);
  proofBad.update.proofSha256 = sha(canonical(proofBad.proof));
  await assert.rejects(reg.publish(proofBad.update, proofBad.proof), /PROOF_CONTENT/);
  const result1 = await publish(reg, first);
  assert.equal(held.sourceGenerations.selection, ACCEPTED.generation);
  assert.deepEqual(
    (await held.sourceGenerations.bySourceId('tokenHolders', hr.id, signal)).reported,
    hr,
  );
  assert.equal(held.product.metadata.pair.generation, ACCEPTED.generation);
  const current = reg.capture();
  assert.equal(
    (await current.sourceGenerations.bySourceId('tokenHolders', hr.id, signal)).reported
      .tokenBalance,
    '123.456',
  );
  current.release();
  const second = await update(
    reg,
    {
      tokenHolders: [
        { ...h1, tokenBalance: '789.001' },
        { ...newH, tokenBalance: '0' },
      ],
      stakeStarts: [
        { ...s1, stakedDays: '778' },
        { ...newS, stakedDays: '2' },
      ],
    },
    2,
  );
  const result2 = await publish(reg, second);
  await observer.refresh(undefined, true);
  assert.equal(observer.status().generation, result2.selected.generation);
  assert.equal(observer.status().error, null);
  const replay = await publish(reg, second);
  assert.equal(replay.idempotent, true);
  assert.equal(reg.productDaily.capture().version, result2.selected.product.version);
  const h = reg.capture();
  const beforeObservation = (await h.sourceGenerations.bySourceId('tokenHolders', hr.id, signal))
    .observation;
  assert.equal(h.sourceGenerations.identity.holderRows, 664436);
  assert.equal(h.sourceGenerations.identity.stakeRows, 954716);
  h.release();
  const overlap = await update(reg, { tokenHolders: [{ ...h1, tokenBalance: '789.001' }] }, 3);
  await publish(reg, overlap);
  const o = reg.capture();
  assert.deepEqual(
    (await o.sourceGenerations.bySourceId('tokenHolders', hr.id, signal)).observation,
    beforeObservation,
  );
  o.release();
  await publish(reg, await update(reg, {}, 4));
  preserveParticipantProduct(seed, reg.productDaily.capture());
  held.release();
  receipt.cases.push(
    'two consecutive changes to same holder/stake; insert then replace; lexical insertion; strict before/ancestry/proof; idempotent replay; unchanged overlap timestamp; empty window; held compatible view; skipped adoption; all quiet rows unchanged',
  );
  const f = await fixture({
    participants: reg,
    productDaily: reg.productDaily,
    sourceGenerations: base,
  });
  try {
    let reads = 0;
    const refresh = reg.refresh.bind(reg);
    reg.refresh = async (...args) => {
      reads++;
      return refresh(...args);
    };
    const beforeReads = reads;
    for (const key of [keys.invalid, keys.revoked])
      assert.equal(
        (await f.inject({ url: '/api/v2/holders', headers: auth(key) })).statusCode,
        401,
      );
    assert.equal(reads, beforeReads);
    const list = await f.inject('/api/v2/holders?limit=2');
    assert.equal(list.statusCode, 200, list.body);
    const body = list.json();
    assert(body.nextCursor);
    const stake = await f.inject('/api/v2/stakes/' + sr.stakeId);
    assert.equal(stake.statusCode, 200, stake.body);
    const address = await f.inject('/api/v2/addresses/' + hr.holderAddress);
    assert.equal(address.statusCode, 200, address.body);
    for (const key of ['source', 'generation', 'view'])
      assert.equal((await f.inject('/api/v2/holders?' + key + '=x')).statusCode, 400);
    const paid = await wire(f.app, '/api/v2/holders', [['Authorization', auth().authorization]]);
    assert.equal(paid.statusCode, 200);
    const head = await wire(
      f.app,
      '/api/v2/holders',
      [['Authorization', auth().authorization]],
      'HEAD',
    );
    assert.equal(head.statusCode, 200);
    assert.equal(head.body, '');
    const unchanged = await wire(f.app, '/api/v2/holders', [
      ['Authorization', auth().authorization],
      ['If-None-Match', paid.headers.etag],
    ]);
    assert.equal(unchanged.statusCode, 304);
    const change = await update(reg, { tokenHolders: [{ ...h1, tokenBalance: '999' }] }, 5);
    await publish(reg, change);
    const restarted = await f.inject(
      '/api/v2/holders?limit=2&cursor=' + encodeURIComponent(body.nextCursor),
    );
    assert.equal(restarted.statusCode, 409, restarted.body);
    const changed = await wire(f.app, '/api/v2/holders', [
      ['Authorization', auth().authorization],
      ['If-None-Match', paid.headers.etag],
    ]);
    assert.equal(changed.statusCode, 200);
    assert.notEqual(changed.headers.etag, paid.headers.etag);
    const product = reg.productDaily.capture();
    assert.equal(
      (await f.inject('/api/v2/downloads/' + product.bundleId + '/daily')).statusCode,
      403,
    );
    for (const path of ['/participants/CURRENT.json', '/data/holders.ndjson'])
      assert.equal((await f.inject(path)).statusCode, 404);
    // Suspend an actual indexed read, cancel its socket, then adopt two newer views.
    const oldView = reg.capture();
    let entered = false,
      unblock;
    const gate = new Promise((resolve) => {
      unblock = resolve;
    });
    let once = true;
    const rowAt = base.holders.rowAt.bind(base.holders);
    base.holders.rowAt = async (...args) => {
      if (once) {
        once = false;
        entered = true;
        await gate;
      }
      return rowAt(...args);
    };
    charge();
    const socket = net.createConnection({ host: '127.0.0.1', port: f.app.server.address().port });
    socket.on('error', () => {});
    socket.on('connect', () =>
      socket.write(
        'GET /api/v2/holders?limit=10 HTTP/1.1\r\nHost: 127.0.0.1\r\nConnection: close\r\n\r\n',
      ),
    );
    await until(() => entered);
    socket.destroy();
    await publish(reg, await update(reg, {}, 6));
    await publish(reg, await update(reg, {}, 7));
    assert(reg.status().retained >= 3);
    oldView.release();
    unblock();
    await delay(50);
    base.holders.rowAt = rowAt;
    assert.equal(reg.status().error, null);
    assert.equal(f.lifecycle.stats().pending, 0);
    receipt.cases.push(
      'actual indexed read cancelled during two paired adoptions; lease retained until read unwind',
    );
    receipt.results.push({
      list: body,
      stake: stake.json(),
      address: address.json(),
      paidStatus: paid.statusCode,
      headStatus: head.statusCode,
      notModified: unchanged.statusCode,
      restart: restarted.statusCode,
    });
  } finally {
    await f.close();
  }
  receipt.cases.push(
    'actual API address/stake/list; access before selection; paid GET/HEAD/304; cursor restart and ETag separation; protected CSV; static isolation',
  );
  const good = await readFile(join(reg.root, 'CURRENT.json'));
  await writeFile(
    join(reg.root, 'CURRENT.json'),
    JSON.stringify({ ...JSON.parse(good), generation: 'f'.repeat(64) }),
  );
  await reg.refresh(undefined, true);
  assert(reg.status().error);
  assert.equal(reg.status().generation, JSON.parse(good).generation);
  await writeFile(join(reg.root, 'CURRENT.json'), good);
  await reg.refresh(undefined, true);
  for (const phase of ['before-product', 'after-product', 'after-pointer', 'acknowledgement']) {
    const r = await fresh('failure-' + phase);
    const u = await update(r, { tokenHolders: [h1] });
    await assert.rejects(
      r.publish(u.update, u.proof, {
        fault: (p) => {
          if (p === phase) throw Error('SYNTHETIC_' + phase);
        },
      }),
      /SYNTHETIC/,
    );
    if (phase === 'acknowledgement') {
      await r.refresh(undefined, true);
      assert.notEqual(r.status().generation, ACCEPTED.generation);
    } else {
      await assert.rejects(
        ParticipantRegistry.open(r.root, r.productDaily.root, base),
        /UNKNOWN_PUBLICATION/,
      );
      const recovered = await r.recoverOwnedFailure();
      assert.equal(
        recovered.outcome,
        phase === 'before-product' ? 'ABORTED_BEFORE_PRODUCT' : 'COMPLETED_SAVED_PUBLICATION',
      );
    }
    receipt.cases.push('known closed ' + phase + ' recovery without provider request');
  }
  const unknown = await fresh('unknown-lock');
  await writeFile(join(unknown.root, 'SELECTION.lock'), '{}');
  await assert.rejects(unknown.recoverOwnedFailure(), /UNKNOWN_PARTICIPANT_WRITER/);
  await assert.rejects(
    ParticipantRegistry.open(unknown.root, unknown.productDaily.root, base),
    /UNKNOWN_PUBLICATION/,
  );
  receipt.cases.push('unknown ownership retained; bad pointer retains LKG');
  receipt.status = 'PASS';
  receipt.rss = process.memoryUsage().rss;
  receipt.runRoot = runRoot;
  await save('COMPOSED_TESTS', receipt);
  console.log(
    'COMPOSED_PASS ' +
      JSON.stringify({
        runRoot,
        baseMilliseconds: receipt.baseMetrics.milliseconds,
        rss: receipt.rss,
      }),
  );
  // The actual seed is separate from all synthetic generations above.
  const actualRoot = join(R, 'runtime');
  await mkdir(actualRoot);
  await restoreStorage(
    join(R, 'seed-backup'),
    join(actualRoot, 'product'),
    inputs.bundledBackup.originalBackupManifestSha256,
  );
  const store = new ProductDailyStore(join(actualRoot, 'product'), participantPair(base));
  await store.load();
  real = await ParticipantRegistry.initialize(join(actualRoot, 'participants'), store, base);
  registries.push(real);
  const actualProfile = { ...profile, productRoot: store.root, participantRoot: real.root };
  await writeFile(
    join(R, 'PARTICIPANT_PROFILE.json'),
    JSON.stringify(actualProfile, null, 2) + '\n',
    { flag: 'wx' },
  );
  await save('ACTUAL_READY', {
    status: 'PASS',
    generation: real.status().generation,
    productVersion: real.status().productVersion,
    baseReadinessPasses: 1,
    pid: process.pid,
    startedAt: new Date().toISOString(),
  });
  appFixture = await fixture(
    { participants: real, productDaily: store, sourceGenerations: base },
    {
      webRoot: resolve('dist/web'),
      account: { webRoot: resolve('account/dist/ui'), register: async () => {} },
    },
  );
  const origin = await appFixture.app.listen({ host: '127.0.0.1', port: 0 });
  await save('API_LISTENER', { origin, pid: process.pid });
  console.log('AWAITING_PREFLIGHT ' + origin);
  const input = createInterface({ input: process.stdin, crlfDelay: Infinity });
  const maximum = setTimeout(
    () => {
      input.close();
    },
    5 * 60 * 60 * 1000,
  );
  for await (const line of input) {
    const command = JSON.parse(line);
    if (command.action === 'close') break;
    if (command.action === 'trial') {
      const result = await runParticipantRefresh({
        taskRoot: R,
        preflightPath: join(R, 'PREFLIGHT.json'),
        registry: real,
        onAdoption: async (selected, check) => {
          await delay(1100);
          check();
          const live = await appFixture.inject('/api/v2/live');
          assert.equal(live.statusCode, 200, live.body);
          assert.equal(live.json().datasetVersion, selected.product.version);
          const holders = await appFixture.inject('/api/v2/holders?limit=2');
          assert.equal(holders.statusCode, 200, holders.body);
          assert.equal(holders.json().generation, selected.generation);
          const stakes = await appFixture.inject('/api/v2/stakes?limit=2');
          assert.equal(stakes.statusCode, 200, stakes.body);
          assert.equal(stakes.json().generation, selected.generation);
          return {
            origin,
            live: live.json(),
            holders: holders.json(),
            stakes: stakes.json(),
            sameProcess: process.pid,
          };
        },
      });
      await save('TRIAL_RESULT', result);
      console.log('TRIAL_CLOSED ' + result.status);
    } else if (command.action === 'final') {
      const module = await import('./final.mjs');
      await module.finalize({ R, real, base, fixture: appFixture, origin, runRoot, save });
      console.log('FINAL_EVIDENCE_COMPLETE');
    } else throw Error('Unknown owned runner command');
  }
  clearTimeout(maximum);
  input.close();
} catch (error) {
  receipt.status = 'FAIL';
  receipt.error = String(error.stack ?? error);
  await save('COMPOSED_FAILURE_' + Date.now(), receipt);
  console.error(error);
  process.exitCode = 1;
} finally {
  for (const lease of leases) lease.release();
  if (appFixture) await appFixture.close();
  for (const r of registries.reverse()) await r.close();
  if (base) await base.close();
  receipt.closed = true;
  await save('OWNED_RUNNER_CLOSED_' + process.pid, {
    closed: true,
    pid: process.pid,
    at: new Date().toISOString(),
  });
}
