import test from 'node:test';
import assert from 'node:assert/strict';
import { Source } from '../../dist/providers/source.js';
import { RpcClient } from '../../dist/providers/rpc.js';
import { rpcDiagnostic } from '../../dist/providers/rpc-diagnostic.js';
import { ProviderBudget } from '../../dist/providers/budget.js';
import { ReconstructionSession } from '../../dist/operator/reconstruction-state.js';
import { selectors, word } from '../../dist/providers/abi.js';
import { FakeClock, memoryCooldown, CONTRACT, CODE_HASH, hash } from '../sync/fixture.mjs';

globalThis.fetch = () => {
  throw Error('REAL NETWORK FORBIDDEN');
};
const addresses = Array.from(
  { length: 32 },
  (_, i) => '0x' + (i + 1).toString(16).padStart(40, '0'),
);
const expected = addresses.map((address, i) => ({
  address,
  hearts: i === 0 ? '0' : String(9007199254740993n + BigInt(i)),
}));
const header = { number: '107', hash: hash(107), parentHash: hash(106), timestamp: '1575406801' };

// In-memory persistence only; the production session checks and attempt gate are unchanged.
function probe({ fail = () => false, mutate = (rows) => rows, stop, logical = 1000 } = {}) {
  const clock = new FakeClock();
  const state = {
    start: 0,
    deadline: 3600000,
    highWater: 0,
    http: 0,
    logical: 0,
    observedBytes: 0,
    chargedBytes: 0,
    pending: false,
    uncertainAttempts: 0,
    terminal: false,
    reason: '',
    secondary: [],
    segment: { deadline: 1800000, before: { http: 0, logical: 0, chargedBytes: 0 } },
  };
  const owner = new ReconstructionSession(
    {
      profile: { contract: CONTRACT, commonHistory: 'ethereum' },
      caps: { http: 100, logical, bytes: 536870912, responseBytes: 4194304 },
      segment: { http: 100, logical: 1000, bytes: 268435456 },
    },
    state,
    clock,
  );
  const saves = [];
  owner.save = async () => saves.push(structuredClone(state));
  const trace = [];
  let active = 0,
    peak = 0;
  const controller = new AbortController();
  const raw = async (body, signal, deadline) => {
    signal.throwIfAborted();
    const calls = JSON.parse(body);
    const record = { calls, deadline, bytes: 0, complete: false };
    trace.push(record);
    if (fail(calls, trace.length)) throw Error('Synthetic network failure');
    active++;
    peak = Math.max(peak, active);
    const rows = mutate(
      calls.map((c) => ({
        jsonrpc: '2.0',
        id: c.id,
        result:
          '0x' +
          word(expected.find((v) => v.address === '0x' + c.params[0].data.slice(-40))?.hearts ?? 0),
      })),
      calls,
      trace.length,
    );
    return {
      status: 200,
      retryAfter: null,
      body: (async function* () {
        await new Promise((r) => setImmediate(r));
        const bytes = Buffer.from(
          typeof rows === 'string' ? rows : JSON.stringify([...rows].reverse()),
        );
        record.bytes = bytes.length;
        yield bytes;
        record.complete = true;
      })(),
      close: async () => {
        active--;
      },
    };
  };
  const transport = owner.gate.transport(1, raw, 'paging-source', { request() {}, response() {} });
  const budget = new ProviderBudget('worker', memoryCooldown(), clock);
  const source = new Source(new RpcClient('paging-source', null, 1, CONTRACT, transport, budget), {
    codeHash: CODE_HASH,
    finality: { mode: 'finalized' },
    completeness: 'filtered-ranges',
  });
  if (stop) {
    const calls = source.rpc.calls.bind(source.rpc);
    source.rpc.calls = async (...args) => {
      const result = await calls(...args);
      if (trace.length === 1) stop({ clock, state, controller });
      return result;
    };
  }
  return { source, owner, state, clock, trace, saves, controller, peak: () => peak };
}
function shapes(p) {
  return p.trace.map((t) => t.calls.length);
}
function accounting(p) {
  assert.equal(p.state.http, p.trace.length);
  assert.equal(
    p.state.logical,
    p.trace.reduce((n, t) => n + t.calls.length, 0),
  );
  assert.equal(
    p.state.observedBytes,
    p.trace.reduce((n, t) => n + t.bytes, 0),
  );
  assert.equal(
    p.state.chargedBytes,
    p.trace.reduce((n, t) => n + (t.complete ? t.bytes : 8388608), 0),
  );
  assert.equal(p.state.pending, false);
}
function evidence(label, p, result) {
  console.log(
    'PAGING_EVIDENCE',
    JSON.stringify({ label, trace: p.trace, state: p.state, saves: p.saves, result }),
  );
}

