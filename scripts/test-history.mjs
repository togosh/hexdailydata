import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import {
  mkdirSync,
  readFileSync,
  writeFileSync,
  appendFileSync,
  copyFileSync,
  chmodSync,
  existsSync,
} from 'node:fs';
import { resolve, join, relative, isAbsolute } from 'node:path';
import net from 'node:net';

const evidence = resolve(
  process.env.HDD_V2_HISTORY_EVIDENCE ??
    'artifacts/task-pulsechain-history/sql-' + randomUUID().slice(0, 8),
);
const evidenceRelative = relative(resolve('artifacts'), evidence);
assert.ok(
  evidenceRelative &&
    !evidenceRelative.startsWith('..') &&
    !isAbsolute(evidenceRelative) &&
    !existsSync(evidence),
  'New task-owned evidence required',
);
mkdirSync(evidence, { recursive: true });
const environments = [];
let serial = 0;
console.log(
  'New isolated history resources:',
  evidence,
  'DB + one runner only; providers disabled.',
);
async function execute(exe, args, { expected = [0], label = 'command', env = process.env } = {}) {
  const start = performance.now(),
    id = String(++serial).padStart(3, '0');
  const child = spawn(exe, args, { env, stdio: ['ignore', 'pipe', 'pipe'] });
  let output = '',
    size = 0;
  for (const stream of [child.stdout, child.stderr])
    stream.on('data', (b) => {
      size += b.length;
      if (size < 2 * 1024 * 1024) output += b;
    });
  const timer = setTimeout(() => child.kill(), 600000);
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
  if (!expected.includes(code)) throw Error(`${label} exit=${code}: ${output.slice(-6000)}`);
  return output;
}
const config = (d) => JSON.parse(readFileSync(join(d, 'environment.json')));
const env = (d) => ({
  ...process.env,
  HDD_V2_PROJECT: config(d).project,
  HDD_V2_DB_INSTANCE: config(d).instance,
  HDD_V2_IMAGE: config(d).built,
  HDD_V2_SECRET_DIR: join(d, 'secrets'),
  HDD_V2_OPERATOR_INPUT: join(d, 'input'),
  HDD_V2_HOST_PORT: config(d).port,
  HDD_V2_OPS_EVIDENCE: evidence,
});
const host = (d, command, ...args) =>
  execute(process.execPath, ['scripts/operator/host.mjs', command, d, ...args], { label: command });
const compose = (d, args, options = {}) =>
  execute('docker', ['compose', '-p', config(d).project, '-f', 'compose.yaml', ...args], {
    env: env(d),
    ...options,
  });
const runner = (d, script, args = [], options = {}) =>
  compose(
    d,
    ['-f', 'compose.ops-test.yaml', 'run', '--rm', '-T', 'runner', 'node', script, ...args],
    { label: args[0] ?? 'runner', ...options },
  );
const phase = (d, name, label = name) => runner(d, 'tests/history/run.mjs', [name, label]);
const op = (d, args, options = {}) =>
  compose(d, ['run', '--rm', '-T', 'operator', ...args], { label: args[0], ...options });
const lastJson = (output) =>
  JSON.parse(
    output
      .trim()
      .split('\n')
      .findLast((l) => l.startsWith('{')),
  );
