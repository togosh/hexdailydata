// Last-good genuine product only. No participant base admission/public session.
import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { ProductDailyStore } from '../../dist/services/product-daily/store.js';
import { sha } from '../../dist/services/source-update/generation.js';
import { fixture, auth } from '../market-feed/access-fixture.mjs';
import { guard, listening, measuredWire } from './budget.mjs';
import { previews } from './final.mjs';
const R = process.env.HDD_TASK_ROOT;
assert(R?.endsWith('btc-eth-current-reference-freshness-r2'));
const inputs = JSON.parse(await readFile(join(R, 'packet/INPUTS.json')));
const store = new ProductDailyStore(join(R, 'runtime/product'), inputs.acceptedSeedProfile.pair);
await store.load();
const seed = store.capture();
assert.equal(seed.version, inputs.preserveAcceptedInputsAndExistingCells.closeProduct);
assert.equal(sha(seed.csv), inputs.preserveAcceptedInputsAndExistingCells.closeCsvSha256);
const save = (n, v) =>
  writeFile(join(R, 'evidence', n + '.json'), JSON.stringify(v, null, 2) + '\n');
const f = guard(
  await fixture(
    { productDaily: store },
    {
      webRoot: resolve('dist/web'),
      account: { webRoot: resolve('account/dist/ui'), register: async () => {} },
    },
  ),
);
try {
  f.controls.now = Date.now();
  const origin = await f.app.listen({ host: '127.0.0.1', port: 0 });
  listening(f);
  const responses = {};
  for (const path of [
    '/api/v2/live',
    '/api/v2/home',
    '/api/v2/daily?from=2026-10-01&to=2026-10-09&metric=btcPriceUsd',
  ]) {
    const r = await measuredWire(f, path);
    assert.equal(r.statusCode, 200);
    responses[path] = JSON.parse(r.body);
  }
  assert.equal(responses['/api/v2/live'].freshness.BTC.status, 'stale');
  assert.equal(responses['/api/v2/live'].freshness.ETH.status, 'stale');
  const path = '/api/v2/downloads/' + seed.bundleId + '/daily';
  assert([401, 403].includes((await f.inject(path)).statusCode));
  const csv = await f.inject({ url: path, headers: auth() });
  assert.equal(csv.statusCode, 200);
  assert.equal(sha(csv.body), sha(seed.csv));
  for (const method of ['HEAD', 'GET'])
    assert.equal(
      (
        await f.inject({
          url: path,
          method,
          headers: { ...auth(), 'if-none-match': csv.headers.etag },
        })
      ).statusCode,
      304,
    );
  await save('LAST_GOOD_API_CSV', {
    status: 'PASS',
    scope:
      'Unchanged genuine close seed; product-only local API, no new trades or genuine paired adoption',
    responses,
    csvSha256: sha(seed.csv),
    unauthenticatedRefusal: true,
    head304: true,
  });
  await previews({ R, origin, save, f });
  await writeFile(join(R, 'SELECTED_PROFILE.json'), await readFile(join(R, 'PROFILE.json')), {
    flag: 'wx',
  });
} finally {
  await f.close();
  await save('PARTIAL_PREVIEW_CLOSURE', {
    closed: true,
    closedAt: new Date().toISOString(),
    baseAdmissions: 0,
    publicRequests: 0,
  });
}
