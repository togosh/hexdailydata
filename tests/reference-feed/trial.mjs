// One explicit real trial; no preliminary calls and no automatic repeat after closure.
import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { openProductDependencies } from '../../dist/services/product-daily/open.js';
import { ParticipantRegistry } from '../../dist/services/source-update/refresh.js';
import { runReferences } from '../../scripts/reference-refresh.mjs';
import { fixture } from '../market-feed/access-fixture.mjs';
import { finalize } from './final.mjs';
const R = process.env.HDD_TASK_ROOT;
assert(R?.endsWith('btc-eth-reference-feed-r1'));
assert(process.argv.length === 3 && process.argv[2] === 'trial');
assert(
  !existsSync(join(R, 'session')) && !existsSync(join(R, 'PUBLIC_ADMISSION.json')),
  'Existing or uncertain session',
);
const save = (name, v) =>
  writeFile(join(R, 'evidence', name + '.json'), JSON.stringify(v, null, 2) + '\n');
let deps, apiReader, f;
const result = { status: 'PREPARING', publicRequestsLaunched: false, closed: false };
try {
  deps = await openProductDependencies(JSON.parse(await readFile(join(R, 'PROFILE.json'))));
  const real = deps.participants,
    base = deps.sourceGenerations,
    seed = real.productDaily.capture();
  apiReader = await ParticipantRegistry.open(real.root, real.productDaily.root, base);
  f = await fixture(
    { participants: apiReader, productDaily: apiReader.productDaily, sourceGenerations: base },
    {
      webRoot: resolve('dist/web'),
      account: { webRoot: resolve('account/dist/ui'), register: async () => {} },
    },
  );
  f.controls.now = Date.now();
  const origin = await f.app.listen({ host: '127.0.0.1', port: 0 });
  await save('TRIAL_LISTENER', { origin, pid: process.pid, openedAt: new Date().toISOString() });
  const baseline = await f.inject('/api/v2/live');
  assert.equal(baseline.statusCode, 200, baseline.body);
  await save('ACTUAL_BASELINE_API', baseline.json());
  result.publicRequestsLaunched = true;
  result.trial = await runReferences({
    taskRoot: R,
    preflightPath: join(R, 'PREFLIGHT.json'),
    registry: real,
    onAdoption: async (selected, check) => {
      await new Promise((r) => setTimeout(r, 1100));
      check();
      f.controls.now = Date.now();
      const bodies = {};
      for (const path of [
        '/api/v2/live',
        '/api/v2/home',
        '/api/v2/holders?limit=2',
        '/api/v2/stakes?limit=2',
      ]) {
        const r = await f.inject(path);
        assert.equal(r.statusCode, 200, r.body);
        bodies[path] = r.json();
      }
      assert.equal(bodies['/api/v2/live'].datasetVersion, selected.product.version);
      assert.equal(apiReader.status().productVersion, selected.product.version);
      assert.equal(apiReader.status().generation, selected.generation);
      check();
      return {
        origin,
        pid: process.pid,
        adoptionTime: new Date().toISOString(),
        bodies,
        selected: apiReader.status(),
      };
    },
  });
  result.status = result.trial.status;
  await save('TRIAL_RESULT', result);
  console.log('PUBLIC_SESSION_CLOSED ' + result.status);
  if (result.trial.networkClosureKnown) {
    await finalize({ R, real, base, fixture: f, origin, seed, save });
    result.finalEvidence = 'PASS';
  }
} catch (e) {
  result.status = 'PARTIAL';
  result.error = String(e.stack ?? e);
  console.error(e);
  process.exitCode = 2;
} finally {
  if (f) await f.close();
  if (apiReader) await apiReader.close();
  if (deps) await deps.close();
  result.closed = true;
  result.completedAt = new Date().toISOString();
  await save('TRIAL_FINAL', result);
}
console.log(JSON.stringify({ status: result.status, closed: result.closed, error: result.error }));
