// Real host adapter, coordinator, supervisor, seals and Windows kernel exclusion.
// Docker/SQL/provider side effects and effective Compose inspection are intercepted.
import test, { mock } from 'node:test';
import assert from 'node:assert/strict';
import { spawn as nativeSpawn } from 'node:child_process';
import { readFileSync, writeFileSync, copyFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { randomUUID, createHash } from 'node:crypto';
import { boundaryFixture } from './boundary-fixture.mjs';
import { pause, readSmall } from '../../scripts/operator/reconstruction-job.mjs';
import { digest } from '../../dist/services/projections/input.js';

let fixture;
mock.module(new URL('../../scripts/operator/audit-bindings.mjs', import.meta.url), {
  namedExports: {
    checkAuditBindings() {
      fixture.events.push('injected-compose-binding-inspection');
    },
  },
});
mock.module('node:child_process', {
  namedExports: {
    spawn(binary, args, options) {
      if (binary === 'powershell.exe' || binary === 'flock')
        return nativeSpawn(binary, args, options);
      assert.equal(binary, process.execPath);
      assert.equal(args[0], 'scripts/operator/reconstruction-segment.mjs');
      fixture.work = fixture.adapter.launch('resume', 19, () => {});
      const child = nativeSpawn(
        process.execPath,
        ['--max-old-space-size=512', '-e', 'setTimeout(() => process.exit(3), 30)'],
        { stdio: 'ignore', windowsHide: true },
      );
      fixture.child = child;
      child.once('close', () => pause(fixture.root, fixture.options.operation));
      return child;
    },
    spawnSync(binary, args) {
      assert.equal(binary, 'docker');
      const f = fixture,
        plan = f.options.plan;
      f.commands.push(args);
      let stdout = '';
      switch (args[0]) {
        case 'context':
          stdout = 'desktop-linux';
          break;
        case 'volume':
          stdout = JSON.stringify([{ Name: plan.admission.volume }]);
          break;
        case 'ps':
          break;
        case 'compose':
          if (args.includes('config'))
            stdout = JSON.stringify({
              services: {
                operator: {
                  volumes: [
                    { type: 'volume', target: plan.storagePath, source: 'state' },
                    { type: 'volume', target: plan.quotaPath, source: 'quota' },
                  ],
                },
              },
              volumes: { state: { name: 'synthetic-state' }, quota: { name: 'synthetic-quota' } },
            });
          else if (args.includes('ps')) stdout = 'synthetic-db';
          else assert(args.includes('up'));
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
                  Mounts: [{ Name: 'synthetic-state', RW: false }],
                }
              : {
                  Config: {
                    Entrypoint: ['postgres'],
                    Cmd: ['-D', '/var/lib/postgresql/data'],
                    Labels: {
                      'com.docker.compose.project': plan.project,
                      'com.docker.compose.service': 'db',
                    },
                  },
                  Mounts: [{ Name: plan.admission.volume }],
                  NetworkSettings: { Networks: { [plan.project + '_private']: {} } },
                },
          ]);
          break;
        case 'cp':
          copyFileSync(join(f.environment, 'reconstruction.json'), args[2]);
          if (++f.copies === 1) f.setRaw(f.time(1001314));
          break;
        case 'stop':
        case 'rm':
          break;
        default:
          throw Error('Unexpected intercepted command');
      }
      return { status: 0, stdout, stderr: '', signal: null };
    },
  },
});
const { hostJob } = await import('../../scripts/operator/reconstruction-job-host.mjs');

test('maintained host admission reaches synthetic segment 19 with exact files and settled child/exclusion', async () => {
  fixture = await boundaryFixture(
    join(resolve(process.env.HDD_V2_BOUNDARY_EVIDENCE), 'host-' + randomUUID()),
  );
  const f = fixture,
    plan = f.options.plan,
    hash = (path) => createHash('sha256').update(readFileSync(path)).digest('hex');
  f.commands = [];
  f.copies = 0;
  f.put(join(f.environment, 'input/approval.json'), {
    run: plan.run,
    planDigest: digest(plan),
    release: plan.release,
    reviewedCommit: plan.reviewedCommit,
    instance: plan.instance,
    decision: 'owner-approved-bounded-reconstruction',
    resumePolicy: plan.resumePolicy,
  });
  f.put(join(f.environment, 'environment.json'), {
    project: plan.project,
    instance: plan.instance,
    current: plan.release,
  });
  writeFileSync(join(f.environment, 'offline.yaml'), 'SYNTHETIC INTERCEPTED GRAPH');
  f.put(f.options.scopePath, {
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
    approvalSha256: hash(join(f.environment, 'input/approval.json')),
    overrideSha256: hash(join(f.environment, 'offline.yaml')),
  });
  const identities = {
    plan: hash(join(f.environment, 'input/plan.json')),
    approval: hash(join(f.environment, 'input/approval.json')),
    override: hash(join(f.environment, 'offline.yaml')),
    scope: hash(f.options.scopePath),
  };
  const binding = digest({ environment: f.environment, identities });
  f.old.binding = binding;
  f.put(join(f.root, 'status.json'), f.old);
  f.put(join(f.environment, 'reconstruction-job-binding.json'), {
    operation: plan.run,
    root: f.root,
    binding,
  });
  const original = hash(join(f.root, f.old.resultFile));
  const result = await hostJob(
    {
      environment: f.environment,
      scopePath: f.options.scopePath,
      root: f.root,
      action: 'resume',
      readmitClockStop: f.oldOwner,
    },
    f.clock,
  );
  await f.work;
  assert.equal(result.outcome, 'PAUSED_AT_BOUNDARY');
  assert.equal(result.lastSettled.segment, 19);
  assert.equal(result.originalDeadline, plan.expiresAt);
  assert.equal(hash(join(f.root, f.old.resultFile)), original);
  assert.equal(f.child.exitCode, 3);
  assert.equal(f.copies, 3, 'Admission, after-wait control recheck and next settlement');
  assert(f.events.some((e) => e.startsWith('clock-wait-')));
  assert.equal(readSmall(join(f.root, 'invocation-00019-result.json')).exit, 3);
  f.put(join(f.root, 'HOST_PROOF.json'), {
    result,
    commands: f.commands,
    events: f.events,
    childExit: f.child.exitCode,
    realDockerCalls: 0,
    realSqlCalls: 0,
    realProviderCalls: 0,
    realComposeBindingInspection: false,
    mutex: 'actual OS file exclusion acquired and released',
  });
});
