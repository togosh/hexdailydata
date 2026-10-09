import assert from 'node:assert/strict';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { join, dirname, basename } from 'node:path';
import {
  fresh,
  files,
  metadata,
  realRows,
  exceptions,
  update,
  publish,
  receipt,
  hash,
  root,
} from './helpers.mjs';
import {
  applyMarketUpdate,
  migrateMarketMetadata,
  validateMarketHistory,
} from '../../dist/services/product-daily/market.js';
import { productFiles } from '../../dist/services/product-daily/project.js';
import { ProductDailyStore } from '../../dist/services/product-daily/store.js';
import {
  backupStorage,
  restoreStorage,
  auditJournal,
} from '../../dist/services/product-daily/storage.js';
import { ProductQuery } from '../../dist/contracts/product-daily.js';
import { PageCursors } from '../../dist/services/queries/cursor.js';
import { publishCycle } from '../../scripts/market-refresh.mjs';
import { fixture, auth, keys, until, wire } from '../market-feed/access-fixture.mjs';
const realNow = Date.now;
Date.now = () => Date.parse('2026-11-01T00:00:00Z');
const started = performance.now();
// Virtual typed prior readings make a full real-history seed immediately below the
// active boundary. No provider or mock page; all 2,502 original daily rows stay present.
let base = { rows: realRows, metadata, exceptions };
for (let i = 0; i < 250; i++) base = applyMarketUpdate(base, update(i));
assert.equal(base.metadata.observations.length, 510);
const s = await fresh('full-application', productFiles(base));
const reader = new ProductDailyStore(s.root, metadata.pair);
await reader.load();
const old = reader.capture(),
  originalCSV = old.csv;
const f = await fixture({ productDaily: reader });
f.controls.now = Date.now();
let comparisons = 0,
  refreshCalls = 0;
