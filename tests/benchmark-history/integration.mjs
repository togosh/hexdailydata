// Focused corrected run over the once-restored genuine seed; failures use new derived roots.
import assert from 'node:assert/strict';
import { readFile, writeFile, stat } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { SavedSourceGenerations, sha } from '../../dist/services/source-update/generation.js';
import { ACCEPTED } from '../../dist/contracts/saved-generation.js';
import { stable } from '../../dist/history-bootstrap/normalize.js';
import { admitProduct } from '../../dist/services/product-daily/store.js';
import { ParticipantRegistry } from '../../dist/services/source-update/refresh.js';
import { deriveFixture } from '../unified-refresh/fixture-state.mjs';
import { auditJournal, inspectStorage } from '../../dist/services/product-daily/storage.js';
import { preserveMarketHistory } from '../../dist/services/product-daily/market.js';
import { columns } from '../../dist/services/product-daily/project.js';
import { PageCursors } from '../../dist/services/queries/cursor.js';
import { ProductQuery } from '../../dist/contracts/product-daily.js';
import { fixture, auth, wire } from '../market-feed/access-fixture.mjs';
import { access } from './access.mjs';
import { finalize } from './final.mjs';
const R = process.env.HDD_TASK_ROOT;
assert(R?.endsWith('btc-eth-historical-backfill-r1'));
const save = async (n, v) => {
  const file = join(R, 'evidence', n + '.json');
  const exists = await stat(file).catch((e) => {
    if (e.code === 'ENOENT') return null;
    throw e;
  });
  return writeFile(
    exists ? join(R, 'evidence', n + '_5.json') : file,
    JSON.stringify(v, null, 2) + '\n',
    { flag: 'wx' },
  );
};
const review = JSON.parse(await readFile(join(R, 'evidence/METHOD_REVIEW.json')));
assert.equal(review.status, 'METHOD_AND_SELECTION_PASS');
for (const [p, id] of Object.entries(review.bindings))
  assert.equal(sha(await readFile(join(R, p))), id.sha256);
