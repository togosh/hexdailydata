import assert from 'node:assert/strict';
import { readFile, writeFile, mkdtemp, mkdir, cp } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { spawn, execFileSync } from 'node:child_process';
import { openProductDependencies } from '../../dist/services/product-daily/open.js';
import { ParticipantRegistry } from '../../dist/services/source-update/refresh.js';
import { sha } from '../../dist/services/source-update/generation.js';
import { runJob, admittedInputs, guardStorage } from '../../scripts/refresh-data.mjs';
import { deriveFixture } from './fixture-state.mjs';
import { fixture } from '../market-feed/access-fixture.mjs';
const R = process.env.HDD_TASK_ROOT,
  root = await mkdtemp(join(R, 'temp/native-composed-'));
const read = async (p) => JSON.parse(await readFile(p)),
  json = (p, v) => writeFile(p, JSON.stringify(v) + '\n');
const plan = await read(join(R, 'REQUEST_PLAN.json')),
  profile = await read(join(R, 'PROFILE.json'));
let deps, reader, f, registry;
const receipt = { root, synthetic: true, externalRequests: 0, jobs: [] };
try {
  deps = await openProductDependencies(profile);
  registry = await deriveFixture(deps.participants, join(root, 'runtime'), deps.sourceGenerations);
  reader = await ParticipantRegistry.open(
    registry.root,
    registry.productDaily.root,
    deps.sourceGenerations,
  );
  f = await fixture({
    participants: reader,
    productDaily: reader.productDaily,
    sourceGenerations: deps.sourceGenerations,
  });
  const session = join(root, 'session');
  await mkdir(session);
  let parent = {
    status: 'ADMITTED',
    mode: 'SYNTHETIC_OFFLINE_TEST',
    networkSessionCount: 0,
    networkClosesAtUnixSeconds: Date.now() / 1000 + 1200,
    job: null,
    pending: null,
    lastClosedMonotonic: null,
    attempts: 0,
    extraAttempts: 0,
    graphAttempts: 0,
    rpcAttempts: 0,
    graphExtras: 0,
    rpcExtras: 0,
    graphChargedBytes: 0,
    rpcChargedBytes: 0,
    chargedEntities: 0,
    observedBytes: 0,
    returnedEntities: 0,
    unknownEntityReservations: 0,
    rpcEndpointAttempts: [0, 0],
  };
  await json(join(session, 'PARENT_ACCOUNTING.json'), parent);
  for (const family of ['gas', 'participants']) {
    const name = family + '-1',
      jobRoot = join(session, name);
    await mkdir(jobRoot);
    await mkdir(join(jobRoot, 'temp'));
    const held = registry.capture();
    let initial;
    try {
      initial = admittedInputs(held, true);
    } finally {
      held.release();
    }
    const allowance = { ...plan.limits[family] },
      a = {
        task: 'HDD-UNIFIED-REFRESH-OPERATION-R1',
        combinedJob: true,
        synthetic: true,
        job: name,
        family,
        jobRoot,
        initial,
        allowance,
        nonce: 'synthetic',
        runtimeFiles: {},
        sourceFiles: {},
        networkSeconds: allowance.seconds - allowance.publication - 5,
        deadlineUnixSeconds: Date.now() / 1000 + allowance.seconds,
        networkClosesAtUnixSeconds:
          Date.now() / 1000 + allowance.seconds - allowance.publication - 5,
      };
    if (family === 'participants') {
      assert.equal(plan.participant.finalTarget.hash, null);
      assert.equal(plan.participant.finalTarget.timestamp, null);
      await json(join(jobRoot, 'PLAN.json'), {
        ...plan.participant,
        base: initial.participant.base,
      });
      a.planSha256 = sha(await readFile(join(jobRoot, 'PLAN.json')));
      await json(join(jobRoot, 'FRONTIER.json'), {
        completedWindows: 0,
        pin: initial.participant.base,
        generation: initial.participant.generation,
        productVersion: initial.product.version,
      });
    }
    await json(join(jobRoot, 'ADMISSION.json'), a);
    parent = await read(join(session, 'PARENT_ACCOUNTING.json'));
    parent.job = name;
    parent.jobAdmissionSha256 = sha(await readFile(join(jobRoot, 'ADMISSION.json')));
    await json(join(session, 'PARENT_ACCOUNTING.json'), parent);
    const result = await runJob({
      storageGuard: async (bytes = 0) => {
        const checked = await guardStorage(root, 512 * 1024 ** 2 + bytes);
        receipt.storageChecks ??= [];
        receipt.storageChecks.push(checked);
      },
      jobRoot,
      admission: a,
      registry,
      deadline: performance.now() + allowance.seconds * 1000,
      spawnChild: (_exe, _args, options) =>
        spawn(
          'python',
          ['-I', '-S', resolve('tests/unified-refresh/native-fixture.py'), jobRoot],
          options,
        ),
      onAdoption: async (selected) => {
        await new Promise((r) => setTimeout(r, 1100));
        f.controls.now = Date.now();
        const live = await f.inject('/api/v2/live');
        assert.equal(live.statusCode, 200, live.body);
        assert.equal(live.json().datasetVersion, selected.product.version);
        assert.equal(reader.status().generation, selected.generation);
        return {
          datasetVersion: live.json().datasetVersion,
          generation: reader.status().generation,
        };
      },
    });
    receipt.jobs.push({ family, ...result });
    assert.equal(result.status, 'QUALIFIED_ADOPTED', JSON.stringify(result));
  }
  parent = await read(join(session, 'PARENT_ACCOUNTING.json'));
  parent.status = 'CLOSED';
  await json(join(session, 'PARENT_ACCOUNTING.json'), parent);
  receipt.parentAudit = JSON.parse(
    execFileSync('python', ['-I', '-S', 'scripts/unified-refresh/audit_parent.py', session], {
      encoding: 'utf8',
    }),
  );
  receipt.status = 'PASS';
} catch (e) {
  receipt.status = 'FAIL';
  receipt.failure = String(e.stack ?? e);
  throw e;
} finally {
  if (f) await f.close();
  if (reader) await reader.close();
  if (registry) await registry.close();
  if (deps) await deps.close();
  receipt.closed = true;
  await json(join(R, 'evidence', 'NATIVE_COMPOSED_' + Date.now() + '.json'), receipt);
  console.log(
    JSON.stringify({
      status: receipt.status,
      root,
      failure: receipt.failure,
      jobs: receipt.jobs.map((j) => ({ family: j.family, status: j.status })),
    }),
  );
}
