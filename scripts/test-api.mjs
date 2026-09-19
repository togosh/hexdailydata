import { randomBytes, randomUUID } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { mkdirSync, appendFileSync, writeFileSync } from 'node:fs';
import { resolve, relative, isAbsolute } from 'node:path';
const evidence = resolve(process.env.HDD_V2_API_EVIDENCE ?? 'artifacts/task-06/api-' + Date.now());
const rel = relative(resolve('artifacts/task-06'), evidence);
if (rel.startsWith('..') || isAbsolute(rel)) throw new Error('Task06 evidence directory required.');
mkdirSync(evidence, { recursive: true });
const project = 'hexdailydata-v2-api-' + randomUUID().slice(0, 8);
const env = {
  ...process.env,
  HDD_V2_PROJECT: project,
  HDD_V2_DB_INSTANCE: randomUUID(),
  HDD_V2_API_IMAGE: project + ':test',
  HDD_V2_API_EVIDENCE: evidence,
};
for (const role of ['ADMIN', 'API', 'WORKER', 'MIGRATOR'])
  env[`HDD_V2_${role}_PASSWORD`] = randomBytes(24).toString('hex');
const compose = ['compose', '-p', project, '-f', 'compose.sql.yaml', '-f', 'compose.api-test.yaml'];
function docker(args, timeout = 120000, input) {
  const r = spawnSync('docker', args, {
    env,
    encoding: 'utf8',
    timeout,
    maxBuffer: 8 * 1024 * 1024,
    ...(input === undefined ? {} : { input }),
  });
  appendFileSync(
    resolve(evidence, 'commands.txt'),
    `${new Date().toISOString()} docker ${args.join(' ')} exit=${r.status}\n`,
  );
  if (r.status !== 0)
    throw new Error(`exit=${r.status} ${r.error?.message ?? ''}\n${r.stdout}\n${r.stderr}`);
  return r.stdout.trim();
}
try {
  console.log(
    project,
    evidence,
    'combined limit: DB 1.5CPU/3GiB + runner .25CPU/.5GiB + compiled API .25CPU/.5GiB',
  );
  docker([...compose, 'up', '-d', '--wait', 'db']);
  docker([...compose, 'run', '--rm', '-T', 'storage-init']);
  const output = docker([...compose, 'run', '--rm', '-T', 'runner'], 1800000);
  writeFileSync(resolve(evidence, 'api.log'), output + '\n');
  console.log(output);
  docker(['build', '-f', 'deploy/Dockerfile', '-t', env.HDD_V2_API_IMAGE, '.'], 600000);
  docker([...compose, 'up', '-d', 'api']);
  const image = docker([...compose, 'run', '--rm', '-T', 'runner', 'node', 'tests/api/image.mjs']);
  writeFileSync(resolve(evidence, 'image.log'), image + '\n');
  console.log(image);
  writeFileSync(
    resolve(evidence, 'api-container.log'),
    docker([...compose, 'logs', '--no-color', 'api']) + '\n',
  );
  const safeProbe = `if(process.getuid()!==1000)throw Error('UID');for(const key of ['HDD_V2_WORKER_PASSWORD','HDD_V2_MIGRATOR_PASSWORD','HDD_V2_ADMIN_PASSWORD'])if(process.env[key])throw Error('Credential');for(const path of ['/exports/api-must-not-write','/app/api-must-not-write']){try{require('fs').writeFileSync(path,'x');throw Error('Writable')}catch(e){if(!['EROFS','EACCES'].includes(e.code))throw e}}console.log('UID1000; API-only credentials; read-only application/export mounts; no sibling source');`;
  writeFileSync(
    resolve(evidence, 'authority.log'),
    docker([...compose, 'exec', '-T', 'api', 'node', '-e', safeProbe]) + '\n',
  );
  docker([...compose, 'restart', 'api']);
  writeFileSync(
    resolve(evidence, 'restart.log'),
    docker([...compose, 'run', '--rm', '-T', 'runner', 'node', 'tests/api/image.mjs']) + '\n',
  );
  if (env.HDD_V2_API_SCALE !== '1') {
    const dump =
      docker([
        ...compose,
        'exec',
        '-T',
        'db',
        'pg_dump',
        '-U',
        'hdd_v2_admin',
        '-d',
        'hexdailydata_v2',
        '--data-only',
        '--schema=hdd',
        '--exclude-table=hdd.schema_migrations',
        '--no-owner',
        '--no-acl',
      ]) + '\n';
    writeFileSync(resolve(evidence, 'restore-input.sql'), dump);
    docker([...compose, 'down', '--volumes']);
    env.HDD_V2_DB_INSTANCE = randomUUID();
    docker([...compose, 'up', '-d', '--wait', 'db']);
    docker([...compose, 'run', '--rm', '-T', 'storage-init']);
    docker([...compose, 'run', '--rm', '-T', 'runner', 'node', 'src/db/main.ts', 'migrate']);
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
      dump,
    );
    docker([...compose, 'up', '-d', 'api']);
    writeFileSync(
      resolve(evidence, 'restore-api.log'),
      docker([
        ...compose,
        'run',
        '--rm',
        '-T',
        'runner',
        'node',
        'tests/api/image.mjs',
        '--restore',
      ]) + '\n',
    );
  }
} catch (e) {
  writeFileSync(resolve(evidence, 'failure.log'), e.stack);
  console.error(e.message);
  process.exitCode = 1;
} finally {
  try {
    docker([...compose, 'down', '--volumes']);
    docker(['image', 'rm', env.HDD_V2_API_IMAGE]);
  } catch (e) {
    appendFileSync(
      resolve(evidence, 'cleanup.log'),
      e.message + '\n',
    ); /* The image may not have been built after a test failure. */
  }
  writeFileSync(
    resolve(evidence, 'remaining-containers.txt'),
    docker([
      'ps',
      '-a',
      '--filter',
      'label=com.docker.compose.project=' + project,
      '--format',
      '{{.Names}}',
    ]) + '\n',
  );
  writeFileSync(
    resolve(evidence, 'remaining-volumes.txt'),
    docker([
      'volume',
      'ls',
      '--filter',
      'label=com.docker.compose.project=' + project,
      '--format',
      '{{.Name}}',
    ]) + '\n',
  );
}
