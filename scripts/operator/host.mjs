import { randomBytes, randomUUID } from 'node:crypto';
import {
  mkdirSync,
  readFileSync,
  writeFileSync,
  existsSync,
  lstatSync,
  realpathSync,
  appendFileSync,
  readdirSync,
  chmodSync,
} from 'node:fs';
import { resolve, join, relative, isAbsolute, dirname } from 'node:path';
import { spawnSync } from 'node:child_process';

const [command, directory, ...args] = process.argv.slice(2);
if (!directory)
  throw new Error(
    'Usage: node scripts/operator/host.mjs init|build|provision|release|rollback|compose|destroy <owned environment directory> [args]',
  );
const root = resolve(directory),
  rel = relative(process.cwd(), root);
if (
  !rel ||
  rel.startsWith('..') ||
  isAbsolute(rel) ||
  !['.local', 'artifacts'].includes(rel.split(/[\\/]/)[0])
)
  throw new Error('Environment must be inside this source checkout.');
for (let ancestor = root; ancestor !== dirname(ancestor); ancestor = dirname(ancestor))
  if (existsSync(ancestor) && lstatSync(ancestor).isSymbolicLink())
    throw new Error('Symlink environment ancestor refused.');
const configPath = join(root, 'environment.json');
if (command === 'init') {
  if (process.platform === 'linux' && (process.getuid() !== 1000 || process.getgid() !== 1000))
    throw new Error(
      'Supported Linux provisioning requires operator UID/GID1000 for private secret-file ownership.',
    );
  if (existsSync(root) && readdirSync(root).length)
    throw new Error('Initialization requires a new empty environment directory.');
  mkdirSync(root, { recursive: true, mode: 0o700 });
  if (existsSync(configPath))
    throw new Error('Environment already exists; retain its identity and secrets.');
  const project = 'hexdailydata-v2-' + randomUUID().slice(0, 8);
  mkdirSync(join(root, 'secrets'), { mode: 0o700 });
  mkdirSync(join(root, 'input'), { mode: 0o750 });
  chmodSync(join(root, 'input'), 0o750);
  for (const role of ['admin', 'api', 'worker', 'migrator']) {
    writeFileSync(join(root, 'secrets', role), randomBytes(32).toString('hex') + '\n', {
      flag: 'wx',
      mode: 0o640,
    });
    chmodSync(join(root, 'secrets', role), 0o640);
  }
  writeFileSync(join(root, 'compose.env'), '# Explicit host.mjs environment only.\n', {
    flag: 'wx',
    mode: 0o600,
  });
  writeFileSync(
    configPath,
    JSON.stringify(
      {
        project,
        instance: randomUUID(),
        image: project + ':local',
        port: args[0] ?? '4320',
        createdAt: new Date().toISOString(),
      },
      null,
      2,
    ) + '\n',
    { flag: 'wx', mode: 0o600 },
  );
  console.log('Created new empty v2 configuration:', project);
  process.exit(0);
}
if (
  lstatSync(root).isSymbolicLink() ||
  realpathSync(root) !== root ||
  lstatSync(configPath).isSymbolicLink()
)
  throw new Error('Indirect environment path refused.');
for (const child of ['secrets', 'input', 'compose.env']) {
  const path = join(root, child);
  if (lstatSync(path).isSymbolicLink()) throw new Error('Indirect environment child refused.');
}
for (const name of readdirSync(join(root, 'secrets'))) {
  if (!lstatSync(join(root, 'secrets', name)).isFile()) throw new Error('Non-file secret refused.');
}
const config = JSON.parse(readFileSync(configPath, 'utf8'));
if (
  !/^hexdailydata-v2-[a-z0-9-]+$/.test(config.project) ||
  !/^[0-9a-f-]{36}$/.test(config.instance) ||
  !/^\d{1,5}$/.test(config.port)
)
  throw new Error('Invalid explicit environment identity.');
