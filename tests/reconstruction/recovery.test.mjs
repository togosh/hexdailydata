import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { recoveryBindings } from '../../scripts/operator/reconstruction-recover.mjs';
import { recoveryMutex } from '../../scripts/operator/reconstruction-recovery-mutex.mjs';
import { sha, jsonBytes } from '../../scripts/operator/reconstruction-recovery.mjs';
import { digest } from '../../dist/services/projections/input.js';
import { coordinate, publish } from '../../scripts/operator/reconstruction-job.mjs';
import { jobFixture } from './job-fixture.mjs';
const root = resolve('artifacts/task-10/power-loss-recovery/unit-' + randomUUID());
mkdirSync(root, { recursive: true });
const put = (p, x) => writeFileSync(p, jsonBytes(x));
test('recovery exact authority input mutations refuse before any Docker/SQL adapter', () => {
  const env = join(root, 'environment'),
    out = join(root, 'output');
  mkdirSync(join(env, 'input'), { recursive: true });
  mkdirSync(out);
  const plan = JSON.parse(readFileSync('config/reconstruction.synthetic.example.json'));
  put(join(env, 'input/plan.json'), plan);
  put(join(env, 'input/approval.json'), {
    run: plan.run,
    planDigest: digest(plan),
    release: plan.release,
    reviewedCommit: plan.reviewedCommit,
    instance: plan.instance,
    decision: 'owner-approved-bounded-reconstruction',
    resumePolicy: plan.resumePolicy,
  });
  const config = { project: plan.project, instance: plan.instance, built: plan.release };
  put(join(env, 'environment.json'), config);
  writeFileSync(join(env, 'future.yaml'), 'synthetic only');
  const scope = {
    version: 1,
    run: plan.run,
    project: plan.project,
    instance: plan.instance,
    release: plan.release,
    reviewedCommit: plan.reviewedCommit,
    planDigest: digest(plan),
    databaseVolume: plan.admission.volume,
    stateVolume: 'synthetic-state',
    quotaVolume: 'synthetic-quota',
    override: 'future.yaml',
    overrideSha256: sha(readFileSync(join(env, 'future.yaml'))),
    approvalSha256: sha(readFileSync(join(env, 'input/approval.json'))),
  };
  const path = join(env, 'scope.json');
  put(path, scope);
  assert.equal(recoveryBindings(env, path, out).plan.run, plan.run);
  const refused = [];
  for (const key of [
    'run',
    'project',
    'instance',
    'release',
    'reviewedCommit',
    'planDigest',
    'databaseVolume',
    'approvalSha256',
    'overrideSha256',
  ]) {
    put(path, { ...scope, [key]: 'wrong' });
    assert.throws(() => recoveryBindings(env, path, out));
    refused.push(key);
  }
  put(path, { ...scope, stateVolume: scope.quotaVolume });
  assert.throws(() => recoveryBindings(env, path, out));
  put(path, scope);
  put(join(env, 'environment.json'), { ...config, built: 'wrong' });
  assert.throws(() => recoveryBindings(env, path, out));
  put(join(env, 'environment.json'), config);
  writeFileSync(join(env, 'input/approval.json'), '{}');
  assert.throws(() => recoveryBindings(env, path, out));
  put(join(root, 'authority-receipt.json'), { refused, providerCalls: 0, dockerCalls: 0 });
});
test('real host kernel lock excludes concurrency and releases for an explicit retry', async () => {
  const env = join(root, 'mutex');
  mkdirSync(env);
  const release = await recoveryMutex(env);
  try {
    release.check();
    await assert.rejects(recoveryMutex(env));
  } finally {
    await release();
  }
  const next = await recoveryMutex(env);
  next.check();
  await next();
});
test('normal paused unknown ending and recovered status without verifier both refuse', async () => {
  for (const recovered of [false, true]) {
    const f = jobFixture(join(root, 'coordinator-' + recovered));
    const owner = randomUUID();
    publish(f.options.lockRoot, 'reconstruction-job-binding.json', {
      operation: f.options.operation,
      root: f.options.root,
      binding: f.options.binding,
    });
    publish(f.options.root, 'result-' + owner + '.json', {
      owner,
      outcome: recovered ? 'RECOVERED_AFTER_POWER_LOSS' : 'PAUSED_AT_BOUNDARY',
      originalStart: Date.now(),
      originalDeadline: Date.now() + 60000,
    });
    publish(f.options.root, 'status.json', { owner, resultFile: 'result-' + owner + '.json' });
    Object.assign(f.state(), {
      status: 'paused',
      start: Date.now(),
      segment: { number: 1, ended: null },
    });
    await assert.rejects(
      coordinate({ ...f.options, action: 'resume' }, f.adapter),
      recovered ? /Recovery verifier/ : /Invalid start/,
    );
    assert.equal(f.children.length, 0);
  }
});
