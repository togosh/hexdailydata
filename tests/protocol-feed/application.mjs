import assert from 'node:assert/strict';
import { readFile, mkdir, writeFile } from 'node:fs/promises';
import { dirname, join, basename } from 'node:path';
import {
  fresh,
  metadata,
  realRows,
  root,
  receipt,
  hash,
  exceptions,
  syntheticProtocol,
} from './helpers.mjs';
import { ProductDailyStore } from '../../dist/services/product-daily/store.js';
import { publishStoredMarket, auditJournal } from '../../dist/services/product-daily/storage.js';
import { applyMarketUpdate } from '../../dist/services/product-daily/market.js';
import { productFiles } from '../../dist/services/product-daily/project.js';
import { publishProtocol } from '../../scripts/protocol-publication.mjs';
import { fixture, auth, keys, until, wire } from '../market-feed/access-fixture.mjs';
import { ProductQuery } from '../../dist/contracts/product-daily.js';
import { PageCursors } from '../../dist/services/queries/cursor.js';
const s = await fresh('protocol-application');
const reader = new ProductDailyStore(s.root, metadata.pair);
await reader.load();
const f = await fixture({ productDaily: reader });
f.controls.now = Date.now();
const old = reader.capture(),
  beforeLive = reader.live(old, Date.now()),
  held = reader.openExport(old, old.bundleId, 'daily', new AbortController().signal);
const cursors = new PageCursors(),
  query = ProductQuery.parse({ from: '2026-10-01', to: '2026-10-08', limit: '1' });
