import { randomBytes, randomUUID } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { mkdirSync, writeFileSync, appendFileSync, existsSync } from 'node:fs';
import { resolve, relative, isAbsolute } from 'node:path';
const root = resolve('artifacts/task-07');
const evidence = resolve(process.env.HDD_V2_WEB_EVIDENCE ?? `${root}/web-${Date.now()}`);
if (relative(root, evidence).startsWith('..') || isAbsolute(relative(root, evidence)))
  throw new Error('New Task07 evidence required.');
if (existsSync(evidence)) throw new Error('Refusing to overwrite existing browser evidence.');
mkdirSync(evidence, { recursive: true });
const project = 'hexdailydata-v2-web-' + randomUUID().slice(0, 8);
const env = {
  ...process.env,
  HDD_V2_PROJECT: project,
  HDD_V2_DB_INSTANCE: randomUUID(),
  HDD_V2_WEB_EVIDENCE: evidence,
  HDD_V2_SQL_EVIDENCE: evidence,
  HDD_V2_WEB_INPUT: resolve(evidence, 'input'),
  HDD_V2_WEB_SCENARIO: 'charts',
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
  const port = docker(['port', 'web', '4320']).split(':').at(-1);
  const args = [script, `http://127.0.0.1:${port}`, scenario, evidence];
  const output = command(process.execPath, args, 300000);
  writeFileSync(resolve(evidence, `${scenario}.log`), output + '\n');
  console.log(output);
}
try {
  console.log(project, evidence, 'Offline compiled Charts; fresh private SQL; no providers');
  docker(['up', '-d', '--wait', 'db']);
  docker(['run', '--rm', '-T', 'storage-init']);
  for (const mode of ['archive', 'both', 'native', 'later', 'none']) {
    for (const [name, script] of [
      ['setup', 'tests/browser/charts-setup.mjs'],
      ['api', 'tests/api/charts.mjs'],
    ]) {
      const output = docker(['run', '--rm', '-T', 'runner', 'node', script, mode]);
      writeFileSync(resolve(evidence, `${name}-${mode}.log`), output + '\n');
      console.log(output);
    }
    if (mode === 'archive') docker(['up', '-d', 'web']);
    browser(mode, 'tests/browser/charts.mjs');
  }
  writeFileSync(
    resolve(evidence, 'result.json'),
    JSON.stringify({ status: 'PASS', project, liveRequests: 0 }, null, 2),
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
