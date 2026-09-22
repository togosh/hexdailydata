import assert from 'node:assert/strict';
import test from 'node:test';
import { createHash } from 'node:crypto';
import { z } from 'zod';
import { RpcClient, RangeError } from '../../dist/providers/rpc.js';
import { RpcExchange, rpcDiagnostic } from '../../dist/providers/rpc-diagnostic.js';
import { ProviderBudget } from '../../dist/providers/budget.js';
import { CanarySession } from '../../dist/operator/canary-session.js';
import { operatorError } from '../../dist/operator/errors.js';
import { prefixPlan } from './prefix-fixture.mjs';
import { FakeClock, memoryCooldown, CONTRACT, A, hash } from '../sync/fixture.mjs';
import { topics, selectors } from '../../dist/providers/abi.js';

globalThis.fetch = () => {
  throw Error('REAL NETWORK FORBIDDEN');
};
const signal = new AbortController().signal;
const logs = {
  method: 'eth_getLogs',
  params: [
    { address: CONTRACT, fromBlock: '0x64', toBlock: '0x67', topics: [Object.values(topics)] },
  ],
};
const digest = (b) => createHash('sha256').update(b).digest('hex');
const p = () =>
  prefixPlan('/unused', {
    project: 'hexdailydata-v2-diagnostic-test',
    instance: 'b602a42a-8403-45f3-b18e-5c2363c47ef6',
  });
