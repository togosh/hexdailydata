// One normal readiness admission, focused actual handlers/access, then the single preview.
import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { openProductDependencies } from '../../dist/services/product-daily/open.js';
import {
  ProductLiveResponseSchema,
  ProductHomeResponseSchema,
  ProductDailyResponseSchema,
} from '../../dist/contracts/product-daily.js';
import { fixture, wire, until, keys, auth, cookie, root } from '../market-feed/access-fixture.mjs';
import { preview } from '../market-feed/preview.mjs';
const profile = JSON.parse(await readFile(join(root, 'PRODUCT_PROFILE.json')));
const out = {
  status: 'RUNNING',
  readinessPasses: 0,
  externalRequests: 0,
  checks: [],
  syntheticSeams: ['account identity', 'meter database', 'paid entitlement'],
  originalCaptureScans: 0,
};
let deps, f;
try {
  deps = await openProductDependencies(profile);
  out.readinessPasses++;
  const store = deps.productDaily,
    snapshot = store.capture();
  f = await fixture(
    { ...deps, close: undefined },
    {
      webRoot: resolve('dist/web'),
      account: { webRoot: resolve('account/dist/ui'), register: async () => {} },
    },
  );
  // Actual wall clock is retained for freshness. The fixture's paid period remains synthetic.
  f.controls.now = Date.now();
  const end = snapshot.metadata.through,
    from = new Date(Date.parse(end) - 89 * 86400000).toISOString().slice(0, 10);
  const daily = '/api/v2/daily?from=' + from + '&to=' + end + '&metric=trackedLiquidityUsd';
  const routes = [daily, '/api/v2/live', '/api/v2/home'];
  const originalCapture = store.capture.bind(store);
  let captures = 0;
  store.capture = () => {
    captures++;
    return originalCapture();
  };
  for (const url of routes) {
    const before = captures;
    for (const key of [keys.invalid, keys.revoked])
      assert.equal((await f.inject({ url, headers: auth(key) })).statusCode, 401);
    for (const fields of [
      [
        ['Authorization', 'Bearer ' + keys.good],
        ['authorization', 'Bearer ' + keys.good],
      ],
      [
        ['Authorization', 'Bearer ' + keys.good],
        ['Authorization', 'Bearer ' + keys.revoked],
      ],
    ]) {
      const response = await wire(f.app, url, fields);
      assert([400, 401].includes(response.statusCode), response.body);
    }
    assert.equal(captures, before, 'invalid/revoked/duplicate credentials before reader');
  }
  out.checks.push('actual invalid/revoked/duplicate credentials rejected before reads');
  for (const url of routes) {
    for (const key of [keys.invalid, keys.revoked])
      assert.equal((await f.inject({ url, headers: auth(key) })).statusCode, 401);
    const headers = [['Authorization', 'Bearer ' + keys.good]],
      get = await wire(f.app, url, headers);
    assert.equal(get.statusCode, 200, get.body);
    const head = await wire(f.app, url, headers, 'HEAD');
    assert.equal(head.statusCode, 200);
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
  await until(() => f.events.filter((e) => e.stage === 'finalize').length === 9);
  assert(f.events.filter((e) => e.stage === 'finalize').every((e) => e.success));
  out.checks.push('three affected normal routes paid GET/HEAD/304 original holds');
  const live = ProductLiveResponseSchema.parse((await f.inject('/api/v2/live')).json());
  const home = ProductHomeResponseSchema.parse((await f.inject('/api/v2/home')).json());
  const page = ProductDailyResponseSchema.parse((await f.inject(daily)).json());
  assert.deepEqual(home.live, live);
  assert.equal(live.hexPriceUsd, store.live(snapshot, f.controls.now).hexPriceUsd);
  assert.deepEqual(
    page.items,
    snapshot.rows.filter((r) => r.dateUtc >= from && r.dateUtc <= end),
  );
  assert.deepEqual(
    home.liquidityHistory,
    page.items.map((r) => ({ dateUtc: r.dateUtc, value: r.trackedLiquidityUsd })),
  );
  assert.equal(live.freshness.savedState.status, 'stale');
  assert.equal(live.btcPriceUsd, null);
  assert.equal(live.gasPriceWei, null);
  for (const q of ['source=pulsex', 'view=history', 'series=liquidity', 'generation=base'])
    assert.equal((await f.inject(daily + '&' + q)).statusCode, 400);
  assert.equal((await f.inject('/api/v2/holders?limit=100')).statusCode, 403);
  assert.equal((await f.inject('/api/v2/stakes?limit=2')).statusCode, 200);
  assert.equal((await f.inject('/api/v2/holders?limit=2')).statusCode, 200);
  out.checks.push(
    'normal API/Home/Daily identity and exact values; saved pair limits; no selection choices',
  );
  const download = '/api/v2/downloads/' + snapshot.bundleId + '/daily';
  const unauth = await f.inject(download);
  assert([401, 403].includes(unauth.statusCode), unauth.body);
  const paid = await f.inject({ url: download, headers: auth() });
  assert.equal(paid.statusCode, 200, paid.body);
  assert.equal(paid.body, snapshot.csv.toString());
  const session = await f.inject({ url: download, headers: cookie });
  assert.equal(session.statusCode, 200, session.body);
  assert.equal(session.body, paid.body);
  const cached = await f.inject({ url: download, headers: { 'if-none-match': paid.headers.etag } });
  assert([401, 403].includes(cached.statusCode));
  for (const url of [
    '/data/product/CURRENT.json',
    '/data/product/' + snapshot.version + '/daily.csv',
    '/ACCOUNTING.json',
  ])
    assert.equal((await f.inject(url)).statusCode, 404);
  out.checks.push(
    'complete CSV remains authenticated before cache handling; identical selected bytes; no static bulk exposure',
  );
  await writeFile(
    join(root, 'evidence/API_EXAMPLES.json'),
    JSON.stringify(
      {
        daily: { request: daily, response: page },
        home: { request: '/api/v2/home', response: home },
        live: { request: '/api/v2/live', response: live },
      },
      null,
      2,
    ) + '\n',
    { flag: 'wx' },
  );
  const originalLive = store.live.bind(store);
  const oldFinalizes = f.events.filter((e) => e.stage === 'finalize').length;
  store.live = () => {
    throw Error('SYNTHETIC_READ_FAILURE');
  };
  assert.equal((await f.inject({ url: '/api/v2/live', headers: auth() })).statusCode, 503);
  await until(() => f.events.filter((e) => e.stage === 'finalize').length === oldFinalizes + 1);
  const released = f.events.filter((e) => e.stage === 'finalize').at(-1);
  assert.equal(released.success, false);
  assert.equal(released.hold.periodId, 'original-period');
  store.live = originalLive;
  out.checks.push('synthetic read failure releases actual original paid hold');
  const publication = JSON.parse(await readFile(join(root, 'evidence/PUBLICATION.json')));
  if (publication.generations.length) {
    const selected = publication.selected,
      prior = publication.generations.at(-2) ?? publication.base;
    const newer = await f.inject('/api/v2/live');
    await store.select(prior, { rollback: true });
    const older = await f.inject({
      url: '/api/v2/live',
      headers: { 'if-none-match': newer.headers.etag },
    });
    assert.equal(older.statusCode, 200);
    assert.notEqual(older.headers.etag, newer.headers.etag);
    await store.select(selected);
    assert.equal((await f.inject('/api/v2/live')).headers.etag, newer.headers.etag);
    out.checks.push('actual API generation ETag separation and candidate rollback restoration');
  }
  store.capture = originalCapture;
  await f.close();
  f = null;
  await preview(deps);
  out.status = 'PASS';
} catch (e) {
  out.status = 'FAIL';
  out.error = e.stack;
  throw e;
} finally {
  if (f) await f.close();
  if (deps) await deps.close();
  out.readersClosed = Boolean(deps);
  await writeFile(join(root, 'evidence/APPLICATION.json'), JSON.stringify(out, null, 2) + '\n', {
    flag: 'wx',
  });
}
console.log(JSON.stringify(out));
