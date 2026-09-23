// Actual host adapter cancellation; every Docker command is intercepted.
// This tests startup ownership, not real Docker/process-tree qualification.
import test, { mock } from 'node:test';
import assert from 'node:assert/strict';
import { spawn as nativeSpawn } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { randomUUID, createHash } from 'node:crypto';
import { publish, readSmall } from '../../scripts/operator/reconstruction-job.mjs';
import { digest } from '../../dist/services/projections/input.js';

let fixture;
mock.module('node:child_process', {
  namedExports: {
    spawn: () => {
      const { started, stopped, events } = fixture;
      const child = nativeSpawn(
        process.execPath,
        [
          '-e',
          `
        const fs = require('node:fs');
        setTimeout(() => {
          fs.writeFileSync(${JSON.stringify(started)}, 'synthetic operator');
          const timer = setInterval(() => {
            if (fs.existsSync(${JSON.stringify(stopped)})) { clearInterval(timer); process.exit(2); }
          }, 10);
        }, 50);
        setTimeout(() => process.exit(2), 800);
      `,
        ],
        { stdio: 'ignore', windowsHide: true },
      );
      fixture.child = child;
      child.once('close', () => events.push('supervisor-settled'));
      return child;
    },
    spawnSync: (binary, args) => {
      assert.equal(binary, 'docker');
      const f = fixture;
      let stdout = '';
      switch (args[0]) {
        case 'ps':
          assert.deepEqual(args, [
            'ps',
            '-aq',
            '--filter',
            'name=^/' + f.plan.project + '-reconstruction$',
          ]);
          f.events.push(existsSync(f.started) ? 'operator-discovered' : 'operator-absent');
          stdout = existsSync(f.started) ? 'synthetic-container-id' : '';
          break;
        case 'inspect':
          assert.deepEqual(args, ['inspect', 'synthetic-container-id']);
          stdout = JSON.stringify([
            {
              Id: 'synthetic-container-id',
              Config: {
                Labels: {
                  'com.docker.compose.project':
                    f.mode === 'invalid-identity' ? 'someone-else' : f.plan.project,
                  'com.docker.compose.service': 'operator',
                },
                Image: f.plan.release,
              },
              Mounts: [
                { Name: f.scope.stateVolume, Destination: f.plan.storagePath },
                { Name: f.scope.quotaVolume, Destination: f.plan.quotaPath },
              ],
            },
          ]);
          break;
        case 'stop':
          assert.deepEqual(args, ['stop', '--time', '20', 'synthetic-container-id']);
          assert.notEqual(f.mode, 'invalid-identity');
          f.events.push('scoped-stop');
          writeFileSync(f.stopped, 'stop');
          break;
        default:
          throw Error('Unexpected Docker command: ' + args[0]);
      }
      return { status: 0, signal: null, stdout, stderr: '' };
    },
  },
});
mock.module(new URL('../../scripts/operator/reconstruction-job.mjs', import.meta.url), {
  namedExports: {
    publish,
    readSmall,
    coordinate: async (_options, adapter) => {
      const f = fixture;
      let canceled;
      const launched = adapter.launch('run', 1, () => {
        if (f.mode === 'publication-failure') throw Error('synthetic publication failure');
        canceled = adapter.cancel().then(
          () => f.events.push('cancel-returned'),
          (error) => {
            f.events.push('cancel-rejected');
            f.cancelError = error.message;
          },
        );
      });
      if (f.mode === 'publication-failure') {
        await assert.rejects(launched, /synthetic publication failure/);
        f.events.push('publication-failure-returned');
      } else {
        f.native = await launched;
        await canceled;
      }
      await assert.rejects(
        adapter.launch('resume', 2, () => {}),
        /cancellation/,
      );
    },
  },
});
const { hostJob } = await import('../../scripts/operator/reconstruction-job-host.mjs');
const root = resolve(
  process.env.HDD_V2_JOB_HOST_EVIDENCE ?? 'artifacts/task-10/clock-and-runner/host-tests',
);

for (const mode of ['late-operator', 'publication-failure', 'invalid-identity']) {
  test('host adapter retains startup cancellation ownership: ' + mode, async () => {
    const directory = join(root, mode + '-' + randomUUID());
    const environment = join(directory, 'environment'),
      output = join(directory, 'output');
    mkdirSync(join(environment, 'input'), { recursive: true });
    mkdirSync(output);
    const plan = JSON.parse(readFileSync('config/reconstruction.synthetic.example.json'));
    const put = (file, value) => writeFileSync(file, JSON.stringify(value, null, 2));
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
    writeFileSync(join(environment, 'offline.yaml'), 'synthetic stub only');
    const hash = (file) => createHash('sha256').update(readFileSync(file)).digest('hex');
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
    fixture = {
      plan,
      scope,
      mode,
      events: [],
      started: join(directory, 'started.txt'),
      stopped: join(directory, 'stopped.txt'),
    };
    await hostJob({ environment, scopePath, root: output, action: 'run' });
    const { events, child, native, cancelError } = fixture;
    put(join(directory, 'witness.json'), {
      events,
      native,
      cancelError,
      childExit: child.exitCode,
      realDockerCalls: 0,
      realProviderCalls: 0,
      realProcessTree: 'NOT_EXERCISED',
    });
    assert.equal(child.exitCode, 2);
    assert(events.includes('operator-absent'));
    const settled = events.indexOf('supervisor-settled');
    const returned = events.findIndex((e) =>
      ['cancel-returned', 'cancel-rejected', 'publication-failure-returned'].includes(e),
    );
    assert(settled >= 0 && returned > settled, JSON.stringify(events));
    if (mode === 'invalid-identity') {
      assert(!events.includes('scoped-stop'));
      assert(cancelError);
    } else assert(events.indexOf('scoped-stop') < settled);
  });
}
