import { randomBytes, randomUUID, createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import {
  mkdirSync,
  writeFileSync,
  readFileSync,
  copyFileSync,
  appendFileSync,
  existsSync,
} from 'node:fs';
import { resolve, relative, isAbsolute } from 'node:path';
const root = resolve('artifacts/task-07');
const evidence = resolve(process.env.HDD_V2_WEB_EVIDENCE ?? `${root}/web-${Date.now()}`);
if (relative(root, evidence).startsWith('..') || isAbsolute(relative(root, evidence)))
  throw new Error('New Task07 evidence required.');
if (existsSync(evidence)) throw new Error('Refusing to overwrite existing browser evidence.');
mkdirSync(evidence, { recursive: true });
const large = process.argv.includes('--scale');
const project = 'hexdailydata-v2-web-' + randomUUID().slice(0, 8);
const env = {
  ...process.env,
  HDD_V2_PROJECT: project,
  HDD_V2_DB_INSTANCE: randomUUID(),
  HDD_V2_WEB_EVIDENCE: evidence,
  HDD_V2_SQL_EVIDENCE: evidence,
  HDD_V2_WEB_INPUT: resolve(evidence, 'input'),
  HDD_V2_WEB_SCENARIO: 'empty',
  HDD_V2_ALLOW_LIVE_RPC: 'false',
};
for (const role of ['ADMIN', 'API', 'WORKER', 'MIGRATOR'])
  env[`HDD_V2_${role}_PASSWORD`] = randomBytes(24).toString('hex');
mkdirSync(env.HDD_V2_WEB_INPUT);
const compose = ['compose', '-p', project, '-f', 'compose.sql.yaml', '-f', 'compose.web-test.yaml'];
function command(binary, args, timeout = 120000) {
  const r = spawnSync(binary, args, { env, encoding: 'utf8', timeout, maxBuffer: 8 * 1024 * 1024 });
  appendFileSync(
    resolve(evidence, 'commands.txt'),
    `${new Date().toISOString()} ${binary} ${args.join(' ')} exit=${r.status}\n`,
  );
  if (r.status !== 0)
    throw new Error(`exit=${r.status} ${r.error?.message ?? ''}\n${r.stdout}\n${r.stderr}`);
  return r.stdout.trim();
}
const docker = (args, timeout) => command('docker', [...compose, ...args], timeout);
function browser(scenario, script = 'tests/browser/journey.mjs') {
  if (process.argv.includes('--visual-only') && scenario !== 'visual') return;
  const port = docker(['port', 'web', '4320']).split(':').at(-1);
  const args = [script, `http://127.0.0.1:${port}`, scenario, evidence];
  const output = command(process.execPath, args, 300000);
  writeFileSync(resolve(evidence, `${scenario}.log`), output + '\n');
  console.log(output);
}
try {
  console.log(
    project,
    evidence,
    'DB 1.5CPU/3GiB + API .25CPU/.5GiB + setup .25CPU/.5GiB; browser outside envelope',
  );
  docker(['up', '-d', '--wait', 'db']);
  docker(['run', '--rm', '-T', 'storage-init']);
  console.log(docker(['run', '--rm', '-T', 'runner', 'node', 'tests/browser/setup.mjs', 'empty']));
  if (!large) {
    docker(['up', '-d', 'web']);
    browser('empty');
    const retained = resolve('artifacts/task-pulsechain-history/input');
    const raw = readFileSync(resolve(retained, 'hds-pulsechain.json'));
    const digest = createHash('sha256').update(raw).digest('hex');
    if (
      raw.length !== 4829074 ||
      digest !== 'cb314fca46c2beae121349a3b375c71874bb72b76caf3b32cf98724b9db18520'
    )
      throw new Error('Retained HDS input identity mismatch. No download permitted.');
    for (const name of [
      'hds-pulsechain.json',
      'hds-pulsechain.json.receipt.json',
      'selection.json',
    ])
      copyFileSync(resolve(retained, name), resolve(env.HDD_V2_WEB_INPUT, name));
    writeFileSync(
      resolve(env.HDD_V2_WEB_INPUT, 'destination.json'),
      JSON.stringify({
        project,
        instance: env.HDD_V2_DB_INSTANCE,
        purpose: 'new-isolated-history-test',
      }),
    );
    const imported = docker([
      'run',
      '--rm',
      '-T',
      'runner',
      'node',
      'dist/operator/main.js',
      'history',
      'import',
      '/input/hds-pulsechain.json',
      '/input/selection.json',
      '/input/destination.json',
      '/input/hds-pulsechain.json.receipt.json',
    ]);
    writeFileSync(resolve(evidence, 'real-import.json'), imported + '\n');
    writeFileSync(
      resolve(evidence, 'input-identity.json'),
      JSON.stringify(
        {
          bytes: raw.length,
          sha256: digest,
          project,
          instance: env.HDD_V2_DB_INSTANCE,
          originalReadOnly: true,
          downloadRequests: 0,
        },
        null,
        2,
      ),
    );
    browser('archive');
    docker(['stop', 'web']);
  }
  env.HDD_V2_WEB_SCENARIO = large ? 'scale' : 'native';
  console.log(
    docker(
      ['run', '--rm', '-T', 'runner', 'node', 'tests/browser/setup.mjs', env.HDD_V2_WEB_SCENARIO],
      300000,
    ),
  );
  docker(['up', '-d', 'web']);
  browser(env.HDD_V2_WEB_SCENARIO);
  if (process.argv.includes('--visual') || process.argv.includes('--visual-only')) {
    console.log(docker(['run', '--rm', '-T', 'runner', 'node', 'tests/browser/visual-setup.mjs']));
    browser('visual', 'tests/browser/visual.mjs');
  }
  writeFileSync(
    resolve(evidence, 'result.json'),
    JSON.stringify({ status: 'PASS', project, scenario: env.HDD_V2_WEB_SCENARIO }, null, 2),
  );
} catch (e) {
  writeFileSync(resolve(evidence, 'failure.log'), e.stack);
  console.error(e.message);
  process.exitCode = 1;
} finally {
  try {
    writeFileSync(resolve(evidence, 'server.log'), docker(['logs', '--no-color', 'web']));
    docker(['down', '--volumes']);
    const remaining = command('docker', [
      'ps',
      '-a',
      '--filter',
      'label=com.docker.compose.project=' + project,
      '--format',
      '{{.Names}}',
    ]);
    const volumes = command('docker', [
      'volume',
      'ls',
      '--filter',
      'label=com.docker.compose.project=' + project,
      '--format',
      '{{.Name}}',
    ]);
    writeFileSync(
      resolve(evidence, 'cleanup.json'),
      JSON.stringify(
        {
          project,
          remainingContainers: remaining,
          remainingVolumes: volumes,
          priorResourcesTouched: false,
        },
        null,
        2,
      ),
    );
  } catch (e) {
    writeFileSync(resolve(evidence, 'cleanup-failure.txt'), e.message);
    process.exitCode = 1;
  }
}
