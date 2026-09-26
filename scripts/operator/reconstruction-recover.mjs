import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { readFileSync, existsSync, lstatSync, realpathSync } from 'node:fs';
import { resolve, join, relative, isAbsolute, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createInterface } from 'node:readline';
import { reconstructionPlanSchema } from '../../dist/operator/reconstruction-plan.js';
import { digest } from '../../dist/services/projections/input.js';
import { ReconstructionClock } from '../../dist/operator/reconstruction-clock.js';
import { checkAuditBindings, auditPostgresImage } from './audit-bindings.mjs';
import { recoveryMutex } from './reconstruction-recovery-mutex.mjs';
import { recover, readJson, sha } from './reconstruction-recovery.mjs';

export function recoveryBindings(environment, scopePath, root) {
  for (const path of [environment, scopePath, root]) {
    const rel = relative(process.cwd(), path);
    assert(
      rel &&
        !rel.startsWith('..') &&
        !isAbsolute(rel) &&
        ['.local', 'artifacts'].includes(rel.split(/[\\/]/)[0]),
      'Owned repository path required',
    );
    for (let p = path; p !== dirname(p); p = dirname(p))
      if (existsSync(p)) assert(!lstatSync(p).isSymbolicLink());
  }
  assert.equal(realpathSync(environment), environment);
  assert(
    relative(environment, root).startsWith('..') && relative(root, environment).startsWith('..'),
  );
  const scope = readJson(scopePath),
    plan = reconstructionPlanSchema.parse(readJson(join(environment, 'input/plan.json')));
  assert.equal(scope.version, 1);
  for (const k of ['run', 'project', 'instance', 'release', 'reviewedCommit'])
    assert.equal(scope[k], plan[k]);
  assert.equal(scope.planDigest, digest(plan));
  assert.equal(scope.databaseVolume, plan.admission.volume);
  assert(/^[a-z][a-z0-9-]*\.yaml$/.test(scope.override));
  const override = join(environment, scope.override);
  const identities = Object.fromEntries(
    Object.entries({
      plan: join(environment, 'input/plan.json'),
      approval: join(environment, 'input/approval.json'),
      override,
      scope: scopePath,
    }).map(([k, p]) => {
      for (let part = p; part !== dirname(part); part = dirname(part))
        assert(!lstatSync(part).isSymbolicLink(), 'Indirect authority path');
      return [k, sha(readFileSync(p))];
    }),
  );
  assert.equal(identities.approval, scope.approvalSha256);
  assert.equal(identities.override, scope.overrideSha256);
  assert.deepEqual(readJson(join(environment, 'input/approval.json')), {
    run: plan.run,
    planDigest: digest(plan),
    release: plan.release,
    reviewedCommit: plan.reviewedCommit,
    instance: plan.instance,
    decision: 'owner-approved-bounded-reconstruction',
    resumePolicy: plan.resumePolicy,
  });
  const config = readJson(join(environment, 'environment.json'));
  assert.equal(config.project, plan.project);
  assert.equal(config.instance, plan.instance);
  assert.equal(config.current ?? config.built, plan.release);
  assert.equal(new Set([scope.databaseVolume, scope.stateVolume, scope.quotaVolume]).size, 3);
  return {
    environment,
    root,
    scopePath,
    scope,
    plan,
    identities,
    binding: digest({ environment, identities }),
    override,
  };
}
export function bootObservation(status) {
  const pids = [status.coordinatorPid, status.child?.pid];
  assert(pids.every((p) => Number.isSafeInteger(p) && p > 0));
  if (process.platform === 'win32') {
    const command = `$ErrorActionPreference='Stop'; $taskBoot=(Get-CimInstance Win32_OperatingSystem).LastBootUpTime.ToUniversalTime(); $taskProcesses=@(); foreach($taskPid in ${pids.join(',')}) { $taskProcess=Get-Process -Id $taskPid -ErrorAction SilentlyContinue; if($taskProcess) { $taskProcesses+=@{pid=$taskPid; started=([DateTimeOffset]$taskProcess.StartTime.ToUniversalTime()).ToUnixTimeMilliseconds()} } else { $taskProcesses+=@{pid=$taskPid; absent=$true} } }; @{boot=([DateTimeOffset]$taskBoot).ToUnixTimeMilliseconds(); processes=$taskProcesses} | ConvertTo-Json -Compress`;
    const r = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', command], {
      encoding: 'utf8',
      timeout: 15000,
      windowsHide: true,
    });
    assert.equal(r.status, 0, 'Boot/process observation failed');
    return { ...JSON.parse(r.stdout), now: Date.now() };
  }
  assert.equal(process.platform, 'linux');
  const boot = Number(/^btime (\d+)$/m.exec(readFileSync('/proc/stat', 'utf8'))?.[1]) * 1000;
  return {
    boot,
    now: Date.now(),
    processes: pids.map((pid) => ({ pid, absent: !existsSync('/proc/' + pid) })),
  };
}

