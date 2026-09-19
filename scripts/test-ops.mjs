import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import {
  chmodSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
  appendFileSync,
  copyFileSync,
} from 'node:fs';
import { resolve, join } from 'node:path';
import { setTimeout as pause } from 'node:timers/promises';
import net from 'node:net';

const scale = process.argv.includes('--scale');
const smoke = process.argv.includes('--smoke');
const evidence = resolve(
  'artifacts/task-08/' + (scale ? 'scale-' : 'ops-') + randomUUID().slice(0, 8),
);
mkdirSync(evidence, { recursive: true });
chmodSync(evidence, 0o770);
console.log(
  'Evidence:',
  evidence,
  'allocation: DB 1.25CPU/2.5GiB + API/worker/helper each .25CPU/.5GiB; build/control separate.',
);
const results = [],
  environments = [];
let serial = 0;
async function execute(
  exe,
  args,
  { env = process.env, expected = [0], timeout = 600000, label = 'command' } = {},
) {
  const start = performance.now(),
    id = String(++serial).padStart(3, '0');
  const child = spawn(exe, args, { env, stdio: ['ignore', 'pipe', 'pipe'] });
  let output = '',
    size = 0;
  for (const stream of [child.stdout, child.stderr])
    stream.on('data', (b) => {
      size += b.length;
      if (size < 2 * 1024 * 1024) output += b.toString();
    });
  const timer = setTimeout(() => child.kill(), timeout);
  const code = await new Promise((ok, no) => {
    child.once('error', no);
    child.once('close', ok);
  });
  clearTimeout(timer);
  appendFileSync(
    join(evidence, 'commands.txt'),
    `${id} ${exe} ${args.join(' ')} exit=${code} ms=${(performance.now() - start).toFixed(1)}\n`,
  );
  writeFileSync(join(evidence, id + '-' + label + '.log'), output);
  if (!expected.includes(code)) throw Error(`${label} exit=${code}: ${output.slice(-2500)}`);
  return output;
}
async function port() {
  const s = net.createServer();
  await new Promise((r) => s.listen(0, '127.0.0.1', r));
  const n = s.address().port;
  await new Promise((r) => s.close(r));
  return String(n);
}
const read = (d) => JSON.parse(readFileSync(join(d, 'environment.json'), 'utf8'));
function env(d) {
  const c = read(d);
  return {
    ...process.env,
    HDD_V2_PROJECT: c.project,
    HDD_V2_DB_INSTANCE: c.instance,
    HDD_V2_IMAGE: c.current ?? c.built,
    HDD_V2_SECRET_DIR: join(d, 'secrets'),
    HDD_V2_OPERATOR_INPUT: join(d, 'input'),
    HDD_V2_HOST_PORT: c.port,
    HDD_V2_OPS_EVIDENCE: evidence,
  };
}
const host = (d, cmd, ...args) =>
  execute(process.execPath, ['scripts/operator/host.mjs', cmd, d, ...args], { label: cmd });
const compose = (d, args, options = {}) =>
  execute('docker', ['compose', '-p', read(d).project, '-f', 'compose.yaml', ...args], {
    env: env(d),
    ...options,
  });
const runner = (d, args, options = {}) =>
  compose(
    d,
    ['-f', 'compose.ops-test.yaml', 'run', '--rm', '-T', 'runner', 'node', ...args],
    options,
  );
const probe = (d, action, ...args) =>
  runner(d, ['tests/operations/probe.mjs', action, ...args], { label: action });
const op = (d, command, ...args) =>
  compose(d, ['run', '--rm', '-T', 'operator', command, ...args], { label: command });
