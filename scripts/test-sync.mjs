import { randomBytes, randomUUID } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { resolve, relative, isAbsolute } from 'node:path';
import { mkdirSync, appendFileSync, writeFileSync } from 'node:fs';

const evidence = resolve(process.env.HDD_V2_SYNC_EVIDENCE ?? 'artifacts/task-03');
const relativeEvidence = relative(resolve('artifacts'), evidence);
if (relativeEvidence.startsWith('..') || isAbsolute(relativeEvidence))
  throw new Error('Sync evidence must remain in repository artifacts.');
mkdirSync(evidence, { recursive: true });
let failure;
const phases = process.env.HDD_V2_SYNC_TEST_PHASE
  ? [process.env.HDD_V2_SYNC_TEST_PHASE]
  : ['build', 'early-import', 'import', 'unpruned', 'sparse-build', 'sparse-import', 'busy'];
if (
  phases.some(
    (p) =>
      ![
        'build',
        'early-import',
        'import',
        'unpruned',
        'sparse-build',
        'sparse-import',
        'busy',
      ].includes(p),
  )
)
  throw new Error('Unknown test phase.');
for (const phase of phases) {
  if (failure) break;
  const project = `hexdailydata-v2-sync-${randomUUID().slice(0, 8)}`;
  const env = {
    ...process.env,
    HDD_V2_PROJECT: project,
    HDD_V2_SYNC_EVIDENCE: evidence,
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
    const output = docker(
      [
        ...compose,
        'run',
        '--rm',
        '-T',
        'runner',
        'node',
        phase.startsWith('sparse-') || phase === 'busy'
          ? 'tests/sync/acquisition.mjs'
          : 'tests/sync/run.mjs',
      ],
      900000,
    );
    writeFileSync(`${evidence}/${phase}-integration.log`, output + '\n');
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
      `${evidence}/runs.txt`,
      `${new Date().toISOString()} ${phase} ${project} exit=${process.exitCode ?? 0}\n`,
    );
  }
}