const oldPage = reader.read(old, query, 'daily', cursors, Date.now(), 'public');
assert(oldPage.nextCursor);
const evidence = syntheticProtocol;
let refreshCalls = 0;
const refresh = reader.refresh.bind(reader);
reader.refresh = async (...args) => {
  refreshCalls++;
  return refresh(...args);
};
const publications = [];
try {
  const first = await wire(f.app ?? f, '/api/v2/live');
  const port = (f.app ?? f).server.address().port;
  const calls = refreshCalls;
  for (const key of [keys.invalid, keys.revoked])
    assert.equal((await f.inject({ url: '/api/v2/live', headers: auth(key) })).statusCode, 401);
  assert.equal(refreshCalls, calls);
  for (let c = 1; c <= 3; c++) {
    const raw = await readFile(join(evidence.root, `ROUND_${c}_UPDATE.json`)),
      audit = await readFile(join(evidence.root, `ROUND_${c}_AUDIT.json`));
    const lease = await s.acquireWriter();
    let published;
    try {
      published = await publishProtocol(s, lease, evidence.root, {
        cycle: c,
        update: `ROUND_${c}_UPDATE.json`,
        updateSha256: hash(raw),
        auditSha256: hash(audit),
        pin: JSON.parse(audit).details.context,
        expiresAtUnixSeconds: Date.now() / 1000 + 29,
      });
    } finally {
      await s.releaseWriter(lease);
    }
    await reader.refresh(performance.now() + c * 2000);
    f.controls.now = Date.now();
    const live = (await f.inject('/api/v2/live')).json();
    assert.equal(live.datasetVersion, published.selected.version);
    for (const [key, value] of Object.entries(beforeLive.freshness))
      if (!['protocol', 'payout'].includes(key))
        assert.equal(live.freshness[key].observedAtUtc, value.observedAtUtc);
    publications.push(published);
  }
  const latest = reader.capture(),
    after = await wire(f.app ?? f, '/api/v2/live');
  const homeRange = (await f.inject('/api/v2/home')).json();
  assert.equal(homeRange.dailyThroughDateUtc, latest.metadata.through);
  assert(homeRange.dailyThroughDateUtc >= homeRange.live.latestMaterializedPayout.dateUtc);
  assert.equal((f.app ?? f).server.address().port, port);
  assert.notEqual(first.headers.etag, after.headers.etag);
  assert.throws(() =>
    reader.read(
      latest,
      { ...query, cursor: oldPage.nextCursor },
      'daily',
      cursors,
      Date.now(),
      'public',
    ),
  );
  assert.deepEqual(latest.metadata.pair, metadata.pair);
  assert.deepEqual(latest.metadata.liquidityHistory, metadata.liquidityHistory);
  assert.deepEqual(
    latest.metadata.readings.filter((r) => r.kind !== 'protocol'),
    metadata.readings,
  );
  let comparisons = 0;
  for (const row of realRows) {
    const got = latest.rows.find((r) => r.dateUtc === row.dateUtc);
    assert(got);
    for (const [k, v] of Object.entries(row)) {
      if (
        row.contractDay >= 2498 &&
        row.contractDay < 2500 &&
        ['payoutHearts', 'payoutStakeShares', 'dailyPayoutHEX', 'payoutPerTshareHEX'].includes(k)
      )
        continue;
      assert.deepEqual(got[k], v);
      comparisons++;
    }
  }
  const chunks = [];
  for await (const b of held.stream) chunks.push(b);
  await held.released;
  assert.deepEqual(Buffer.concat(chunks), old.csv);
  const abort = new AbortController();
  const cancelled = reader.openExport(latest, latest.bundleId, 'daily', abort.signal);
  abort.abort();
  cancelled.stream.on('error', () => {});
  await cancelled.released;
  const down = '/api/v2/downloads/' + latest.bundleId + '/daily';
  assert([401, 403].includes((await f.inject(down)).statusCode));
  assert.equal((await f.inject({ url: down, headers: auth() })).body, latest.csv.toString());
  for (const url of [
    '/api/v2/live',
    '/api/v2/home',
    '/api/v2/daily?from=2026-10-01&to=2026-10-20',
    down,
  ]) {
    const g = await f.inject({ url, headers: auth() });
    assert.equal(g.statusCode, 200);
    const h = await f.inject({ url, method: 'HEAD', headers: auth() });
    assert.equal(h.statusCode, 200);
    assert.equal(h.body, '');
    assert.equal(h.headers.etag, g.headers.etag);
    assert.equal(
      (
        await f.inject({
          url,
          method: 'HEAD',
          headers: { ...auth(), 'if-none-match': g.headers.etag },
        })
      ).statusCode,
      304,
    );
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
    (await f.inject('/api/v2/daily?from=2026-10-01&to=2026-10-20&limit=101')).statusCode,
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
  const capture = reader.capture.bind(reader);
  reader.capture = () => {
    throw Error('SYNTHETIC_READ_FAILURE');
  };
  assert.equal((await f.inject({ url: '/api/v2/live', headers: auth() })).statusCode, 503);
  reader.capture = capture;
  await until(() => f.events.some((e) => e.stage === 'finalize' && e.success === false));
  const protocol = latest.metadata.readings.find((r) => r.kind === 'protocol'),
    at = Date.parse(protocol.observedAtUtc);
  assert.equal(reader.live(latest, at + 300000).freshness.protocol.status, 'fresh');
  assert.equal(reader.live(latest, at + 300001).freshness.protocol.status, 'stale');
  assert.deepEqual(
    (await f.inject('/api/v2/home')).json().live,
    (await f.inject('/api/v2/live')).json(),
  );
  const originalUpdate = JSON.parse(await readFile(join(evidence.root, 'ROUND_3_UPDATE.json')));
  const finalPointer = await readFile(join(s.root, 'CURRENT.json'));
  const testLease = await s.acquireWriter();
  try {
    assert.equal((await publishStoredMarket(s, testLease, originalUpdate)).changed, false);
    const conflict = structuredClone(originalUpdate);
    conflict.readings[0].globalWords[1] = '9999999';
    await assert.rejects(
      publishStoredMarket(s, testLease, conflict),
      /PROTOCOL_PIN_REGRESSION|SAME_TIME_MARKET_CONFLICT/,
    );
    const older = structuredClone(originalUpdate);
    older.readings[0].blockNumber -= 1;
    await assert.rejects(publishStoredMarket(s, testLease, older), /PROTOCOL_PIN_REGRESSION/);
  } finally {
    await s.releaseWriter(testLease);
  }
  assert.deepEqual(await readFile(join(s.root, 'CURRENT.json')), finalPointer);
  await receipt('APPLICATION_' + basename(dirname(s.root)), {
    status: 'PASS',
    synthetic: true,
    externalRequests: 0,
    root: s.root,
    listener: port,
    publications,
    realRows: realRows.length,
    realRowComparisons: comparisons,
    historicalBuckets: 90,
    accountSeams: 'synthetic; no SQL/payments',
    checks: [
      'same-server adoption',
      'auth before refresh',
      'GET HEAD 304 holds',
      'exact CSV',
      'held CSV',
      'cancelled export release and version-bound cursor/ETag',
      'duplicate idempotence; conflicting/older update preservation',
      'public cap/static isolation',
      'failed read release',
      'independent 300-second freshness',
      'original unrelated values/times',
    ],
  });
  console.log('PASS full saved protocol application and access controls');
} finally {
  await f.close();
}
