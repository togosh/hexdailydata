// Reuse the existing synthetic account/meter seam; production entry stays authorizer-free.
import './deny-network.mjs';
import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { syntheticBase, now } from './fixture.mjs';
import { ParticipantRegistry } from '../../dist/services/source-update/refresh.js';
import { fixture, wire, keys, until } from '../market-feed/access-fixture.mjs';
const T = process.env.HDD_TASK_ROOT;
const result = JSON.parse(
  await readFile(join(T, 'evidence/CHECK-actual-entry-static-refusal-corrected.json'), 'utf8'),
).stdout;
const root = JSON.parse(result).root;
const base = syntheticBase(root);
const registry = await ParticipantRegistry.open(
  join(root, 'participants'),
  join(root, 'product'),
  base,
);
const f = await fixture(
  {
    participants: registry,
    productDaily: registry.productDaily,
    sourceGenerations: base,
    close: async () => {
      await registry.close();
      await base.close();
    },
  },
  { now: () => now },
);
const start = performance.now();
const cases = [];
try {
  const headers = [['Authorization', 'Bearer ' + keys.good]];
  for (const path of ['/api/v2/calculator/inputs', '/api/v2/home']) {
    const first = await wire(f.app, path, headers);
    assert.equal(first.statusCode, 200);
    for (const [method, h, status] of [
      ['HEAD', headers, 200],
      ['GET', [...headers, ['If-None-Match', first.headers.etag]], 304],
    ]) {
      const r = await wire(f.app, path, h, method);
      assert.equal(r.statusCode, status);
      assert.equal(r.body, '');
    }
  }
  await until(() => f.events.filter((e) => e.stage === 'lifecycle.terminal').length === 6);
  assert(
    f.events
      .filter((e) => e.stage === 'lifecycle.terminal')
      .every((e) => e.state === 'charged'),
  );
  const captured = registry.capture();
  let csv = Buffer.from(captured.product.csv),
    bundle = captured.product.bundleId;
  captured.release();
  let first;
  for (const method of ['GET', 'HEAD']) {
    const r = await wire(f.app, '/api/v2/downloads/' + bundle + '/daily', headers, method);
    assert.equal(r.statusCode, 200);
    if (method === 'GET') {
      assert.equal(r.body, csv.toString());
      first = r;
    } else assert.equal(r.body, '');
  }
  assert.equal(
    (
      await wire(
        f.app,
        '/api/v2/downloads/' + bundle + '/daily',
        [...headers, ['If-None-Match', first.headers.etag]],
        'HEAD',
      )
    ).statusCode,
    304,
  );
  assert.equal(
    (
      await wire(
        f.app,
        '/api/v2/downloads/' + bundle + '/daily',
        [
          ['Authorization', 'Bearer ' + keys.revoked],
          ['If-None-Match', first.headers.etag],
        ],
        'HEAD',
      )
    ).statusCode,
    401,
  );
  assert.equal((await wire(f.app, '/api/v2/stake-events', headers)).statusCode, 503);
  cases.push(
    'original metering lifecycle charges successful GET/HEAD/304 exactly once',
    'protected synthetic CSV matches selected rows',
    'revoked HEAD refuses before 304',
    'authorized canonical event still explicitly unavailable',
  );
  console.log(
    JSON.stringify({
      status: 'PASS',
      synthetic: true,
      cases,
      requests: 11,
      listenerSeconds: (performance.now() - start) / 1000,
    }),
  );
} finally {
  await f.close();
}