export async function recoverHost(options) {
  const o = recoveryBindings(options.environment, options.scopePath, options.root);
  const release = await recoveryMutex(o.environment);
  const clock = new ReconstructionClock();
  const { scope, plan } = o;
  let db, helper, completion, lines;
  const docker = (args) => {
    release.check();
    const r = spawnSync('docker', ['--context', 'desktop-linux', ...args], {
      encoding: 'utf8',
      timeout: 30000,
      maxBuffer: 8 * 1024 * 1024,
      windowsHide: true,
    });
    assert.equal(r.status, 0, 'Scoped Docker inspection/control failed: ' + args[0]);
    return r.stdout.trim();
  };
  const inspect = (args) => JSON.parse(docker(args));
  const module = resolve('scripts/operator/reconstruction-recovery-sql.mjs');
  let graph;
  const base = (name, network, write = false) => [
    'run',
    '--rm',
    '-i',
    '--pull',
    'never',
    '--name',
    name,
    '--network',
    network,
    '--read-only',
    '--user',
    '1000:1000',
    '--cpus',
    '0.5',
    '--memory',
    '1g',
    '--memory-swap',
    '1g',
    '--cap-drop',
    'ALL',
    '--security-opt',
    'no-new-privileges:true',
    '--mount',
    `type=volume,source=${scope.stateVolume},target=${plan.storagePath}${write ? '' : ',readonly'}`,
    '--mount',
    `type=volume,source=${scope.quotaVolume},target=${plan.quotaPath},readonly`,
    '--mount',
    `type=bind,source=${join(o.environment, 'input')},target=/input,readonly`,
    '--mount',
    `type=bind,source=${module},target=/recovery-sql.mjs,readonly`,
  ];
  const read = async () => {
    const row = await lines.next();
    assert(!row.done, 'Recovery SQL helper did not settle');
    return JSON.parse(row.value);
  };
  try {
    assert.equal(process.env.DOCKER_HOST, undefined);
    assert.equal(process.env.DOCKER_CONTEXT, undefined);
    graph = inspect([
      'compose',
      '--env-file',
      join(o.environment, 'compose.env'),
      '-p',
      plan.project,
      '-f',
      o.override,
      'config',
      '--format',
      'json',
    ]);
    checkAuditBindings(
      plan,
      graph,
      inspect(['volume', 'inspect', scope.databaseVolume])[0],
      inspect(['volume', 'inspect', scope.stateVolume, scope.quotaVolume]),
      [],
    );
    for (const [volume, target] of [
      [scope.stateVolume, plan.storagePath],
      [scope.quotaVolume, plan.quotaPath],
    ])
      assert.equal(
        graph.volumes[graph.services.operator.volumes.find((m) => m.target === target).source].name,
        volume,
      );
    const network = plan.project + '_private';
    assert.equal(inspect(['network', 'inspect', network])[0].Internal, true);
    const adapter = {
      async observe(status, proving = false) {
        const observed = bootObservation(status);
        observed.now = clock.now();
        assert.deepEqual(
          recoveryBindings(o.environment, o.scopePath, o.root).identities,
          o.identities,
          'Authority changed',
        );
        if (proving) return observed;
        observed.operatorAbsent =
          docker(['ps', '-aq', '--filter', 'name=^/' + plan.project + '-reconstruction$']) === '';
        observed.volumesIdle = [scope.databaseVolume, scope.stateVolume, scope.quotaVolume].every(
          (v) => docker(['ps', '-q', '--filter', 'volume=' + v]) === '',
        );
        return observed;
      },
      async capture() {
        return JSON.parse(
          docker([
            ...base(plan.project + '-recovery-capture', 'none'),
            '--entrypoint',
            'node',
            plan.release,
            '/recovery-sql.mjs',
            '--capture',
          ]),
        );
      },
      async prove(before, previous, raw) {
        const name = plan.project + '-recovery-db';
        db = docker([
          'run',
          '--rm',
          '-d',
          '--pull',
          'never',
          '--name',
          name,
          '--label',
          'hdd.v2.recovery-run=' + plan.run,
          '--network',
          network,
          '--network-alias',
          'db',
          '--read-only',
          '--user',
          '999:999',
          '--cpus',
          '1.25',
          '--memory',
          '2560m',
          '--memory-swap',
          '2560m',
          '--cap-drop',
          'ALL',
          '--security-opt',
          'no-new-privileges:true',
          '--tmpfs',
          '/tmp:size=16m,mode=1777',
          '--tmpfs',
          '/var/run/postgresql:uid=999,gid=999,size=16m',
          '--mount',
          `type=volume,source=${scope.databaseVolume},target=/var/lib/postgresql/data`,
          '--health-cmd',
          'pg_isready -U hdd_v2_api -d hexdailydata_v2',
          '--health-interval',
          '1s',
          '--entrypoint',
          'postgres',
          auditPostgresImage,
          '-D',
          '/var/lib/postgresql/data',
          '-c',
          'default_transaction_read_only=on',
        ]);
        const wait = spawnSync(
          'docker',
          [
            '--context',
            'desktop-linux',
            'exec',
            db,
            'sh',
            '-c',
            'for n in $(seq 1 60); do pg_isready -U hdd_v2_api -d hexdailydata_v2 >/dev/null && exit 0; sleep 1; done; exit 1',
          ],
          { encoding: 'utf8', timeout: 65000, windowsHide: true },
        );
        assert.equal(wait.status, 0, 'Read-only PostgreSQL readiness failed');
        const args = base(plan.project + '-recovery-proof', network, true);
        for (const role of ['api', 'worker'])
          args.push(
            '--mount',
            `type=bind,source=${graph.secrets[role].file},target=/run/secrets/${role},readonly`,
          );
        for (const [k, v] of Object.entries({
          HDD_V2_DB_HOST: 'db',
          HDD_V2_DB_NAME: 'hexdailydata_v2',
          HDD_V2_DB_INSTANCE: plan.instance,
          HDD_V2_API_PASSWORD_FILE: '/run/secrets/api',
          HDD_V2_WORKER_PASSWORD_FILE: '/run/secrets/worker',
          HDD_V2_ALLOW_LIVE_RPC: 'false',
        }))
          args.push('-e', k + '=' + v);
        helper = spawn(
          'docker',
          [
            '--context',
            'desktop-linux',
            ...args,
            '--entrypoint',
            'node',
            plan.release,
            '/recovery-sql.mjs',
          ],
          { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true },
        );
        completion = new Promise((resolve) => helper.once('close', (code) => resolve(code)));
        helper.stdin.on('error', () => {});
        helper.stderr.on('data', () => {});
        lines = createInterface({ input: helper.stdout })[Symbol.asyncIterator]();
        helper.stdin.write(
          JSON.stringify({ before: raw.toString('base64'), previous: previous.accepted }) + '\n',
        );
        const response = await read();
        assert(response.proof);
        return response.proof;
      },
      async commit(_before, post) {
        release.check();
        assert.deepEqual(
          recoveryBindings(o.environment, o.scopePath, o.root).identities,
          o.identities,
          'Authority changed',
        );
        helper.stdin.write(
          JSON.stringify({ action: 'commit', post: post.toString('base64') }) + '\n',
        );
        const r = await read();
        assert.equal(r.committed, true);
        assert.equal(r.sha256, sha(post));
      },
    };
    return await recover(o, adapter);
  } finally {
    try {
      if (helper) {
        helper.stdin.end('{"action":"close"}\n');
        await completion;
      }
      if (db) {
        const meta = inspect(['inspect', db])[0];
        assert.equal(meta.Config.Labels['hdd.v2.recovery-run'], plan.run);
        assert.equal(meta.Mounts[0].Name, scope.databaseVolume);
        docker(['stop', '--timeout', '10', db]);
      }
    } finally {
      await release();
    }
  }
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const [environment, scopePath, root] = process.argv.slice(2);
  try {
    assert(environment && scopePath && root);
    console.log(
      JSON.stringify(
        await recoverHost({
          environment: resolve(environment),
          scopePath: resolve(scopePath),
          root: resolve(root),
        }),
        null,
        2,
      ),
    );
  } catch (error) {
    console.error(error.message);
    process.exitCode = 2;
  }
}
