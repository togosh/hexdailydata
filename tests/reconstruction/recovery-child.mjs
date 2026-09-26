import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { supervise } from '../../scripts/operator/reconstruction-segment.mjs';
import { executeBulk, clockAt, fixture } from './fixture.mjs';
import { ReconstructionPause } from '../../dist/operator/reconstruction-state.js';
const [path, mode] = process.argv.slice(2),
  plan = JSON.parse(readFileSync(path));
const state = JSON.parse(readFileSync(plan.storagePath + '/reconstruction.json'));
globalThis.fetch = () => {
  throw Error('Real network forbidden');
};
if (mode.startsWith('supervisor-')) {
  const action = mode === 'supervisor-first' ? 'run' : 'resume';
  let now = state.highWater + 1234;
  const result = supervise(
    dirname(path),
    plan,
    action,
    () => {
      const child = spawnSync(
        process.execPath,
        ['tests/reconstruction/recovery-child.mjs', path, mode.slice(11)],
        { encoding: 'utf8', timeout: 180000, maxBuffer: 4 * 1024 * 1024 },
      );
      writeFileSync(dirname(path) + '/reconstruction-output.log', child.stdout + child.stderr);
      console.log(
        JSON.stringify({
          childExit: child.status,
          childError: child.error?.message,
          stderr: child.stderr,
          ending: JSON.parse(readFileSync(plan.storagePath + '/reconstruction.json')),
        }),
      );
      if (mode === 'supervisor-crash') {
        assert.equal(child.status, 88, child.stderr);
        process.exit(89);
      }
      now = JSON.parse(readFileSync(plan.storagePath + '/reconstruction.json')).highWater + 1;
      return { status: child.status };
    },
    () => now,
  );
  console.log(JSON.stringify({ supervisorResult: result }));
  process.exitCode = result.status;
} else {
  const clock = clockAt(state.highWater + 1234),
    f = fixture(plan, clock);
  const original = f.transport;
  f.transport = (endpoint) => {
    const raw = original(endpoint);
    return async (body, ...args) => {
      const calls = JSON.parse(body);
      if (
        mode === 'crash' &&
        calls.some(
          (c) =>
            c.method === 'eth_getLogs' &&
            BigInt(c.params[0].toBlock) - BigInt(c.params[0].fromBlock) >= 128n,
        )
      )
        return {
          status: 200,
          retryAfter: null,
          body: (async function* () {
            yield Buffer.alloc(2097153, 32);
          })(),
        };
      return raw(body, ...args);
    };
  };
  const base = BigInt(state.accepted.revision);
  const result = await executeBulk(plan, mode === 'first' ? 'run' : 'resume', clock, {
    fixture: f,
    boundary: async (s) => {
      if (mode === 'crash' && BigInt(s.state.accepted.revision) >= base + 6n) process.exit(88);
      if (mode === 'next' && BigInt(s.state.accepted.revision) > base)
        throw new ReconstructionPause('Synthetic next accepted checkpoint');
    },
  });
  console.log(
    JSON.stringify({ result, syntheticRequests: f.attempts.length, realProviderCalls: 0 }),
  );
  process.exitCode = result.status === 'paused' ? 3 : result.status === 'complete' ? 0 : 2;
}