function session(clock, plan = p()) {
  const now = clock.now();
  const s = new CanarySession(
    plan,
    {
      start: now,
      deadline: now + plan.caps.milliseconds,
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
    },
    clock,
  );
  s.save = async () => {};
  return s;
}
async function probe(
  make,
  { wrapped = false, calls = [logs], closeFails = false, status = 200, retryAfter = null } = {},
) {
  const clock = new FakeClock(),
    bodies = [],
    requests = [];
  const s = wrapped ? session(clock) : null;
  const raw = async (body) => {
    const q = JSON.parse(body);
    requests.push(q);
    const value = make(q);
    const b = Buffer.from(typeof value === 'string' ? value : JSON.stringify(value));
    bodies.push(b);
    return {
      status,
      retryAfter,
      body: (async function* () {
        yield b;
      })(),
      close: async () => {
        if (closeFails) throw Error('Synthetic close failure.');
      },
    };
  };
  const client = new RpcClient(
    'synthetic-source',
    null,
    369,
    CONTRACT,
    s ? s.transport(1, raw, 'synthetic-source') : raw,
    new ProviderBudget('worker', memoryCooldown(), clock),
  );
  let value, error;
  try {
    value = await client.calls(calls, signal);
  } catch (e) {
    error = e;
  } finally {
    await s?.close();
  }
  return { value, error, diagnostic: rpcDiagnostic(error), client, s, bodies, requests };
}
test('actual Zod optional unknown preserves both/neither/null property presence', () => {
  const schema = z.object({
    result: z.unknown().optional(),
    error: z.object({ code: z.number() }).optional(),
  });
  for (const value of [
    { result: [] },
    { result: null },
    { error: { code: -32005 } },
    { result: null, error: { code: -32005 } },
    {},
  ])
    assert.deepEqual(Object.keys(schema.parse(value)), Object.keys(value));
});
test('actual client and prefix seam reject ambiguous envelopes without retries or text-driven split authority', async () => {
  const cases = [
    [
      'both-result-error',
      (q) => [
        {
          jsonrpc: '2.0',
          id: q[0].id,
          result: null,
          error: { code: -32005, message: 'network timeout disagreement range' },
        },
      ],
    ],
    ['neither-result-error', (q) => [{ jsonrpc: '2.0', id: q[0].id }]],
    ['unexpected-id', (q) => [{ jsonrpc: '2.0', id: q[0].id + 1, result: [] }]],
    [
      'invalid-id',
      () => [{ jsonrpc: '2.0', id: null, error: { code: -32005, message: 'Synthetic null ID' } }],
    ],
    ['missing-id', () => [{ jsonrpc: '2.0', result: [] }]],
    ['batch-size', () => []],
    [
      'batch-size',
      (q) => [
        { jsonrpc: '2.0', id: q[0].id, result: [] },
        { jsonrpc: '2.0', id: 9, result: [] },
      ],
    ],
    [
      'envelope',
      () => ({ jsonrpc: '2.0', id: null, error: { code: -32600, message: 'Synthetic non-array' } }),
    ],
    ['parse', () => 'network timeout disagreement https://invalid.example/private?key=HIDDEN'],
    [
      'envelope',
      (q) => [
        { jsonrpc: '2.0', id: q[0].id, result: [], 'network timeout disagreement': 'SECRET' },
      ],
    ],
  ];
  for (const wrapped of [false, true])
    for (const [reason, make] of cases) {
      const r = await probe(make, { wrapped });
      assert.ok(r.error, reason);
      assert.ok(!(r.error instanceof RangeError));
      assert.equal(r.client.counters.requests, 1);
      assert.equal(r.client.counters.retries, 0);
      const d = r.diagnostic;
      assert.equal(d.reason, reason);
      assert.equal(d.httpStatus, 200);
      assert.equal(d.streamComplete, true);
      assert.equal(d.accepted, false);
      assert.equal(d.observedBytes, r.bodies[0].length);
      assert.equal(d.sha256, digest(r.bodies[0]));
      assert.equal(d.digestScope, 'complete-body');
      assert.equal(d.requests[0].fromBlock, '0x64');
      assert.equal(d.requests[0].toBlock, '0x67');
      assert.equal(d.requests[0].id.value, r.requests[0][0].id);
      assert.doesNotMatch(operatorError(r.error), /network|timeout|disagreement|SECRET|https:/);
      assert.equal(JSON.stringify(r.error).includes('observedUntrustedError'), false);
      assert.ok(Buffer.byteLength(JSON.stringify(d)) <= 8192);
    }
});
test('duplicate IDs reject; valid reordered replies and literal null/false/empty values stay unchanged', async () => {
  for (const wrapped of [false, true]) {
    const calls = [
      { method: 'eth_chainId', params: [] },
      { method: 'eth_chainId', params: [] },
    ];
    const duplicate = await probe(
      (q) => q.map(() => ({ jsonrpc: '2.0', id: q[0].id, result: false })),
      { calls, wrapped },
    );
    assert.equal(duplicate.diagnostic.reason, 'duplicate-id');
    assert.equal(duplicate.client.counters.requests, 1);
    const reordered = await probe(
      (q) => [
        { jsonrpc: '2.0', id: q[1].id, result: '0x0' },
        { jsonrpc: '2.0', id: q[0].id, result: false },
      ],
      { calls, wrapped },
    );
    assert.deepEqual(reordered.value, [false, '0x0']);
    assert.equal(reordered.diagnostic, undefined);
    for (const result of [[], null]) {
      const r = await probe((q) => [{ jsonrpc: '2.0', id: q[0].id, result }], { wrapped });
      assert.deepEqual(r.value, [result]);
      assert.equal(r.client.counters.requests, 1);
    }
  }
});
test('correlated explicit range codes stay RangeError; retries retain last actual attempt and primary beats close', async () => {
  for (const code of [-32005, -32602])
    for (const wrapped of [false, true]) {
      const r = await probe(
        (q) => [
          { jsonrpc: '2.0', id: q[0].id, error: { code, message: 'Synthetic range rejection' } },
        ],
        { wrapped },
      );
      assert.ok(r.error instanceof RangeError);
      assert.equal(r.diagnostic.reason, 'correlated-rpc-error');
      assert.equal(r.client.counters.retries, 0);
    }
  const r = await probe(
    (q) => [{ jsonrpc: '2.0', id: q[0].id, result: null, error: { code: -32005 } }],
    { wrapped: true, closeFails: true },
  );
  assert.match(r.error.message, /Missing\/conflicting/);
  assert.equal(r.diagnostic.cleanupFailed, true);
  const retry = await probe((q) => [{ jsonrpc: '2.0', id: q[0].id, error: { code: -32000 } }]);
  assert.equal(retry.client.counters.retries, 3);
  assert.equal(retry.diagnostic.attempt, 4);
  assert.equal(retry.diagnostic.sha256, digest(retry.bodies.at(-1)));
});
test('bounded structural preview, UTF8 messages, omitted unsafe prose, IDs, calldata and result payloads', async () => {
  const secrets = [
    'https://invalid.example/private?key=DEMO',
    'Authorization: Bearer TOPSECRET',
    'Cookie: session=SECRET',
    '/private/path',
    A,
    '0x' + 'a'.repeat(200),
    'api_key SECRET',
  ];
  for (const text of secrets) {
    const r = await probe((q) => [
      {
        jsonrpc: '2.0',
        id: q[0].id,
        result: 'RESULT_SECRET',
        error: { code: -32005, message: text, data: { nested: 'DATA_SECRET' } },
      },
    ]);
    const encoded = JSON.stringify(r.diagnostic);
    assert.equal(encoded.includes(text), false);
    assert.doesNotMatch(encoded, /RESULT_SECRET|DATA_SECRET/);
    assert.equal(r.diagnostic.received[0].observedUntrustedError.message.omitted, true);
  }
  const calls = Array.from({ length: 104 }, (_, i) => ({
    id: i + 1,
    method: 'eth_call',
    params: [
      { to: CONTRACT, data: selectors.balanceOf + A.slice(2).padStart(64, '0') },
      { blockHash: hash(100) },
    ],
  }));
  const exchange = new RpcExchange('synthetic', calls, CONTRACT, 1, 1, 10);
  const body = Buffer.from(
    JSON.stringify(
      calls.map((c) => ({
        jsonrpc: '2.0',
        id: c.id,
        result: null,
        error: { code: -32005, message: '界\u0001 '.repeat(150) },
      })),
    ),
  );
  exchange.observe(body);
  exchange.complete = true;
  const d = exchange.failure('rpc', 3, body);
  assert.ok(Buffer.byteLength(JSON.stringify(d)) <= 8192);
  assert.ok(Buffer.byteLength(d.preview) <= 1024);
  assert.equal(d.previewTruncated, true);
  assert.ok(d.truncatedRows > 0 && d.truncatedRequests > 0);
  assert.equal(d.received.length + d.truncatedRows, 104);
  assert.equal(d.requests.length + d.truncatedRequests, 104);
  assert.equal(d.received[0].observedUntrustedError.message.controlsRemoved, true);
  assert.equal(d.received[0].observedUntrustedError.message.truncated, true);
  assert.ok(Buffer.byteLength(d.received[0].observedUntrustedError.message.text) <= 256);
  assert.equal(JSON.stringify(d).includes(A.slice(2)), false);
});

