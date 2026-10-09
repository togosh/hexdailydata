// Real combined handlers/readers. New snapshots/failures below are explicitly SYNTHETIC.
import assert from 'node:assert/strict';
import { readFile, writeFile, mkdir, mkdtemp, lstat, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import net from 'node:net';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import {
  SavedSourceGenerations,
  canonical,
  sha,
} from '../../dist/services/source-update/generation.js';
import { ParticipantRegistry, participantPair } from '../../dist/services/source-update/refresh.js';
import { ACCEPTED } from '../../dist/contracts/saved-generation.js';
import { createMarketStorage } from '../../dist/services/product-daily/storage.js';
import { productFiles } from '../../dist/services/product-daily/project.js';
import { marketEvidence, preserveMarketHistory } from '../../dist/services/product-daily/market.js';
import { prepareWindow } from '../../scripts/participant-refresh.mjs';
import { restoreParticipants } from '../../scripts/participant-refresh-backup.mjs';
import { admittedInputs, runUnified } from '../../scripts/refresh-data.mjs';
import {
  fixture,
  auth,
  keys,
  wire,
  until,
  charge,
  cookie,
} from '../market-feed/access-fixture.mjs';
const R = process.env.HDD_TASK_ROOT;
assert(R?.endsWith('unified-refresh-operation-r1'));
const input = JSON.parse(await readFile(join(R, 'INPUTS.json')));
const root = await mkdtemp(join(R, 'temp/composed-'));
const receipt = { synthetic: true, externalRequests: 0, cases: [], root, baseReadinessPasses: 1 };
const regs = [],
  leases = [],
  unblockAll = [];
let base, real, f;
const actualDateNow = Date.now;
const hold = (reg) => {
  const h = reg.capture();
  try {
    return { product: h.product, identity: h.sourceGenerations.identity };
  } finally {
    h.release();
  }
};
let sequence = 0;
function productUpdate(reg, kind = 'gas', seconds = 60) {
  const p = hold(reg).product,
    old = p.metadata.readings.find((r) => r.kind === kind);
  const latest = Math.max(...p.metadata.readings.map((r) => Date.parse(r.observedAtUtc)));
  const r = {
    ...structuredClone(old),
    observedAtUtc: new Date(latest + seconds * 1000).toISOString(),
  };
  if (kind === 'gas') r.gasPriceWei = String(BigInt(r.gasPriceWei) + 1n);
  if (kind === 'market') r.value = '0.0023';
  return { readings: [r], liquidityHistory: [], receiptSha256: sha('synthetic' + ++sequence) };
}
async function participantUpdate(reg) {
  const s = hold(reg).identity.snapshot,
    b = { number: s.number, hash: s.hash, timestamp: s.timestamp };
  const target = {
    number: b.number + 1,
    hash: '0x' + sha('synthetic participant ' + ++sequence),
    timestamp: b.timestamp + 10,
  };
  const after = { tokenHolders: [], stakeStarts: [] };
  const draft = await prepareWindow(reg, {
    base: b,
    target,
    after,
    provenance: after,
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
    captureLedgerSha256: 'b'.repeat(64),
    afterSha256: Object.fromEntries(Object.entries(after).map(([k, v]) => [k, sha(canonical(v))])),
    families: ['tokenHolders', 'stakeStarts', 'stakeEnds', 'stakeGoodAccountings'],
    explicitEmptyAndRepeats: true,
    parentChecks: true,
    witnessChecks: true,
    closingHeadersAndMetadata: true,
    networkClosureKnown: true,
  };
  return { update: { ...draft, proofSha256: sha(canonical(proof)) }, proof };
}
async function participant(reg) {
  const u = await participantUpdate(reg);
  await reg.publish(u.update, u.proof);
  await reg.refresh(undefined, true);
  assert.equal(reg.status().error, null);
  return u;
}
async function product(reg, update = productUpdate(reg), options) {
  const r = await reg.publishProduct(update, options);
  await reg.refresh(undefined, true);
  assert.equal(reg.status().error, null);
  return r;
}
async function fresh(label) {
  const folder = join(root, label);
  await mkdir(folder);
  const snapshot = hold(real).product;
  const metadata = structuredClone(snapshot.metadata);
  metadata.pair = participantPair(base);
  metadata.observations = marketEvidence(metadata);
  delete metadata.marketStorage;
  const exceptions = (
    await readFile(join(real.productDaily.root, snapshot.version, 'exceptions.ndjson'), 'utf8')
  )
    .trim()
    .split('\n')
    .filter(Boolean)
    .map(JSON.parse);
  const store = await createMarketStorage(
    join(folder, 'product'),
    productFiles({ rows: snapshot.rows, metadata, exceptions }),
  );
  const reg = await ParticipantRegistry.initialize(join(folder, 'participants'), store, base);
  regs.push(reg);
  return reg;
}
try {
  const began = performance.now();
  base = await SavedSourceGenerations.activate({
    root: input.acceptedB1Overlay.root,
    holdersRoot: input.externalBaseHolders.root,
    stakesRoot: input.externalBaseStakes.root,
  });
  await base.admit(join(base.root, ACCEPTED.generation), { readOnly: true });
  await base.loadSelection();
  receipt.baseMilliseconds = performance.now() - began;
  const existing = await lstat(join(R, 'runtime')).catch((e) => {
    if (e.code === 'ENOENT') return null;
    throw e;
  });
  const restored = existing
    ? {
        registry: await ParticipantRegistry.open(
          join(R, 'runtime/participants'),
          join(R, 'runtime/product'),
          base,
        ),
        receipt: { status: 'REOPENED_SAME_TASK_RESTORE', notRestoredAgain: true },
      }
    : await restoreParticipants(
        join(R, 'seed-backup'),
        join(R, 'runtime'),
        input.bundledGenuineBackup.backupManifestSha256,
        base,
      );
  real = restored.registry;
  receipt.genuineRestore = restored.receipt;
  const h = real.capture();
  let initial;
  try {
    initial = admittedInputs(h, true);
    assert.equal(initial.protocol.end, 2502);
    assert.equal(h.product.rows.length, 2503);
    assert.equal(h.product.metadata.liquidityHistory.length, 90);
    await writeFile(
      join(R, 'evidence/ADMITTED_SEED.json'),
      JSON.stringify(
        {
          initial,
          pair: h.product.metadata.pair,
          version: h.product.version,
          coverage: h.product.metadata.coverage,
          readings: h.product.metadata.readings,
        },
        null,
        2,
      ) + '\n',
    );
  } finally {
    h.release();
  }
  const reg = await fresh('mixed');
  const reader = await ParticipantRegistry.open(reg.root, reg.productDaily.root, base);
  regs.push(reader);
  const held = reader.capture(),
    originalCsv = held.product.csv;
  leases.push(held);
  const original = hold(reg).product;
  await product(reg);
  await product(reg, productUpdate(reg, 'market'));
  const u = await participant(reg);
  const participantGeneration = reg.status().generation;
  const quiet = hold(reg).product;
  await product(reg);
  await product(reg, productUpdate(reg, 'market'));
  assert.equal(reg.status().generation, participantGeneration);
  await reader.refresh(undefined, true);
  assert.equal(reader.status().error, null);
  assert.equal(reader.status().generation, participantGeneration);
  assert.equal(held.sourceGenerations.selection, ACCEPTED.generation);
  assert.deepEqual(held.product.csv, originalCsv);
  assert.equal(held.product.metadata.pair.generation, held.sourceGenerations.selection);
  preserveMarketHistory(original, hold(reg).product);
  assert.deepEqual(quiet.metadata.ledgerSegments, hold(reg).product.metadata.ledgerSegments);
  for (let i = 0; i < 4; i++) await product(reg);
  await reader.refresh(undefined, true);
  assert.equal(reader.status().error, null);
  const shared = reader.capture();
  leases.push(shared);
  for (let i = 0; i < 3; i++) {
    await product(reg);
    await reader.refresh(undefined, true);
  }
  assert.equal(shared.sourceGenerations.selection, participantGeneration);
  assert(
    await shared.sourceGenerations.bySourceId(
      'tokenHolders',
      base.overlay.holders.keys().next().value,
      new AbortController().signal,
    ),
  );
  shared.release();
  held.release();
  await delay(10);
  assert(reg.status().retained <= 2);
  assert(reader.status().retained <= 2);
  console.log('STEP');
  receipt.cases.push(
    'mixed certified publications; skipped reader adoption; shared reader lifetime; held product/CSV; bounded current/rollback; quiet ledger/history unchanged',
  );
  const replay = productUpdate(reg);
  await product(reg, replay);
  const selected = reg.status().productVersion;
  assert.equal((await product(reg, replay)).changed, false);
  assert.equal(reg.status().productVersion, selected);
  await assert.rejects(
    reg.publishProduct({ ...replay, readings: [{ ...replay.readings[0], gasPriceWei: '999' }] }),
    /CONFLICT/,
  );
  await reg.recoverOwnedFailure();
  assert.equal(reg.status().productVersion, selected);
  const pending = productUpdate(reg, 'market');
  await participant(reg);
  await product(reg, pending);
  assert.notEqual(reg.status().generation, participantGeneration);
  console.log('STEP');
  receipt.cases.push(
    'idempotence; conflicting same-time value refused; delayed product publication revalidates latest participant predecessor',
  );
  const protocolReceiptNames = (await readdir(join(R, 'evidence')))
    .filter((n) => n.startsWith('CLIENT_protocol_'))
    .sort();
  const protocolReceipt = JSON.parse(
    await readFile(join(R, 'evidence', protocolReceiptNames.at(-1))),
  );
  const protocolAppend = JSON.parse(
    await readFile(join(protocolReceipt.root, 'append/protocol-1/ROUND_1_UPDATE.json')),
  );
  const virtualNow = Date.parse(protocolAppend.readings[0].observedAtUtc) + 3600000;
  const clockOffset = virtualNow - actualDateNow();
  Date.now = () => actualDateNow() + clockOffset;
  receipt.syntheticClockUtc = new Date(virtualNow).toISOString();
  const preAppend = hold(reg).product;
  await product(reg, protocolAppend);
  const appended = reg.capture();
  try {
    const next = admittedInputs(appended, false);
    assert.equal(next.protocol.end, 2503);
    assert.equal(next.protocol.tail.at(-1), protocolAppend.ledgerAppend.words[0]);
    assert.deepEqual(appended.product.rows.slice(0, 2502), preAppend.rows.slice(0, 2502));
    const bad = structuredClone(appended.product.metadata);
    bad.ledgerSegments.at(-1).words[0] = '1';
    assert.throws(
      () => admittedInputs({ ...appended, product: { ...appended.product, metadata: bad } }, false),
      /LEDGER/,
    );
  } finally {
    appended.release();
  }
  await participant(reg);
  await product(reg);
  console.log('STEP');
  receipt.cases.push(
    'actual protocol append through coordinated publisher; unchanged old 2502 periods; next admitted tail advances; tampered packed tail refused; later participant/gas preserves append',
  );
  f = await fixture({ participants: reg, productDaily: reg.productDaily, sourceGenerations: base });
  const read = reg.refresh.bind(reg);
  let selectionReads = 0;
  reg.refresh = async (...a) => {
    selectionReads++;
    return read(...a);
  };
  for (const key of [keys.invalid, keys.revoked]) {
    const n = selectionReads;
    assert.equal((await f.inject({ url: '/api/v2/holders', headers: auth(key) })).statusCode, 401);
    assert.equal(selectionReads, n);
  }
  const list = await f.inject('/api/v2/holders?limit=2');
  assert.equal(list.statusCode, 200, list.body);
  const first = list.json();
  const row = first.data?.[0] ?? first.items?.[0];
  const paid = await wire(f.app, '/api/v2/holders', [['Authorization', auth().authorization]]);
  assert.equal(paid.statusCode, 200);
  assert.equal(
    (await wire(f.app, '/api/v2/holders', [['Authorization', auth().authorization]], 'HEAD')).body,
    '',
  );
  assert.equal(
    (
      await wire(f.app, '/api/v2/holders', [
        ['Authorization', auth().authorization],
        ['If-None-Match', paid.headers.etag],
      ])
    ).statusCode,
    304,
  );
  assert.equal(
    (
      await wire(f.app, '/api/v2/holders', [
        ['Authorization', auth().authorization],
        ['Authorization', auth().authorization],
      ])
    ).statusCode,
    401,
  );
  const dailyUrl = '/api/v2/daily?from=2026-10-01&to=2026-10-20&limit=2';
  const daily = await f.inject(dailyUrl);
  assert.equal(daily.statusCode, 200, daily.body);
  const oldDailyEtag = daily.headers.etag;
  await product(reg);
  assert.equal(
    (await f.inject({ url: dailyUrl, headers: { 'if-none-match': oldDailyEtag } })).statusCode,
    200,
  );
  await participant(reg);
  assert.equal(
    (await f.inject('/api/v2/holders?limit=2&cursor=' + encodeURIComponent(first.nextCursor)))
      .statusCode,
    409,
  );
  const p = hold(reg).product,
    path = '/api/v2/downloads/' + p.bundleId + '/daily';
  assert.equal((await f.inject(path)).statusCode, 403);
  const csv = await f.inject({ url: path, headers: auth() });
  assert.equal(csv.statusCode, 200, csv.body.slice(0, 100));
  assert.equal(csv.body, p.csv.toString());
  const stream = reg.productDaily.openExport(p, p.bundleId, 'daily', new AbortController().signal);
  await product(reg);
  await participant(reg);
  await product(reg);
  const chunks = [];
  for await (const b of stream.stream) chunks.push(b);
  await stream.released;
  assert.deepEqual(Buffer.concat(chunks), p.csv);
  const sampleHolder = await base.holders.rowAt(1, new AbortController().signal);
  const addressUrl = '/api/v2/addresses/' + sampleHolder.reported.holderAddress;
  const addressBefore = await f.inject(addressUrl);
  assert.equal(addressBefore.statusCode, 200, addressBefore.body);
  let addressEntered = false,
    addressUnblock;
  const addressGate = new Promise((r) => (addressUnblock = r));
  const addressCapture = reg.capture(),
    addressSource = addressCapture.sourceGenerations;
  addressCapture.release();
  const originalLookup = addressSource.holderByAddress.bind(addressSource);
  let addressOnce = true;
  unblockAll.push(() => addressUnblock());
  addressSource.holderByAddress = async (...a) => {
    if (addressOnce) {
      addressOnce = false;
      addressEntered = true;
      await addressGate;
    }
    return originalLookup(...a);
  };
  const heldAddress = wire(f.app, addressUrl);
  await until(() => addressEntered);
  await product(reg);
  await participant(reg);
  await product(reg);
  addressUnblock();
  const addressAfter = await heldAddress;
  assert.equal(addressAfter.statusCode, 200);
  assert.deepEqual(JSON.parse(addressAfter.body), addressBefore.json());
  addressSource.holderByAddress = originalLookup;
  console.log('STEP');
  receipt.cases.push(
    'held actual address response and CSV stream stay on original compatible view across mixed commits',
  );
  for (const path of ['/data/daily.csv', '/participants/CURRENT.json'])
    assert.equal((await f.inject(path)).statusCode, 404);
  for (const key of ['source', 'view', 'generation'])
    assert.equal((await f.inject('/api/v2/holders?' + key + '=x')).statusCode, 400);
  // Hold an indexed read over both kinds of publication, then cancel and unwind.
  let entered = false,
    unblock;
  const gate = new Promise((r) => (unblock = r)),
    rowAt = base.holders.rowAt.bind(base.holders);
  let once = true;
  unblockAll.push(() => unblock());
  base.holders.rowAt = async (...a) => {
    if (once) {
      once = false;
      entered = true;
      await gate;
    }
    return rowAt(...a);
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
  await product(reg);
  await participant(reg);
  await product(reg);
  socket.destroy();
  unblock();
  await delay(100);
  base.holders.rowAt = rowAt;
  assert.equal(f.lifecycle.stats().pending, 0);
  assert.equal(reg.status().error, null);
  console.log('STEP');
  receipt.cases.push(
    'actual public/paid GET/HEAD/304; duplicate/revoked/bad keys before selection; cursor/ETag separation; protected CSV bytes; static isolation; held indexed request across mixed updates and cancellation',
  );
  await f.close();
  f = null;
  for (const phase of [
    'before-product',
    'after-product',
    'participant-stage',
    'after-pointer',
    'acknowledgement',
  ]) {
    const r = await fresh('failure-' + phase),
      before = r.status();
    await assert.rejects(
      r.publishProduct(productUpdate(r), {
        fault: (p) => {
          if (p === phase) throw Error('SYNTHETIC_' + phase);
        },
      }),
      /SYNTHETIC/,
    );
    if (phase === 'acknowledgement') await r.refresh(undefined, true);
    else {
      await assert.rejects(
        ParticipantRegistry.open(r.root, r.productDaily.root, base),
        /UNKNOWN_PUBLICATION/,
      );
      const recovery = await r.recoverOwnedFailure();
      assert.equal(
        recovery.outcome,
        phase === 'before-product' ? 'ABORTED_BEFORE_PRODUCT' : 'COMPLETED_SAVED_PUBLICATION',
      );
    }
    assert.equal(r.status().generation, before.generation);
    assert.equal(r.status().error, null);
  }
  console.log('STEP');
  receipt.cases.push(
    'exact known-owner recovery: before product, after product, partial staging, durable pointer/lost ACK; no provider calls',
  );
  const good = await readFile(join(reg.root, 'CURRENT.json'));
  await writeFile(
    join(reg.root, 'CURRENT.json'),
    JSON.stringify({
      ...JSON.parse(good),
      product: { version: 'f'.repeat(64), manifestSha256: 'e'.repeat(64) },
    }),
  );
  const previous = reg.status();
  await reg.refresh(undefined, true);
  assert(reg.status().error);
  assert.equal(reg.status().productVersion, previous.productVersion);
  await writeFile(join(reg.root, 'CURRENT.json'), good);
  await reg.refresh(undefined, true);
  const lock = await import('node:fs/promises').then((fs) =>
    fs.open(join(reg.root, 'SELECTION.lock'), 'wx'),
  );
  await assert.rejects(reg.publishProduct(productUpdate(reg)), /EEXIST/);
  await assert.rejects(reg.recoverOwnedFailure(), /UNKNOWN/);
  await lock.close();
  await import('node:fs/promises').then((fs) => fs.unlink(join(reg.root, 'SELECTION.lock')));
  console.log('STEP');
  receipt.cases.push(
    'pointer disagreement retains old view; second writer and unknown-owner recovery refused',
  );
  // Exercise the actual seven-job controller with native-child boundaries injected.
  for (const mode of ['known-closed', 'unknown', 'stopped']) {
    const r = await fresh('controller-' + mode),
      taskRoot = join(root, 'controller-' + mode);
    await writeFile(
      join(taskRoot, 'REQUEST_PLAN.json'),
      await readFile(join(R, 'REQUEST_PLAN.json')),
    );
    const preflightPath = join(taskRoot, 'PREFLIGHT.json');
    await writeFile(
      preflightPath,
      JSON.stringify({
        verdict: 'PASS',
        taskId: 'HDD-UNIFIED-REFRESH-OPERATION-R1',
        taskRoot,
        synthetic: true,
        runtimeFiles: {},
        inputFiles: {},
        marketSourceFiles: {},
        initialGeneration: r.status().generation,
        initialProductVersion: r.status().productVersion,
      }),
    );
    let starts = 0;
    const spawnChild = (_exe, args) => {
      starts++;
      const child = new EventEmitter();
      child.stdin = new PassThrough();
      child.stdout = new PassThrough();
      child.stderr = new PassThrough();
      child.pid = 999999;
      void (async () => {
        const jobRoot = args.at(-1),
          accounting = {
            status: 'CLOSED',
            pending: mode === 'unknown' ? { conservative: true } : null,
            attempts: 0,
          };
        const source = {
          status: 'PARTIAL',
          accounting,
          feedLocalClosedExhaustion: mode === 'known-closed',
          failure: 'SYNTHETIC_' + mode,
        };
        await writeFile(join(jobRoot, 'ACCOUNTING.json'), JSON.stringify(accounting));
        await writeFile(join(jobRoot, 'RESULT.json'), JSON.stringify(source));
        if (mode !== 'stopped')
          child.stdout.write(JSON.stringify({ type: 'closed', result: source }) + '\n');
        child.stdout.end();
        child.stderr.end();
        child.emit('close', mode === 'stopped' ? null : 2, mode === 'stopped' ? 'SIGTERM' : null);
      })().catch((e) => child.emit('error', e));
      return child;
    };
    // Controller-only injected identity: no collector or publication uses these synthetic rows.
    const controllerRegistry = new Proxy(r, {
      get(target, key) {
        if (key === 'capture')
          return () => {
            const h = target.capture();
            return {
              ...h,
              sourceGenerations: {
                selection: h.sourceGenerations.selection,
                identity: {
                  ...h.sourceGenerations.identity,
                  snapshot: {
                    ...h.sourceGenerations.identity.snapshot,
                    ...input.acceptedData.participantTarget,
                  },
                },
              },
            };
          };
        const value = target[key];
        return typeof value === 'function' ? value.bind(target) : value;
      },
    });
    const result = await runUnified({
      taskRoot,
      preflightPath,
      registry: controllerRegistry,
      onAdoption: () => {
        throw Error('No synthetic publication expected');
      },
      spawnChild,
    });
    assert.equal(result.status, 'PARTIAL');
    assert.equal(result.networkSessionCount, 0);
    assert.equal(starts, mode === 'known-closed' ? 4 : 1);
    if (mode === 'known-closed') {
      assert.equal(result.disabledFeeds.length, 4);
      assert.equal(result.jobs.filter((j) => j.status === 'SKIPPED_DISABLED_FEED').length, 3);
      assert.equal(result.networkClosureKnown, true);
    } else assert.equal(result.networkClosureKnown, false);
    await assert.rejects(
      runUnified({
        taskRoot,
        preflightPath,
        registry: controllerRegistry,
        onAdoption: () => {},
        spawnChild,
      }),
      /EXISTING_OR_UNCERTAIN/,
    );
  }
  console.log('STEP');
  receipt.cases.push(
    'actual finite controller: known closed exhaustion disables each feed and skips round two; unknown/stopped child stops all; no second parent admission',
  );
  receipt.status = 'COORDINATED_OFFLINE_PASS';
} catch (e) {
  receipt.status = 'FAIL';
  receipt.failure = String(e);
  receipt.stack = e.stack;
  throw e;
} finally {
  Date.now = actualDateNow;
  for (const release of unblockAll) release();
  console.log(
    JSON.stringify({ testStatus: receipt.status, failure: receipt.failure, cases: receipt.cases }),
  );
  for (const h of leases) h.release();
  receipt.cleanup = [];
  for (const work of [
    () => f?.close(),
    ...regs.reverse().map((r) => () => r.close()),
    () => real?.close(),
    () => base?.close(),
  ]) {
    try {
      await work();
    } catch (e) {
      receipt.cleanup.push(String(e));
    }
  }
  receipt.closed = receipt.cleanup.length === 0;
  receipt.rss = process.memoryUsage().rss;
  await writeFile(
    join(R, 'evidence/COMPOSED_' + Date.now() + '.json'),
    JSON.stringify(receipt, null, 2) + '\n',
  );
  console.log(JSON.stringify(receipt));
}
