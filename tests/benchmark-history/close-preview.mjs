// Only the affected UI recheck; reuse the completed publication and restore.
import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { ProductDailyStore } from '../../dist/services/product-daily/store.js';
import { fixture } from '../market-feed/access-fixture.mjs';
import { guardFixture } from './close-budget.mjs';
import { previewOnly } from './close-final.mjs';
const R = process.env.HDD_TASK_ROOT;
assert(R?.endsWith('btc-eth-daily-close-integration-r1'));
const profile = JSON.parse(await readFile(join(R, 'inputs/hds/SELECTED_PROFILE.json')));
const store = new ProductDailyStore(join(R, 'runtime/product'), profile.pair);
await store.load();
const receipt = {
  scope: 'UI disclosure correction only',
  startedAt: new Date().toISOString(),
  externalRequests: 0,
  seedRestores: 0,
  backupRestores: 0,
  participantBaseAdmissions: 0,
};
let f;
try {
  f = await fixture(
    { productDaily: store },
    {
      webRoot: resolve('dist/web'),
      account: { webRoot: resolve('account/dist/ui'), register: async () => {} },
    },
  );
  guardFixture(f, 600);
  f.controls.now = Date.now();
  const origin = await f.app.listen({ host: '127.0.0.1', port: 0 });
  await previewOnly({
    R,
    origin,
    save: (n, v) =>
      writeFile(join(R, 'evidence', n + '_CORRECTED.json'), JSON.stringify(v, null, 2) + '\n', {
        flag: 'wx',
      }),
  });
  receipt.status = 'PASS';
} catch (e) {
  receipt.status = 'FAIL';
  receipt.failure = String(e.stack ?? e);
  throw e;
} finally {
  if (f) await f.close();
  receipt.closed = true;
  receipt.completedAt = new Date().toISOString();
  await writeFile(
    join(R, 'evidence/PREVIEW_RECHECK.json'),
    JSON.stringify(receipt, null, 2) + '\n',
    { flag: 'wx' },
  );
}
console.log(
  'PASS corrected normal Charts desktop/mobile; no repeated seed, publication, base admission or restore',
);
