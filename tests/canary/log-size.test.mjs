import assert from 'node:assert/strict';
import test from 'node:test';
import { RpcClient, RangeError, LocalLogSizeError } from '../../dist/providers/rpc.js';
import { CanarySession } from '../../dist/operator/canary-session.js';
import { ProviderBudget } from '../../dist/providers/budget.js';
import { rpcDiagnostic } from '../../dist/providers/rpc-diagnostic.js';
import { topics } from '../../dist/providers/abi.js';
import { prefixPlan } from './prefix-fixture.mjs';
import { FakeClock, memoryCooldown, CONTRACT } from '../sync/fixture.mjs';
import limits from '../../config/limits.json' with { type: 'json' };
import { profileSources } from '../../dist/worker/sync/profile.js';

globalThis.fetch = () => {
  throw Error('REAL NETWORK FORBIDDEN');
};
const MIB = 1024 * 1024;
const logs = {
  method: 'eth_getLogs',
  params: [
    { address: CONTRACT, fromBlock: '0x64', toBlock: '0x67', topics: [Object.values(topics)] },
  ],
};
function setup() {
  const clock = new FakeClock();
  const plan = prefixPlan('/unused', {
    project: 'hexdailydata-v2-log-size-test',
    instance: 'b602a42a-8403-45f3-b18e-5c2363c47ef6',
  });
  const session = new CanarySession(
    plan,
    {
      start: 0,
      deadline: plan.caps.milliseconds,
      highWater: 0,
      http: 0,
      logical: 0,
      chargedBytes: 0,
      observedBytes: 0,
      uncertainAttempts: 0,
      pending: false,
      terminal: false,
      status: 'running',
      phase: 0,
      results: [],
      reason: '',
      prefix: { stopHeader: null, ended: null, secondary: [] },
    },
    clock,
  );
  session.save = async () => {};
  return { clock, plan, session };
}
function padded(id, bytes) {
  const text = JSON.stringify([{ jsonrpc: '2.0', id, result: [] }]);
  return Buffer.from(text + ' '.repeat(bytes - text.length));
}
test('baseline guard order: prefix hard cap precedes ordinary client16MiB guard', async () => {
  const { clock, session } = setup();
  const rpc = new RpcClient(
    'size-test',
    null,
    369,
    CONTRACT,
    session.transport(1, async (body) => ({
      status: 200,
      retryAfter: null,
      body: (async function* () {
        yield padded(JSON.parse(body)[0].id, 4 * MIB + 1);
      })(),
    })),
    new ProviderBudget('worker', memoryCooldown(), clock),
  );
  let failure;
  try {
    await rpc.calls([logs], session.controller.signal, session.state.deadline);
  } catch (error) {
    failure = error;
  } finally {
    await session.close();
  }
  assert(failure);
  assert(!(failure instanceof RangeError));
  assert.match(failure.message, /Canary response byte cap/);
  assert.equal(session.state.observedBytes, 4 * MIB + 1);
  assert.equal(session.state.chargedBytes, 8 * MIB);
  assert.equal(rpc.counters.bytes, 0);
  assert.equal(rpcDiagnostic(failure).streamComplete, false);
  console.log(
    JSON.stringify({
      synthetic: true,
      case: 'baseline-hard-first',
      rawObserved: session.state.observedBytes,
      clientObserved: rpc.counters.bytes,
      charged: session.state.chargedBytes,
      reason: rpcDiagnostic(failure).reason,
    }),
  );
});
test('baseline ordinary client accepts complete padded logs above2MiB below4MiB without an opt-in', async () => {
  const { clock, session } = setup();
  const rpc = new RpcClient(
    'size-test',
    null,
    369,
    CONTRACT,
    session.transport(1, async (body) => ({
      status: 200,
      retryAfter: null,
      body: (async function* () {
        yield padded(JSON.parse(body)[0].id, 2 * MIB + 1);
      })(),
    })),
    new ProviderBudget('worker', memoryCooldown(), clock),
  );
  try {
    assert.deepEqual(await rpc.calls([logs], session.controller.signal, session.state.deadline), [
      [],
    ]);
    assert.equal(session.state.observedBytes, 2 * MIB + 1);
    assert.equal(session.state.uncertainAttempts, 0);
  } finally {
    await session.close();
  }
});