async function create(name, image) {
  const d = join(evidence, name + ' environment'),
    server = net.createServer();
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const port = String(server.address().port);
  await new Promise((r) => server.close(r));
  await host(d, 'init', port);
  environments.push(d);
  if (image) {
    const c = config(d);
    c.built = image;
    writeFileSync(join(d, 'environment.json'), JSON.stringify(c));
  } else await host(d, 'build');
  await host(d, 'provision');
  return d;
}
function input(d, name, data) {
  writeFileSync(join(d, 'input', name), JSON.stringify(data, null, 2));
  chmodSync(join(d, 'input', name), 0o640);
}
function copyInput(d, name, path) {
  copyFileSync(path, join(d, 'input', name));
  chmodSync(join(d, 'input', name), 0o640);
}
async function transfer(d, files) {
  const id = (
    await compose(d, ['run', '-d', '--entrypoint', 'sleep', 'operator', '60'], {
      label: 'transfer-helper',
    })
  )
    .trim()
    .split('\n')
    .at(-1);
  try {
    for (const [from, to] of files)
      await execute('docker', ['cp', id + ':' + from, to], { label: 'copy-task-artifact' });
  } finally {
    await execute('docker', ['stop', '--timeout', '10', id], { label: 'stop-owned-helper' });
    await execute('docker', ['rm', id], { label: 'remove-owned-helper' });
  }
}
async function backup(d, name) {
  const r = lastJson(await op(d, ['backup']));
  await transfer(d, [['/backup/current.age', join(evidence, name + '.age')]]);
  return r;
}
async function restore(d, source, name, receipt) {
  copyInput(d, 'recovery.age', join(evidence, name + '.age'));
  copyInput(d, 'restore.key', join(source, 'secrets', 'backup.key'));
  input(d, 'expectation.json', {
    sha256: receipt.sha256,
    sourceInstance: config(source).instance,
    destinationInstance: config(d).instance,
    destinationProject: config(d).project,
  });
  await compose(
    d,
    [
      'run',
      '--rm',
      '-T',
      '-e',
      'HDD_V2_BACKUP_IDENTITY_FILE=/input/restore.key',
      'operator',
      'restore',
      '/input/recovery.age',
      '/input/expectation.json',
    ],
    { label: name + '-restore' },
  );
}
const snapshot = (d, name) => runner(d, 'tests/operations/probe.mjs', ['snapshot', name]);
const worker = (d, action, target) =>
  runner(d, 'tests/operations/worker.mjs', [action, String(target)]);
