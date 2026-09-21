import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import {
  chmodSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
  appendFileSync,
  existsSync,
} from 'node:fs';
import { resolve, join, relative, isAbsolute } from 'node:path';
import { setTimeout as pause } from 'node:timers/promises';
const root = resolve(
    process.env.HDD_V2_LIFECYCLE_EVIDENCE ??
      'artifacts/task-08/lifecycle-' + randomUUID().slice(0, 8),
  ),
  directory = join(root, 'new environment');
const evidenceRelative = relative(resolve('artifacts'), root);
assert.ok(
  evidenceRelative &&
    !evidenceRelative.startsWith('..') &&
    !isAbsolute(evidenceRelative) &&
    !existsSync(root),
  'New task-owned evidence required',
);
mkdirSync(root, { recursive: true });
chmodSync(root, 0o770);
writeFileSync(join(root, '.dockerignore'), '*\n!Dockerfile.*\n');
let seq = 0,
  config,
  primary;
const configuration = () => JSON.parse(readFileSync(join(directory, 'environment.json'), 'utf8'));
const save = () => writeFileSync(join(directory, 'environment.json'), JSON.stringify(config));
const env = () => ({
  ...process.env,
  HDD_V2_PROJECT: config.project,
  HDD_V2_DB_INSTANCE: config.instance,
  HDD_V2_IMAGE: config.current ?? config.built,
  HDD_V2_SECRET_DIR: join(directory, 'secrets'),
  HDD_V2_OPERATOR_INPUT: join(directory, 'input'),
  HDD_V2_HOST_PORT: '0',
  HDD_V2_EDGE_PORT: '0',
  HDD_V2_OPS_EVIDENCE: root,
});
async function exec(file, args, allowed = [0], environment = process.env) {
  const child = spawn(file, args, { env: environment, stdio: ['ignore', 'pipe', 'pipe'] });
  let output = '';
  for (const stream of [child.stdout, child.stderr])
    stream.on('data', (b) => {
      if (output.length < 2e6) output += b.toString();
    });
  const code = await new Promise((resolve, reject) => {
    child.once('error', reject);
    child.once('close', resolve);
  });
  const name = String(++seq).padStart(3, '0');
  writeFileSync(join(root, name + '.log'), output);
  appendFileSync(join(root, 'commands.txt'), `${name} ${file} ${args.join(' ')} exit=${code}\n`);
  assert.ok(allowed.includes(code), `exit ${code}: ${output.slice(-1500)}`);
  return output;
}
const host = (cmd, ...args) =>
  exec(process.execPath, ['scripts/operator/host.mjs', cmd, directory, ...args]);
const compose = (args, allowed = [0]) =>
  exec('docker', ['compose', '-p', config.project, '-f', 'compose.yaml', ...args], allowed, env());
const runner = (args, allowed = [0]) =>
  compose(['-f', 'compose.ops-test.yaml', 'run', '--rm', '-T', 'runner', 'node', ...args], allowed);
const sql = (query) =>
  compose([
    'exec',
    '-T',
    'db',
    'psql',
    '-U',
    'hdd_v2_admin',
    '-d',
    'hexdailydata_v2',
    '-v',
    'ON_ERROR_STOP=1',
    '-Atc',
    query,
  ]);
const state = async (service) =>
  JSON.parse(
    await exec('docker', [
      'inspect',
      `${config.project}-${service}-1`,
      '--format',
      '{{json .State}}',
    ]),
  );