const update = JSON.parse(await readFile(join(R, 'data/HISTORY_UPDATE.json')));
const profile = JSON.parse(await readFile(join(R, 'inputs/ACCEPTED_PROFILE.json')));
let base, real, reader, f, synthetic, held;
const receipt = { startedAt: new Date().toISOString(), externalRequests: 0, cases: [] };
const snap = (reg) => {
  const h = reg.capture();
  try {
    return h.product;
  } finally {
    h.release();
  }
};
async function publish(reg, u) {
  const result = await reg.publishProduct(u);
  await reg.refresh(undefined, true);
  assert.equal(reg.status().error, null);
  return result;
}
async function invalid(reg, u, pattern) {
  const before = await readFile(join(reg.root, 'CURRENT.json'));
  await assert.rejects(reg.publishProduct(u), pattern);
  await reg.recoverOwnedFailure();
  // Recovery canonically serializes the same selection; byte-order is not its identity.
  assert.deepEqual(JSON.parse(await readFile(join(reg.root, 'CURRENT.json'))), JSON.parse(before));
}
try {
  base = await SavedSourceGenerations.activate({
    root: profile.overlayRoot,
    holdersRoot: profile.holdersRoot,
    stakesRoot: profile.stakesRoot,
  });
  await base.admit(join(base.root, ACCEPTED.generation), { readOnly: true });
  await base.loadSelection();
  // Concrete recovery-reader recheck: reuse the one restored genuine seed, never restore it twice.
  real = await ParticipantRegistry.open(
    join(R, 'runtime/participants'),
    join(R, 'runtime/product'),
    base,
  );
  const seed = snap(real);
  assert.equal(sha(seed.csv), '3be3bfbf504267cb2c2d58da3c2e88d51491390d0ad9eb50b928f9dd551fbaca');
  await save('ADMITTED_SEED', {
    version: seed.version,
    manifestSha256: seed.manifestSha256,
    readings: seed.metadata.readings,
    pair: seed.metadata.pair,
    rows: seed.rows.length,
    csvSha256: sha(seed.csv),
  });
  // Publication and journal fixtures before genuine selection. Existing retention owns only these copies.
  synthetic = await deriveFixture(real, join(R, 'synthetic-journal-5'), base);
  const corrupt = structuredClone(update);
  corrupt.benchmarkHistory.buckets[0].value = '9999';
  await invalid(synthetic, corrupt, /IDENTITY/);
  const first = await publish(synthetic, update);
  assert(first.changed);
  assert.equal((await publish(synthetic, update)).changed, false);
  const conflicting = structuredClone(update);
  conflicting.benchmarkHistory.buckets[0].value = '9999';
  conflicting.benchmarkHistory.selectionSha256 = sha(stable(conflicting.benchmarkHistory.buckets));
  await invalid(synthetic, conflicting, /REPLACEMENT/);
  const histories = snap(synthetic).metadata.benchmarkHistory;
  const gas = seed.metadata.readings.find((r) => r.kind === 'gas');
  const start = Math.max(...seed.metadata.readings.map((r) => Date.parse(r.observedAtUtc))) + 1000;
  const rotation = [];
  for (let i = 0; i < 16; i++) {
    const publication = await publish(synthetic, {
      readings: [{ ...gas, observedAtUtc: new Date(start + i * 1000).toISOString() }],
      liquidityHistory: [],
      receiptSha256: sha('synthetic-journal-' + i),
    });
    assert.deepEqual(snap(synthetic).metadata.benchmarkHistory, histories);
    rotation.push({
      sequence: publication.storage.sequence,
      segment: publication.storage.segment,
      retention: publication.retention,
    });
  }
  const inspection = await inspectStorage(synthetic.productDaily.root);
  assert.equal(inspection.status, 'READABLE');
  const journal = await auditJournal(synthetic.productDaily.root);
  assert.equal(rotation.at(-1).sequence, 17);
  assert.equal(rotation.at(-1).segment, 1);
  assert.notEqual(rotation.at(-2).segment, rotation.at(-1).segment);
  await save('JOURNAL_BOUNDARY', {
    status: 'PASS',
    synthetic: true,
    historyEntries: 4269,
    journal,
    inspection,
    rotation,
  });
  const syntheticProduct = snap(synthetic);
  const metadataPath = join(synthetic.productDaily.root, syntheticProduct.version, 'metadata.json');
  const originalMetadata = await readFile(metadataPath),
    changedMetadata = JSON.parse(originalMetadata);
  const oldToken = changedMetadata.benchmarkHistory.buckets[0].value;
  changedMetadata.benchmarkHistory.buckets[0].value =
    (oldToken[0] === '9' ? '8' : '9') + oldToken.slice(1);
  const changedBytes = Buffer.from(stable(changedMetadata));
  assert.equal(changedBytes.length, originalMetadata.length);
  await writeFile(metadataPath, changedBytes);
  await assert.rejects(
    admitProduct(
      join(synthetic.productDaily.root, syntheticProduct.version),
      syntheticProduct.manifestSha256,
    ),
    /PRODUCT_FILE_DIGEST/,
  );
  assert.deepEqual(snap(synthetic).metadata.benchmarkHistory, histories);
  await save('SAME_SIZE_TAMPER', {
    status: 'PASS',
    synthetic: true,
    path: metadataPath,
    bytes: changedBytes.length,
    originalSha256: sha(originalMetadata),
    alteredSha256: sha(changedBytes),
    newAdmission: 'rejected',
    heldImmutableView: 'unchanged',
    failedFixtureRetained: true,
  });
  await synthetic.close();
  synthetic = null;
  reader = await ParticipantRegistry.open(real.root, real.productDaily.root, base);
  f = await fixture(
    { participants: reader, productDaily: reader.productDaily, sourceGenerations: base },
    {
      webRoot: resolve('dist/web'),
      account: { webRoot: resolve('account/dist/ui'), register: async () => {} },
    },
  );
  f.controls.now = Date.now();
  const origin = await f.app.listen({ host: '127.0.0.1', port: 0 });
  receipt.origin = origin;
  receipt.apiPid = process.pid;
  const beforeLive = (await f.inject('/api/v2/live')).json();
  const holder = (await f.inject('/api/v2/holders?limit=1')).json().items[0].reported;
  const participantPaths = [
    '/api/v2/holders?limit=2',
    '/api/v2/stakes?limit=2',
    '/api/v2/addresses/' + holder.holderAddress,
  ];
  const participantBefore = {};
  for (const p of participantPaths) participantBefore[p] = (await f.inject(p)).json();
  held = reader.capture();
  const cursors = new PageCursors();
  const query = ProductQuery.parse({ from: '2019-12-03', to: '2019-12-10', limit: '1' });
  const oldPage = reader.productDaily.read(
    held.product,
    query,
    'daily',
    cursors,
    Date.now(),
    'public',
  );
  assert(oldPage.nextCursor);
  const beforeWire = await wire(f.app, '/api/v2/daily?from=2019-12-03&to=2019-12-10');
  const published = await publish(real, update);
  assert(published.changed);
  await save('REAL_PUBLICATION', published);
  // Do not manually refresh the API registry: normal request refresh adopts after its throttle.
  await new Promise((r) => setTimeout(r, 1100));
  const adopted = await f.inject('/api/v2/live');
  assert.equal(adopted.statusCode, 200, adopted.body);
  const selected = snap(real),
    afterLive = adopted.json();
  assert.equal(afterLive.datasetVersion, selected.version);
  const strip = (v) => {
    const x = structuredClone(v);
    delete x.datasetVersion;
    return x;
  };
  assert.deepEqual(strip(afterLive), strip(beforeLive));
  assert.equal(selected.metadata.effectiveAtUtc, seed.metadata.effectiveAtUtc);
  assert.deepEqual(selected.metadata.readings, seed.metadata.readings);
  assert.deepEqual(selected.metadata.pair, seed.metadata.pair);
  assert.deepEqual(selected.metadata.ledgerSegments, seed.metadata.ledgerSegments);
  assert.deepEqual(selected.metadata.liquidityHistory, seed.metadata.liquidityHistory);
  preserveMarketHistory(seed, selected);
  assert.equal(selected.rows.length, 2503);
  assert.equal(selected.metadata.coverage.ledgerDates, 2502);
  assert.equal(selected.metadata.liquidityHistory.length, 90);
  const expected = seed.rows.map((r) => ({ ...r })),
    byDate = new Map(expected.map((r) => [r.dateUtc, r]));
  for (const b of update.benchmarkHistory.buckets) {
    const r = byDate.get(b.dateUtc),
      field = b.asset === 'BTC' ? 'btcPriceUsd' : 'ethPriceUsd';
    assert.equal(r[field], null);
    r[field] = b.value;
    assert.equal(r[b.asset === 'BTC' ? 'btcRecordedAtUtc' : 'ethRecordedAtUtc'], null);
  }
  assert.deepEqual(selected.rows, expected);
  assert.equal((await publish(real, update)).changed, false);
  assert.equal(snap(real).version, selected.version);
  await invalid(real, conflicting, /REPLACEMENT/);
  const nextWire = await wire(f.app, '/api/v2/daily?from=2019-12-03&to=2019-12-10');
  assert.notEqual(nextWire.headers.etag, beforeWire.headers.etag);
  assert.throws(() =>
    reader.productDaily.read(
      reader.productDaily.capture(),
      { ...query, cursor: oldPage.nextCursor },
      'daily',
      cursors,
      Date.now(),
      'public',
    ),
  );
  const stream = reader.productDaily.openExport(
      held.product,
      held.product.bundleId,
      'daily',
      new AbortController().signal,
    ),
    chunks = [];
  for await (const b of stream.stream) chunks.push(b);
  await stream.released;
  assert.deepEqual(Buffer.concat(chunks), seed.csv);
  held.release();
  held = null;
  const comparable = (v) =>
    JSON.parse(
      JSON.stringify(v, (k, x) => (k === 'nextCursor' && x !== null ? 'cursor-present' : x)),
    );
  for (const p of participantPaths)
    assert.deepEqual(comparable((await f.inject(p)).json()), comparable(participantBefore[p]));
  // Reconcile every normal API cell once, bounded public page/range controls preserved.
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
  const down = '/api/v2/downloads/' + selected.bundleId + '/daily';
  assert([401, 403].includes((await f.inject(down)).statusCode));
  const csv = await f.inject({ url: down, headers: auth() });
  assert.equal(csv.statusCode, 200);
  assert.equal(sha(csv.body), sha(selected.csv));
  const lines = csv.body.trimEnd().split('\n');
  assert.deepEqual(lines.shift().split(','), columns);
  assert.equal(lines.length, expected.length);
  for (let i = 0; i < lines.length; i++)
    assert.deepEqual(
      lines[i].split(','),
      columns.map((k) => (expected[i][k] === null ? '' : String(expected[i][k]))),
    );
  for (const method of ['HEAD', 'GET']) {
    const r = await f.inject({
      url: down,
      method,
      headers: { ...auth(), 'if-none-match': csv.headers.etag },
    });
    assert.equal(r.statusCode, 304);
  }
  for (const path of ['/data/daily.csv', '/participants/CURRENT.json', '/data/HISTORY_UPDATE.json'])
    assert.equal((await f.inject(path)).statusCode, 404);
  for (const extra of ['source=x', 'view=history', 'generation=x'])
    assert.equal(
      (await f.inject('/api/v2/daily?from=2024-01-01&to=2024-01-02&' + extra)).statusCode,
      400,
    );
  assert.equal((await f.inject('/api/v2/daily?from=2019-12-03&to=2026-10-07')).statusCode, 400);
  assert.equal(
    (await f.inject('/api/v2/daily?from=2024-01-01&to=2024-01-02&limit=101')).statusCode,
    400,
  );
  await save('FULL_RECONCILIATION', {
    status: 'PASS',
    rows: expected.length,
    columns: columns.length,
    exactCsvCells: expected.length * columns.length,
    historyBuckets: 4269,
    apiRows: apiRows.length,
    heldCsvSha256: sha(seed.csv),
    selectedCsvSha256: sha(selected.csv),
    beforeLive,
    afterLive,
    participantsUnchanged: participantPaths,
    sameApiProcess: true,
    normalRequestAdoption: true,
  });
  await access({ R, f, reader });
  await finalize({
    R,
    real,
    base,
    fixture: f,
    origin,
    seed,
    save,
    afterRestore: async (restoredRegistry) => {
      const before = snap(restoredRegistry);
      let derived;
      try {
        derived = await deriveFixture(restoredRegistry, join(R, 'synthetic-after-restore'), base);
        const refs = before.metadata.readings.filter((r) => r.kind === 'reference');
        const t =
          Math.max(...before.metadata.readings.map((r) => Date.parse(r.observedAtUtc))) + 60000;
        await publish(derived, {
          readings: refs.map((r) => ({
            ...r,
            roundId: String(BigInt(r.roundId) + 1n),
            observedAtUtc: new Date(t).toISOString(),
          })),
          liquidityHistory: [],
          receiptSha256: sha('synthetic-reference-after-history-restore'),
        });
        const next = snap(derived);
        assert.deepEqual(next.metadata.benchmarkHistory, before.metadata.benchmarkHistory);
        for (const b of histories.buckets)
          assert.equal(
            next.rows.find((r) => r.dateUtc === b.dateUtc)[
              b.asset === 'BTC' ? 'btcPriceUsd' : 'ethPriceUsd'
            ],
            b.value,
          );
        assert.equal(snap(restoredRegistry).version, before.version);
        await save('POST_RESTORE_UPDATE', {
          status: 'PASS',
          synthetic: true,
          derivedRoot: derived.root,
          historyBuckets: 4269,
          genuineRestoredPointerUnchanged: true,
        });
      } finally {
        if (derived) await derived.close();
      }
    },
  });
  receipt.status = 'PASS';
  receipt.selected = real.status();
  receipt.cases = [
    'paired history publication',
    'idempotence',
    'rejected import preserves last good',
    'same running API adoption',
    'held prior CSV',
    'cursor and ETag separation',
    'every Daily/API/CSV cell',
    'quiet feeds/participants unchanged',
    'journal boundary',
    'original paid holds',
    'genuine backup/restore',
    'later synthetic update',
    'guarded final UI',
  ];
} catch (e) {
  receipt.status = 'FAIL';
  receipt.failure = String(e.stack ?? e);
  throw e;
} finally {
  if (held) held.release();
  if (f) await f.close();
  if (reader) await reader.close();
  if (synthetic) await synthetic.close();
  if (real) await real.close();
  if (base) await base.close();
  receipt.closed = true;
  receipt.completedAt = new Date().toISOString();
  await save('INTEGRATION', receipt);
}
console.log(
  JSON.stringify({ status: receipt.status, cases: receipt.cases, closed: receipt.closed }),
);
