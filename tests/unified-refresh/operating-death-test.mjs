// Abrupt loss of the real synthetic coordinator while its native collector holds
// a physical permit. No network, genuine bases, or replacement completion frames.
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { spawn } from 'node:child_process';
import { OperatingOwner } from '../../scripts/unified-refresh/operating.mjs';
const T = resolve(process.argv[2]);
assert(T.endsWith('repeatable-refresh-operations-r1'));
const before = new Set(await fs.readdir(join(T, 'fixtures')));
const started = Date.now();
const code = `import {runOperating} from './scripts/refresh-data.mjs'; import {runFixture} from './tests/unified-refresh/operating-fixture.mjs'; await runFixture(${JSON.stringify(T)},'operating-parent-death',runOperating);`;
const child = spawn(process.execPath, ['--input-type=module', '-e', code], {
  stdio: ['ignore', 'pipe', 'pipe'],
  windowsHide: true,
});
let output = '',
  nativePid,
  root,
  parentClosed = false;
child.stdout.on('data', (b) => {
  output += b;
});
child.stderr.on('data', (b) => {
  output += b;
});
const exited = new Promise((resolve) =>
  child.once('close', (code, signal) => {
    parentClosed = true;
    resolve({ code, signal });
  }),
);
try {
  while (Date.now() - started < 30000) {
    const name = (await fs.readdir(join(T, 'fixtures'))).find(
      (n) => !before.has(n) && n.startsWith('operating-operating-parent-death-'),
    );
    if (name) {
      root = join(T, 'fixtures', name);
      try {
        const p = JSON.parse(
          await fs.readFile(join(root, 'operating/trade-00000001/SYNTHETIC_NATIVE_PID.json')),
        );
        assert.equal(p.parent, child.pid);
        nativePid = p.pid;
        await fs.access(join(root, 'operating/trade-00000001/01/PHYSICAL_STARTED.json'));
        break;
      } catch (e) {
        if (e.code !== 'ENOENT') throw e;
      }
    }
    await new Promise((r) => setTimeout(r, 10));
  }
  assert(root && nativePid, 'ACTUAL_NATIVE_PHYSICAL_ENTRY');
  const statePath = join(root, 'operating/OPERATING_STATE.json');
  const original = await fs.readFile(statePath),
    state = JSON.parse(original);
  assert(state.pending && state.totals.http.attempts === 1);
  child.kill('SIGKILL');
  const exit = await exited;
  // The orphan is our exact single collector, whose nested spawning is denied.
  try {
    process.kill(nativePid, 'SIGKILL');
  } catch (e) {
    if (e.code !== 'ESRCH') throw e;
  }
  for (let n = 0; n < 100; n++) {
    try {
      process.kill(nativePid, 0);
    } catch (e) {
      if (e.code === 'ESRCH') break;
      throw e;
    }
    await new Promise((r) => setTimeout(r, 10));
  }
  assert.throws(
    () => process.kill(nativePid, 0),
    (e) => e.code === 'ESRCH',
  );
  assert.deepEqual(await fs.readFile(statePath), original);
  const c = JSON.parse(await fs.readFile(join(T, 'fixtures/OPERATING_CONFIG.json')));
  c.expiresAt = c.startsAt + 1801;
  for (const [f, v] of Object.entries(c.families)) {
    v.enabled = f === 'trade';
    v.period = 600;
  }
  await assert.rejects(
    OperatingOwner.open(
      join(root, 'operating'),
      c,
      { mode: 'SYNTHETIC', now: () => state.lastClock },
      { resume: true, sourceBinding: state.sourceBinding },
    ),
    /EEXIST/,
  );
  await fs.writeFile(
    join(root, 'evidence/ABRUPT_PARENT_DEATH.json'),
    JSON.stringify(
      {
        status: 'PASS',
        synthetic: true,
        parentExit: exit,
        parentPid: child.pid,
        nativePid,
        nativeClosed: true,
        retainedCharge: state.totals.http,
        retainedPending: state.pending.id,
        lockRetained: true,
        reAdmissionRefused: true,
        externalRequests: 0,
        genuineBaseAdmissions: 0,
        elapsedMilliseconds: Date.now() - started,
      },
      null,
      2,
    ) + '\n',
    { flag: 'wx' },
  );
  console.log(JSON.stringify({ status: 'PASS', root, abruptParentDeath: true }));
} finally {
  if (!parentClosed) {
    child.kill('SIGKILL');
    await exited;
  }
  if (nativePid)
    try {
      process.kill(nativePid, 'SIGKILL');
    } catch (e) {
      if (e.code !== 'ESRCH') throw e;
    }
  if (root) await fs.writeFile(join(root, 'evidence/PARENT_OUTPUT.txt'), output, { flag: 'wx' });
}