try {
  const source = await create('synthetic-source');
  await phase(source, 'archive');
  await phase(source, 'verify', 'archive-source');
  const archiveBackup = await backup(source, 'archive-only');
  await worker(source, 'rebuild', 296);
  await phase(source, 'native');
  await phase(source, 'verify', 'source');
  const seed = lastJson(await op(source, ['seed-export', '/state/history.seed.tar.gz']));
  await transfer(source, [['/state/history.seed.tar.gz', join(evidence, 'history.seed.tar.gz')]]);
  const nativeBackup = await backup(source, 'native');
  await worker(source, 'once', 300);
  await snapshot(source, 'control-forward');
  await worker(source, 'repair-range', 296);
  await phase(source, 'verify', 'source-rewind');
  await worker(source, 'once', 300);
  await phase(source, 'verify', 'source-replay');
  await compose(source, ['stop']);

  const archive = await create('archive-restored', config(source).built);
  await restore(archive, source, 'archive-only', archiveBackup);
  await phase(archive, 'verify', 'archive-restored');
  copyInput(archive, 'seed.tar.gz', join(evidence, 'history.seed.tar.gz'));
  const expectation = (d) => ({
    instance: config(d).instance,
    sha256: seed.sha256,
    contract: seed.manifest.contractAddress,
    codeHash: '0x' + seed.manifest.codeSha256,
    checkpointHash: seed.manifest.checkpoint.blockHash,
  });
  input(archive, 'seed.json', expectation(archive));
  const refused = await op(archive, ['seed-import', '/input/seed.tar.gz', '/input/seed.json'], {
    expected: [1],
    label: 'nonempty-archive-seed-refusal',
  });
  assert.match(refused, /empty v2 target/);
  await phase(archive, 'verify', 'archive-after-refusal');
  await compose(archive, ['stop']);

  const seeded = await create('seed-restored', config(source).built);
  copyInput(seeded, 'seed.tar.gz', join(evidence, 'history.seed.tar.gz'));
  input(seeded, 'seed.json', expectation(seeded));
  await op(seeded, ['seed-import', '/input/seed.tar.gz', '/input/seed.json']);
  await phase(seeded, 'verify', 'seed-restored');
  await worker(seeded, 'once', 300);
  await phase(seeded, 'verify', 'seed-forward');
  await snapshot(seeded, 'seed-forward');
  await worker(seeded, 'repair-range', 296);
  await phase(seeded, 'verify', 'seed-rewind');
  await compose(seeded, ['stop']);

  const restored = await create('native-restored', config(source).built);
  await restore(restored, source, 'native', nativeBackup);
  await phase(restored, 'verify', 'native-restored');
  await worker(restored, 'once', 300);
  await phase(restored, 'verify', 'restored-forward');
  await snapshot(restored, 'restored-forward');
  await worker(restored, 'repair-range', 296);
  await phase(restored, 'verify', 'restored-rewind');
  await compose(restored, ['stop']);
  const read = (name) => JSON.parse(readFileSync(join(evidence, name + '.json')));
  for (const name of ['seed-forward', 'restored-forward'])
    assert.deepEqual(
      read(name),
      read('control-forward'),
      name + ' canonical fields and independent archive',
    );
  for (const name of [
    'source-rewind',
    'source-replay',
    'archive-restored',
    'archive-after-refusal',
    'seed-restored',
    'seed-forward',
    'seed-rewind',
    'native-restored',
    'restored-forward',
    'restored-rewind',
  ])
    assert.deepEqual(
      read(name + '-archive'),
      read(name.startsWith('archive-') ? 'archive-source-archive' : 'source-archive'),
      name,
    );

  if (process.argv.includes('--real')) {
    const real = await create('actual-hds', config(source).built),
      inputRoot = resolve('artifacts/task-pulsechain-history/input');
    for (const name of [
      'hds-pulsechain.json',
      'hds-pulsechain.json.receipt.json',
      'selection.json',
    ])
      copyInput(real, name, join(inputRoot, name));
    input(real, 'destination.json', {
      project: config(real).project,
      instance: config(real).instance,
      purpose: 'new-isolated-history-test',
    });
    await host(
      real,
      'compose',
      'run',
      '--rm',
      '-T',
      'operator',
      'history',
      'inspect',
      '/input/hds-pulsechain.json',
    );
    await host(
      real,
      'compose',
      'run',
      '--rm',
      '-T',
      'operator',
      'history',
      'inspect',
      '/input/hds-pulsechain.json',
      '/input/selection.json',
      '/input/hds-pulsechain.json.receipt.json',
    );
    for (let i = 0; i < 2; i++)
      await host(
        real,
        'compose',
        'run',
        '--rm',
        '-T',
        'operator',
        'history',
        'import',
        '/input/hds-pulsechain.json',
        '/input/selection.json',
        '/input/destination.json',
        '/input/hds-pulsechain.json.receipt.json',
      );
    await phase(real, 'real');
    await host(
      real,
      'compose',
      'run',
      '--rm',
      '-T',
      'operator',
      'history',
      'export',
      '/state/pulsechain-history.csv',
    );
    await transfer(real, [['/state/pulsechain-history.csv', join(evidence, 'real-history.csv')]]);
    await compose(real, ['stop']);
  }
  writeFileSync(
    join(evidence, 'result.json'),
    JSON.stringify(
      {
        status: 'PASS',
        sourceCommit: 'working-candidate',
        scope:
          'history-only isolated acceptance; synthetic native providers; no live qualification',
        archiveBackup: { sha256: archiveBackup.sha256, bytes: archiveBackup.bytes },
        nativeBackup: { sha256: nativeBackup.sha256, bytes: nativeBackup.bytes },
        seed: {
          sha256: seed.sha256,
          formatVersion: seed.manifest.formatVersion,
          schemaVersion: seed.manifest.schemaVersion,
        },
        real: process.argv.includes('--real'),
      },
      null,
      2,
    ),
  );
  console.log(
    'PASS history SQL/API/operator/portable/backup/native forward-rewind. Evidence:',
    evidence,
  );
} catch (e) {
  writeFileSync(join(evidence, 'failure.log'), e.stack);
  console.error(e.stack);
  process.exitCode = 1;
} finally {
  for (const d of environments.reverse())
    try {
      await host(d, 'destroy', config(d).project);
    } catch (e) {
      appendFileSync(join(evidence, 'cleanup.log'), e.message + '\n');
      process.exitCode = 1;
    }
}
