import { randomBytes, randomUUID } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { mkdirSync, appendFileSync, writeFileSync } from 'node:fs';

mkdirSync('artifacts/task-03', { recursive: true });
let failure;
const phases = process.env.HDD_V2_SYNC_TEST_PHASE
  ? [process.env.HDD_V2_SYNC_TEST_PHASE]
  : ['build', 'import', 'unpruned'];
if (phases.some((p) => !['build', 'import', 'unpruned'].includes(p)))
  throw new Error('Unknown test phase.');
for (const phase of phases) {
  if (failure) break;
  const project = `hexdailydata-v2-sync-${randomUUID().slice(0, 8)}`;
  const env = {
    ...process.env,
    HDD_V2_PROJECT: project,
    HDD_V2_DB_INSTANCE: randomUUID(),
    HDD_V2_SYNC_PHASE: phase,
  };
  for (const role of ['ADMIN', 'API', 'WORKER', 'MIGRATOR'])
    env[`HDD_V2_${role}_PASSWORD`] = randomBytes(24).toString('hex');
  const compose = ['compose', '-p', project, '-f', 'compose.sql.yaml', '-f', 'compose.sync.yaml'];
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
  console.log(
    `Task03 ${phase}: ${project}, 2 CPU / 4 GiB, internal network, no published DB port.`,
  );
  try {
    console.log(docker([...compose, 'up', '-d', '--wait', '--wait-timeout', '100', 'db'], 180000));
    const id = docker([...compose, 'ps', '-q', 'db']);
    console.log(
      'DB constraints:',
      docker([
        'inspect',
        '--format',
        '{{.HostConfig.NanoCpus}} {{.HostConfig.Memory}} {{json .NetworkSettings.Ports}}',
        id,
      ]),
    );
    console.log(docker([...compose, 'exec', '-T', 'db', 'df', '-Pk', '/var/lib/postgresql/data']));
    const output = docker([...compose, 'run', '--rm', '-T', 'runner'], 900000);
    writeFileSync(`artifacts/task-03/${phase}-integration.log`, output + '\n');
    console.log(output);
    console.log(
      'DB sampled resources:',
      docker(['stats', '--no-stream', '--format', '{{.MemUsage}} {{.BlockIO}}', id]),
    );
  } catch (error) {
    failure = error;
    console.error(error.message);
    process.exitCode = 1;
  } finally {
    try {
      console.log(docker([...compose, 'down', '--volumes', '--remove-orphans']));
      console.log(`Removed only ${project}.`);
    } catch (error) {
      console.error('Cleanup failure:', error.message);
      if (!failure) failure = error;
      process.exitCode = 1;
    }
    appendFileSync(
      'artifacts/task-03/runs.txt',
      `${new Date().toISOString()} ${phase} ${project} exit=${process.exitCode ?? 0}\n`,
    );
  }
}
