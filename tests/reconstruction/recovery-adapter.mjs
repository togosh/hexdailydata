import assert from 'node:assert/strict';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import { capture, sha } from '../../scripts/operator/reconstruction-recovery.mjs';
export function sqlAdapter(plan, environment, observation) {
  let child, lines, done;
  const read = async () => {
    const r = await lines.next();
    assert(!r.done, 'SQL helper failed');
    return JSON.parse(r.value);
  };
  return {
    observe: async () => structuredClone(observation),
    capture: async () => capture(join(plan.storagePath, 'reconstruction.json')),
    async prove(before, previous, bytes) {
      child = spawn(
        process.execPath,
        [
          'scripts/operator/reconstruction-recovery-sql.mjs',
          '--plan=' + join(environment, 'plan.json'),
        ],
        {
          env: { ...process.env, HDD_V2_ALLOW_LIVE_RPC: 'false' },
          stdio: ['pipe', 'pipe', 'pipe'],
        },
      );
      let stderr = '';
      child.stdin.on('error', () => {});
      child.stderr.on('data', (b) => (stderr += b));
      done = new Promise((resolve) => child.once('close', (code) => resolve({ code, stderr })));
      lines = createInterface({ input: child.stdout })[Symbol.asyncIterator]();
      child.stdin.write(
        JSON.stringify({ before: bytes.toString('base64'), previous: previous.accepted }) + '\n',
      );
      const r = await read();
      return r.proof;
    },
    async commit(pre, post) {
      child.stdin.write(JSON.stringify({ action: 'commit', post: post.toString('base64') }) + '\n');
      const r = await read();
      assert.equal(r.sha256, sha(post));
    },
    async close() {
      if (child) {
        child.stdin.end('{"action":"close"}\n');
        const result = await done;
        if (result.code !== 0) throw Error(result.stderr);
      }
    },
    get pid() {
      return child?.pid;
    },
  };
}
