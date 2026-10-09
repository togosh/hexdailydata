// One real combined trial. No provider work in verify-local mode.
import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { openProductDependencies } from '../../dist/services/product-daily/open.js';
import { runUnified } from '../../scripts/refresh-data.mjs';
import { fixture } from '../market-feed/access-fixture.mjs';
import { finalize } from './final.mjs';
const mode = process.argv[2],
  R = process.env.HDD_TASK_ROOT;
assert(['trial', 'verify-local'].includes(mode) && process.argv.length === 3);
assert(R?.endsWith('unified-refresh-operation-r1'));
assert(
  !existsSync(join(R, 'session')) && !existsSync(join(R, 'PUBLIC_ADMISSION.json')),
  'Existing or uncertain admission',
);
const save = (n, v) =>
  writeFile(join(R, 'evidence', n + '.json'), JSON.stringify(v, null, 2) + '\n');
let deps, f, apiReader;
const result = { mode, publicRequestsLaunched: false, closed: false };
try {
  const start = performance.now();
  deps = await openProductDependencies(JSON.parse(await readFile(join(R, 'PROFILE.json'))));
  const real = deps.participants,
    base = deps.sourceGenerations,
    seed = real.productDaily.capture();
  // Separate registry instance: the API must discover durable selections itself.
  const { ParticipantRegistry } = await import('../../dist/services/source-update/refresh.js');
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
  await save(mode === 'trial' ? 'TRIAL_LISTENER' : 'LOCAL_LISTENER', {
    origin,
    pid: process.pid,
    openedAt: new Date().toISOString(),
    readinessMilliseconds: performance.now() - start,
  });
  const baseline = await f.inject('/api/v2/live');
  assert.equal(baseline.statusCode, 200, baseline.body);
  await save(mode === 'trial' ? 'ACTUAL_BASELINE_API' : 'LOCAL_BASELINE_API', baseline.json());
  if (mode === 'verify-local') result.status = 'LOCAL_API_PASS';
  else {
    result.publicRequestsLaunched = true;
    result.trial = await runUnified({
      taskRoot: R,
      preflightPath: join(R, 'PREFLIGHT.json'),
      registry: real,
      onAdoption: async (selected, check, job) => {
        await delay(1100);
        check();
        f.controls.now = Date.now();
        const paths = [
          '/api/v2/live',
          '/api/v2/home',
          '/api/v2/holders?limit=2',
          '/api/v2/stakes?limit=2',
        ];
        const bodies = {};
        for (const path of paths) {
          const r = await f.inject(path);
          assert.equal(r.statusCode, 200, r.body);
          bodies[path] = r.json();
        }
        assert.equal(bodies[paths[0]].datasetVersion, selected.product.version);
        for (const path of paths.slice(2))
          assert.equal(bodies[path].generation, selected.generation);
        assert.equal(apiReader.status().productVersion, selected.product.version);
        assert.equal(apiReader.status().generation, selected.generation);
        check();
        return {
          job,
          origin,
          pid: process.pid,
          adoptionTime: new Date().toISOString(),
          bodies,
          selected: apiReader.status(),
          memory: process.memoryUsage(),
        };
      },
    });
    console.log('PUBLIC_SESSION_CLOSED ' + result.trial.status);
    result.status = result.trial.status;
    await save('TRIAL_RESULT', result);
    if (result.trial.networkClosureKnown) {
      f.controls.now = Date.now();
      await finalize({ R, real, base, fixture: f, origin, save, seed });
      result.finalEvidence = 'PASS';
    }
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
  await save(mode === 'trial' ? 'TRIAL_FINAL' : 'LOCAL_CHECK', result);
}
console.log(JSON.stringify({ status: result.status, closed: result.closed, error: result.error }));