const env = {
  ...process.env,
  HDD_V2_PROJECT: config.project,
  HDD_V2_DB_INSTANCE: config.instance,
  HDD_V2_IMAGE: config.current ?? config.built ?? config.image,
  HDD_V2_SECRET_DIR: join(root, 'secrets'),
  HDD_V2_OPERATOR_INPUT: join(root, 'input'),
  HDD_V2_HOST_PORT: config.port,
};
const compose = [
  'compose',
  '--env-file',
  join(root, 'compose.env'),
  '-p',
  config.project,
  '-f',
  'compose.yaml',
];
function docker(argv, { allowFailure = false, timeout = 120000, quiet = false } = {}) {
  const r = spawnSync('docker', argv, {
    env,
    encoding: 'utf8',
    timeout,
    maxBuffer: 4 * 1024 * 1024,
  });
  // Command arguments contain identifiers/paths only, never secret values or rendered config.
  appendFileSync(
    join(root, 'commands.txt'),
    `${new Date().toISOString()} docker ${argv.join(' ')} exit=${r.status}\n`,
  );
  if (!quiet && r.stdout) process.stdout.write(r.stdout);
  if (!quiet && r.stderr) process.stderr.write(r.stderr);
  if (r.status !== 0 && !allowFailure)
    throw new Error(`docker ${argv[0]} failed: exit=${r.status}; ${r.stderr.slice(-4000)}`);
  return r;
}
const volumes = ['db_data', 'state', 'exports', 'provider', 'maintenance', 'backup'];
function ownedVolumes(create = false) {
  for (const name of volumes) {
    const full = config.project + '_' + name;
    const r = docker(['volume', 'inspect', full], { allowFailure: true, quiet: true });
    if (r.status !== 0) {
      if (create)
        docker(
          [
            'volume',
            'create',
            '--label',
            'com.docker.compose.project=' + config.project,
            '--label',
            'com.docker.compose.volume=' + name,
            '--label',
            'hdd.v2.instance=' + config.instance,
            full,
          ],
          { quiet: true },
        );
      else throw new Error('Missing owned volume: ' + name);
    } else if (JSON.parse(r.stdout)[0].Labels?.['hdd.v2.instance'] !== config.instance)
      throw new Error('Unowned volume refused: ' + name);
  }
}
function save() {
  writeFileSync(configPath, JSON.stringify(config, null, 2) + '\n', { mode: 0o600 });
}
try {
  if (command === 'build') {
    docker(
      [
        'build',
        '-f',
        'deploy/Dockerfile',
        '--build-arg',
        'HDD_V2_RELEASE=' + config.project,
        '-t',
        config.image,
        '.',
      ],
      { timeout: 600000 },
    );
    config.built = docker(['image', 'inspect', config.image, '--format', '{{.Id}}'], {
      quiet: true,
    }).stdout.trim();
    save();
  } else if (command === 'provision') {
    if (!config.built) throw new Error('Build the release first.');
    env.HDD_V2_IMAGE = config.built;
    if (!existsSync(join(root, 'secrets', 'backup.key')))
      docker([
        'run',
        '--rm',
        '--network',
        'none',
        '--user',
        '1000:1000',
        '--mount',
        `type=bind,source=${join(root, 'secrets')},target=/keys`,
        config.built,
        'age-keygen',
        '-o',
        '/keys/backup.key',
      ]);
    docker([
      'run',
      '--rm',
      '--network',
      'none',
      '--user',
      '1000:1000',
      '--mount',
      `type=bind,source=${join(root, 'secrets')},target=/keys`,
      config.built,
      'chmod',
      '640',
      '/keys/backup.key',
    ]);
    ownedVolumes(true);
    docker([...compose, 'run', '--rm', '-T', 'volume-init']);
    docker([...compose, 'up', '-d', '--wait', 'db']);
    docker([...compose, 'run', '--rm', '-T', 'migrate']);
    config.provisioned = true;
    save();
  } else if (command === 'release' || command === 'rollback') {
    ownedVolumes();
    const target = command === 'rollback' ? config.previous : config.built;
    if (!target || !/^sha256:[a-f0-9]{64}$/.test(target))
      throw new Error(
        'Build/provision a local release or retain a previous compatible image first.',
      );
    env.HDD_V2_IMAGE = target;
    docker([...compose, 'stop', 'api', 'worker']);
    try {
      docker([...compose, 'run', '--rm', '-T', 'migrate']);
      docker([...compose, 'up', '-d', '--wait', 'api', 'worker']);
      for (const service of ['api', 'worker']) {
        const id = docker([...compose, 'ps', '-q', service], { quiet: true }).stdout.trim();
        const state = JSON.parse(
          docker(['inspect', id, '--format', '{{json .State}}'], { quiet: true }).stdout,
        );
        const actual = docker(['inspect', id, '--format', '{{.Image}}'], {
          quiet: true,
        }).stdout.trim();
        if (!state.Running || actual !== target) throw new Error('Release process/image mismatch.');
      }
      const old = config.current,
        retired = config.previous;
      config.current = target;
      if (old && old !== target) config.previous = old;
      save();
      if (retired && retired !== config.current && retired !== config.previous) {
        const inspection = docker(['image', 'inspect', retired], {
          quiet: true,
          allowFailure: true,
        });
        if (
          inspection.status === 0 &&
          JSON.parse(inspection.stdout)[0].Config.Labels?.['hdd.v2.project'] === config.project
        )
          if (docker(['image', 'rm', retired], { allowFailure: true }).status !== 0)
            console.warn('Older owned image retained (in use or removal refused):', retired);
      }
      console.log('Release accepted locally:', target, 'production qualification NOT_RUN');
    } catch (error) {
      docker([...compose, 'stop', 'api', 'worker'], { allowFailure: true });
      console.error(
        'Release failed; API and worker stopped. Database retained. Correct configuration/image, then release or compatible rollback.',
      );
      throw error;
    }
  } else if (command === 'compose') {
    ownedVolumes();
    // Operator-side pass-through; application containers never see the Docker socket.
    const r = docker([...compose, ...args], { allowFailure: true, timeout: 3600000 });
    process.exitCode = r.status ?? 1;
  } else if (command === 'destroy') {
    ownedVolumes();
    if (args[0] !== config.project)
      throw new Error(
        'Destructive disposable cleanup requires the exact project name as final argument.',
      );
    docker([...compose, 'down', '--volumes', '--remove-orphans']);
    console.log(
      'Removed only owned disposable project volumes; source, keys and evidence retained.',
    );
  } else throw new Error('Unknown host action.');
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
}
