import { randomBytes, randomUUID } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { mkdirSync, appendFileSync, writeFileSync } from 'node:fs';
import { resolve, relative, isAbsolute } from 'node:path';
const evidence = resolve(process.env.HDD_V2_LIVE_EVIDENCE ?? 'artifacts/task-04/sql');
const rel = relative(resolve('artifacts'), evidence);
if (rel.startsWith('..') || isAbsolute(rel))
  throw new Error('Evidence must be task-owned repository artifacts.');
mkdirSync(evidence, { recursive: true });
const project = `hexdailydata-v2-live-${randomUUID().slice(0, 8)}`;
const env = {
  ...process.env,
  HDD_V2_PROJECT: project,
  HDD_V2_DB_INSTANCE: randomUUID(),
  HDD_V2_LIVE_EVIDENCE: evidence,
};
for (const role of ['ADMIN', 'API', 'WORKER', 'MIGRATOR'])
  env[`HDD_V2_${role}_PASSWORD`] = randomBytes(24).toString('hex');
const compose = ['compose', '-p', project, '-f', 'compose.sql.yaml', '-f', 'compose.live.yaml'];
function docker(args, timeout = 60000) {
  const r = spawnSync('docker', args, {
    env,
    encoding: 'utf8',
    timeout,
    maxBuffer: 16 * 1024 * 1024,
  });
  if (r.status !== 0)
    throw new Error(
      `docker ${args.join(' ')} exit=${r.status}: ${r.error?.message ?? ''}\n${r.stdout}\n${r.stderr}`,
    );
  return r.stdout.trim();
}
let primary;
try {
  console.log('Project', project, 'combined 2 CPU / 4 GiB; synthetic provider transport only.');
  console.log(docker([...compose, 'up', '-d', '--wait', '--wait-timeout', '100', 'db'], 180000));
  const id = docker([...compose, 'ps', '-q', 'db']);
  console.log(
    'DB limits',
    docker([
      'inspect',
      '--format',
      '{{.HostConfig.NanoCpus}} {{.HostConfig.Memory}} {{json .NetworkSettings.Ports}}',
      id,
    ]),
  );
  const output = docker([...compose, 'run', '--rm', '-T', 'runner'], 600000);
  writeFileSync(resolve(evidence, 'integration.log'), output + '\n');
  console.log(output);
} catch (error) {
  primary = error;
  console.error(error.message);
  process.exitCode = 1;
} finally {
  try {
    console.log(docker([...compose, 'down', '--volumes']));
    console.log('Removed only', project);
  } catch (error) {
    console.error('Cleanup failure:', error.message);
    if (!primary) process.exitCode = 1;
  }
  appendFileSync(
    resolve(evidence, 'runs.txt'),
    `${new Date().toISOString()} ${project} exit=${process.exitCode ?? 0}\n`,
  );
}
