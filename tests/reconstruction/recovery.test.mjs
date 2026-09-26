import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { recoveryBindings } from '../../scripts/operator/reconstruction-recover.mjs';
import { recoveryMutex } from '../../scripts/operator/reconstruction-recovery-mutex.mjs';
import { sha, jsonBytes } from '../../scripts/operator/reconstruction-recovery.mjs';
import { digest } from '../../dist/services/projections/input.js';
import { coordinate, publish, pause } from '../../scripts/operator/reconstruction-job.mjs';
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
test('pause before recovered launch preserves the verified boundary across repeated resumes', async () => {
  const f = jobFixture(join(root, 'recovered-pause')),
    owner = randomUUID(),
    start = Date.now(),
    deadline = start + f.options.plan.caps.milliseconds,
    recovery = { directory: 'recovery-00002', manifest: 'a'.repeat(64) };
  publish(f.options.lockRoot, 'reconstruction-job-binding.json', {
    operation: f.options.operation,
    root: f.options.root,
    binding: f.options.binding,
  });
  publish(f.options.root, 'result-' + owner + '.json', {
    owner,
    operation: f.options.operation,
    outcome: 'RECOVERED_AFTER_POWER_LOSS',
    originalStart: start,
    originalDeadline: deadline,
    recovery,
  });
  publish(f.options.root, 'status.json', { owner, resultFile: 'result-' + owner + '.json' });
  Object.assign(f.state(), {
    status: 'paused',
    start,
    deadline,
    segment: { number: 2, ended: null },
    lastEnded: null,
    reason: 'RECOVERED_AFTER_POWER_LOSS',
  });
  let verifications = 0;
  f.adapter.recovery = async (state, result) => {
    assert.equal(state.segment.ended, null);
    assert.deepEqual(result.recovery, recovery);
    assert.equal(result.originalStart, start);
    assert.equal(result.originalDeadline, deadline);
    verifications++;
    return true;
  };
  f.adapter.start = async () => pause(f.options.root, f.options.operation);
  const results = [];
  for (let i = 0; i < 2; i++) {
    const result = await coordinate({ ...f.options, action: 'resume' }, f.adapter);
    assert.equal(result.outcome, 'RECOVERED_AFTER_POWER_LOSS');
    assert.deepEqual(result.recovery, recovery);
    assert.equal(result.currentSegment.evidence, 'RECOVERY_BOUNDARY');
    assert.equal(result.currentSegment.reported.ended, null);
    assert.equal(result.currentSegment.reported.nativeExit, null);
    assert.equal(result.nativeOutcome.exit, null);
    assert.equal(result.originalEnded, null);
    assert.equal(f.children.length, 0);
    results.push(result);
  }
  f.adapter.start = async () => {};
  const snapshot = f.adapter.snapshot;
  f.adapter.snapshot = async (number) => {
    const observed = await snapshot(number);
    // This coordinator-only fixture otherwise supplies a fresh start on launch.
    for (const record of [observed.state, observed.host]) {
      record.start = start;
      record.deadline = deadline;
    }
    return observed;
  };
  const resumed = await coordinate({ ...f.options, action: 'resume', stopAt: '20' }, f.adapter);
  assert.equal(verifications, 3);
  assert.equal(f.children.length, 1);
  assert.equal(f.children[0].number, 3);
  assert.equal(resumed.outcome, 'PAUSED_AFTER_MILESTONE');
  assert.equal(resumed.currentSegment.evidence, 'SEALED');
  assert.equal(resumed.nativeOutcome.exit, 3);
  assert.equal(resumed.recovery, undefined);
  put(join(root, 'pause-before-launch-receipt.json'), { results, resumed, verifications });
});
