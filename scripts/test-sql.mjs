import { randomBytes, randomUUID } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { mkdirSync, appendFileSync } from 'node:fs';
const project = `hexdailydata-v2-sql-${randomUUID().slice(0, 8)}`;
const env = { ...process.env, HDD_V2_PROJECT: project, HDD_V2_DB_INSTANCE: randomUUID() };
for (const role of ['ADMIN', 'API', 'WORKER', 'MIGRATOR'])
  env[`HDD_V2_${role}_PASSWORD`] = randomBytes(24).toString('hex');
mkdirSync('artifacts/task-02', { recursive: true });
const compose = ['compose', '-p', project, '-f', 'compose.sql.yaml'];
function docker(args, timeout = 60_000) {
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
console.log(
  `Project ${project}; combined SQL+Node allocation: 2 vCPU / 4 GiB. No API/export load.`,
);
let primary;
try {
  console.log(docker([...compose, 'up', '-d', '--wait', '--wait-timeout', '100', 'db'], 180_000));
  const id = docker([...compose, 'ps', '-q', 'db']);
  console.log(
    'DB constraints:',
    docker([
      'inspect',
      '--format',
      '{{.HostConfig.NanoCpus}} {{.HostConfig.Memory}} {{.HostConfig.MemorySwap}} {{json .NetworkSettings.Ports}}',
      id,
    ]),
  );
  const disk = docker([...compose, 'exec', '-T', 'db', 'df', '-Pk', '/var/lib/postgresql/data']);
  console.log('Disk before:\n' + disk);
  const cells = disk.split('\n').at(-1).trim().split(/\s+/);
  if (Number(cells[3]) * 1024 < Math.max(8 * 1024 ** 3, Number(cells[1]) * 1024 * 0.2))
    throw new Error('Insufficient 20%/8GiB disk reserve.');
  console.log(docker([...compose, 'run', '--rm', '-T', 'runner'], 600_000));
  console.log(
    'Disk after:\n' +
      docker([...compose, 'exec', '-T', 'db', 'df', '-Pk', '/var/lib/postgresql/data']),
  );
  console.log(
    'DB sampled stats:',
    docker(['stats', '--no-stream', '--format', '{{.CPUPerc}} {{.MemUsage}} {{.BlockIO}}', id]),
  );
  console.log('SQL acceptance exit=0');
} catch (error) {
  primary = error;
  console.error(error.message);
  process.exitCode = 1;
} finally {
  try {
    console.log(docker([...compose, 'down', '--volumes', '--remove-orphans'], 60_000));
    console.log(`Removed only ${project} resources.`);
  } catch (error) {
    console.error('Cleanup failure:', error.message);
    if (!primary) process.exitCode = 1;
  }
  appendFileSync(
    'artifacts/task-02/runs.txt',
    `${new Date().toISOString()} ${project} exit=${process.exitCode ?? 0}\n`,
  );
}
