import { randomBytes, randomUUID } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { mkdirSync, appendFileSync, writeFileSync, openSync, closeSync } from 'node:fs';
import { resolve, relative, isAbsolute } from 'node:path';
const evidence = resolve(process.env.HDD_V2_DAILY_EVIDENCE ?? 'artifacts/task-05/integration');
const rel = relative(resolve('artifacts'), evidence);
if (rel.startsWith('..') || isAbsolute(rel)) throw new Error('Task-owned evidence required.');
mkdirSync(evidence, { recursive: true });
const phases = process.env.HDD_V2_DAILY_TEST_PHASE
  ? [process.env.HDD_V2_DAILY_TEST_PHASE]
  : ['functional', 'import', 'restore', 'scale'];
if (phases.some((p) => !['functional', 'import', 'restore', 'scale'].includes(p)))
  throw new Error('Invalid phase.');
for (const phase of phases) {
  const project = 'hexdailydata-v2-daily-' + randomUUID().slice(0, 8);
  const env = {
    ...process.env,
    HDD_V2_PROJECT: project,
    HDD_V2_DB_INSTANCE: randomUUID(),
    HDD_V2_DAILY_EVIDENCE: evidence,
    HDD_V2_DAILY_PHASE: phase,
  };
  for (const role of ['ADMIN', 'API', 'WORKER', 'MIGRATOR'])
    env[`HDD_V2_${role}_PASSWORD`] = randomBytes(24).toString('hex');
  const compose = ['compose', '-p', project, '-f', 'compose.sql.yaml', '-f', 'compose.daily.yaml'];
  function docker(args, timeout = 120000, stdio) {
    const r = spawnSync('docker', args, {
      env,
      encoding: 'utf8',
      timeout,
      maxBuffer: 16 * 1024 * 1024,
      ...(stdio ? { stdio } : {}),
    });
    appendFileSync(
      resolve(evidence, 'commands.txt'),
      `${new Date().toISOString()} docker ${args.join(' ')} exit=${r.status}\n`,
    );
    if (r.status !== 0)
      throw new Error(
        `docker exit=${r.status} ${r.error?.message ?? ''}\n${r.stdout ?? ''}\n${r.stderr ?? ''}`,
      );
    return r.stdout?.trim() ?? '';
  }
  let failed = false;
  try {
    console.log(phase, project, '2 CPU / 4 GiB combined; offline private network.');
    console.log(docker([...compose, 'up', '-d', '--wait', 'db']));
    docker([...compose, 'run', '--rm', '-T', 'storage-init']);
    if (phase === 'restore') {
      docker([...compose, 'run', '--rm', '-T', 'runner', 'node', 'src/db/main.ts', 'migrate']);
      const input = openSync(resolve(evidence, 'recovery.sql'), 'r');
      try {
        docker(
          [
            ...compose,
            'exec',
            '-T',
            'db',
            'psql',
            '-v',
            'ON_ERROR_STOP=1',
            '-U',
            'hdd_v2_admin',
            '-d',
            'hexdailydata_v2',
          ],
          120000,
          [input, 'pipe', 'pipe'],
        );
      } finally {
        closeSync(input);
      }
    }
    const output = docker([...compose, 'run', '--rm', '-T', 'runner'], 1800000);
    writeFileSync(resolve(evidence, phase + '.log'), output + '\n');
    console.log(output);
    if (phase === 'functional') {
      const out = openSync(resolve(evidence, 'recovery.sql'), 'w');
      try {
        docker(
          [
            ...compose,
            'exec',
            '-T',
            'db',
            'pg_dump',
            '-U',
            'hdd_v2_admin',
            '-d',
            'hexdailydata_v2',
            '--schema=hdd',
            '--exclude-table=hdd.schema_migrations',
            '--data-only',
            '--no-owner',
            '--no-acl',
          ],
          120000,
          ['ignore', out, 'pipe'],
        );
      } finally {
        closeSync(out);
      }
    }
  } catch (e) {
    failed = true;
    writeFileSync(resolve(evidence, phase + '-failure-' + Date.now() + '.log'), e.stack);
    console.error(e.message);
    process.exitCode = 1;
  } finally {
    try {
      console.log(docker([...compose, 'down', '--volumes']));
    } catch (e) {
      console.error(e.message);
      failed = true;
      process.exitCode = 1;
    }
    appendFileSync(
      resolve(evidence, 'runs.txt'),
      `${new Date().toISOString()} ${phase} ${project} exit=${failed ? 1 : 0}\n`,
    );
  }
  if (failed) break;
}
