// Actual host admission and coordinator with intercepted Docker and proof adapters.
// SQL/recovery proof and OS exclusion are qualified separately by the offline suites.
import test, { mock } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync, readFileSync, copyFileSync, readdirSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { randomUUID, createHash } from 'node:crypto';
import { publish, pause } from '../../scripts/operator/reconstruction-job.mjs';
import { digest } from '../../dist/services/projections/input.js';

let fixture;
mock.module(new URL('../../scripts/operator/audit-bindings.mjs', import.meta.url), {
  namedExports: { checkAuditBindings() {} },
});
mock.module(new URL('../../scripts/operator/reconstruction-recovery-mutex.mjs', import.meta.url), {
  namedExports: { recoveryMutex: async () => Object.assign(async () => {}, { check() {} }) },
});
mock.module(new URL('../../scripts/operator/reconstruction-recovery.mjs', import.meta.url), {
  namedExports: {
    async verifyRecovery({ state, stateBytes, result }) {
      assert.deepEqual(state, fixture.state);
      assert.deepEqual(stateBytes, readFileSync(fixture.statePath));
      assert.deepEqual(result.recovery, fixture.recovery);
      fixture.verifications++;
      return true;
    },
  },
});
mock.module('node:child_process', {
  namedExports: {
    spawn() {
      throw Error('No child may launch during this pause');
    },
    spawnSync(binary, args) {
      assert.equal(binary, 'docker');
      const f = fixture;
      let stdout = '';
      switch (args[0]) {
        case 'context':
          stdout = 'desktop-linux';
          break;
        case 'compose':
          if (args.includes('config')) stdout = JSON.stringify(f.graph);
          else if (args.includes('up')) pause(f.output, f.plan.run);
          else if (args.includes('ps')) stdout = 'synthetic-db';
          else throw Error('Unexpected Compose command');
          break;
        case 'volume':
          stdout = JSON.stringify([{ Name: f.plan.admission.volume }]);
          break;
        case 'ps':
          break;
        case 'create':
          stdout = 'synthetic-copy';
          break;
        case 'inspect':
          stdout = JSON.stringify([
            args[1] === 'synthetic-copy'
              ? {
                  State: { Running: false, Status: 'created' },
                  HostConfig: { NetworkMode: 'none' },
                  Mounts: [{ Name: f.scope.stateVolume, RW: false }],
                }
              : {
                  Config: {
                    Entrypoint: ['postgres'],
                    Cmd: ['-D', '/var/lib/postgresql/data'],
                    Labels: {
                      'com.docker.compose.project': f.plan.project,
                      'com.docker.compose.service': 'db',
                    },
                  },
                  Mounts: [{ Name: f.plan.admission.volume }],
                  NetworkSettings: { Networks: { [f.plan.project + '_private']: {} } },
                },
          ]);
          break;
        case 'cp':
          copyFileSync(f.statePath, args[2]);
          f.copies.push(args[2]);
          break;
        case 'stop':
        case 'rm':
          break;
        default:
          throw Error('Unexpected Docker command ' + args[0]);
      }
      return { status: 0, signal: null, stdout, stderr: '' };
    },
  },
});
const { hostJob } = await import('../../scripts/operator/reconstruction-job-host.mjs');