const checks = [];
async function pass(name, fn) {
  await fn();
  checks.push(name);
  console.log('PASS', name);
}
try {
  await host('init', '0');
  config = configuration();
  await host('build');
  config = configuration();
  await host('provision');
  await host('release');
  config = configuration();
  const good = config.built;
  await pass(
    'compiled development override and production release report their actual modes',
    async () => {
      await compose(['-f', 'compose.dev.yaml', 'up', '-d', '--wait', 'api', 'worker']);
      await compose([
        'exec',
        '-T',
        'api',
        'node',
        '-e',
        "fetch('http://127.0.0.1:4320/health/live').then(async r=>{if((await r.json()).mode!=='development')process.exit(1)})",
      ]);
      await host('release');
      await compose([
        'exec',
        '-T',
        'api',
        'node',
        '-e',
        "fetch('http://127.0.0.1:4320/health/live').then(async r=>{if((await r.json()).mode!=='production')process.exit(1)})",
      ]);
    },
  );
  await pass('ordinary standby scheduler completes an authenticated empty backup', async () => {
    const log = await compose(['run', '--rm', '-T', 'operator', 'status']);
    const result = JSON.parse(
      log
        .trim()
        .split('\n')
        .find((l) => l.startsWith('{')),
    );
    assert.equal(result.backup.state, 'healthy');
    assert.equal(result.state, 'uninitialized');
    await compose([
      'run',
      '--rm',
      '-T',
      '--entrypoint',
      'sh',
      'operator',
      '-c',
      'node --version; pg_dump --version; age --version',
    ]);
  });
  await pass(
    'worker process-role competition is rejected and SIGTERM releases ownership',
    async () => {
      await compose(['run', '--rm', '-T', 'worker'], [1]);
      await compose(['stop', 'worker']);
      assert.equal((await state('worker')).ExitCode, 0);
      await compose(['up', '-d', '--wait', 'worker']);
      assert.equal((await state('worker')).Health.Status, 'healthy');
    },
  );
  await pass(
    'database dependency loss degrades API and worker retries within a bounded minute',
    async () => {
      await compose(['stop', 'db']);
      await compose([
        'exec',
        '-T',
        'api',
        'node',
        '-e',
        "fetch('http://127.0.0.1:4320/health/ready').then(r=>{if(r.status!==503)process.exit(1)})",
      ]);
      await compose(['up', '-d', '--wait', 'db']);
      for (let i = 0; i < 75; i++) {
        await pause(1000);
        if ((await state('worker')).Health?.Status === 'healthy' && i > 60) break;
      }
      await compose(['logs', '--tail', '15', 'worker']);
      await compose([
        'exec',
        '-T',
        'api',
        'node',
        '-e',
        "fetch('http://127.0.0.1:4320/health/ready').then(r=>{if(r.status!==200)process.exit(1)})",
      ]);
      assert.equal((await state('worker')).Health.Status, 'healthy');
    },
  );
  await pass('unsupported schema release refuses and leaves both processes stopped', async () => {
    await sql("INSERT INTO hdd.schema_migrations VALUES(6,repeat('a',64))");
    await exec(process.execPath, ['scripts/operator/host.mjs', 'release', directory], [1]);
    assert.equal((await state('api')).Running, false);
    assert.equal((await state('worker')).Running, false);
    await sql('DELETE FROM hdd.schema_migrations WHERE version=6');
    await host('release');
  });
  await pass(
    'partial release failure stops API and worker, then compatible release recovers',
    async () => {
      writeFileSync(
        join(root, 'Dockerfile.bad'),
        `FROM ${config.image}\nCMD ["node","-e","process.exit(42)"]\n`,
      );
      const tag = config.project + ':failure';
      await exec('docker', ['build', '-f', join(root, 'Dockerfile.bad'), '-t', tag, root]);
      config.built = (
        await exec('docker', ['image', 'inspect', tag, '--format', '{{.Id}}'])
      ).trim();
      save();
      await exec(process.execPath, ['scripts/operator/host.mjs', 'release', directory], [1]);
      assert.equal((await state('api')).Running, false);
      assert.equal((await state('worker')).Running, false);
      config.built = good;
      save();
      await host('release');
      await exec('docker', ['image', 'rm', tag]);
    },
  );
  await pass(
    'actual compatible image replacement and rollback preserve schema and identity',
    async () => {
      writeFileSync(
        join(root, 'Dockerfile.compatible'),
        `FROM ${config.image}\nENV HDD_V2_RELEASE=compatible-schema5-release\n`,
      );
      const tag = config.project + ':compatible';
      await exec('docker', ['build', '-f', join(root, 'Dockerfile.compatible'), '-t', tag, root]);
      config.built = (
        await exec('docker', ['image', 'inspect', tag, '--format', '{{.Id}}'])
      ).trim();
      save();
      await host('release');
      config = configuration();
      await host('rollback');
      config = configuration();
      assert.equal(config.current, good);
      assert.equal(
        (await sql('SELECT instance::text FROM hdd_identity.instance')).trim(),
        config.instance,
      );
      // Same schema/code with a distinct release image; old Task06 worker behavior is not claimed.
    },
  );
  await pass('maintenance process loss releases snapshot and session locks', async () => {
    await compose(['stop', 'worker']);
    const name = config.project + '-held';
    await compose([
      '-f',
      'compose.ops-test.yaml',
      'run',
      '-d',
      '--name',
      name,
      'runner',
      'node',
      'tests/operations/probe.mjs',
      'hold-backup',
    ]);
    await pause(2000);
    const log = await exec('docker', ['logs', name]);
    assert.match(log, /SNAPSHOT_HELD/);
    await exec('docker', ['kill', name]);
    await exec('docker', ['rm', name]);
    await compose(['run', '--rm', '-T', 'operator', 'backup']);
  });
  await pass(
    'optional local edge routes privately; both Caddy templates validate without ACME',
    async () => {
      const image =
        'caddy:2.10.2-alpine@sha256:4c6e91c6ed0e2fa03efd5b44747b625fec79bc9cd06ac5235a779726618e530d';
      for (const file of ['Caddyfile.local', 'Caddyfile.example'])
        await exec('docker', [
          'run',
          '--rm',
          '--network',
          'none',
          '--mount',
          `type=bind,source=${resolve('deploy/' + file)},target=/etc/caddy/Caddyfile,readonly`,
          '-e',
          'HDD_V2_DOMAIN=example.invalid',
          '-e',
          'HDD_V2_TLS_EMAIL=offline@example.invalid',
          image,
          'caddy',
          'validate',
          '--config',
          '/etc/caddy/Caddyfile',
        ]);
      await compose(['-f', 'compose.edge.yaml', '--profile', 'edge', 'up', '-d', 'edge']);
      const published = (await compose(['-f', 'compose.edge.yaml', 'port', 'edge', '8080'])).trim();
      await pause(1000);
      assert.equal((await fetch('http://' + published + '/health/live')).status, 200);
      await compose(['-f', 'compose.edge.yaml', '--profile', 'edge', 'stop', 'edge']);
    },
  );
} catch (e) {
  primary = e;
  console.error(e.stack);
  writeFileSync(join(root, 'failure.txt'), e.stack);
  process.exitCode = 1;
} finally {
  if (config)
    try {
      await host('destroy', config.project);
    } catch (e) {
      appendFileSync(join(root, 'cleanup.txt'), e.message);
      process.exitCode = 1;
    }
  writeFileSync(
    join(root, 'results.json'),
    JSON.stringify(
      {
        checks,
        exit: process.exitCode ?? 0,
        compatibleImageScope:
          'Two real images, same code/schema5, distinct release metadata. Not a Task06 worker rollback claim.',
        external: 'NOT_RUN',
      },
      null,
      2,
    ),
  );
  console.log('Evidence:', root);
}
