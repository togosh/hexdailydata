import { randomUUID, randomBytes } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { mkdirSync, writeFileSync, appendFileSync } from 'node:fs';
import { resolve, relative, isAbsolute } from 'node:path';

const id = randomUUID().slice(0, 8),
  project = `hexdailydata-v2-canary-${id}`;
const evidence = resolve(
  process.env.HDD_V2_CANARY_EVIDENCE ?? `artifacts/task-03/early-canary/run-${id}`,
);
const relativeEvidence = relative(resolve('artifacts'), evidence);
if (relativeEvidence.startsWith('..') || isAbsolute(relativeEvidence))
  throw Error('Canary test evidence must remain in artifacts.');
mkdirSync(evidence, { recursive: true });
const env = {
  ...process.env,
  HDD_V2_PROJECT: project,
  HDD_V2_DB_INSTANCE: randomUUID(),
  HDD_V2_SQL_EVIDENCE: evidence,
};
for (const role of ['ADMIN', 'API', 'WORKER', 'MIGRATOR'])
  env[`HDD_V2_${role}_PASSWORD`] = randomBytes(24).toString('hex');
const compose = [
  'compose',
  '-p',
  project,
  '-f',
  'compose.sql.yaml',
  '-f',
  'compose.canary-test.yaml',
];
let serial = 0;
function run(args, timeout = 180000) {
  const start = performance.now(),
    r = spawnSync('docker', args, { env, encoding: 'utf8', timeout, maxBuffer: 4 * 1024 * 1024 });
  const name = `${++serial}.log`;
  writeFileSync(resolve(evidence, name), r.stdout + r.stderr);
  appendFileSync(
    resolve(evidence, 'commands.txt'),
    `docker ${args.join(' ')} exit=${r.status} durationMs=${(performance.now() - start).toFixed(1)} log=${name}\n`,
  );
  if (r.status !== 0) throw Error(`${name}: ${r.stdout}\n${r.stderr}\n${r.error ?? ''}`);
  return r.stdout.trim();
}
console.log(
  `Evidence ${evidence}; internal network, DB1.5CPU/3GiB + runner0.5CPU/1GiB; zero provider access.`,
);
try {
  run([...compose, 'up', '-d', '--wait', 'db']);
  run([
    ...compose,
    'run',
    '--rm',
    '-T',
    '--user',
    '0:0',
    '--cap-add',
    'CHOWN',
    'runner',
    'chown',
    '1000:1000',
    '/canary-test',
  ]);
  console.log(
    run(
      [
        ...compose,
        'run',
        '--rm',
        '-T',
        'runner',
        'node',
        'tests/canary/run.mjs',
        ...(process.argv.includes('--diagnostics-only') ? ['--diagnostics-only'] : []),
      ],
      600000,
    ),
  );
} catch (e) {
  console.error(e.message);
  process.exitCode = 1;
} finally {
  try {
    console.log(run([...compose, 'down', '--volumes', '--remove-orphans']));
  } catch (e) {
    console.error(e.message);
    process.exitCode = 1;
  }
  appendFileSync(
    resolve(evidence, 'commands.txt'),
    `result exit=${process.exitCode ?? 0}; cleanup scoped to ${project}; retained Temp folders untouched\n`,
  );
}
