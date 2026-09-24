import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, existsSync, readdirSync, writeFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { join, resolve, relative, isAbsolute } from 'node:path';

const root = resolve(
  process.env.HDD_V2_JOB_CLI_EVIDENCE ?? 'artifacts/task-10/clock-and-runner/job-cli',
);
const rel = relative(resolve('artifacts'), root);
assert(rel && !rel.startsWith('..') && !isAbsolute(rel), 'Disposable artifacts root required');
mkdirSync(root, { recursive: true });
const cli = resolve('scripts/operator/reconstruction-job.mjs');
const quote = (s) => "'" + s.replaceAll("'", "''") + "'";

function invoke(args, directory, powershell = false) {
  // Keep the real CLI/host module graph. Missing fixture scope must fail before
  // authority or Docker; Node also denies child processes and filesystem writes.
  const nodeArgs = ['--permission', '--allow-fs-read=*', cli, ...args];
  const command = powershell
    ? [
        'powershell.exe',
        '-NoProfile',
        '-NonInteractive',
        '-Command',
        '& ' + [process.execPath, ...nodeArgs].map(quote).join(' ') + '; exit $LASTEXITCODE',
      ]
    : [process.execPath, ...nodeArgs];
  const started = performance.now();
  const result = spawnSync(command[0], command.slice(1), {
    encoding: 'utf8',
    timeout: 10000,
    windowsHide: true,
    env: {
      ...process.env,
      NODE_OPTIONS: '',
      HDD_V2_ALLOW_LIVE_RPC: 'false',
      HDD_V2_RECONSTRUCTION_OPT_IN: '',
    },
  });
  writeFileSync(
    join(directory, 'child-receipt.json'),
    JSON.stringify(
      {
        command,
        exit: result.status,
        signal: result.signal,
        error: result.error?.message ?? null,
        elapsedMs: performance.now() - started,
        stdout: result.stdout,
        stderr: result.stderr,
      },
      null,
      2,
    ) + '\n',
    { flag: 'wx' },
  );
  assert.equal(result.error, undefined);
  assert.equal(result.signal, null);
  return result;
}

function rejectedLaunch(action, powershell = false) {
  const directory = join(root, action + '-' + randomUUID());
  const environment = join(directory, 'environment');
  const output = join(directory, 'output');
  const scope = join(directory, 'missing-scope.json');
  mkdirSync(environment, { recursive: true });
  const result = invoke(
    [action, environment, scope, output, '--stop-at=9100255'],
    directory,
    powershell,
  );
  assert.equal(result.status, 2, result.stderr);
  assert.match(result.stderr, /ENOENT/);
  assert(result.stderr.includes('missing-scope.json'));
  assert.doesNotMatch(result.stderr, /unsettled top-level await/i);
  assert.equal(result.stdout, '');
  assert(!existsSync(output));
  assert.deepEqual(readdirSync(environment), []);
}

for (const action of ['run', 'resume']) {
  test(
    'direct CLI ' + action + ' settles its real host import and rejects absent fixture authority',
    () => {
      rejectedLaunch(action);
    },
  );
}

test(
  'owner PowerShell direct CLI settles the same real import graph',
  { skip: process.platform !== 'win32' },
  () => {
    rejectedLaunch('run', true);
  },
);

test('direct CLI help and saved status retain successful JSON settlement', () => {
  for (const action of ['help', 'status']) {
    const directory = join(root, action + '-' + randomUUID());
    mkdirSync(directory);
    const output = join(directory, 'absent-output');
    const result = invoke(action === 'status' ? [action, output] : [action], directory);
    assert.equal(result.status, 0, result.stderr);
    const value = JSON.parse(result.stdout);
    if (action === 'help') assert.match(value.help, /Foreground owner PowerShell only/);
    else {
      assert.equal(value.observation, 'UNKNOWN');
      assert.equal(value.result, 'NOT_YET_OBSERVED');
    }
    assert(!existsSync(output));
  }
});
