import assert from 'node:assert/strict';
import test from 'node:test';
import { CanarySession } from '../../dist/operator/canary-session.js';
import { RpcClient } from '../../dist/providers/rpc.js';
import { realClock } from '../../dist/providers/budget.js';
import { prefixPlan } from '../canary/prefix-fixture.mjs';
import { rpcDiagnostic } from '../../dist/providers/rpc-diagnostic.js';
import { createHash } from 'node:crypto';

test('stalled dispatch continuation cannot outrun the original RPC deadline timer', async () => {
  const plan = prefixPlan('/unused', {
    project: 'hexdailydata-v2-deadline-test',
    instance: 'b602a42a-8403-45f3-b18e-5c2363c47ef6',
  });
  const now = Date.now();
  // The slot and durable reservation have already completed. This isolated seam
  // uses real time/timer starvation and zero SQL, files or provider access.
  const state = {
    start: now - 61000,
    deadline: now + 100000,
    highWater: now,
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
  };
  const session = new CanarySession(plan, state, realClock, {
    beforeDispatch: async () => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 90),
  });
  session.save = async () => {};
  let sends = 0;
  const transport = session.transport(1, async () => {
    sends++;
    throw Error('Must not dispatch');
  });
  const budget = {
    clock: realClock,
    run: async (_lane, _logical, _deadline, _signal, work) => work(),
  };
  const rpc = new RpcClient('deadline-test', null, 369, plan.profile.contract, transport, budget);
  try {
    await assert.rejects(
      rpc.calls(
        [{ method: 'eth_chainId', params: [] }],
        new AbortController().signal,
        Date.now() + 30,
      ),
      /original request deadline/,
    );
    assert.equal(sends, 0);
    assert.equal(state.http, 1); // The already persisted reservation is never refunded.
    assert.equal(state.chargedBytes, 2 * plan.caps.responseBytes);
    assert.equal(state.pending, false);
  } finally {
    await session.close();
  }
});

test('real late body continuation is charged and retains an observed-prefix digest', async () => {
  const plan = prefixPlan('/unused', {
    project: 'hexdailydata-v2-deadline-test',
    instance: 'b602a42a-8403-45f3-b18e-5c2363c47ef6',
  });
  const now = Date.now();
  const state = {
    start: now - 61000,
    deadline: now + 100000,
    highWater: now,
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
  };
  const session = new CanarySession(plan, state, realClock);
  session.save = async () => {};
  const body = Buffer.from('[{"jsonrpc":"2.0","id":1,"result":"0x171"}]');
  let sends = 0;
  const rpc = new RpcClient(
    'deadline-test',
    null,
    369,
    plan.profile.contract,
    session.transport(1, async () => {
      sends++;
      return {
        status: 200,
        retryAfter: null,
        body: (async function* () {
          Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 90);
          yield body;
        })(),
      };
    }),
    { clock: realClock, run: async (_lane, _logical, _deadline, _signal, work) => work() },
  );
  try {
    await assert.rejects(
      rpc.calls(
        [{ method: 'eth_chainId', params: [] }],
        new AbortController().signal,
        Date.now() + 30,
      ),
      (error) => {
        assert.match(error.message, /original request deadline/);
        const diagnostic = rpcDiagnostic(error);
        assert.equal(diagnostic.observedBytes, body.length);
        assert.equal(diagnostic.streamComplete, false);
        assert.equal(diagnostic.reason, 'deadline');
        assert.equal(diagnostic.digestScope, 'observed-prefix');
        assert.equal(diagnostic.sha256, createHash('sha256').update(body).digest('hex'));
        return true;
      },
    );
    assert.equal(sends, 1);
    assert.equal(state.observedBytes, body.length);
    assert.equal(state.chargedBytes, 2 * plan.caps.responseBytes);
    assert.equal(state.pending, false);
  } finally {
    await session.close();
  }
});