test('balance pages preserve empty/tail/boundary samples, pins, order and exact integers', async () => {
  for (const size of [32, 0, 1, 9, 10, 11, 20, 29, 30, 31]) {
    const p = probe();
    const result = await p.source.balances(addresses.slice(0, size), header, p.controller.signal);
    assert.deepEqual(result, expected.slice(0, size));
    const want = Array.from({ length: Math.ceil(size / 10) }, (_, i) =>
      Math.min(10, size - i * 10),
    );
    console.log('PAGE_SHAPE', JSON.stringify({ size, observed: shapes(p), expected: want }));
    assert.deepEqual(shapes(p), want);
    assert.equal(p.peak(), size ? 1 : 0);
    assert.deepEqual(
      p.trace.flatMap((t) => t.calls.map((c) => '0x' + c.params[0].data.slice(-40))),
      addresses.slice(0, size),
    );
    for (const t of p.trace)
      for (const c of t.calls) {
        assert.equal(c.method, 'eth_call');
        assert.deepEqual(c.params[1], { blockHash: header.hash, requireCanonical: true });
        assert.equal(c.params[0].to, CONTRACT);
      }
    accounting(p);
    if (size === 32) evidence('complete-32', p, result);
  }
});

test('size-sensitive injected transport rejects old shape and accepts complete ten-call pages', async () => {
  const p = probe({ fail: (calls) => calls.length > 10 });
  let result;
  try {
    result = await p.source.balances(addresses, header, p.controller.signal);
  } finally {
    evidence('size-sensitive', p, result);
  }
  assert.deepEqual(shapes(p), [10, 10, 10, 2]);
  assert.deepEqual(result, expected);
  accounting(p);
});

test('generic callsAt retains thirty-call chunks', async () => {
  const p = probe();
  await p.source.callsAt(
    Array.from({ length: 32 }, () => ({ data: selectors.totalSupply })),
    header,
    p.controller.signal,
  );
  assert.deepEqual(shapes(p), [30, 2]);
});

test('recoverable later-page transport failure retains reservation and retries only that page', async () => {
  const p = probe({ fail: (_calls, attempt) => attempt === 2 });
  const result = await p.source.balances(addresses, header, p.controller.signal);
  assert.deepEqual(result, expected);
  assert.deepEqual(shapes(p), [10, 10, 10, 10, 2]);
  assert.deepEqual(p.trace[1].calls, p.trace[2].calls);
  assert.equal(p.source.rpc.counters.retries, 1);
  assert.equal(p.state.uncertainAttempts, 1);
  accounting(p);
  evidence('recoverable', p, result);
});

test('persistent later-page failure stops after original plus three retries, without a tail page', async () => {
  const p = probe({ fail: (_calls, attempt) => attempt >= 2 });
  await assert.rejects(p.source.balances(addresses, header, p.controller.signal), (error) => {
    assert.match(error.message, /Synthetic network failure/);
    assert.equal(rpcDiagnostic(error).requestBatchSize, 10);
    return true;
  });
  assert.deepEqual(shapes(p), [10, 10, 10, 10, 10]);
  for (const t of p.trace.slice(2)) assert.deepEqual(t.calls, p.trace[1].calls);
  assert.equal(p.source.rpc.counters.retries, 3);
  assert.equal(p.state.uncertainAttempts, 4);
  accounting(p);
  evidence('persistent', p);
});

test('original logical/operation/segment limits and cancellation prevent the next page', async () => {
  for (const mode of ['logical', 'operation', 'segment', 'cancel']) {
    let afterFirstPage;
    const p = probe({
      logical: mode === 'logical' ? 10 : 1000,
      stop: ({ clock, state, controller }) => {
        afterFirstPage = structuredClone(state);
        if (mode === 'operation') clock.time = state.deadline;
        if (mode === 'segment') clock.time = state.segment.deadline;
        if (mode === 'cancel') controller.abort(Error('Owner cancelled synthetic read'));
      },
    });
    const before = structuredClone(p.state);
    await assert.rejects(
      p.source.balances(addresses, header, p.controller.signal),
      /allowance|cancelled/,
    );
    assert.deepEqual(shapes(p), [10]);
    assert.equal(p.state.deadline, before.deadline);
    assert.equal(p.state.segment.deadline, before.segment.deadline);
    assert.equal(afterFirstPage.logical, 10);
    assert.equal(afterFirstPage.pending, false);
    if (mode === 'segment') assert.equal(p.state.terminal, false);
    assert.equal(p.source.rpc.counters.retries, 0);
    accounting(p);
    evidence(mode, p, { before, afterFirstPage, after: p.state });
  }
});

test('invalid later-page envelopes and ABI values reject the whole result', async () => {
  for (const mode of ['malformed', 'missing', 'duplicate', 'unexpected', 'abi']) {
    const p = probe({
      mutate: (rows, _calls, attempt) => {
        if (attempt !== 2) return rows;
        if (mode === 'malformed') return '{';
        if (mode === 'missing') return rows.slice(1);
        if (mode === 'duplicate') rows[1].id = rows[0].id;
        if (mode === 'unexpected') rows[0].id = 999999;
        if (mode === 'abi') rows[0].result = '0x01';
        return rows;
      },
    });
    await assert.rejects(p.source.balances(addresses, header, p.controller.signal));
    assert.deepEqual(shapes(p), [10, 10]);
    assert.equal(p.source.rpc.counters.retries, 0);
    accounting(p);
    evidence(mode, p);
  }
});
