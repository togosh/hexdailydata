import { spawn } from 'node:child_process';
import { mkdir, writeFile, readFile } from 'node:fs/promises';
import { join } from 'node:path';
const root =
  'C:\\Code\\HEXDailyData-Subgraph-First-Launch-Proof-R2\\btc-eth-current-reference-freshness-r2\\worker-stdin-isolation-r1';
const worktree = 'C:\\Code\\HEXDailyData-v2-Subgraph-History-R2';
async function scenario(mode, folder, family = 'minimal') {
  await mkdir(folder, { recursive: true });
  for (const name of ['stdin-isolation.py', 'stdin-isolation.mjs'])
    await writeFile(join(folder, name), await readFile(join(worktree, 'tests/trade-feed', name)), {
      flag: 'wx',
    });
  const env = Object.fromEntries(
    ['SystemRoot', 'WINDIR', 'COMSPEC']
      .filter((k) => process.env[k])
      .map((k) => [k, process.env[k]]),
  );
  Object.assign(env, { TEMP: folder, TMP: folder, PYTHONIOENCODING: 'utf-8' });
  const child = spawn(
    'C:\\Python314\\python.exe',
    ['-I', '-S', join(worktree, 'tests/trade-feed/stdin-isolation.py'), family, mode, folder],
    { cwd: worktree, env, stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true },
  );
  let output = '',
    stderr = '',
    line = '',
    expired = false;
  const events = [];
  child.stdout.on('data', (chunk) => {
    output = (output + chunk).slice(0, 32768);
    line += chunk;
    for (let n; (n = line.indexOf('\n')) >= 0;) {
      const raw = line.slice(0, n);
      line = line.slice(n + 1);
      const e = JSON.parse(raw);
      events.push(e);
      if (e.type === 'release') child.stdin.write('release-one-read\n');
      if (e.type === 'ack')
        child.stdin.write(JSON.stringify({ ok: true, cycle: e.ordinal }) + '\n');
      if (e.type === 'close_input') child.stdin.end();
    }
  });
  child.stderr.on('data', (b) => {
    stderr = (stderr + b).slice(0, 8192);
  });
  const timer = setTimeout(() => {
    expired = true;
    child.stdin.end();
    const killer = spawn(
      join(process.env.SystemRoot, 'System32/taskkill.exe'),
      ['/PID', String(child.pid), '/T', '/F'],
      { windowsHide: true, stdio: 'ignore' },
    );
    killer.on('error', () => child.kill());
  }, 15000);
  const result = await new Promise((resolve, reject) => {
    child.once('error', reject);
    child.once('close', (code, signal) => resolve({ code, signal }));
  });
  clearTimeout(timer);
  child.stdin.destroy();
  const receipt = {
    ...result,
    expired,
    events,
    stdout: output,
    stderr,
    synthetic: true,
    publicRequests: 0,
    baseAdmissions: 0,
  };
  await writeFile(join(folder, 'OWNER.json'), JSON.stringify(receipt, null, 2) + '\n', {
    flag: 'wx',
  });
  if (result.code !== 0 || expired) throw Error('Offline scenario failed: ' + mode + ' ' + stderr);
  return receipt;
}
if (process.argv[2] === 'minimal') {
  const stamp = Date.now();
  const results = [];
  for (const mode of [
    'no_reader_inherited',
    'pending_inherited',
    'pending_devnull',
    'pending_release',
  ])
    results.push(await scenario(mode, join(root, 'fixtures', `minimal-${stamp}`, mode)));
  await writeFile(
    join(root, 'evidence', `MINIMAL_MATRIX-${stamp}.json`),
    JSON.stringify({ results, synthetic: true, publicRequests: 0, baseAdmissions: 0 }, null, 2) +
      '\n',
    { flag: 'wx' },
  );
  console.log(JSON.stringify(results.map((x) => x.events.find((e) => e.type === 'result').result)));
} else if (['actual_inherited', 'actual_isolated'].includes(process.argv[2])) {
  const mode = process.argv[2],
    stamp = Date.now();
  const result = await scenario(mode, join(root, 'fixtures', `${mode}-${stamp}`), 'actual');
  await writeFile(
    join(root, 'evidence', `${mode}-${stamp}.json`),
    JSON.stringify(result, null, 2) + '\n',
    { flag: 'wx' },
  );
  console.log(
    JSON.stringify({
      mode,
      code: result.code,
      result: result.events.find((e) => e.type === 'result').result.launches,
    }),
  );
} else console.log('Offline by default. Use minimal or an actual_* no-network scenario.');
