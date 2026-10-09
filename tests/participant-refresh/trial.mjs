// Explicit one finite reviewed trial; no restart or default provider operation.
import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { openProductDependencies } from '../../dist/services/product-daily/open.js';
import { runParticipantRefresh } from '../../scripts/participant-refresh.mjs';
import { fixture, charge } from '../market-feed/access-fixture.mjs';
import { finalize } from './final.mjs';
if (process.argv[2] !== 'trial' || process.argv.length !== 3)
  throw Error('Explicit trial required');
const R = process.env.HDD_TASK_ROOT;
assert(R?.endsWith('participant-catchup-refresh-r1'));
const save = async (name, value) =>
  writeFile(join(R, 'evidence', name + '.json'), JSON.stringify(value, null, 2) + '\n');
let deps, f;
const result = { status: 'STARTING', publicRequestsLaunched: false, closed: false };
try {
  const start = performance.now();
  deps = await openProductDependencies(
    JSON.parse(await readFile(join(R, 'PARTICIPANT_PROFILE.json'))),
  );
  const real = deps.participants,
    base = deps.sourceGenerations,
    seed = real.productDaily.capture();
  await save('TRIAL_BASE_READINESS', {
    milliseconds: performance.now() - start,
    rss: process.memoryUsage().rss,
    metrics: base.metrics,
  });
  f = await fixture(
    { ...deps, close: undefined },
    {
      webRoot: resolve('dist/web'),
      account: { webRoot: resolve('account/dist/ui'), register: async () => {} },
    },
  );
  const apiCalls = [];
  f.controls.now = Date.now();
  f.app.server.on('connect', (_req, socket) => {
    charge();
    socket.destroy();
  });
  const origin = await f.app.listen({ host: '127.0.0.1', port: 0 });
  await save('TRIAL_LISTENER', { origin, pid: process.pid, beganAt: new Date().toISOString() });
  const initial = await f.inject('/api/v2/live');
  assert.equal(initial.statusCode, 200, initial.body);
  await save('ACTUAL_BASELINE_API', initial.json());
  result.publicRequestsLaunched = true;
  result.trial = await runParticipantRefresh({
    taskRoot: R,
    preflightPath: join(R, 'PREFLIGHT.json'),
    registry: real,
    onAdoption: async (selected, check) => {
      await delay(1100);
      check();
      f.controls.now = Date.now();
      const live = await f.inject('/api/v2/live');
      assert.equal(live.statusCode, 200, live.body);
      assert.equal(live.json().datasetVersion, selected.product.version);
      const holders = await f.inject('/api/v2/holders?limit=2');
      assert.equal(holders.statusCode, 200, holders.body);
      assert.equal(holders.json().generation, selected.generation);
      const stakes = await f.inject('/api/v2/stakes?limit=2');
      assert.equal(stakes.statusCode, 200, stakes.body);
      assert.equal(stakes.json().generation, selected.generation);
      const held = real.capture();
      try {
        return {
          origin,
          processId: process.pid,
          live: live.json(),
          holders: holders.json(),
          stakes: stakes.json(),
          memory: process.memoryUsage(),
          metrics: held.sourceGenerations.metrics,
        };
      } finally {
        held.release();
      }
    },
  });
  console.log('PUBLIC_SESSION_CLOSED ' + result.trial.status);
  result.status = result.trial.status;
  await save('TRIAL_RESULT', result);
  await finalize({ R, real, base, fixture: f, origin, save, seed });
  result.finalEvidence = 'PASS';
  result.apiCalls = apiCalls;
} catch (e) {
  result.status = 'PARTIAL';
  result.error = String(e.stack ?? e);
  console.error(e);
  process.exitCode = 2;
} finally {
  if (f) await f.close();
  if (deps) await deps.close();
  result.closed = true;
  result.completedAt = new Date().toISOString();
  await save('TRIAL_FINAL', result);
}
console.log(
  JSON.stringify({
    status: result.status,
    closed: result.closed,
    error: result.error,
    windows: result.trial?.source.completedWindows,
  }),
);
