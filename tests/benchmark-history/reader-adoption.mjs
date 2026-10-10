// One real immutable-base admission and compact seed initialization. All writes
// and later observations are isolated synthetic fixtures, never genuine selection.
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import { syncBuiltinESMExports } from 'node:module';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { restoreParticipants } from '../../scripts/participant-refresh-backup.mjs';
import { SavedSourceGenerations } from '../../dist/services/source-update/generation.js';
import { ACCEPTED } from '../../dist/contracts/saved-generation.js';
import { ParticipantRegistry } from '../../dist/services/source-update/refresh.js';
import { ProductDailyStore } from '../../dist/services/product-daily/store.js';
import { verifyMarketReaderAdvance } from '../../dist/services/product-daily/storage.js';
import {
  applyMarketUpdate,
  preserveMarketHistory,
} from '../../dist/services/product-daily/market.js';
import { hash, stable } from '../../dist/history-bootstrap/normalize.js';
import { PageCursors } from '../../dist/services/queries/cursor.js';
import { ProductQuery } from '../../dist/contracts/product-daily.js';
import { columns } from '../../dist/services/product-daily/project.js';
import { fixture, auth } from '../market-feed/access-fixture.mjs';
import { guard, measuredWire } from './reader-budget.mjs';
const R = process.env.HDD_TASK_ROOT;
assert(R?.endsWith('btc-eth-daily-close-reader-adoption-r1'));
const save = (n, v) =>
  fs.writeFile(join(R, 'evidence', n + '.json'), JSON.stringify(v, null, 2) + '\n', { flag: 'wx' });
const inputs = JSON.parse(await fs.readFile(join(R, 'INPUTS.json'))),
  p = inputs.preserveGenuine;
