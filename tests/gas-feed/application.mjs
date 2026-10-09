import assert from 'node:assert/strict';
import { readFile, mkdir, writeFile } from 'node:fs/promises';
import { dirname, join, basename } from 'node:path';
import {
  fresh,
  files,
  metadata,
  realRows,
  root,
  receipt,
  hash,
  exceptions,
  syntheticGas,
} from './helpers.mjs';
import { ProductDailyStore } from '../../dist/services/product-daily/store.js';
import { publishStoredMarket, auditJournal } from '../../dist/services/product-daily/storage.js';
import { applyMarketUpdate } from '../../dist/services/product-daily/market.js';
import { productFiles } from '../../dist/services/product-daily/project.js';
import { publishGas } from '../../scripts/gas-publication.mjs';
import { fixture, auth, keys, until, wire } from '../market-feed/access-fixture.mjs';
import { ProductQuery } from '../../dist/contracts/product-daily.js';
import { PageCursors } from '../../dist/services/queries/cursor.js';
const s = await fresh('gas-application');
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
const evidence = syntheticGas;
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
      published = await publishGas(s, lease, evidence.root, {
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
      if (key !== 'gas') assert.equal(live.freshness[key].observedAtUtc, value.observedAtUtc);
    publications.push(published);
  }
  const latest = reader.capture(),
    after = await wire(f.app ?? f, '/api/v2/live');
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
    latest.metadata.readings.filter((r) => r.kind !== 'gas'),
    metadata.readings,
  );
  const gasDates = new Set(publications.map((p) => p.observedAtUtc.slice(0, 10)));
  let comparisons = 0;
  for (const row of realRows) {
    const got = latest.rows.find((r) => r.dateUtc === row.dateUtc);
    assert(got);
    for (const [k, v] of Object.entries(row)) {
      if (
        gasDates.has(row.dateUtc) &&
        ['gasPriceWei', 'baseFeeWei', 'priorityFeeWei', 'gasRecordedAtUtc'].includes(k)
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
  const gas = latest.metadata.readings.find((r) => r.kind === 'gas'),
    at = Date.parse(gas.observedAtUtc);
  assert.equal(reader.live(latest, at + 300000).freshness.gas.status, 'fresh');
  assert.equal(reader.live(latest, at + 300001).freshness.gas.status, 'stale');
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
    conflict.readings[0].gasPriceWei = '9999999';
    await assert.rejects(publishStoredMarket(s, testLease, conflict), /SAME_TIME_MARKET_CONFLICT/);
    const older = structuredClone(originalUpdate);
    older.readings[0].observedAtUtc = '2026-10-01T00:00:00Z';
    await assert.rejects(publishStoredMarket(s, testLease, older), /OLDER_MARKET_OBSERVATION/);
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
  console.log('PASS full saved gas application and access controls');
} finally {
  await f.close();
}

// Small actual publication boundary with independently quiet market and BTC keys.
const actual = Date.now;
Date.now = () => Date.parse('2026-11-01T00:00:00Z');
try {
  let base = { rows: realRows, metadata, exceptions };
  const start = Date.parse('2026-10-10T00:00:00Z');
  for (let i = 0; i < 501; i++)
    base = applyMarketUpdate(base, {
      readings: [
        {
          kind: 'gas',
          chainId: 369,
          unit: 'wei/gas',
          gasPriceWei: String(100 + i),
          baseFeeWei: null,
          priorityFeeWei: i % 2 ? '0' : null,
          observedAtUtc: new Date(start + i * 1000).toISOString(),
        },
      ],
      liquidityHistory: [],
      receiptSha256: hash('rotation' + i),
    });
  assert.equal(base.metadata.observations.length, 511);
  const rotation = await fresh('gas-rotation', productFiles(base)),
    quiet = rotation.capture().metadata.readings.filter((r) => r.kind !== 'gas');
  for (const u of [
    {
      kind: 'market',
      asset: 'BTC',
      quote: 'USD',
      observation: 'spot',
      value: '123.0001',
      observedAtUtc: new Date(start + 600000).toISOString(),
    },
    {
      kind: 'gas',
      chainId: 369,
      unit: 'wei/gas',
      gasPriceWei: '999',
      baseFeeWei: '0',
      priorityFeeWei: null,
      observedAtUtc: new Date(start + 601000).toISOString(),
    },
  ]) {
    const lease = await rotation.acquireWriter();
    try {
      await publishStoredMarket(rotation, lease, {
        readings: [u],
        liquidityHistory: [],
        receiptSha256: hash(JSON.stringify(u)),
      });
    } finally {
      await rotation.releaseWriter(lease);
    }
  }
  assert.equal(rotation.capture().metadata.observations.length, 1);
  for (const r of quiet)
    assert.deepEqual(
      rotation
        .capture()
        .metadata.readings.find(
          (p) => p.kind === r.kind && (r.kind !== 'market' || p.asset === r.asset),
        ),
      r,
    );
  assert.equal(
    rotation.capture().metadata.readings.find((r) => r.kind === 'market' && r.asset === 'BTC')
      .value,
    '123.0001',
  );
  assert.equal(
    rotation.capture().metadata.readings.find((r) => r.kind === 'gas').priorityFeeWei,
    null,
  );
  const restarted = new ProductDailyStore(rotation.root, metadata.pair);
  await restarted.load();
  assert.equal(restarted.capture().version, rotation.capture().version);
  await receipt('ROTATION_' + basename(dirname(rotation.root)), {
    status: 'PASS',
    synthetic: true,
    externalRequests: 0,
    active: 1,
    checkpoints: rotation.capture().metadata.marketStorage.checkpoints.length,
    journal: await auditJournal(rotation.root),
  });
  console.log('PASS small 511/512 rotation and quiet-key restart');
} finally {
  Date.now = actual;
}