const originalRefresh = reader.refresh.bind(reader);
reader.refresh = async (...args) => {
  refreshCalls++;
  return originalRefresh(...args);
};
const publications = [];
try {
  // Actual loopback listener is reused for each adoption.
  const wireBefore = await wire(f.app ?? f, '/api/v2/live');
  assert.equal(wireBefore.statusCode, 200);
  const listener = (f.app ?? f).server.address().port;
  const before = refreshCalls;
  for (const key of [keys.invalid, keys.revoked])
    assert.equal((await f.inject({ url: '/api/v2/live', headers: auth(key) })).statusCode, 401);
  assert.equal(refreshCalls, before);
  const cursor = new PageCursors(),
    q = ProductQuery.parse({ from: '2026-10-01', to: '2026-10-11', limit: '2' });
  const oldPage = reader.read(old, q, 'daily', cursor, Date.now(), 'public');
  const stream = reader.openExport(old, old.bundleId, 'daily', new AbortController().signal);
  assert.equal(stream.status, 'available');
  for (let cycle = 1; cycle <= 3; cycle++) {
    const output = join(dirname(s.root), 'cycle-' + cycle);
    await mkdir(output);
    const u = update(249 + cycle),
      raw = Buffer.from(JSON.stringify(u) + '\n');
    await writeFile(join(output, `ROUND_${cycle}_UPDATE.json`), raw, { flag: 'wx' });
    await writeFile(
      join(output, `ROUND_${cycle}_AUDIT.json`),
      JSON.stringify({
        status: 'PASS',
        capturePromotable: true,
        sealedRounds: cycle,
        synthetic: true,
      }) + '\n',
      { flag: 'wx' },
    );
    const lease = await s.acquireWriter();
    try {
      const result = await publishCycle(s, lease, output, {
        cycle,
        update: `ROUND_${cycle}_UPDATE.json`,
        updateSha256: hash(raw),
        pin: {
          number: 27748189 + cycle,
          hash: hash('synthetic pin ' + cycle),
          timestamp: Date.parse(u.readings[0].observedAtUtc) / 1000,
        },
        sealedAt: new Date(Date.now()).toISOString(),
        expiresAtUnixSeconds: Date.now() / 1000 + 29,
      });
      publications.push(result);
    } finally {
      await s.releaseWriter(lease);
    }
    // Deliberately skip one generation to exercise compact preservation on adoption.
    if (cycle !== 2) await originalRefresh(10000 + cycle * 2000);
    if (cycle !== 2) assert.equal(reader.capture().version, s.capture().version);
    assert.equal(s.capture().metadata.observations.length, cycle === 1 ? 512 : cycle === 2 ? 2 : 4);
  }
  const latest = reader.capture(),
    after = await wire(f.app ?? f, '/api/v2/live');
  assert.equal((f.app ?? f).server.address().port, listener);
  assert.equal(JSON.parse(after.body).datasetVersion, latest.version);
  assert.notEqual(wireBefore.headers.etag, after.headers.etag);
  assert.throws(() =>
    reader.read(
      latest,
      { ...q, cursor: oldPage.nextCursor },
      'daily',
      cursor,
      Date.now(),
      'public',
    ),
  );
  const heldChunks = [];
  for await (const b of stream.stream) heldChunks.push(b);
  assert.deepEqual(Buffer.concat(heldChunks), originalCSV);
  await stream.released;
  // Old directory has actually been collected; request-held bytes remain exact.
  await assert.rejects(readFile(join(s.root, old.version, 'MANIFEST.json')), /ENOENT/);
  for (let i = 0; i < realRows.length; i++)
    for (const [k, v] of Object.entries(realRows[i])) {
      assert.deepEqual(latest.rows[i][k], v);
      comparisons++;
    }
  assert.deepEqual(latest.metadata.liquidityHistory, metadata.liquidityHistory);
  assert.equal(latest.metadata.liquidityHistory.length, 90);
  const down = '/api/v2/downloads/' + latest.bundleId + '/daily';
  assert([401, 403].includes((await f.inject(down)).statusCode));
  const paid = await f.inject({ url: down, headers: auth() });
  assert.equal(paid.statusCode, 200);
  assert.equal(paid.body, latest.csv.toString());
  for (const url of [
    '/api/v2/live',
    '/api/v2/home',
    '/api/v2/daily?from=2026-10-01&to=2026-10-11',
    down,
  ]) {
    const g = await f.inject({ url, headers: auth() });
    assert.equal(g.statusCode, 200, g.body);
    const h = await f.inject({ url, method: 'HEAD', headers: auth() });
    assert.equal(h.statusCode, 200);
    assert.equal(h.body, '');
    assert.equal(h.headers.etag, g.headers.etag);
    const c = await f.inject({
      url,
      method: 'HEAD',
      headers: { ...auth(), 'if-none-match': g.headers.etag },
    });
    assert.equal(c.statusCode, 304);
    assert(
      [401, 403].includes(
        (
          await f.inject({
            url,
            method: 'HEAD',
            headers: { ...auth(keys.invalid), 'if-none-match': g.headers.etag },
          })
        ).statusCode,
      ),
    );
  }
  assert.equal(
    (await f.inject('/api/v2/daily?from=2026-10-01&to=2026-10-11&limit=101')).statusCode,
    400,
  );
  for (const url of [
    '/data/CURRENT.json',
    '/STORAGE.json',
    '/journal/00000000.ndjson',
    '/api/v2/storage',
    '/data/' + latest.version + '/daily.csv',
  ])
    assert.equal((await f.inject(url)).statusCode, 404);
  const priorCapture = reader.capture.bind(reader);
  reader.capture = () => {
    throw Error('SYNTHETIC_READ_FAILURE');
  };
  assert.equal((await f.inject({ url: '/api/v2/live', headers: auth() })).statusCode, 503);
  reader.capture = priorCapture;
  await until(() => f.events.some((e) => e.stage === 'finalize' && e.success === false));
  const time = Date.parse(latest.metadata.readings[0].observedAtUtc);
  assert.equal(reader.live(latest, time + 300000).freshness.HEX.status, 'fresh');
  assert.equal(reader.live(latest, time + 300001).freshness.HEX.status, 'stale');
  assert.deepEqual(
    (await f.inject('/api/v2/home')).json().live,
    (await f.inject('/api/v2/live')).json(),
  );
  const backup = await backupStorage(s.root, join(dirname(s.root), 'backup'));
  await receipt('BACKUP_' + basename(dirname(s.root)), backup);
  // Restore is run separately with an fs boundary denying the source runtime root.
  await receipt('APPLICATION_' + basename(dirname(s.root)), {
    status: 'PASS',
    synthetic: true,
    externalRequests: 0,
    root: s.root,
    listener,
    publications,
    realRowComparisons: comparisons,
    realRows: realRows.length,
    historicalBuckets: 90,
    heldCSVAfterCollection: true,
    skippedGenerationAdoption: true,
    backup,
    elapsedSeconds: (performance.now() - started) / 1000,
    checks: [
      'auth before refresh',
      'paid GET HEAD 304 and invalid key',
      'exact CSV',
      'public limit',
      'no static bypass',
      'failed read release',
      'unchanged 300 second freshness',
      'Home/Live agreement',
      'same running loopback listener',
      'full real seed at 512 then rotation',
    ],
  });
  console.log('PASS full application and backup', s.root);
} finally {
  await f.close();
  Date.now = realNow;
}