const profile = JSON.parse(await fs.readFile(join(R, 'inputs/hds/SELECTED_PROFILE.json')));
const update = JSON.parse(await fs.readFile(join(R, 'data/HISTORY_UPDATE.json')));
const snap = (reg) => {
  const h = reg.capture();
  try {
    return h.product;
  } finally {
    h.release();
  }
};
const receipt = {
  synthetic: true,
  externalRequests: 0,
  startedAt: new Date().toISOString(),
  cases: [],
  boundedReads: [],
};
const rawRead = fs.readFile;
let reads;
fs.readFile = async function (path, ...args) {
  const b = await rawRead(path, ...args);
  if (reads) reads.push({ path: String(path), bytes: Buffer.byteLength(b) });
  return b;
};
syncBuiltinESMExports();
async function measured(name, fn) {
  reads = [];
  try {
    return await fn();
  } finally {
    receipt.boundedReads.push({
      name,
      files: reads,
      bytes: reads.reduce((n, r) => n + r.bytes, 0),
      journalReads: reads.filter((r) => r.path.includes('journal')).length,
    });
    reads = null;
  }
}
let base, writer, reader, delayed, refusalReader, f, held, oldExport;
try {
  await save('FIXTURE_ADMISSION_STARTED', {
    at: new Date().toISOString(),
    maximumBaseAdmissions: 1,
    maximumSeedInitializations: 1,
    synthetic: true,
  });
  base = await SavedSourceGenerations.activate({
    root: profile.overlayRoot,
    holdersRoot: profile.holdersRoot,
    stakesRoot: profile.stakesRoot,
  });
  await base.admit(join(base.root, ACCEPTED.generation), { readOnly: true });
  await base.loadSelection();
  const restored = await restoreParticipants(
    join(R, 'seed-backup'),
    join(R, 'synthetic-runtime'),
    p.hdsSeedBackupSha256,
    base,
  );
  writer = restored.registry;
  await save('ONE_SEED_INITIALIZATION', restored.receipt);
  const seed = snap(writer),
    pair = seed.metadata.pair;
  assert.equal(seed.version, p.hdsRollback);
  assert.equal(hash(seed.csv), p.hdsCsvSha256);
  reader = await ParticipantRegistry.open(writer.root, writer.productDaily.root, base);
  delayed = await ParticipantRegistry.open(writer.root, writer.productDaily.root, base);
  refusalReader = await ParticipantRegistry.open(writer.root, writer.productDaily.root, base);
  const standalone = new ProductDailyStore(writer.productDaily.root, pair);
  await standalone.load();
  const refused = new ProductDailyStore(writer.productDaily.root, pair);
  await refused.load();
  held = reader.capture();
  oldExport = reader.productDaily.openExport(
    held.product,
    held.product.bundleId,
    'daily',
    new AbortController().signal,
  );
  const cursors = new PageCursors(),
    query = ProductQuery.parse({ from: '2019-12-03', to: '2019-12-10', limit: '1' });
  const oldPage = reader.productDaily.read(seed, query, 'daily', cursors, Date.now(), 'public');
  assert(oldPage.nextCursor);
  f = guard(
    await fixture({
      participants: reader,
      productDaily: reader.productDaily,
      sourceGenerations: base,
    }),
  );
  f.controls.now = Date.now();
  receipt.origin = await f.app.listen({ host: '127.0.0.1', port: 0 });
  receipt.apiPid = process.pid;
  const before = await measuredWire(f.app, '/api/v2/daily?from=2019-12-03&to=2019-12-10');
  assert.equal(before.statusCode, 200);
  // No delayed-reader request/refresh between these two writer commits.
  await writer.publishProduct(update);
  await writer.refresh(undefined, true);
  const close = snap(writer);
  assert.equal(close.version, p.closeProduct);
  assert.equal(hash(close.csv), p.closeCsvSha256);
  const synthetic = {
    readings: close.metadata.readings
      .filter((r) => r.kind === 'reference')
      .map((r) => ({ ...r, roundId: String(BigInt(r.roundId) + 1n) })),
    liquidityHistory: [],
    receiptSha256: hash('SYNTHETIC reader24 unchanged time and price'),
  };
  await writer.publishProduct(synthetic);
  await writer.refresh(undefined, true);
  const next = snap(writer);
  assert.equal(next.metadata.marketStorage.sequence, 24);
  assert.equal(next.metadata.effectiveAtUtc, seed.metadata.effectiveAtUtc);
  assert.deepEqual(next.rows, close.rows);
  assert.equal(snap(reader).version, seed.version);
  assert.equal(snap(delayed).version, seed.version);
  await delay(1100);
  const adopted = await measured('ordinary paired 22->24', () => f.inject('/api/v2/live'));
  assert.equal(adopted.statusCode, 200, adopted.body);
  assert.equal(adopted.json().datasetVersion, next.version);
  assert.equal(reader.status().error, null);
  assert.equal(snap(reader).version, next.version);
  await measured('standalone same-time 22->24', () => standalone.refresh());
  assert.equal(standalone.capture().version, next.version);
  assert.equal(standalone.reloadStatus().error, null);
  receipt.cases.push('ordinary paired 22->24 and standalone 22->24; same-time reference round');
  await save('ADOPT_24', {
    status: 'PASS',
    seedVersion: seed.version,
    missed: close.version,
    selected: next.version,
    sequence: 24,
    sameTimestamp: next.metadata.effectiveAtUtc,
    live: adopted.json(),
    readerStatus: reader.status(),
  });
  // Small corruption cases modify only isolated fixture files, then restore exact bytes.
  const journal = join(writer.productDaily.root, 'journal/00000001.ndjson'),
    original = await fs.readFile(journal);
  const records = original.toString().trimEnd().split('\n').map(JSON.parse);
  const rewrite = (record) => {
    const { archiveHash, ...envelope } = record;
    return { ...envelope, archiveHash: hash(stable(envelope)) };
  };
  const refusals = [];
  async function reject(
    name,
    prepare,
    restore,
    action = () => refused.adoptCoordinated(next, pair),
  ) {
    try {
      await prepare();
      let error;
      try {
        await action();
      } catch (e) {
        error = e.message;
      }
      assert(error, name + ' must refuse');
      assert.equal(refused.capture().version, seed.version);
      refusals.push({ name, error, lastGood: seed.version });
    } finally {
      await restore();
    }
  }
  for (const [name, mutate] of [
    ['wrong predecessor', (r) => (r.previousGeneration.version = '0'.repeat(64))],
    ['wrong history', (r) => (r.update.benchmarkHistory.predecessorHistorySha256 = '0'.repeat(64))],
    ['modified receipt', (r) => (r.update.receiptSha256 = '0'.repeat(64))],
    ['modified selection', (r) => (r.selected.version = '0'.repeat(64))],
    ['modified close value', (r) => (r.update.benchmarkHistory.buckets[0].value = '999')],
    ['broken archive predecessor', (r) => (r.archivePrevious = '0'.repeat(64))],
  ])
    await reject(
      name,
      async () => {
        const list = structuredClone(records);
        mutate(list[6]);
        list[6].head = hash(
          stable({
            sequence: list[6].sequence,
            previous: list[6].previous,
            update: list[6].update,
          }),
        );
        list[6] = rewrite(list[6]);
        await fs.writeFile(journal, list.map(stable).join(''));
      },
      () => fs.writeFile(journal, original),
    );
  await reject(
    'malformed journal',
    () => fs.writeFile(journal, '{\n'),
    () => fs.writeFile(journal, original),
  );
  await reject(
    'missing journal',
    () => fs.rename(journal, journal + '.synthetic-held'),
    () => fs.rename(journal + '.synthetic-held', journal),
  );
  const cert = join(writer.productDaily.root, 'verified-' + next.version + '.json');
  const certBytes = await fs.readFile(cert);
  await reject(
    'modified certificate',
    () => fs.writeFile(cert, '{}\n'),
    () => fs.writeFile(cert, certBytes),
  );
  await reject(
    'missing certificate',
    () => fs.rename(cert, cert + '.synthetic-held'),
    () => fs.rename(cert + '.synthetic-held', cert),
  );
  await reject(
    'wrong final pair',
    async () => {},
    async () => {},
    () => refused.adoptCoordinated(next, { ...pair, generation: '0'.repeat(64) }),
  );
  const participantPointer = join(writer.root, 'CURRENT.json'),
    ptrBytes = await fs.readFile(participantPointer);
  try {
    const bad = JSON.parse(ptrBytes);
    bad.product.version = '0'.repeat(64);
    await fs.writeFile(participantPointer, stable(bad));
    await refusalReader.refresh();
    assert(refusalReader.status().error);
    assert.equal(snap(refusalReader).version, seed.version);
    refusals.push({
      name: 'paired invalid final selection',
      error: refusalReader.status().error,
      lastGood: seed.version,
    });
  } finally {
    await fs.writeFile(participantPointer, ptrBytes);
  }
  assert.throws(() => preserveMarketHistory(next, seed));
  await assert.rejects(standalone.adoptCoordinated(seed, pair));
  assert.equal(standalone.capture().version, next.version);
  refusals.push({ name: 'regression', lastGood: next.version });
  await save('READER_REFUSALS', { status: 'PASS', synthetic: true, refusals });
  // A second ordinary update causes normal retention to remove intermediate 23.
  const later = {
    ...synthetic,
    readings: synthetic.readings.map((r) => ({ ...r, roundId: String(BigInt(r.roundId) + 1n) })),
    receiptSha256: hash('SYNTHETIC reader25 unchanged time and price'),
  };
  await writer.publishProduct(later);
  await writer.refresh(undefined, true);
  const final = snap(writer);
  assert.equal(final.metadata.marketStorage.sequence, 25);
  await assert.rejects(fs.stat(join(writer.productDaily.root, close.version)), { code: 'ENOENT' });
  await assert.rejects(fs.stat(join(writer.productDaily.root, seed.version)), { code: 'ENOENT' });
  // Direct measurement isolates the new seam from product admission and HTTP overhead.
  await measured('bounded bridge with pruned 23', () =>
    verifyMarketReaderAdvance(writer.productDaily.root, final, seed),
  );
  const bounded = receipt.boundedReads.at(-1);
  assert.equal(bounded.journalReads, 4);
  assert.equal(bounded.files.length, 7);
  assert(bounded.bytes < 4 * 2 * 1024 ** 2 + 65536 + 8192 + 4096);
  await f.close();
  f = null;
  // Reader was established at 22; normal first request now sees 25, never 23/24.
  f = guard(
    await fixture({
      participants: delayed,
      productDaily: delayed.productDaily,
      sourceGenerations: base,
    }),
  );
  f.controls.now = Date.now();
  const finalLive = await f.inject('/api/v2/live');
  assert.equal(finalLive.json().datasetVersion, final.version);
  assert.equal(delayed.status().error, null);
  assert.deepEqual(final.rows, close.rows);
  assert.deepEqual(final.metadata.pair, seed.metadata.pair);
  assert.deepEqual(final.metadata.ledgerSegments, seed.metadata.ledgerSegments);
  assert.deepEqual(final.metadata.liquidityHistory, seed.metadata.liquidityHistory);
  const expected = seed.rows.map((r) => ({ ...r })),
    byDate = new Map(expected.map((r) => [r.dateUtc, r]));
  for (const b of update.benchmarkHistory.buckets) {
    const r = byDate.get(b.dateUtc);
    r[b.asset === 'BTC' ? 'btcPriceUsd' : 'ethPriceUsd'] = b.value;
    assert.equal(r[b.asset === 'BTC' ? 'btcRecordedAtUtc' : 'ethRecordedAtUtc'], null);
  }
  assert.deepEqual(final.rows, expected);
  const apiRows = [],
    day = (s, n) => new Date(Date.parse(s) + n * 86400000).toISOString().slice(0, 10);
  for (let from = expected[0].dateUtc; from <= expected.at(-1).dateUtc; from = day(from, 366)) {
    const to = day(from, 365) < expected.at(-1).dateUtc ? day(from, 365) : expected.at(-1).dateUtc;
    let cursor;
    do {
      const q = new URLSearchParams({ from, to, limit: '100', ...(cursor ? { cursor } : {}) });
      const r = await f.inject('/api/v2/daily?' + q);
      assert.equal(r.statusCode, 200, r.body);
      apiRows.push(...r.json().items);
      cursor = r.json().nextCursor;
    } while (cursor);
  }
  assert.deepEqual(apiRows, expected);
  const down = '/api/v2/downloads/' + final.bundleId + '/daily';
  assert([401, 403].includes((await f.inject(down)).statusCode));
  const csv = await f.inject({ url: down, headers: auth() });
  assert.equal(csv.statusCode, 200);
  assert.equal(hash(csv.body), hash(final.csv));
  assert.equal(csv.body.trimEnd().split('\n').length, 2504);
  const chunks = [];
  for await (const b of oldExport.stream) chunks.push(b);
  await oldExport.released;
  oldExport = null;
  assert.equal(hash(Buffer.concat(chunks)), p.hdsCsvSha256);
  assert.equal(hash(held.product.csv), p.hdsCsvSha256);
  assert.throws(() =>
    delayed.productDaily.read(
      final,
      { ...query, cursor: oldPage.nextCursor },
      'daily',
      cursors,
      Date.now(),
      'public',
    ),
  );
  const after = await f.inject({
    url: '/api/v2/daily?from=2019-12-03&to=2019-12-10',
    headers: { 'if-none-match': before.headers.etag },
  });
  assert.equal(after.statusCode, 200);
  assert.notEqual(after.headers.etag, before.headers.etag);
  const repeat = await f.inject({
    url: '/api/v2/daily?from=2019-12-03&to=2019-12-10',
    headers: { 'if-none-match': after.headers.etag },
  });
  assert.equal(repeat.statusCode, 304);
  await delay(1100);
  await measured('unchanged pointer ordinary request', () => f.inject('/api/v2/live'));
  assert.equal(receipt.boundedReads.at(-1).journalReads, 0);
  await standalone.refresh();
  assert.equal(standalone.capture().version, final.version);
  const cold = new ProductDailyStore(writer.productDaily.root, pair);
  await cold.load();
  assert.equal(cold.capture().version, final.version);
  assert.equal((await writer.publishProduct(update)).changed, false);
  receipt.cases.push(
    '22->25 after normal pruning; cold start and already-close advance; repeat no-op; held export; full Daily and protected CSV; ETag/cursor',
  );
  receipt.final = {
    version: final.version,
    sequence: 25,
    rows: 2503,
    cells: 2503 * columns.length,
    closes: 5004,
    otherCellsUnchanged: 112637,
    csvSha256: hash(final.csv),
    historicalTimes: null,
    live: finalLive.json(),
    intermediateDirectoryPruned: true,
  };
  receipt.status = 'PASS';
} catch (e) {
  receipt.status = 'FAIL';
  receipt.error = String(e.stack ?? e);
  throw e;
} finally {
  reads = null;
  fs.readFile = rawRead;
  syncBuiltinESMExports();
  if (oldExport) {
    oldExport.stream.destroy();
    await oldExport.released.catch(() => {});
  }
  held?.release();
  await f?.close();
  for (const r of [reader, delayed, refusalReader, writer]) await r?.close();
  await base?.close();
  receipt.closedAt = new Date().toISOString();
  receipt.ownedProcessesClosed = true;
  await save('READER_ADOPTION', receipt);
}
console.log(
  'PASS actual paired/standalone delayed readers, pruning, refusal guards, held CSV, full ordinary Daily',
);
