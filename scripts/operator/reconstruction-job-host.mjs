// Host adapter promoted from the saved task coordinator. Never imported by status/pause.
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import {
  existsSync,
  readFileSync,
  openSync,
  closeSync,
  mkdirSync,
  lstatSync,
  realpathSync,
  unlinkSync,
} from 'node:fs';
import { join, relative, isAbsolute, dirname } from 'node:path';
import { reconstructionPlanSchema } from '../../dist/operator/reconstruction-plan.js';
import { digest } from '../../dist/services/projections/input.js';
import { checkAuditBindings } from './audit-bindings.mjs';
import { collect } from './reconstruction-collect.mjs';
import { verify } from './reconstruction-seal.mjs';
import { coordinate, publish, readSmall } from './reconstruction-job.mjs';
import { verifyRecovery } from './reconstruction-recovery.mjs';
import { recoveryMutex } from './reconstruction-recovery-mutex.mjs';
import { replayClockFloor } from './reconstruction-boundary.mjs';

function owned(path) {
  const rel = relative(process.cwd(), path);
  assert(
    rel &&
      !rel.startsWith('..') &&
      !isAbsolute(rel) &&
      ['.local', 'artifacts'].includes(rel.split(/[\\/]/)[0]),
    'Explicit repository-owned path required',
  );
  for (let p = path; p !== dirname(p); p = dirname(p))
    if (existsSync(p)) assert(!lstatSync(p).isSymbolicLink(), 'Indirect path refused');
}
export async function hostJob(
  { environment, scopePath, root, action, stopAt, readmitClockStop },
  clock,
) {
  for (const p of [environment, root, scopePath]) owned(p);
  assert.equal(realpathSync(environment), environment);
  assert(
    relative(environment, root).startsWith('..') && relative(root, environment).startsWith('..'),
    'Environment/output must be distinct non-nested roots',
  );
  const scope = readSmall(scopePath),
    planPath = join(environment, 'input/plan.json'),
    approvalPath = join(environment, 'input/approval.json');
  const plan = reconstructionPlanSchema.parse(readSmall(planPath));
  assert.equal(scope.version, 1);
  for (const key of ['run', 'project', 'instance', 'release', 'reviewedCommit'])
    assert.equal(scope[key], plan[key], 'Scope ' + key);
  assert.equal(scope.planDigest, digest(plan));
  assert.equal(scope.databaseVolume, plan.admission.volume);
  assert(
    /^[a-z][a-z0-9-]*\.yaml$/.test(scope.override),
    'Explicit local override filename required',
  );
  const override = join(environment, scope.override);
  for (const file of [planPath, approvalPath, override]) {
    owned(file);
    assert(!lstatSync(file).isSymbolicLink());
  }
  const hash = (file) => createHash('sha256').update(readFileSync(file)).digest('hex');
  const identities = {
    plan: hash(planPath),
    approval: hash(approvalPath),
    override: hash(override),
    scope: hash(scopePath),
  };
  assert.equal(identities.approval, scope.approvalSha256);
  assert.equal(identities.override, scope.overrideSha256);
  assert.deepEqual(readSmall(approvalPath), {
    run: plan.run,
    planDigest: digest(plan),
    release: plan.release,
    reviewedCommit: plan.reviewedCommit,
    instance: plan.instance,
    decision: 'owner-approved-bounded-reconstruction',
    resumePolicy: plan.resumePolicy,
  });
  const config = readSmall(join(environment, 'environment.json'));
  assert.equal(config.project, plan.project);
  assert.equal(config.instance, plan.instance);
  assert.equal(config.current ?? config.built, plan.release);
  const compose = [
    'compose',
    '--env-file',
    join(environment, 'compose.env'),
    '-p',
    plan.project,
    '-f',
    override,
  ];
  let serial = 0,
    child,
    childCompletion,
    childSettled = true,
    cancellation,
    dbId,
    collectorId,
    canceled = false,
    recovered,
    admission;
  const command = (args, timeout = 30000) => {
    const begin = performance.now(),
      r = spawnSync('docker', args, {
        encoding: 'utf8',
        timeout,
        maxBuffer: 8 * 1024 * 1024,
        windowsHide: true,
      });
    // Fresh owner UUID in the name avoids overwriting receipts across explicit resumes.
    const name = 'host-command-' + process.pid + '-' + process.hrtime.bigint() + '-' + ++serial;
    publish(
      root,
      name + '.json',
      {
        command: ['docker', ...args],
        exit: r.status,
        signal: r.signal,
        elapsedMonotonicMs: performance.now() - begin,
        error: r.error?.code ?? null,
      },
      true,
    );
    assert.equal(r.status, 0, 'Owned Docker command failed: ' + args[0]);
    return r.stdout;
  };
  const inspect = (args) => JSON.parse(command(args));
  const assertBindings = () => {
    release.check();
    assert.equal(process.env.DOCKER_HOST, undefined);
    assert.equal(process.env.DOCKER_CONTEXT, undefined);
    assert.equal(command(['context', 'show']).trim(), 'desktop-linux');
    assert.deepEqual(
      {
        plan: hash(planPath),
        approval: hash(approvalPath),
        override: hash(override),
        scope: hash(scopePath),
      },
      identities,
      'Authority inputs changed',
    );
    const graph = inspect([...compose, 'config', '--format', 'json']);
    const volume = inspect(['volume', 'inspect', plan.admission.volume])[0];
    const mounts = graph.services.operator.volumes.filter((m) => m.type === 'volume');
    assert.equal(
      graph.volumes[mounts.find((m) => m.target === plan.storagePath)?.source]?.name,
      scope.stateVolume,
    );
    assert.equal(
      graph.volumes[mounts.find((m) => m.target === plan.quotaPath)?.source]?.name,
      scope.quotaVolume,
    );
    const ids = command(['ps', '-q', '--filter', 'volume=' + volume.Name])
      .trim()
      .split(/\s+/)
      .filter(Boolean);
    checkAuditBindings(
      plan,
      graph,
      volume,
      inspect(['volume', 'inspect', scope.stateVolume, scope.quotaVolume]),
      ids.length ? inspect(['inspect', ...ids]) : [],
    );
    return graph;
  };
  const quiescent = () => {
    assert(!existsSync(join(environment, '.reconstruction-host.lock')), 'Host ownership uncertain');
    for (const volume of [scope.stateVolume, scope.quotaVolume])
      assert.equal(
        command(['ps', '-q', '--filter', 'volume=' + volume]).trim(),
        '',
        'Operation roots still active',
      );
  };
  const snapshot = (number, initial = false) => {
    quiescent();
    const destination = join(
      root,
      (initial ? 'admission-' : 'snapshot-') +
        String(number).padStart(5, '0') +
        (initial ? '-' + randomUUID() : ''),
    );
    mkdirSync(destination);
    // A stopped, read-only, networkless copy container, exactly as in the saved loop.
    collectorId = command([
      'create',
      '--name',
      plan.project + '-collect-' + number,
      '--network',
      'none',
      '--read-only',
      '--cpus',
      '0.25',
      '--memory',
      '128m',
      '--cap-drop',
      'ALL',
      '--security-opt',
      'no-new-privileges:true',
      '--entrypoint',
      'node',
      '--mount',
      'type=volume,source=' + scope.stateVolume + ',target=/state,readonly',
      plan.release,
    ]).trim();
    try {
      const meta = inspect(['inspect', collectorId])[0];
      assert.equal(meta.State.Running, false);
      assert.equal(meta.State.Status, 'created');
      assert.equal(meta.HostConfig.NetworkMode, 'none');
      assert.equal(meta.Mounts.length, 1);
      assert.equal(meta.Mounts[0].Name, scope.stateVolume);
      assert.equal(meta.Mounts[0].RW, false);
      command([
        'cp',
        collectorId + ':/state/reconstruction.json',
        join(destination, 'reconstruction.json'),
      ]);
      const { checksum, ...state } = readSmall(join(destination, 'reconstruction.json'));
      assert.equal(checksum, digest(state));
      assert.equal(state.digest, digest(plan));
      if (
        !initial &&
        state.milestone > 0 &&
        !existsSync(join(root, 'milestone-' + plan.milestones[state.milestone - 1]))
      ) {
        assert(['milestone-audited', 'complete'].includes(state.phase));
        for (const name of ['comparisons.jsonl', 'audit-result.json'])
          command(['cp', collectorId + ':/state/' + name, join(destination, name)]);
      } else if (
        !initial &&
        state.audit &&
        (state.terminal || state.pending || state.pendingSql || state.status === 'blocked')
      ) {
        // Preserve a partial comparison prefix without awarding full audit credit.
        command([
          'cp',
          collectorId + ':/state/comparisons.jsonl',
          join(destination, 'comparisons-PARTIAL.jsonl'),
        ]);
        publish(
          destination,
          'PARTIAL.json',
          { classification: 'PARTIAL_NOT_A_COMPLETED_AUDIT', audit: state.audit },
          true,
        );
      }
      return {
        state,
        snapshot: destination,
        ...(initial
          ? {}
          : {
              host: readSmall(join(environment, 'reconstruction-host.json')),
              hostResult: readSmall(join(environment, 'reconstruction-host-result.json')),
            }),
      };
    } finally {
      command(['rm', collectorId]);
      collectorId = null;
    }
  };
  const verifyOperator = () => {
    const ids = command([
      'ps',
      '-aq',
      '--filter',
      'name=^/' + plan.project + '-reconstruction$',
    ]).trim();
    if (!ids) return null;
    const op = inspect(['inspect', ids])[0];
    assert.equal(op.Config.Labels['com.docker.compose.project'], plan.project);
    assert.equal(op.Config.Labels['com.docker.compose.service'], 'operator');
    assert.equal(op.Config.Image, plan.release);
    for (const [volume, target] of [
      [scope.stateVolume, plan.storagePath],
      [scope.quotaVolume, plan.quotaPath],
    ])
      assert(op.Mounts.some((m) => m.Name === volume && m.Destination === target));
    return op.Id;
  };
  const adapter = {
    async recovery(state, result) {
      await verifyRecovery({
        environment,
        root,
        plan,
        binding: digest({ environment, identities }),
        state,
        stateBytes: readFileSync(join(admission, 'reconstruction.json')),
        result,
      });
      recovered = result;
      return true;
    },
    async admit(mode) {
      assertBindings();
      quiescent();
      assert.equal(
        command(['ps', '-q', '--filter', 'volume=' + plan.admission.volume]).trim(),
        '',
        'Database already owned elsewhere',
      );
      if (mode === 'run')
        assert(
          !existsSync(join(environment, 'reconstruction-host.json')),
          'Existing host operation',
        );
      const number =
        mode === 'run' ? 0 : readSmall(join(environment, 'reconstruction-host.json')).segments;
      const observed = snapshot(number, true);
      admission = observed.snapshot;
      return observed;
    },
    async start() {
      // Mark startup ownership before the command so a failed readiness wait is cleaned.
      dbId = 'starting';
      command(
        [
          ...compose,
          'up',
          '-d',
          '--wait',
          '--wait-timeout',
          '90',
          '--no-build',
          '--pull',
          'never',
          'db',
        ],
        110000,
      );
      dbId = command([...compose, 'ps', '-q', 'db']).trim();
      const db = inspect(['inspect', dbId])[0];
      assert.deepEqual(db.Config.Entrypoint, ['postgres']);
      assert.deepEqual(db.Config.Cmd, ['-D', '/var/lib/postgresql/data']);
      assert.equal(db.Mounts[0].Name, plan.admission.volume);
      assert.deepEqual(Object.keys(db.NetworkSettings.Networks), [plan.project + '_private']);
    },
    async boundary(previous, next, refresh = false) {
      assertBindings();
      quiescent();
      if (next === 'resume') {
        if (previous.segment?.ended === null) {
          assert(recovered, 'Missing recovered coordinator boundary');
          await adapter.recovery(previous, recovered);
          assert(!canceled, 'Emergency cancellation requested');
          return;
        }
        const host = readSmall(join(environment, 'reconstruction-host.json'));
        assert(!host.pending && !host.terminal && host.digest === previous.digest);
        assert.equal(host.start, previous.start);
        assert.equal(host.deadline, previous.deadline);
        const segmentRoot = join(root, 'segment-' + String(host.segments).padStart(5, '0'));
        const seal = await verify(segmentRoot, [
          'reconstruction-output.log',
          'reconstruction-host-result.json',
          'reconstruction-host.json',
          'reconstruction.json',
        ]);
        assert.equal(seal.binding.run, plan.run);
        assert.equal(seal.binding.segment, host.segments);
        assert.equal(
          digest(host),
          digest(readSmall(join(segmentRoot, 'reconstruction-host.json'))),
          'Host boundary changed',
        );
        assert.equal(
          digest(readSmall(join(environment, 'reconstruction-host-result.json'))),
          digest(readSmall(join(segmentRoot, 'reconstruction-host-result.json'))),
          'Host result changed',
        );
        const saved = readSmall(
          join(root, 'segment-' + String(host.segments).padStart(5, '0'), 'reconstruction.json'),
        );
        assert.equal(
          saved.checksum,
          digest(previous),
          'Operator state differs from sealed boundary',
        );
        for (let i = 0; i < previous.milestone; i++)
          await verify(join(root, 'milestone-' + plan.milestones[i]), [
            'comparisons.jsonl',
            'audit-result.json',
            'reconstruction.json',
          ]);
        let admissionSnapshot;
        if (refresh) {
          const current = snapshot(host.segments, true);
          assert.deepEqual(current.state, previous, 'Operator state changed during boundary wait');
          admissionSnapshot = current.snapshot;
        }
        assert(!canceled, 'Emergency cancellation requested');
        if (previous.phase === 'replay' && !previous.audit) replayClockFloor(previous, host);
        return { normalSeal: true, highWater: host.highWater, admissionSnapshot };
      }
      assert(!canceled, 'Emergency cancellation requested');
    },
    async launch(mode, number, onChild) {
      release.check();
      assert(!canceled, 'Emergency cancellation requested');
      const name = 'invocation-' + String(number).padStart(5, '0');
      const stdout = openSync(join(root, name + '.stdout.log'), 'wx'),
        stderr = openSync(join(root, name + '.stderr.log'), 'wx');
      const args = [
        'scripts/operator/reconstruction-segment.mjs',
        environment,
        override,
        mode,
        'plan.json',
        'approval.json',
      ];
      const started = performance.now();
      try {
        child = spawn(process.execPath, args, {
          stdio: ['ignore', stdout, stderr],
          windowsHide: true,
        });
        childSettled = false;
        let spawnError;
        const completion = (childCompletion = new Promise((resolve) => {
          child.once('error', (e) => {
            spawnError = e.message;
          });
          child.once('close', (exit, signal) => {
            childSettled = true;
            resolve({ exit, signal, ...(spawnError ? { error: spawnError } : {}) });
          });
        }));
        let publicationError;
        try {
          onChild({ pid: child.pid ?? null, kind: 'owned-supervisor', segment: number });
          publish(
            root,
            name + '-launch.json',
            {
              pid: child.pid ?? null,
              command: [process.execPath, ...args],
              observedWallUtc: Date.now(),
            },
            true,
          );
        } catch (error) {
          publicationError = error;
          try {
            await adapter.cancel();
          } catch (cancelError) {
            publicationError = new Error(error.message + '; cancellation: ' + cancelError.message);
          }
        }
        const native = await completion;
        if (publicationError) throw publicationError;
        publish(
          root,
          name + '-result.json',
          { ...native, elapsedMonotonicMs: performance.now() - started },
          true,
        );
        return native;
      } finally {
        child = null;
        closeSync(stdout);
        closeSync(stderr);
      }
    },
    async snapshot(number) {
      return snapshot(number);
    },
    async collect(path) {
      const result = await collect(environment, path, root);
      // Full copies now live in the verified create-once milestone seal. Keep only
      // one full evidence set; terminal partial prefixes remain explicitly partial.
      for (const name of ['comparisons.jsonl', 'audit-result.json'])
        if (existsSync(join(path, name))) unlinkSync(join(path, name));
      return result;
    },
    async cancel() {
      canceled = true;
      // A supervisor can still be checking bindings when cancellation arrives.
      // Retain ownership until its native settlement and stop an exact operator
      // that appears after the first lookup. Never kill the supervisor/PID and
      // orphan a Docker client that can subsequently create work.
      cancellation ??= (async () => {
        try {
          do {
            const id = verifyOperator();
            if (id) command(['stop', '--time', '20', id], 30000);
            if (!childSettled) {
              let timer;
              try {
                await Promise.race([
                  childCompletion,
                  new Promise((resolve) => {
                    timer = setTimeout(resolve, 250);
                  }),
                ]);
              } finally {
                clearTimeout(timer);
              }
            }
          } while (!childSettled);
          const late = verifyOperator();
          if (late) command(['stop', '--time', '20', late], 30000);
        } finally {
          // Identity/discovery failure is uncertainty, never permission to release
          // a still-owned supervisor or kill a different process/container.
          await childCompletion;
        }
      })();
      await cancellation;
    },
    async close() {
      if (collectorId) {
        command(['rm', collectorId]);
        collectorId = null;
      }
      if (dbId) {
        const op = verifyOperator();
        if (op) {
          command(['stop', '--time', '20', op]);
          command(['rm', op]);
        }
        // Only the verified project's exact DB container; never remove a volume.
        const id = command([...compose, 'ps', '-aq', 'db']).trim();
        if (id) {
          const db = inspect(['inspect', id])[0];
          assert.equal(db.Config.Labels['com.docker.compose.project'], plan.project);
          assert.equal(db.Config.Labels['com.docker.compose.service'], 'db');
          assert.equal(db.Mounts[0].Name, plan.admission.volume);
          command(['stop', '--time', '20', id]);
          command(['rm', id]);
        }
      }
      quiescent();
      assert.equal(command(['ps', '-q', '--filter', 'volume=' + plan.admission.volume]).trim(), '');
    },
  };
  const release = await recoveryMutex(environment);
  try {
    return await coordinate(
      {
        root,
        lockRoot: environment,
        operation: plan.run,
        plan,
        action,
        stopAt,
        readmitClockStop,
        scopePath,
        binding: digest({ environment, identities }),
      },
      adapter,
      clock,
    );
  } finally {
    await release();
  }
}
