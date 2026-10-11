import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { createInterface } from 'node:readline';
import { publicRoot as T } from '../../scripts/unified-refresh/public-profile.mjs';
const root = await mkdtemp(join(T, 'fixtures/startup-'));
const child = spawn('python', ['-I', '-S', 'tests/unified-refresh/public-startup.py', root], {
  stdio: ['pipe', 'pipe', 'pipe'],
  windowsHide: true,
});
const lines = createInterface({ input: child.stdout }),
  events = [];
let stderr = '';
child.stderr.on('data', (b) => (stderr += b));
const timer = setTimeout(() => child.kill(), 30000);
const done = new Promise((r) => child.once('close', (code, signal) => r({ code, signal })));
for await (const line of lines) {
  const m = JSON.parse(line);
  events.push(m);
  if (m.type === 'ack') child.stdin.write(JSON.stringify({ ok: true, cycle: m.ordinal }) + '\n');
  if (m.type === 'close_input') child.stdin.end();
}
const exit = await done;
clearTimeout(timer);
await writeFile(join(root, 'OWNER.json'), JSON.stringify({ exit, stderr, events }, null, 2) + '\n');
assert.equal(exit.code, 0, stderr);
assert.equal(events.at(-1).result.readerClosed, true);
console.log(
  JSON.stringify({
    status: 'PASS',
    root,
    actualNestedWorkers: 2,
    publicRequests: 0,
    genuineBaseAdmissions: 0,
  }),
);
