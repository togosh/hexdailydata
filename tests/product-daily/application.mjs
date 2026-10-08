import assert from 'node:assert/strict';
import { readFile, writeFile, mkdtemp } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import net from 'node:net';
import { input, profile, pointer, root, receipt, json } from './inputs.mjs';
import { fixture, wire, until, keys, auth, cookie, charge } from './access-fixture.mjs';
import { openProductDependencies } from '../../dist/services/product-daily/open.js';
import {
  ProductDailyStore,
  writeProductGeneration,
} from '../../dist/services/product-daily/store.js';
import { projectDaily, productFiles } from '../../dist/services/product-daily/project.js';
import { preview } from './preview.mjs';
const result = {
  status: 'RUNNING',
  externalRequests: 0,
  originalCaptureScans: 0,
  readinessPasses: 0,
  checks: [],
  readersClosed: false,
};
const check = (name, detail = {}) => {
  result.checks.push({ name, ...detail });
  console.log('PASS ' + name);
};
let deps, f;
const started = performance.now();
try {
  deps = await openProductDependencies(profile);
  result.readinessPasses++;
  const g = deps.sourceGenerations,
    store = deps.productDaily,
    snapshot = store.capture();
  const bundle = await json(join(profile.overlayRoot, profile.pair.generation, 'BUNDLE.json'));
  const holder = bundle.changes.tokenHolders.find(
    (e) => e.kind === 'replacement' && !/^0x0+$/.test(e.after.holderAddress),
  );
  const changedStake = bundle.changes.stakeStarts.find(
      (e) => e.before && !e.before.stakeEnd && e.after.stakeEnd,
    ),
    newStake = bundle.changes.stakeStarts.find((e) => !e.before);
  f = await fixture(
    { ...deps, close: undefined },
    {
      webRoot: resolve('dist/web'),
      account: { webRoot: resolve('account/dist/ui'), register: async () => {} },
    },
  );
  const daily = '/api/v2/daily?from=2020-01-01&to=2020-01-31',
    lookups = [
      ['holders', '/api/v2/holders?limit=2'],
      ['stakes', '/api/v2/stakes?limit=2'],
      ['stake', '/api/v2/stakes/' + changedStake.after.stakeId],
      ['address', '/api/v2/addresses/' + holder.after.holderAddress + '?limit=2'],
      ['addressStakes', '/api/v2/addresses/' + holder.after.holderAddress + '/stakes?limit=2'],
    ];
  let captures = 0;
  const originalCapture = store.capture.bind(store);
  store.capture = () => {
    captures++;
    return originalCapture();
  };
  const before = g.metrics.requests;
  for (const key of [keys.invalid, keys.revoked])
    for (const url of [daily, '/api/v2/live', lookups[0][1]])
      assert.equal((await f.inject({ url, headers: auth(key) })).statusCode, 401);
  assert.equal(
    (
      await wire(f.app, daily, [
        ['Authorization', 'Bearer ' + keys.good],
        ['Authorization', 'Bearer ' + keys.good],
      ])
    ).statusCode,
    401,
  );
  assert.equal(captures, 0);
  assert.equal(g.metrics.requests, before);
  check('invalid/revoked/duplicate credentials rejected before product or indexed read');
  for (const url of [
    daily,
    '/api/v2/live',
    '/api/v2/home',
    '/api/v2/markets/daily?from=2020-01-01&to=2020-01-31',
    ...lookups.map((r) => r[1]),
  ]) {
    const headers = [['Authorization', 'Bearer ' + keys.good]],
      get = await wire(f.app, url, headers);
    assert.equal(get.statusCode, 200, get.body);
    assert(get.headers.etag);
    const head = await wire(f.app, url, headers, 'HEAD');
    assert.equal(head.statusCode, 200, head.body);
    assert.equal(head.body, '');
    assert.equal(head.headers.etag, get.headers.etag);
    const cached = await wire(
      f.app,
      url,
      [...headers, ['If-None-Match', get.headers.etag]],
      'HEAD',
    );
    assert.equal(cached.statusCode, 304);
    assert.equal(cached.body, '');
  }
  await until(() => f.events.filter((x) => x.stage === 'finalize').length === 27);
  assert(
    f.events
      .filter((x) => x.stage === 'finalize')
      .every(
        (x) =>
          x.success &&
          x.hold.periodId === 'original-period' &&
          x.hold.windowId === 'original-window',
      ),
  );
  check('nine normal routes real paid loopback GET/HEAD/304 settle original holds', {
    successes: 27,
  });
  const actualDaily = (await f.inject(daily)).json(),
    actualMarket = (await f.inject('/api/v2/markets/daily?from=2020-01-01&to=2020-01-31')).json(),
    actualHome = (await f.inject('/api/v2/home')).json(),
    actualLive = (await f.inject('/api/v2/live')).json();
  assert.deepEqual(
    actualDaily.items,
    snapshot.rows.filter((r) => r.dateUtc >= '2020-01-01' && r.dateUtc <= '2020-01-31'),
  );
  assert.deepEqual(actualMarket.items, actualDaily.items);
  assert.deepEqual(actualHome.daily, snapshot.rows.at(-1));
  assert.deepEqual(actualHome.live, actualLive);
  assert.equal(actualLive.hexPriceUsd, null);
  assert.equal(actualLive.freshness.savedState.status, 'stale');
  await receipt('API_EXAMPLES.json', {
    daily: { request: daily, response: actualDaily },
    live: { request: '/api/v2/live', response: actualLive },
    home: { request: '/api/v2/home', response: actualHome },
  });
  check('actual normal handlers use shared daily/home/live/market values');
  const oldRead = g.read.bind(g);
  g.read = async () => {
    throw Error('SYNTHETIC_READER_FAILURE');
  };
  assert.equal(
    (await wire(f.app, lookups[0][1], [['Authorization', 'Bearer ' + keys.good]])).statusCode,
    503,
  );
  g.read = oldRead;
  await until(() => f.events.filter((x) => x.stage === 'finalize').length === 28);
  assert.equal(f.events.filter((x) => x.stage === 'finalize').at(-1).success, false);
  let enter;
  const entered = new Promise((r) => (enter = r));
  g.read = async (_r, _q, _p, signal) => {
    enter();
    await new Promise((_ok, reject) =>
      signal.addEventListener('abort', () => reject(Error('SYNTHETIC_ABORT')), { once: true }),
    );
  };
  charge();
  const socket = net.createConnection({ host: '127.0.0.1', port: f.app.server.address().port });
  socket.on('error', () => {});
  socket.on('connect', () =>
    socket.write(
      'GET ' +
        lookups[0][1] +
        ' HTTP/1.1\r\nHost: 127.0.0.1\r\nAuthorization: Bearer ' +
        keys.good +
        '\r\nConnection: close\r\n\r\n',
    ),
  );
  await entered;
  socket.destroy();
  await until(() => f.events.filter((x) => x.stage === 'finalize').length === 29);
  g.read = oldRead;
  assert.equal(f.events.filter((x) => x.stage === 'finalize').at(-1).success, false);
  check('actual read failure and socket cancellation release original holds');
  let url = '/api/v2/holders?limit=1',
    firstCursor;
  for (let page = 1; page <= 6; page++) {
    const r = await f.inject(url);
    assert.equal(r.statusCode, page <= 5 ? 200 : 403, r.body);
    if (page <= 5) {
      if (page === 1) firstCursor = r.json().nextCursor;
      url = '/api/v2/holders?limit=1&cursor=' + encodeURIComponent(r.json().nextCursor);
    }
  }
  assert.equal((await f.inject('/api/v2/holders?limit=100')).statusCode, 403);
  assert.equal(
    (await f.inject('/api/v2/stakes?limit=1&cursor=' + encodeURIComponent(firstCursor))).statusCode,
    409,
  );
  for (const query of [
    'source=subgraph',
    'source=contract-ledger',
    'view=history',
    'series=anything',
    'generation=base',
    'datasetVersion=foo',
    'holderDatasetVersion=foo',
  ]) {
    const r = await f.inject(daily + '&' + query);
    assert.equal(r.statusCode, 400);
    assert.equal(r.json().error.code, 'selection_migrated');
  }
  for (const url of [
    '/api/v2/home?chain=ethereum',
    '/api/v2/live?chain=ethereum',
    '/api/v2/daily?from=2020-01-01&to=2021-01-01',
    '/api/v2/daily?from=2020-01-01&to=2020-01-02&limit=101',
  ])
    assert.equal((await f.inject(url)).statusCode, 400);
  const paged = await f.inject(daily + '&limit=2');
  assert(paged.json().nextCursor);
  for (const prefix of [
    '/api/v2/markets/daily?from=2020-01-01&to=2020-01-31&limit=2',
    daily + '&limit=2&metric=hexPriceUsd',
  ])
    assert.equal(
      (await f.inject(prefix + '&cursor=' + encodeURIComponent(paged.json().nextCursor)))
        .statusCode,
      409,
    );
  const headLive = await f.inject('/api/v2/live');
  f.controls.now += 1000;
  assert.notEqual((await f.inject('/api/v2/live')).headers.etag, headLive.headers.etag);
  check(
    'strict selector migration, chain/date bounds, cursor contexts, five-page/50-row browse and age-aware ETags',
  );
  const changed = (await f.inject('/api/v2/stakes/' + changedStake.after.stakeId)).json();
  assert.deepEqual(changed.item.reported, changedStake.after);
  const newOne = (await f.inject('/api/v2/stakes/' + newStake.after.stakeId)).json();
  assert.deepEqual(newOne.item.reported, newStake.after);
  const addr = (await f.inject('/api/v2/addresses/' + holder.after.holderAddress)).json();
  assert.equal(addr.holder.item.reported.tokenBalance, holder.after.tokenBalance);
  assert.equal(addr.holderDatasetVersion, profile.pair.holderDatasetVersion);
  const zero = (await f.inject('/api/v2/addresses/0x' + '0'.repeat(40))).json();
  assert.equal(zero.holder.state, 'source_anomaly');
  assert(zero.holder.item.reported.tokenBalance.startsWith('-'));
  const zeroHolder = await g.holders.rowAt(0, new AbortController().signal); // bounded index read, never a full scan
  check('exact changed/new stake, saved address balance and negative zero-address anomaly', {
    zeroRecordInspected: zeroHolder.reported.id,
  });
  const csv = '/api/v2/downloads/' + snapshot.bundleId + '/daily';
  const countBefore = captures;
  for (const method of ['GET', 'HEAD'])
    assert.equal((await f.inject({ url: csv, method })).statusCode, 403);
  assert.equal((await f.inject({ url: csv, headers: { 'if-none-match': '*' } })).statusCode, 403);
  assert.equal((await f.inject({ url: csv, headers: auth(keys.invalid) })).statusCode, 401);
  assert.equal(captures, countBefore);
  const exportGet = await f.inject({ url: csv, headers: cookie });
  assert.equal(exportGet.statusCode, 200);
  assert(Buffer.from(exportGet.body).equals(snapshot.csv));
  assert.equal(
    (await f.inject({ url: csv, headers: { ...cookie, ...auth(keys.invalid) } })).statusCode,
    401,
  );
  const paidCsv = await wire(f.app, csv, [['Authorization', 'Bearer ' + keys.good]], 'HEAD');
  assert.equal(paidCsv.statusCode, 200);
  assert.equal(paidCsv.headers['content-length'], String(snapshot.csv.length));
  assert.equal(
    (
      await wire(
        f.app,
        csv,
        [
          ['Authorization', 'Bearer ' + keys.good],
          ['If-None-Match', exportGet.headers.etag],
        ],
        'HEAD',
      )
    ).statusCode,
    304,
  );
  for (const path of [
    '/daily.csv',
    '/CURRENT.json',
    '/data/product/' + pointer.version + '/daily.ndjson',
    '/history-input/daily.ndjson',
    '/api/v2/charts/archive',
    '/api/v2/charts/native',
  ])
    assert.notEqual((await f.inject(path)).statusCode, 200);
  check(
    'shared full CSV byte equality, auth before capture/HEAD/304, invalid-key precedence and no static data',
  );
  assert.equal((await f.inject('/health/ready')).statusCode, 200);
  await f.close();
  f = null;
  store.capture = originalCapture;
  // Selected product changes never modify the read-only pair; hold one old product in flight.
  const local = await mkdtemp(join(root, 'scratch/api-publication-')),
    base = productFiles(projectDaily(input));
  await writeProductGeneration(local, base);
  const candidate = new ProductDailyStore(local, profile.pair);
  await candidate.select(pointer);
  const replacement = productFiles(
    projectDaily({
      ...input,
      readings: [
        {
          kind: 'market',
          asset: 'ETH',
          quote: 'USD',
          observation: 'spot',
          value: '1234.0000',
          observedAtUtc: '2026-10-08T00:01:00Z',
        },
      ],
    }),
  );
  await writeProductGeneration(local, replacement);
  f = await fixture({ productDaily: candidate, sourceGenerations: g });
  const beforePage = await f.inject(daily + '&limit=2');
  let enterPair, release;
  const reached = new Promise((r) => (enterPair = r)),
    gate = new Promise((r) => (release = r));
  g.read = async (...args) => {
    enterPair();
    await gate;
    return oldRead(...args);
  };
  const pending = f.inject('/api/v2/addresses/' + holder.after.holderAddress + '?limit=1');
  await reached;
  await candidate.select({
    version: replacement.version,
    manifestSha256: replacement.manifestSha256,
  });
  release();
  const coherent = await pending;
  g.read = oldRead;
  assert.equal(coherent.statusCode, 200);
  assert.equal(coherent.json().holderDatasetVersion, profile.pair.holderDatasetVersion);
  assert.equal(
    (await f.inject(daily + '&limit=2&cursor=' + encodeURIComponent(beforePage.json().nextCursor)))
      .statusCode,
    409,
  );
  assert.notEqual((await f.inject(daily + '&limit=2')).headers.etag, beforePage.headers.etag);
  await candidate.select(pointer, { rollback: true });
  assert.equal(candidate.capture().version, pointer.version);
  await f.close();
  f = null;
  check(
    'candidate-only replacement/rollback with request-held product/pair and dataset-separated API cursors/ETags',
  );
  result.preview = await preview(deps, bundle);
  result.status = 'PASS';
} catch (error) {
  result.status = 'FAIL';
  result.error = error.stack;
  process.exitCode = 1;
} finally {
  if (f) await f.close();
  if (deps) {
    result.readerMetrics = deps.sourceGenerations.metrics;
    await deps.close();
    result.readersClosed = true;
  }
  result.elapsedSeconds = (performance.now() - started) / 1000;
  await receipt('APPLICATION.json', result);
  console.log(JSON.stringify(result));
}