test('actual host and coordinator preserve fresh admission receipts across recovered pauses', async () => {
  const directory = resolve(
      process.env.HDD_V2_RECOVERY_HOST_EVIDENCE ?? 'artifacts/task-10/power-loss-recovery',
      'host-repeat-' + randomUUID(),
    ),
    environment = join(directory, 'environment'),
    output = join(directory, 'output'),
    put = (path, value) => writeFileSync(path, JSON.stringify(value)),
    hash = (path) => createHash('sha256').update(readFileSync(path)).digest('hex');
  mkdirSync(join(environment, 'input'), { recursive: true });
  mkdirSync(output);
  const priorAdmission = join(output, 'admission-00002');
  mkdirSync(priorAdmission);
  writeFileSync(join(priorAdmission, 'retained.txt'), 'prior observation');
  const plan = JSON.parse(readFileSync('config/reconstruction.synthetic.example.json'));
  put(join(environment, 'input/plan.json'), plan);
  put(join(environment, 'input/approval.json'), {
    run: plan.run,
    planDigest: digest(plan),
    release: plan.release,
    reviewedCommit: plan.reviewedCommit,
    instance: plan.instance,
    decision: 'owner-approved-bounded-reconstruction',
    resumePolicy: plan.resumePolicy,
  });
  put(join(environment, 'environment.json'), {
    project: plan.project,
    instance: plan.instance,
    built: plan.release,
  });
  put(join(environment, 'reconstruction-host.json'), { segments: 2 });
  writeFileSync(join(environment, 'offline.yaml'), 'synthetic only');
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
    override: 'offline.yaml',
    approvalSha256: hash(join(environment, 'input/approval.json')),
    overrideSha256: hash(join(environment, 'offline.yaml')),
  };
  const scopePath = join(directory, 'scope.json');
  put(scopePath, scope);
  const start = Date.now(),
    deadline = start + plan.caps.milliseconds,
    state = {
      digest: digest(plan),
      start,
      deadline,
      highWater: start,
      segment: { number: 2, ended: null },
      lastEnded: null,
      status: 'paused',
      reason: 'RECOVERED_AFTER_POWER_LOSS',
      terminal: false,
      pending: false,
      pendingSql: null,
      http: 1,
      logical: 1,
      chargedBytes: 1,
      observedBytes: 1,
      accepted: { header: { number: '1311' }, revision: '10' },
      audited: { header: { number: '611' }, revision: '4' },
      phase: 'milestone-audited',
    },
    statePath = join(directory, 'state.json'),
    recovery = { directory: 'recovery-00002', manifest: 'a'.repeat(64) },
    owner = randomUUID();
  put(statePath, { ...state, checksum: digest(state) });
  publish(environment, 'reconstruction-job-binding.json', {
    operation: plan.run,
    root: output,
    binding: digest({
      environment,
      identities: {
        plan: hash(join(environment, 'input/plan.json')),
        approval: hash(join(environment, 'input/approval.json')),
        override: hash(join(environment, 'offline.yaml')),
        scope: hash(scopePath),
      },
    }),
  });
  publish(output, 'result-' + owner + '.json', {
    owner,
    operation: plan.run,
    outcome: 'RECOVERED_AFTER_POWER_LOSS',
    originalStart: start,
    originalDeadline: deadline,
    recovery,
  });
  publish(output, 'status.json', { owner, resultFile: 'result-' + owner + '.json' });
  fixture = {
    plan,
    scope,
    state,
    statePath,
    recovery,
    output,
    copies: [],
    verifications: 0,
    graph: {
      services: {
        operator: {
          volumes: [
            { type: 'volume', source: 'state', target: plan.storagePath },
            { type: 'volume', source: 'quota', target: plan.quotaPath },
          ],
        },
      },
      volumes: { state: { name: scope.stateVolume }, quota: { name: scope.quotaVolume } },
    },
  };
  const results = [];
  for (let i = 0; i < 3; i++) {
    const result = await hostJob({ environment, scopePath, root: output, action: 'resume' });
    assert.equal(result.outcome, 'RECOVERED_AFTER_POWER_LOSS');
    assert.equal(result.nativeOutcome.exit, null);
    assert.deepEqual(result.recovery, recovery);
    results.push(result);
  }
  assert.equal(fixture.verifications, 6);
  assert.equal(new Set(fixture.copies).size, 3);
  assert.equal(readdirSync(output).filter((name) => name.startsWith('admission-')).length, 4);
  assert.equal(readFileSync(join(priorAdmission, 'retained.txt'), 'utf8'), 'prior observation');
  for (const path of fixture.copies) assert.equal(hash(path), hash(statePath));
  put(join(directory, 'receipt.json'), {
    results,
    copies: fixture.copies,
    verifications: fixture.verifications,
    realDockerCalls: 0,
    realProviderCalls: 0,
  });
});
