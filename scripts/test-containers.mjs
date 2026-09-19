import { randomBytes, randomUUID } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import assert from 'node:assert/strict';

// Only this run's Compose namespace is ever passed to down --volumes.
const project = `hexdailydata-v2-test-${randomUUID().slice(0, 8)}`;
const env = {
  ...process.env,
  HDD_V2_PROJECT: project,
  HDD_V2_HOST_PORT: '0',
  HDD_V2_POSTGRES_PASSWORD: randomBytes(24).toString('hex'),
};
const files = ['compose', '-p', project, '-f', 'compose.yaml', '-f', 'compose.database.yaml'];
function docker(args, timeout = 60_000) {
  const result = spawnSync('docker', args, {
    env,
    encoding: 'utf8',
    timeout,
    maxBuffer: 4 * 1024 * 1024,
  });
  if (result.status !== 0)
    throw new Error(
      `docker ${args.join(' ')} failed: ${result.error?.message ?? ''}\n${result.stdout}\n${result.stderr}`,
    );
  return result.stdout.trim();
}
console.log(`Isolated project: ${project}`);
try {
  console.log(docker([...files, 'build', '--pull'], 600_000));
  console.log(docker([...files, 'up', '-d', '--wait', '--wait-timeout', '90'], 180_000));
  assert.equal(docker([...files, 'exec', '-T', 'api', 'id', '-u']), '1000');
  assert.equal(docker([...files, 'exec', '-T', 'db', 'id', '-u']), '999');
  assert.equal(docker([...files, 'exec', '-T', 'api', 'node', '--version']), 'v24.21.0');
  const db = docker([
    ...files,
    'exec',
    '-T',
    'db',
    'psql',
    '-U',
    'hdd_v2_migrator',
    '-d',
    'hexdailydata_v2',
    '-Atc',
    'select current_database(), version();',
  ]);
  assert.match(db, /^hexdailydata_v2\|PostgreSQL 17\.11/);
  console.log(db);
  const published = docker([...files, 'port', 'api', '4320']);
  const base = `http://${published}`;
  for (const [path, expected] of [
    ['/health/live', 200],
    ['/health/ready', 503],
    ['/api/v2/status', 200],
    ['/', 200],
  ]) {
    const response = await fetch(base + path, { signal: AbortSignal.timeout(5_000) });
    assert.equal(response.status, expected, path);
    if (path === '/') {
      const html = await response.text();
      assert.match(html, /<title>HEXDailyData/);
      const script = html.match(/src="([^"]+\.js)"/)[1];
      assert.equal((await fetch(base + script)).status, 200);
    }
  }
  console.log(
    'PASS: non-root containers, real health, PostgreSQL identity, built HTML/JS over loopback.',
  );
} finally {
  console.log(
    docker([...files, 'down', '--volumes', '--remove-orphans', '--rmi', 'local'], 60_000),
  );
  console.log(`Removed only project ${project} and its disposable volume.`);
}