async function test(name, fn) {
  const at = performance.now();
  await fn();
  results.push({ name, ms: performance.now() - at, status: 'PASS' });
  console.log('PASS', name);
}
async function create(name, image) {
  const d = join(evidence, name + ' environment');
  await host(d, 'init', await port());
  environments.push(d);
  if (image) {
    const c = read(d);
    c.built = image;
    writeFileSync(join(d, 'environment.json'), JSON.stringify(c));
  } else await host(d, 'build');
  await host(d, 'provision');
  return d;
}
async function json(d, path) {
  return (
    await fetch(`http://127.0.0.1:${read(d).port}${path}`, { signal: AbortSignal.timeout(5000) })
  ).json();
}
let seedResult;
let monitor;
const reads = { requests: 0, failures: 0, maxMs: 0 };
function monitorReads(d) {
  monitor = setInterval(async () => {
    const at = performance.now();
    try {
      const r = await fetch(`http://127.0.0.1:${read(d).port}/api/v2/home`, {
        signal: AbortSignal.timeout(5000),
      });
      if (r.status !== 200) reads.failures++;
      await r.arrayBuffer();
    } catch {
      reads.failures++;
    } finally {
      reads.requests++;
      reads.maxMs = Math.max(reads.maxMs, performance.now() - at);
    }
  }, 250);
}
try {
  const source = await create('source');
  await test('README empty install and coherent compiled release', async () => {
    await host(source, 'release');
    const s = await json(source, '/api/v2/status');
    assert.equal(s.state, 'uninitialized');
    assert.equal(s.productionReady, false);
    assert.equal(s.liveProvidersEnabled, false);
    assert.equal(s.mode, 'production');
    await compose(source, ['run', '--rm', '-T', 'operator', 'doctor'], {
      expected: [0, 2],
      label: 'doctor-empty',
    });
    await compose(
      source,
      ['run', '--rm', '-T', '-e', 'HDD_V2_MAINTENANCE_PATH=/missing', 'operator', 'doctor'],
      {
        expected: [2],
        label: 'doctor-bad-path',
      },
    );
    await host(source, 'provision');
    const authority = `const fs=require('fs');if(process.getuid()!==1000)throw Error('UID');for(const p of ['/run/secrets/admin','/run/secrets/worker','/run/secrets/backup','/run/secrets/migrator','/app/tests','/app/src'])if(fs.existsSync(p))throw Error('Authority/runtime leak');try{fs.writeFileSync('/exports/no-write','x');throw Error('Writable exports')}catch(e){if(!['EROFS','EACCES'].includes(e.code))throw e}for(const p of ['/provider/worker.json']){try{fs.writeFileSync(p,'1');throw Error('Writable other cooldown')}catch(e){if(e.code!=='EACCES')throw e}}fs.writeFileSync('/provider/api.json','0');console.log('PASS UID1000, API-only secrets, read-only exports, runtime has no src/tests/planner');`;
    await compose(source, ['exec', '-T', 'api', 'node', '-e', authority], { label: 'authority' });
    const network = JSON.parse(
      await execute('docker', ['network', 'inspect', read(source).project + '_private'], {
        label: 'private-network',
      }),
    );
    assert.equal(network[0].Internal, true);
    await compose(source, ['stop', 'worker']);
    const diagnostic = await execute(
      process.execPath,
      [
        'scripts/operator/host.mjs',
        'compose',
        source,
        'run',
        '--rm',
        '-T',
        'operator',
        'sync',
        '--once',
      ],
      { expected: [1], label: 'disabled-provider-diagnostic' },
    );
    assert.match(diagnostic, /Provider work disabled: explicit source profile/);
  });
  if (!smoke) {
    if (scale)
      await test('reuse only existing large synthetic shape generator', () =>
        runner(source, ['tests/operations/scale.mjs'], {
          label: 'scale-generator',
          timeout: 900000,
        }));
    else {
      await test('actual compiled worker rebuild with isolated injected transport', () =>
        runner(source, ['tests/operations/worker.mjs', 'rebuild', '296'], {
          label: 'worker-rebuild',
        }));
      await op(source, 'exports');
      await probe(source, 'market', '0');
      await probe(source, 'audit');
      const log = await op(source, 'seed-export', '/state/synthetic.seed.tar.gz');
      seedResult = JSON.parse(
        log
          .trim()
          .split('\n')
          .findLast((l) => l.startsWith('{')),
      );
    }
    await probe(source, 'snapshot', 'before');
    await pause(5500);
    const oldIds = (await json(source, '/api/v2/downloads')).bundles.map((b) => b.id);
    if (!scale) assert.ok(oldIds.length, 'source publication is readable by distinct API UID');
    monitorReads(source);
    let backup;
    await test('real consistent encrypted destination backup while Home remains available', async () => {
      if (scale) {
        const log = await op(source, 'backup');
        backup = JSON.parse(
          log
            .trim()
            .split('\n')
            .findLast((l) => l.startsWith('{') && l.includes('sha256')),
        );
        writeFileSync(join(evidence, 'backup.json'), JSON.stringify(backup, null, 2));
      } else {
        await probe(source, 'consistent-backup');
        backup = JSON.parse(readFileSync(join(evidence, 'backup.json')));
      }
      assert.equal(backup.health.state, 'healthy');
    });
    if (!scale)
      await test('failed backups preserve last good and bounded staging', () =>
        probe(source, 'backup-failures'));
    const transfer = join(evidence, 'restore environment');
    mkdirSync(transfer, { recursive: true });
    // Only ciphertext traverses host storage; large files never enter this driver's heap.
    const container = (await compose(source, ['ps', '-q', 'db'])).trim();
    const backupContainer = (
      await compose(source, ['run', '-d', '--entrypoint', 'sleep', 'operator', '300'])
    ).trim();
    await execute(
      'docker',
      ['cp', backupContainer + ':/backup/current.age', join(transfer, 'recovery.age')],
      { label: 'copy-ciphertext' },
    );
    if (!scale)
      await execute(
        'docker',
        [
          'cp',
          backupContainer + ':/state/synthetic.seed.tar.gz',
          join(transfer, 'synthetic.seed.tar.gz'),
        ],
        { label: 'copy-seed' },
      );
    await execute('docker', ['rm', '-f', backupContainer], { label: 'remove-transfer-helper' });
    await execute('docker', ['stats', '--no-stream', '--format', '{{json .}}', container], {
      label: 'resource-milestone',
    });
    if (!scale) {
      await test('uninterrupted control forward checkpoint', () =>
        runner(source, ['tests/operations/worker.mjs', 'once', '300'], {
          label: 'control-forward',
        }));
      await probe(source, 'snapshot', 'control');
    }
    clearInterval(monitor);
    monitor = undefined;
    assert.equal(reads.failures, 0);
    assert.ok(reads.requests > 0);
    await compose(source, ['stop']); // The restore allocation replaces the source allocation.
    if (!scale) {
      const seeded = await create('seed', read(source).built);
      copyFileSync(join(transfer, 'synthetic.seed.tar.gz'), join(seeded, 'input', 'seed.tar.gz'));
      chmodSync(join(seeded, 'input', 'seed.tar.gz'), 0o640);
      const m = seedResult.manifest;
      writeFileSync(
        join(seeded, 'input', 'seed.json'),
        JSON.stringify({
          instance: read(seeded).instance,
          sha256: seedResult.sha256,
          contract: m.contractAddress,
          codeHash: '0x' + m.codeSha256,
          checkpointHash: m.checkpoint.blockHash,
        }),
      );
      await test('documented compiled operator seed import into new identity', () =>
        op(seeded, 'seed-import', '/input/seed.tar.gz', '/input/seed.json'));
      await probe(seeded, 'audit');
      await runner(seeded, ['tests/operations/worker.mjs', 'once', '300'], {
        label: 'seed-forward',
      });
      await probe(seeded, 'snapshot', 'seed-forward');
      const control = JSON.parse(readFileSync(join(evidence, 'control.json'))),
        seededState = JSON.parse(readFileSync(join(evidence, 'seed-forward.json')));
      for (const name of Object.keys(control).filter((n) => !n.startsWith('market_')))
        assert.deepEqual(seededState[name], control[name], name);
      await compose(seeded, ['stop']);
    }
    const target = await create('target', read(source).built);
    copyFileSync(join(transfer, 'recovery.age'), join(target, 'input', 'recovery.age'));
    copyFileSync(join(source, 'secrets', 'backup.key'), join(target, 'input', 'restore.key'));
    for (const file of ['recovery.age', 'restore.key'])
      chmodSync(join(target, 'input', file), 0o640);
    const expected = {
      sha256: backup.sha256,
      sourceInstance: read(source).instance,
      destinationInstance: read(target).instance,
      destinationProject: read(target).project,
    };
    writeFileSync(join(target, 'input', 'expectation.json'), JSON.stringify(expected));
    const restoreArgs = [
      'run',
      '--rm',
      '-T',
      '-e',
      'HDD_V2_BACKUP_IDENTITY_FILE=/input/restore.key',
      'operator',
      'restore',
      '/input/recovery.age',
      '/input/expectation.json',
    ];
    if (!scale)
      await test('wrong target and injected pre-commit failure leave target empty', () =>
        compose(
          target,
          [
            '-f',
            'compose.ops-test.yaml',
            'run',
            '--rm',
            '-T',
            '-e',
            'HDD_V2_BACKUP_IDENTITY_FILE=/input/restore.key',
            'runner',
            'node',
            'tests/operations/probe.mjs',
            'restore-failure',
          ],
          { label: 'restore-rollback' },
        ));
    await test('standard operator encrypted restore into independently identified fresh target', () =>
      compose(target, restoreArgs, { label: 'restore', timeout: 1200000 }));
    await probe(target, 'snapshot', 'restored');
    await probe(target, 'resources', 'restored');
    const before = JSON.parse(readFileSync(join(evidence, 'before.json'))),
      restored = JSON.parse(readFileSync(join(evidence, 'restored.json')));
    assert.deepEqual(restored, before);
    await compose(target, ['up', '-d', '--wait', 'api']);
    assert.ok((await json(target, '/api/v2/home')).daily);
    if (!scale) {
      const missing = await json(target, '/api/v2/downloads');
      assert.equal(missing.bundles.length, 0);
      for (const id of oldIds)
        assert.notEqual(
          (
            await fetch(`http://127.0.0.1:${read(target).port}/api/v2/downloads/${id}/daily`, {
              headers: { 'If-None-Match': '*' },
            })
          ).status,
          304,
        );
      await probe(target, 'audit');
      await test('nonempty target refused', () =>
        compose(target, restoreArgs, { label: 'nonempty-refusal', expected: [1] }));
      await test('restored pending market and exact forward native state match', async () => {
        await runner(target, ['tests/operations/worker.mjs', 'once', '300'], {
          label: 'restored-forward',
        });
        await probe(target, 'snapshot', 'forward');
        const control = JSON.parse(readFileSync(join(evidence, 'control.json'))),
          forward = JSON.parse(readFileSync(join(evidence, 'forward.json')));
        for (const name of Object.keys(control).filter((n) => !n.startsWith('market_')))
          assert.deepEqual(forward[name], control[name], name);
        assert.notDeepEqual(
          forward.market_daily,
          control.market_daily,
          'post-snapshot local observation is intentionally unrecoverable',
        );
      });
      let downloads;
      for (let i = 0; i < 75; i++) {
        downloads = await json(target, '/api/v2/downloads');
        if (downloads.bundles.some((b) => !oldIds.includes(b.id))) break;
        if (i % 15 === 0)
          await compose(target, ['run', '--rm', '-T', 'operator', 'exports'], {
            label: 'exports-after-grace',
            expected: [0, 1],
          });
        assert.ok((await json(target, '/api/v2/home')).daily);
        await pause(1000);
      }
      assert.ok(downloads.bundles.length && downloads.bundles.every((b) => !oldIds.includes(b.id)));
      writeFileSync(join(evidence, 'restored-downloads.json'), JSON.stringify(downloads, null, 2));
      await test('actual synthetic watch handles competing worker, SIGTERM, retained repair and restart', async () => {
        const name = read(target).project + '-watch';
        await compose(target, [
          '-f',
          'compose.ops-test.yaml',
          'run',
          '-d',
          '--name',
          name,
          'runner',
          'node',
          'tests/operations/worker.mjs',
          'watch',
          '300',
        ]);
        await pause(2000);
        await runner(target, ['tests/operations/worker.mjs', 'once', '300'], {
          label: 'competing-worker',
          expected: [1],
        });
        await execute('docker', ['stop', '--timeout', '10', name], { label: 'watch-sigterm' });
        const result = JSON.parse(
          await execute('docker', ['inspect', name, '--format', '{{json .State}}'], {
            label: 'watch-exit',
          }),
        );
        assert.equal(result.ExitCode, 0);
        await execute('docker', ['logs', name], { label: 'watch-log' });
        await execute('docker', ['rm', name], { label: 'watch-cleanup' });
        await runner(target, ['tests/operations/worker.mjs', 'repair-range', '296'], {
          label: 'retained-repair',
        });
        await runner(target, ['tests/operations/worker.mjs', 'once', '300'], {
          label: 'repair-forward',
        });
        await probe(target, 'audit');
      });
      await test('real process restart retains ready DB and native data', async () => {
        await compose(target, ['restart', 'api']);
        await pause(4000);
        assert.ok((await json(target, '/api/v2/home')).daily);
      });
    }
    await compose(target, ['run', '--rm', '-T', 'operator', 'status'], {
      label: 'restored-status',
      expected: [0, 2],
    });
  }
  writeFileSync(
    join(evidence, 'results.json'),
    JSON.stringify({ results, reads, scale, external: 'NOT_RUN' }, null, 2),
  );
} catch (e) {
  writeFileSync(join(evidence, 'failure.txt'), e.stack);
  console.error(e.message);
  process.exitCode = 1;
} finally {
  clearInterval(monitor);
  for (const d of environments.reverse())
    try {
      await host(d, 'destroy', read(d).project);
      await execute(
        'docker',
        [
          'volume',
          'ls',
          '--filter',
          'label=com.docker.compose.project=' + read(d).project,
          '--format',
          '{{.Name}}',
        ],
        { label: 'remaining-volumes' },
      );
    } catch (e) {
      appendFileSync(join(evidence, 'cleanup-failure.txt'), e.message + '\n');
      process.exitCode = 1;
    }
  writeFileSync(
    join(evidence, 'run-summary.json'),
    JSON.stringify({ results, reads, exit: process.exitCode ?? 0 }, null, 2),
  );
}
