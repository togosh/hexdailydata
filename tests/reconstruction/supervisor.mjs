import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { supervise } from '../../scripts/operator/reconstruction-segment.mjs';
export function supervisorSmoke(plan) {
  let now = JSON.parse(readFileSync(plan.storagePath + '/reconstruction.json')).highWater + 1234;
  const traces = [];
  for (const [action, mode] of [
    ['run', 'one-commit'],
    ['resume', 'normal'],
  ]) {
    const result = supervise(
      plan.storagePath + '/..',
      plan,
      action,
      ({ invoked, deadline, originalStart, timeout }) => {
        assert(timeout <= 3600000);
        assert(deadline <= originalStart + plan.caps.milliseconds);
        const out = spawnSync(
          'node',
          [
            'tests/reconstruction/child.mjs',
            plan.storagePath + '/../plan.json',
            action,
            mode,
            '/evidence/host-' + action + '-attempts.json',
          ],
          { encoding: 'utf8', timeout: 60000, maxBuffer: 2 * 1024 * 1024 },
        );
        writeFileSync('/evidence/host-' + action + '.log', out.stdout + out.stderr);
        now = JSON.parse(readFileSync(plan.storagePath + '/reconstruction.json')).highWater + 1234;
        traces.push({ invoked, deadline, originalStart, exit: out.status });
        return { status: out.status };
      },
      () => now,
    );
    assert.equal(result.status, action === 'run' ? 3 : 0);
  }
  assert.equal(traces[0].originalStart, traces[1].originalStart);
  writeFileSync(
    '/evidence/host-smoke.json',
    JSON.stringify(
      {
        traces,
        record: JSON.parse(readFileSync(plan.storagePath + '/../reconstruction-host.json')),
      },
      null,
      2,
    ),
  );
}
