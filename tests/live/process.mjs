// Actual elapsed-time API/worker scheduler witness; fake transports, no network.
import assert from 'node:assert/strict';
import { fork } from 'node:child_process';
import { mkdir, writeFile } from 'node:fs/promises';
import { resolve, relative, isAbsolute, join } from 'node:path';
import { setTimeout as pause } from 'node:timers/promises';
import { ProviderBudget } from '../../dist/providers/budget.js';
import { cooldownFiles } from '../../dist/providers/cooldown.js';

const [directory, role, round] = process.argv.slice(2);
const root = resolve(directory);
const rel = relative(resolve('artifacts/task-09'), root);
assert.ok(rel && !rel.startsWith('..') && !isAbsolute(rel));
if (role) {
  const started = Date.now(),
    store = await cooldownFiles(root, role);
  const budget = new ProviderBudget(role, store),
    trace = [];
  let inflight = 0,
    peak = 0;
  const outcomes = await Promise.allSettled(
    Array.from({ length: 4 }, (_, i) => {
      const lane = role === 'api' ? 'address' : i % 2 ? 'metrics' : 'sync';
      let row;
      return budget.run(
        lane,
        1,
        started + 120000,
        new AbortController().signal,
        async () => {
          peak = Math.max(peak, ++inflight);
          try {
            await pause(2000);
          } finally {
            inflight--;
            row.ended = Date.now();
          }
        },
        () => {
          row = { at: Date.now(), lane, logical: 1, role, round };
          trace.push(row);
        },
      );
    }),
  );
  assert.ok(
    outcomes.every((r) => r.status === 'fulfilled'),
    JSON.stringify(outcomes),
  );
  await store.close();
  process.send({ started, trace, peak, counters: budget.counters });
} else {
  await mkdir(root, { recursive: false });
  const receipts = [];
  const child = (role, round) =>
    new Promise((yes, no) => {
      let result;
      const p = fork(new URL(import.meta.url), [root, role, round], {
        env: { ...process.env, HDD_V2_ALLOW_LIVE_RPC: 'false' },
        silent: true,
        windowsHide: true,
      });
      let error = '';
      p.stderr.on('data', (b) => (error += b));
      p.on('message', (value) => (result = value));
      p.on('error', no);
      p.on('exit', (code) =>
        code === 0 && result ? yes(result) : no(Error(`child ${role} ${code}: ${error}`)),
      );
    });
  for (const round of ['first', 'restart']) {
    receipts.push(...(await Promise.all(['api', 'worker'].map((role) => child(role, round)))));
    await writeFile(join(root, 'receipts.json'), JSON.stringify(receipts, null, 2));
    if (round === 'first') {
      const store = await cooldownFiles(root, 'worker');
      await store.extend(Date.now() + 65000);
      await store.close();
    }
  }
  const trace = receipts.flatMap((r) => r.trace).sort((a, b) => a.at - b.at);
  const cooldownStore = await cooldownFiles(root, 'api');
  const cooldown = await cooldownStore.read();
  await cooldownStore.close();
  const gaps = trace.slice(1).map((r, i) => r.at - trace[i].at);
  const output = {
    clock: 'real shared host epoch milliseconds',
    receipts,
    trace,
    cooldown,
    minimumSpacing: Math.min(...gaps),
  };
  await writeFile(join(root, 'result.json'), JSON.stringify(output, null, 2));
  for (const r of receipts) {
    assert.equal(r.peak, 1);
    assert.ok(r.trace.every((t) => t.at >= r.started + 60000));
    if (r.trace[0].round === 'restart') assert.ok(r.trace.every((t) => t.at >= cooldown));
  }
  assert.ok(Math.min(...gaps) >= 1300);
  for (const r of trace)
    for (const [lane, cap] of [
      ['all', 42],
      ['address', 24],
      ['metrics', 6],
      ['sync', 12],
    ])
      assert.ok(
        trace.filter(
          (t) => t.at <= r.at && t.at > r.at - 60000 && (lane === 'all' || t.lane === lane),
        ).length <= cap,
      );
  const overlap = trace.some((r, i) => trace.slice(i + 1).some((t) => t.at < r.ended));
  assert.ok(overlap, 'different role responses may overlap');
  console.log(
    'PASS real process quarantine, persisted cross-role cooldown, restart, spacing, serialization and rolling ceilings',
  );
}
