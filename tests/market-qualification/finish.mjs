// Resume only affected fixture assertions and the still-unstarted preview.
// The complete holder/stake normal readiness and route checks are reused by identity.
import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { ProductDailyStore } from '../../dist/services/product-daily/store.js';
import { fixture, auth, until, root } from '../market-feed/access-fixture.mjs';
import { preview } from '../market-feed/preview.mjs';
const prior = JSON.parse(await readFile(join(root, 'evidence/APPLICATION.json')));
assert.equal(prior.readinessPasses, 1);
assert.equal(prior.readersClosed, true);
assert(prior.error.includes('503 !== 500'));
assert.equal(prior.checks.length, 4);
const profile = JSON.parse(await readFile(join(root, 'PRODUCT_PROFILE.json')));
const store = new ProductDailyStore(profile.productRoot, profile.pair);
await store.load();
const out = {
  status: 'RUNNING',
  reused: 'evidence/APPLICATION.json',
  newHolderStakeReadinessPasses: 0,
  smallDailyReaderReopens: 1,
  checks: [],
  externalRequests: 0,
};
let f;
try {
  f = await fixture({ productDaily: store });
  f.controls.now = Date.now();
  const originalLive = store.live.bind(store);
  store.live = () => {
    throw Error('SYNTHETIC_READ_FAILURE');
  };
  assert.equal((await f.inject({ url: '/api/v2/live', headers: auth() })).statusCode, 503);
  await until(() => f.events.some((e) => e.stage === 'finalize'));
  const released = f.events.find((e) => e.stage === 'finalize');
  assert.equal(released.success, false);
  assert.equal(released.hold.periodId, 'original-period');
  store.live = originalLive;
  out.checks.push('injected reader failure returns established503 and releases original paid hold');
  const publication = JSON.parse(await readFile(join(root, 'evidence/PUBLICATION.json'))),
    selected = publication.selected,
    olderPointer = publication.generations.at(-2) ?? publication.base;
  const newer = await f.inject('/api/v2/live');
  await store.select(olderPointer, { rollback: true });
  const older = await f.inject({
    url: '/api/v2/live',
    headers: { 'if-none-match': newer.headers.etag },
  });
  assert.equal(older.statusCode, 200);
  assert.notEqual(older.headers.etag, newer.headers.etag);
  await store.select(selected);
  assert.equal((await f.inject('/api/v2/live')).headers.etag, newer.headers.etag);
  out.checks.push('actual generation ETag separation, rollback and selected generation restored');
  await f.close();
  f = null;
  await preview({ productDaily: store });
  out.status = 'PASS';
} catch (e) {
  out.status = 'FAIL';
  out.error = e.stack;
  throw e;
} finally {
  if (f) await f.close();
  out.ownedFixturesClosed = true;
  await writeFile(
    join(root, 'evidence/APPLICATION_FINISH.json'),
    JSON.stringify(out, null, 2) + '\n',
    { flag: 'wx' },
  );
}
console.log(JSON.stringify(out));
