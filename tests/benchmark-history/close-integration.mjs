// Focused corrected run over the once-restored genuine seed; failures use new derived roots.
import assert from 'node:assert/strict';
import { readFile, writeFile, stat } from 'node:fs/promises';
import { readFileSync, existsSync } from 'node:fs';
import { restoreParticipants } from '../../scripts/participant-refresh-backup.mjs';
import { guardFixture, measuredWire } from './close-budget.mjs';
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
import { finalize } from './close-final.mjs';
const R = process.env.HDD_TASK_ROOT;
assert(R?.endsWith('btc-eth-daily-close-integration-r1'));
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
const update = JSON.parse(await readFile(join(R, 'data/HISTORY_UPDATE.json')));
const profile = JSON.parse(await readFile(join(R, 'inputs/hds/SELECTED_PROFILE.json')));
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
  const initialized = await restoreParticipants(
    join(R, 'seed-backup'),
    join(R, 'runtime'),
    'aebc9c6c828159d36f179064efab96cf2b9e2b2bf1b4e91d36e940eac9e8879d',
    base,
  );
  real = initialized.registry;
  await save('SEED_RESTORE', initialized.receipt);
  const seed = snap(real);
  assert.equal(sha(seed.csv), '0743443360d9d542dbf188ab1a76ec46e09812505d6f4daa549765e391196fb9');
  await save('ADMITTED_SEED', {
    version: seed.version,
    manifestSha256: seed.manifestSha256,
    readings: seed.metadata.readings,
    pair: seed.metadata.pair,
    rows: seed.rows.length,
    csvSha256: sha(seed.csv),
  });
  reader = await ParticipantRegistry.open(real.root, real.productDaily.root, base);
  f = await fixture(
    { participants: reader, productDaily: reader.productDaily, sourceGenerations: base },
    {
      webRoot: resolve('dist/web'),
      account: { webRoot: resolve('account/dist/ui'), register: async () => {} },
    },
  );
  guardFixture(f, 900);
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
  const beforeWire = await measuredWire(f.app, '/api/v2/daily?from=2019-12-03&to=2019-12-10');
  const sizes = { updateBytes: Buffer.byteLength(stable(update)), pendingBytes: 0, intentBytes: 0 };
  // Fail after the certified product commit but before paired selection. The same
  // owner's exact saved intent is recovered, never reset or manually selected.
  await assert.rejects(
    real.publishProduct(update, {
      beforeCommit: () => {
        const path = join(real.productDaily.root, 'PENDING.json');
        if (existsSync(path))
          sizes.pendingBytes = Math.max(sizes.pendingBytes, readFileSync(path).length);
      },
      fault: async (stage) => {
        if (stage === 'after-product') {
          const raw = await readFile(join(real.root, 'INTENT.json'));
          sizes.intentBytes = raw.length;
          await writeFile(join(R, 'evidence/OWNED_FAILURE_INTENT.json'), raw, { flag: 'wx' });
          throw Error('SYNTHETIC_AFTER_PRODUCT_COMMIT');
        }
      },
    }),
    /SYNTHETIC_AFTER_PRODUCT_COMMIT/,
  );
  await new Promise((r) => setTimeout(r, 1100));
  assert.equal((await f.inject('/api/v2/live')).json().datasetVersion, seed.version);
  const recovery = await real.recoverOwnedFailure();
  await real.refresh(undefined, true);
  const journal = await auditJournal(real.productDaily.root);
  const inspection = await inspectStorage(real.productDaily.root);
  assert.equal(inspection.status, 'READABLE');
  const storage = JSON.parse(await readFile(join(real.productDaily.root, 'STORAGE.json')));
  assert.equal(storage.rollback.version, seed.version);
  const rollback = await admitProduct(
    join(real.productDaily.root, storage.rollback.version),
    storage.rollback.manifestSha256,
  );
  assert.equal(sha(rollback.csv), sha(seed.csv));
  assert(sizes.intentBytes < 1048576 + 65536 && sizes.pendingBytes < 1048576 + 131072);
  assert(storage.segmentBytes < 2 * 1048576);
  await save('OWNED_FAILURE_RECOVERY', {
    status: 'PASS',
    failure: 'SYNTHETIC_AFTER_PRODUCT_COMMIT',
    oldApiHeldUntilPairedRecovery: true,
    recovery,
    sizes,
    journal,
    inspection,
    activeSegmentBytes: storage.segmentBytes,
    rollback: storage.rollback,
    rollbackCsvSha256: sha(rollback.csv),
  });
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
    assert.notEqual(r[field], b.value);
    r[field] = b.value;
    assert.equal(r[b.asset === 'BTC' ? 'btcRecordedAtUtc' : 'ethRecordedAtUtc'], null);
  }
  assert.deepEqual(selected.rows, expected);
  assert.equal((await publish(real, update)).changed, false);
  assert.equal(snap(real).version, selected.version);
  const conflicting = structuredClone(update);
  conflicting.benchmarkHistory.buckets[0].value = '9999';
  await invalid(real, conflicting, /IDENTITY/);
  const nextWire = await measuredWire(f.app, '/api/v2/daily?from=2019-12-03&to=2019-12-10');
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
    historyBuckets: 5004,
    apiRows: apiRows.length,
    heldCsvSha256: sha(seed.csv),
    selectedCsvSha256: sha(selected.csv),
    beforeLive,
    afterLive,
    participantsUnchanged: participantPaths,
    sameApiProcess: true,
    normalRequestAdoption: true,
  });
  let replacements = 0,
    fills = 0,
    unchanged = 0;
  for (let i = 0; i < seed.rows.length; i++)
    for (const key of columns) {
      const old = seed.rows[i][key],
        fresh = selected.rows[i][key];
      if (old === fresh) unchanged++;
      else {
        assert(['btcPriceUsd', 'ethPriceUsd'].includes(key));
        if (old === null) fills++;
        else replacements++;
      }
    }
  assert.deepEqual(
    { replacements, fills, unchanged },
    { replacements: 4269, fills: 735, unchanged: 112637 },
  );
  await save('CELL_PRESERVATION', {
    status: 'PASS',
    replacements,
    fills,
    unchanged,
    totalCells: 117641,
    historicalQuoteTimes: null,
    witnesses: selected.rows.filter((r) =>
      ['2019-12-03', '2024-03-27', '2024-08-16', '2024-09-01', '2026-10-08', '2026-10-09'].includes(
        r.dateUtc,
      ),
    ),
    allOtherFieldsAndTimesExact: true,
    oldConflictsResolved: false,
  });
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
        for (const b of before.metadata.benchmarkHistory.buckets)
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
          historyBuckets: 5004,
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
    'exact owned failure recovery and journal bounds',
    'original protected export guards',
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
