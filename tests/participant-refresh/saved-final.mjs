// Local-only post-closure evidence correction. This never launches a collector.
import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { admitProduct } from '../../dist/services/product-daily/store.js';
import { openProductDependencies } from '../../dist/services/product-daily/open.js';
import { fixture, charge } from '../market-feed/access-fixture.mjs';
import { finalize } from './final.mjs';
const R = process.env.HDD_TASK_ROOT;
const accounting = JSON.parse(await readFile(join(R, 'session/ACCOUNTING.json')));
assert.equal(accounting.status, 'CLOSED');
assert.equal(accounting.pending, null);
const save = async (name, value) =>
  writeFile(join(R, 'evidence', name + '.json'), JSON.stringify(value, null, 2) + '\n');
const result = {
  externalRequests: 0,
  publicSessionRerun: false,
  priorTrialFailurePreserved: 'TRIAL_FINAL.json',
};
let deps, f;
try {
  deps = await openProductDependencies(
    JSON.parse(await readFile(join(R, 'PARTICIPANT_PROFILE.json'))),
  );
  const real = deps.participants;
  const inputs = JSON.parse(await readFile(join(R, 'INPUTS.json')));
  const seed = await admitProduct(
    join(R, 'seed-backup', inputs.bundledBackup.currentVersion),
    inputs.bundledBackup.currentManifestSha256,
  );
  f = await fixture(
    { ...deps, close: undefined },
    {
      webRoot: resolve('dist/web'),
      account: { webRoot: resolve('account/dist/ui'), register: async () => {} },
    },
  );
  f.controls.now = Date.now();
  f.app.server.on('connect', (_req, socket) => {
    charge();
    socket.destroy();
  });
  const origin = await f.app.listen({ host: '127.0.0.1', port: 0 });
  await finalize({ R, real, base: deps.sourceGenerations, fixture: f, origin, save, seed });
  result.status = 'PASS';
} catch (e) {
  result.status = 'FAIL';
  result.error = String(e.stack ?? e);
  console.error(e);
  process.exitCode = 1;
} finally {
  if (f) await f.close();
  if (deps) await deps.close();
  result.closed = true;
  result.completedAt = new Date().toISOString();
  await save('SAVED_FINAL_RESULT', result);
}
console.log(JSON.stringify(result));