async function earlyProbe({
  bytes = 2 * MIB + 1,
  status = 200,
  calls = [logs],
  mode = '',
  threshold = 2 * MIB,
} = {}) {
  const { clock, session } = setup();
  let sends = 0,
    cancelled = 0,
    closes = 0;
  const transport = session.transport(1, async (body, active) => {
    sends++;
    const request = JSON.parse(body);
    const payload = padded(request[0].id, bytes);
    let sent = false;
    return {
      status,
      retryAfter: null,
      body: {
        [Symbol.asyncIterator]() {
          return this;
        },
        async next() {
          if (sent) return { done: true };
          sent = true;
          if (mode === 'cancel') session.controller.abort(Error('Synthetic global cancellation.'));
          if (mode === 'deadline') clock.time = session.state.deadline;
          return { done: false, value: payload };
        },
        async return() {
          cancelled++;
          if (mode === 'iterator-close') throw Error('Synthetic iterator cleanup disagreement.');
          assert.equal(active.aborted, false, 'normal early cancellation precedes abort signal');
          return { done: true };
        },
      },
      close: async () => {
        closes++;
        if (mode === 'close') throw Error('Synthetic close disagreement.');
      },
    };
  });
  const rpc = new RpcClient(
    'early-test',
    null,
    369,
    CONTRACT,
    transport,
    new ProviderBudget('worker', memoryCooldown(), clock),
    undefined,
    threshold,
  );
  let value, error;
  try {
    value = await rpc.calls(calls, session.controller.signal, session.state.deadline);
  } catch (e) {
    error = e;
  }
  return { session, rpc, value, error, sends, cancelled, closes, clock };
}
test('local byte boundary, scope and config preserve unrelated behavior and hard limit', async () => {
  const original = structuredClone(limits);
  for (const [bytes, singleton, expected] of [
    [2 * MIB, false, 'ok'],
    [2 * MIB + 1, false, 'local'],
    [2 * MIB + 1, true, 'ok'],
    [4 * MIB + 1, true, 'hard'],
    [4 * MIB + 1, false, 'hard'],
  ]) {
    const call = structuredClone(logs);
    if (singleton) call.params[0].toBlock = call.params[0].fromBlock;
    const p = await earlyProbe({ bytes, calls: [call] });
    try {
      if (expected === 'ok') {
        assert.deepEqual(p.value, [[]]);
        assert.equal(p.session.state.uncertainAttempts, 0);
      } else {
        assert(p.error);
        assert.equal(p.error instanceof LocalLogSizeError, expected === 'local');
        assert.equal(
          rpcDiagnostic(p.error).reason,
          expected === 'local' ? 'local-size' : 'response-size',
        );
        assert.equal(rpcDiagnostic(p.error).streamComplete, false);
        assert.equal(rpcDiagnostic(p.error).digestScope, 'observed-prefix');
        assert.equal(p.session.state.chargedBytes, 8 * MIB);
      }
      assert.equal(p.session.state.observedBytes, bytes);
      assert.equal(p.sends, 1);
      assert.equal(p.rpc.counters.retries, 0);
      if (expected === 'local') {
        assert.equal(p.cancelled, 1);
        assert.equal(p.closes, 1);
        assert.equal(p.session.controller.signal.aborted, false);
        assert.equal(p.session.state.pending, false);
      }
    } finally {
      await p.session.close();
    }
  }
  for (const invalid of [0, -1, NaN, Infinity, 16 * MIB + 1])
    assert.throws(
      () => new RpcClient('bad', null, 369, CONTRACT, async () => {}, {}, undefined, invalid),
      /Invalid historical/,
    );
  assert.deepEqual(limits, original);
});
test('local abort cannot hide actual cleanup, cancellation, deadline or exhausted reservation', async () => {
  for (const mode of ['iterator-close', 'close', 'cancel', 'deadline']) {
    const p = await earlyProbe({ mode });
    try {
      assert(p.error);
      assert(!(p.error instanceof LocalLogSizeError), mode);
      assert(p.session.controller.signal.aborted, mode);
      assert.equal(p.sends, 1);
      assert.equal(p.session.state.chargedBytes, 8 * MIB);
      const before = p.session.state.http;
      await assert.rejects(
        p.rpc.calls([logs], p.session.controller.signal, p.session.state.deadline),
      );
      assert.equal(p.session.state.http, before);
    } finally {
      await p.session.close();
    }
  }
  const p = await earlyProbe();
  try {
    p.session.state.chargedBytes = p.session.plan.caps.bytes - 8 * MIB + 1;
    await assert.rejects(
      p.rpc.calls([logs], p.session.controller.signal, p.session.state.deadline),
      /reservation/,
    );
    assert.equal(p.session.state.http, 1);
  } finally {
    await p.session.close();
  }
});
test('non-200 and complete malformed envelopes retain existing classification with early threshold enabled', async () => {
  for (const status of [429, 503]) {
    const p = await earlyProbe({ status });
    try {
      assert(!(p.error instanceof LocalLogSizeError));
      assert.equal(p.error.code, status);
      assert.equal(p.sends, 4);
      assert.equal(p.rpc.counters.retries, 3);
      assert.equal(rpcDiagnostic(p.error).reason, 'http');
      assert.equal(rpcDiagnostic(p.error).streamComplete, true);
    } finally {
      await p.session.close();
    }
  }
  for (const kind of ['wrong-id', 'both', 'neither']) {
    const { clock, session } = setup();
    const rpc = new RpcClient(
      'bad-envelope',
      null,
      369,
      CONTRACT,
      session.transport(1, async (body) => {
        const id = JSON.parse(body)[0].id;
        return {
          status: 200,
          retryAfter: null,
          body: (async function* () {
            yield Buffer.from(
              JSON.stringify([
                {
                  jsonrpc: '2.0',
                  id: kind === 'wrong-id' ? id + 1 : id,
                  ...(kind === 'neither' ? {} : { result: [] }),
                  ...(kind === 'both' ? { error: { code: -32005 } } : {}),
                },
              ]),
            );
          })(),
        };
      }),
      new ProviderBudget('worker', memoryCooldown(), clock),
      undefined,
      2 * MIB,
    );
    try {
      await assert.rejects(
        rpc.calls([logs], session.controller.signal, session.state.deadline),
        (error) => {
          assert(!(error instanceof RangeError));
          assert.notEqual(rpcDiagnostic(error).reason, 'local-size');
          return true;
        },
      );
      assert.equal(session.state.http, 1);
      assert.equal(rpc.counters.retries, 0);
    } finally {
      await session.close();
    }
  }
});