test('HTTP failure retains only safe Retry-After and the final actual observed response', async () => {
  for (const retryAfter of ['2', 'Wed, 23 Sep 2026 12:00:00 GMT', 'Authorization Bearer PRIVATE']) {
    // A fatal HTTP400 exercises header capture without sleeping until a distant date.
    const r = await probe(
      (q) => [
        { jsonrpc: '2.0', id: q[0].id, error: { code: -32600, message: 'Synthetic HTTP failure' } },
      ],
      { status: 400, retryAfter },
    );
    assert.equal(r.client.counters.requests, 1);
    assert.equal(r.diagnostic.reason, 'http');
    assert.equal(r.diagnostic.httpStatus, 400);
    assert.equal(r.diagnostic.retryAfter, retryAfter.includes('PRIVATE') ? null : retryAfter);
    assert.equal(r.diagnostic.sha256, digest(r.bodies[0]));
    assert.equal(r.diagnostic.observedBytes, r.bodies[0].length);
  }
  for (const status of [429, 503]) {
    const r = await probe((q) => [{ jsonrpc: '2.0', id: q[0].id, error: { code: -32000 } }], {
      status,
      retryAfter: '1',
      wrapped: true,
    });
    assert.equal(r.client.counters.requests, 4);
    assert.equal(r.client.counters.retries, 3);
    assert.equal(r.diagnostic.attempt, 4);
    assert.equal(r.diagnostic.httpStatus, status);
    assert.equal(r.s.state.http, 4);
    assert.equal(r.s.state.logical, 4);
    assert.equal(
      r.s.state.observedBytes,
      r.bodies.reduce((n, b) => n + b.length, 0),
    );
    assert.equal(r.s.state.chargedBytes, r.s.state.observedBytes);
    assert.equal(r.s.state.uncertainAttempts, 0);
  }
});
test('partial, oversize and late bodies hash exactly observed bytes and do not claim complete digests', async () => {
  for (const mode of ['partial', 'oversize', 'late']) {
    const clock = new FakeClock(),
      plan = p();
    if (mode === 'oversize') plan.caps.responseBytes = 16;
    const s = session(clock, plan),
      b = Buffer.from('x'.repeat(mode === 'oversize' ? 40 : 8));
    const rpc = new RpcClient(
      'synthetic',
      null,
      369,
      CONTRACT,
      s.transport(
        1,
        async () => ({
          status: 200,
          retryAfter: null,
          body: (async function* () {
            if (mode === 'late') clock.time += 16000;
            yield b;
            throw Error('Synthetic interrupted body.');
          })(),
        }),
        'synthetic',
      ),
      new ProviderBudget('worker', memoryCooldown(), clock),
    );
    let e;
    try {
      await rpc.calls([logs], signal);
    } catch (error) {
      e = error;
    } finally {
      await s.close();
    }
    const d = rpcDiagnostic(e);
    assert.equal(d.streamComplete, false);
    assert.equal(d.digestScope, 'observed-prefix');
    assert.equal(d.observedBytes, b.length);
    assert.equal(d.sha256, digest(b));
    assert.equal(s.state.observedBytes, b.length);
    assert.equal(s.state.chargedBytes, Math.max(b.length, 2 * plan.caps.responseBytes));
    assert.equal(s.state.http, 1);
    assert.equal(s.state.uncertainAttempts, 1);
    assert.equal(s.state.pending, false);
  }
});
