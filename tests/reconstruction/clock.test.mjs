import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { join, resolve } from 'node:path';
import { ReconstructionClock } from '../../dist/operator/reconstruction-clock.js';
import { ReconstructionSession, cadence } from '../../dist/operator/reconstruction-state.js';
import { ProviderBudget } from '../../dist/providers/budget.js';
import { RpcClient } from '../../dist/providers/rpc.js';
import { rpcDiagnostic } from '../../dist/providers/rpc-diagnostic.js';
import { supervise } from '../../scripts/operator/reconstruction-segment.mjs';
import { memoryCooldown, CONTRACT } from '../sync/fixture.mjs';
globalThis.fetch = () => {
  throw Error('REAL NETWORK FORBIDDEN');
};
const evidence = resolve(
  process.env.HDD_V2_CLOCK_EVIDENCE ?? 'artifacts/task-10/clock-and-runner/focused',
);
mkdirSync(evidence, { recursive: true });
const receipts = [];
export function injected(epoch = 1800000000000) {
  const raw = { wall: epoch, mono: 10_000_000n, sleeps: [], onSleep: null };
  const clock = new ReconstructionClock({
    wall: () => raw.wall,
    monotonic: () => raw.mono,
    sleep: async (ms, signal) => {
      signal.throwIfAborted();
      raw.sleeps.push(ms);
      raw.onSleep?.(ms);
      raw.mono += BigInt(Math.ceil(ms * 1e6));
      raw.wall += Math.ceil(ms);
    },
  });
  return {
    raw,
    clock,
    advance: (ms) => {
      raw.mono += BigInt(ms) * 1000000n;
    },
  };
}
test('ceiling retains sub-ms progress and forward charges while independent continuous waits never jump', () => {
  const { raw, clock, advance } = injected(),
    start = clock.now(),
    sequence = [];
  raw.wall -= 1;
  for (let i = 0; i < 10000; i++) {
    raw.mono += 100_000n;
    clock.now();
  }
  assert.equal(clock.now(), start + 1000);
  sequence.push(clock.snapshot());
  raw.wall = start + 100000;
  const forward = clock.now(),
    continuous = clock.waitNow();
  raw.wall = start - 1000;
  advance(15000);
  assert.equal(clock.now(), forward + 15000);
  assert.equal(clock.waitNow(), continuous + 15000);
  sequence.push(clock.snapshot());
  const fixedDeadline = start + 16000;
  assert(clock.now() > fixedDeadline);
  receipts.push({ name: 'independent-sequences', sequence });
});
test('invalid samples fail sticky with typed bounded witnesses including overflow and regression', () => {
  for (const kind of [
    'NaN',
    'Infinity',
    'unsafe',
    'type',
    'negative-mono',
    'mono-type',
    'regression',
    'overflow',
    'throws',
  ]) {
    const { raw, clock } = injected();
    clock.now();
    if (kind === 'NaN') raw.wall = NaN;
    if (kind === 'Infinity') raw.wall = Infinity;
    if (kind === 'unsafe') raw.wall = Number.MAX_SAFE_INTEGER + 1;
    if (kind === 'type') raw.wall = '1800000000000';
    if (kind === 'negative-mono') raw.mono = -1n;
    if (kind === 'mono-type') raw.mono = 3;
    if (kind === 'regression') raw.mono -= 1n;
    if (kind === 'overflow') raw.mono += BigInt(Number.MAX_SAFE_INTEGER) * 1000000n;
    if (kind === 'throws')
      Object.defineProperty(raw, 'wall', {
        get() {
          throw Error('synthetic');
        },
      });
    let first;
    try {
      clock.now();
    } catch (e) {
      first = e;
    }
    assert(first);
    assert.throws(
      () => clock.now(),
      (e) => e === first,
    );
    const snapshot = clock.snapshot();
    assert.equal(snapshot.anomalies.count, 1);
    assert.equal(snapshot.anomalies.first.classification, 'terminal');
    assert(!JSON.stringify(snapshot).includes('"value":null'));
    receipts.push({ kind, snapshot });
  }
});
function session(clock) {
  const now = clock.now();
  const state = {
    start: now,
    deadline: now + 10000000,
    highWater: now,
    http: 0,
    logical: 0,
    chargedBytes: 0,
    observedBytes: 0,
    pending: false,
    uncertainAttempts: 0,
    terminal: false,
    reason: '',
    secondary: [],
    segment: {
      number: 1,
      started: now,
      deadline: now + 10000000,
      before: { http: 0, logical: 0, chargedBytes: 0 },
    },
  };
  const owner = new ReconstructionSession(
    {
      profile: { contract: CONTRACT, commonHistory: 'pulsechain' },
      caps: { http: 100, logical: 10000, bytes: 1e10, responseBytes: 4194304 },
      segment: { http: 100, logical: 10000, bytes: 1e10 },
    },
    state,
    clock,
  );
  owner.save = async () => {
    if (!owner.clockFailure) owner.time();
  };
  return owner;
}
test('both rate layers preserve HTTP/logical windows and spacing across forward and backward wall steps', async () => {
  for (const layer of ['budget', 'gate'])
    for (const logical of [30, 90]) {
      const { raw, clock } = injected(),
        starts = [],
        owner = session(clock);
      const budget = new ProviderBudget('worker', memoryCooldown(), clock);
      const work = async () => {
        starts.push(clock.waitNow());
        if (starts.length === 1) raw.wall += 600000;
        else raw.wall -= 1;
      };
      for (let i = 0; i < 14; i++) {
        if (layer === 'budget')
          await budget.run('sync', logical, owner.deadline(), owner.controller.signal, work);
        else {
          const gate = owner.gate.transport(
            1,
            async () => {
              await work();
              return {
                status: 200,
                retryAfter: null,
                body: (async function* () {
                  yield Buffer.from('[]');
                })(),
              };
            },
            'fixture',
            { request() {}, response() {} },
            cadence,
            owner.state.start + 60000,
          );
          const r = await gate(
            JSON.stringify(
              Array.from({ length: logical }, () => ({ method: 'eth_chainId', params: [] })),
            ),
            owner.controller.signal,
            owner.deadline(),
          );
          for await (const chunk of r.body) assert(chunk);
          await r.close();
        }
      }
      for (let i = 1; i < starts.length; i++)
        assert(starts[i] - starts[i - 1] >= (layer === 'gate' ? 2100 : 1300));
      for (const at of starts) {
        const window = starts.filter((s) => s > at - 60000 && s <= at);
        assert(window.length <= 12);
        assert(window.length * logical <= 360);
      }
      receipts.push({ name: 'rate-layer', layer, logical, starts, clock: clock.snapshot() });
      await owner.close();
    }
});
test('numeric and HTTP-date cooldowns retain full monotonic delay across adjustments', async () => {
  for (const kind of ['numeric', 'http-date']) {
    const { raw, clock } = injected();
    const starts = [];
    const budget = new ProviderBudget('worker', memoryCooldown(), clock);
    let adjusted = false;
    const rpc = new RpcClient(
      'fixture',
      'worker',
      369,
      CONTRACT,
      async (body) => {
        starts.push(clock.waitNow());
        if (starts.length === 1) raw.wall -= 50000;
        raw.onSleep = () => {
          if (!adjusted) {
            adjusted = true;
            raw.wall += 60000;
          }
        };
        return {
          status: starts.length === 1 ? 429 : 200,
          retryAfter: kind === 'numeric' ? '120' : new Date(raw.wall + 120000).toUTCString(),
          body: (async function* () {
            yield Buffer.from(
              JSON.stringify(
                JSON.parse(body).map((c) => ({ id: c.id, jsonrpc: '2.0', result: '0x171' })),
              ),
            );
          })(),
        };
      },
      budget,
    );
    await rpc.calls(
      [{ method: 'eth_chainId', params: [] }],
      new AbortController().signal,
      clock.now() + 1000000,
      'sync',
    );
    assert.equal(starts.length, 2);
    assert(starts[1] - starts[0] >= 119999); // HTTP dates have whole-second precision.
    receipts.push({ name: 'retry-after', kind, starts, snapshot: clock.snapshot() });
  }
});
test('streamed attempts expire at original 15 seconds with frozen/backward wall and retain primary clock error', async () => {
  for (const kind of ['backward', 'frozen', 'invalid', 'late-wake', 'forward-expiry']) {
    const { raw, clock, advance } = injected(),
      owner = session(clock);
    let dispatches = 0;
    const budget = new ProviderBudget('worker', memoryCooldown(), {
      now: () => owner.time(),
      waitNow: () => owner.waitTime(),
      wallNow: () => clock.wallNow(),
      snapshot: () => clock.snapshot(),
      sleep: clock.sleep,
    });
    if (kind === 'late-wake')
      owner.hooks.beforeDispatch = async () => {
        advance(15001);
      };
    const transport = owner.gate.transport(
      1,
      async () => {
        dispatches++;
        return {
          status: 200,
          retryAfter: null,
          body: (async function* () {
            if (kind === 'invalid') raw.wall = NaN;
            else {
              advance(15001);
              if (kind === 'backward') raw.wall -= 1;
            }
            yield Buffer.from('[]');
          })(),
        };
      },
      'fixture',
      { request() {}, response() {} },
      cadence,
      owner.state.start + 60000,
    );
    const rpc = new RpcClient('fixture', 'worker', 369, CONTRACT, transport, budget);
    if (kind === 'forward-expiry') {
      raw.wall = owner.deadline();
      clock.now();
      raw.wall -= 1000000;
    }
    let error;
    try {
      await rpc.call('eth_chainId', [], owner.controller.signal);
    } catch (e) {
      error = e;
    }
    assert(error);
    assert.equal(dispatches, ['late-wake', 'forward-expiry'].includes(kind) ? 0 : 1);
    if (kind === 'invalid') assert.match(error.message, /clock invalid/);
    if (dispatches) {
      assert.equal(owner.state.chargedBytes, 8388608);
      assert.equal(owner.state.pending, false);
    }
    receipts.push({
      name: 'request-expiry',
      kind,
      dispatches,
      reason: error.message,
      diagnostic: rpcDiagnostic(error),
      state: owner.state,
    });
    await owner.close();
  }
});
test('host end validation refuses invalid/backward effective values even after native clean pause', () => {
  const plan = {
    caps: { milliseconds: 100000 },
    segment: { milliseconds: 10000 },
    expiresAt: null,
  };
  for (const value of [999, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1]) {
    const root = join(evidence, 'host-' + randomUUID());
    mkdirSync(root);
    let now = 1000;
    const r = supervise(
      root,
      plan,
      'run',
      () => {
        now = value;
        return { status: 3 };
      },
      () => now,
    );
    assert.equal(r.status, 2);
    assert.equal(r.nativeStatus, 3);
    const saved = JSON.parse(readFileSync(join(root, 'reconstruction-host.json')));
    assert.equal(saved.terminal, true);
    assert.equal(saved.pending, false);
    receipts.push({ name: 'host-effective-invalid', value: String(value), result: r, saved });
  }
  const { raw, clock } = injected(),
    root = join(evidence, 'host-' + randomUUID());
  mkdirSync(root);
  const r = supervise(
    root,
    plan,
    'run',
    ({ now, deadline }) => {
      raw.wall = deadline;
      assert(now() >= deadline);
      raw.wall--;
      return { status: 3 };
    },
    clock,
  );
  assert.equal(r.status, 2);
  const before = readFileSync(join(root, 'reconstruction-host.json'));
  assert.throws(
    () =>
      supervise(
        root,
        plan,
        'resume',
        () => {
          throw Error('must not run');
        },
        clock,
      ),
    /continuation/,
  );
  assert.deepEqual(readFileSync(join(root, 'reconstruction-host.json')), before);
});
test('independent host elapsed timeout bounds a short real child with frozen raw wall', () => {
  const root = join(evidence, 'host-process-' + randomUUID());
  mkdirSync(root);
  const wall = Date.now(),
    clock = new ReconstructionClock({ wall: () => wall, monotonic: process.hrtime.bigint });
  const plan = { caps: { milliseconds: 10000 }, segment: { milliseconds: 150 }, expiresAt: null };
  let native;
  const start = performance.now();
  const result = supervise(
    root,
    plan,
    'run',
    ({ timeout }) => {
      const child = spawnSync(process.execPath, ['-e', 'setTimeout(() => process.exit(3), 1000)'], {
        timeout,
        windowsHide: true,
      });
      native = { status: child.status, signal: child.signal, error: child.error?.code, timeout };
      return { status: child.status, error: child.error?.code };
    },
    clock,
  );
  assert.equal(native.error, 'ETIMEDOUT');
  assert.notEqual(result.status, 3);
  assert(performance.now() - start < 3000);
  assert.equal(JSON.parse(readFileSync(join(root, 'reconstruction-host.json'))).terminal, true);
  receipts.push({
    name: 'host-real-child-timeout',
    native,
    result,
    elapsedMonotonicMs: performance.now() - start,
  });
});
test.after(() =>
  writeFileSync(join(evidence, 'clock-witnesses.json'), JSON.stringify(receipts, null, 2)),
);