test('unrelated calls, singleton row stops and simultaneous global stop keep their authority', async () => {
  const unrelated = await earlyProbe({ calls: [{ method: 'eth_chainId', params: [] }] });
  try {
    assert.deepEqual(unrelated.value, [[]]);
    assert.equal(unrelated.session.state.uncertainAttempts, 0);
  } finally {
    await unrelated.session.close();
  }
  const hard = await earlyProbe({ threshold: 8 * MIB, bytes: 4 * MIB + 1 });
  try {
    assert.match(hard.error.message, /byte cap/);
    assert(!(hard.error instanceof LocalLogSizeError));
  } finally {
    await hard.session.close();
  }
  const stopped = await earlyProbe({ mode: 'cancel', bytes: 4 * MIB + 1 });
  try {
    assert.match(stopped.error.message, /cancellation/);
    assert.equal(rpcDiagnostic(stopped.error).reason, 'deadline');
  } finally {
    await stopped.session.close();
  }
  const { clock, plan, session } = setup();
  let dispatches = 0;
  const pair = profileSources(
    plan.profile,
    1,
    () =>
      session.transport(1, async (body) => {
        dispatches++;
        return {
          status: 200,
          retryAfter: null,
          body: (async function* () {
            yield Buffer.from(
              JSON.stringify([
                { jsonrpc: '2.0', id: JSON.parse(body)[0].id, result: Array(2001).fill({}) },
              ]),
            );
          })(),
        };
      }),
    new ProviderBudget('worker', memoryCooldown(), clock),
    2 * MIB,
  );
  try {
    await assert.rejects(
      pair[0].events([plan.profile.constructor.checkpoint], session.controller.signal),
      (error) => {
        assert(error instanceof RangeError);
        assert(!(error instanceof LocalLogSizeError));
        return true;
      },
    );
    assert.equal(dispatches, 1);
  } finally {
    await session.close();
  }
});
