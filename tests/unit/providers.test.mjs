import test from 'node:test';
import assert from 'node:assert/strict';
import { ProviderBudget } from '../../src/providers/budget.ts';
import { RpcClient, validateCall } from '../../src/providers/rpc.ts';
import { decodeLog, topics, selectors, word } from '../../src/providers/abi.ts';
import {
  fixture,
  FakeClock,
  memoryCooldown,
  CONTRACT,
  CODE_HASH,
  hash,
  A,
  B,
  LARGE,
} from '../sync/fixture.mjs';

const signal = new AbortController().signal;
test('ABI literal signatures and raw integer layout, strict padding/boolean/time affinity', () => {
  assert.equal(selectors.globalInfo, '0xf04b5fa0');
  assert.equal(selectors.dailyDataRange, '0x6a210a0e');
  assert.equal(
    topics.stake_start,
    '0x14872dc760f33532684e68e1b6d5fd3f71ba7b07dee76bdb2b084f28b74233ef',
  );
  const chain = fixture({ last: 130 });
  const raw = structuredClone(chain.logs.get(102)[1]),
    header = chain.plain(102);
  assert.deepEqual(decodeLog(raw, 1, CONTRACT, header).value, {
    kind: 'stake_start',
    stakeId: '1',
    address: A,
    principal: '100',
    shares: '50',
    days: 1,
    auto: false,
  });
  raw.data = '0x' + word(BigInt(raw.data) + (2n << 200n));
  assert.throws(() => decodeLog(raw, 1, CONTRACT, header), /boolean/);
  raw.data = '0x' + word(BigInt(raw.data) + (1n << 255n));
  assert.throws(() => decodeLog(raw, 1, CONTRACT, header), /padding/);
  assert.equal(
    decodeLog(chain.logs.get(101)[0], 1, CONTRACT, chain.plain(101)).value.hearts,
    LARGE.toString(),
  );
  assert.throws(
    () => decodeLog(chain.logs.get(101)[0], 1, CONTRACT, { ...chain.plain(101), hash: hash(99) }),
    /affinity/,
  );
});
test('read-only contract/method/pinned call allowlist rejects writes and unbounded work', () => {
  for (const call of [
    { method: 'eth_sendRawTransaction', params: ['0x00'] },
    {
      method: 'eth_call',
      params: [{ to: CONTRACT, data: '0xa9059cbb' + '00'.repeat(64) }, 'latest'],
    },
    {
      method: 'eth_getLogs',
      params: [{ address: A, fromBlock: '0x0', toBlock: '0x1', topics: [[topics.transfer]] }],
    },
  ])
    assert.throws(() => validateCall(call, CONTRACT));
  validateCall(
    {
      method: 'eth_call',
      params: [
        { to: CONTRACT, data: selectors.balanceOf + A.slice(2).padStart(64, '0') },
        { blockHash: hash(101), requireCanonical: true },
      ],
    },
    CONTRACT,
  );
});
test('raw acquisition matches IDs and rejects false empty, truncated, malformed and wrong-code responses', async () => {
  const chain = fixture({ last: 130 });
  const good = chain.source(1, 'one');
  await good.verify(chain.plain(100), signal);
  assert.equal((await good.events([chain.plain(101)], signal)).length, 2);
  const empty = chain.source(1, 'empty', new FakeClock(), (rows, requests) =>
    rows.map((r, i) => (requests[i].method === 'eth_getLogs' ? { ...r, result: [] } : r)),
  );
  await assert.rejects(() => empty.events([chain.plain(101)], signal), /Incomplete/);
  const truncated = chain.source(1, 'partial', new FakeClock(), (rows) => rows.slice(1));
  await assert.rejects(() => truncated.verify(chain.plain(100), signal));
  const wrong = chain.source(1, 'code', new FakeClock(), (rows, requests) =>
    rows.map((r, i) => (requests[i].method === 'eth_getCode' ? { ...r, result: '0x00' } : r)),
  );
  await assert.rejects(() => wrong.verify(chain.plain(100), signal), /code/);
  const duplicate = chain.source(1, 'duplicate', new FakeClock(), (rows) =>
    rows.map((r) => ({ ...r, id: rows[0].id })),
  );
  await assert.rejects(() => duplicate.verify(chain.plain(100), signal), /identity/);
  const misordered = chain.source(1, 'order', new FakeClock(), (rows, requests) =>
    rows.map((r, i) =>
      requests[i].method === 'eth_getLogs' ? { ...r, result: [...r.result].reverse() } : r,
    ),
  );
  await assert.rejects(() => misordered.events([chain.plain(101)], signal), /Misordered/);
});
test('fixed non-borrowing role lanes bound rolling physical/logical work, aliases and conservative restart', async () => {
  const clock = new FakeClock(),
    store = memoryCooldown(),
    api = new ProviderBudget('api', store, clock),
    worker = new ProviderBudget('worker', store, clock),
    dispatched = [];
  async function job(budget, lane, logical = 30) {
    await budget.run(lane, logical, clock.now() + 600000, signal, async () =>
      dispatched.push({ at: clock.now(), lane, logical }),
    );
  }
  for (let i = 0; i < 32; i++) {
    await job(api, 'address');
    await job(worker, 'sync');
    if (i % 2 === 0) await job(worker, 'metrics');
  }
  assert.ok(dispatched[0].at >= 60000);
  for (let i = 1; i < dispatched.length; i++)
    assert.ok(dispatched[i].at - dispatched[i - 1].at >= 2000);
  for (const end of dispatched) {
    const window = dispatched.filter((x) => x.at > end.at - 60000 && x.at <= end.at);
    assert.ok(window.length <= 30);
    assert.ok(window.reduce((n, x) => n + x.logical, 0) <= 900);
    for (const [lane, http, rpc] of [
      ['address', 12, 360],
      ['sync', 12, 360],
      ['metrics', 6, 180],
    ]) {
      const rows = window.filter((x) => x.lane === lane);
      assert.ok(rows.length <= http);
      assert.ok(rows.reduce((n, x) => n + x.logical, 0) <= rpc);
    }
  }
  const started = clock.now(),
    restarted = new ProviderBudget('worker', store, clock);
  await job(restarted, 'sync');
  assert.ok(clock.now() - started >= 60000);
  await assert.rejects(
    () => worker.run('address', 1, clock.now() + 60000, signal, async () => {}),
    /lane/,
  );
  await assert.rejects(
    () => worker.run('sync', 361, clock.now() + 60000, signal, async () => {}),
    /logical/,
  );
});
test('queue saturation, queued deadlines/cancellation and metrics priority', async () => {
  const clock = new FakeClock(),
    budget = new ProviderBudget('worker', memoryCooldown(), clock),
    order = [];
  const promises = [];
  for (let i = 0; i < 8; i++)
    promises.push(budget.run('sync', 1, 1000000, signal, async () => order.push('sync')));
  await assert.rejects(() => budget.run('sync', 1, 1000000, signal, async () => {}), /saturated/);
  await Promise.all(promises);
  const sync = budget.run('sync', 1, clock.now() + 100000, signal, async () =>
    order.push('new sync'),
  );
  const metric = budget.run('metrics', 1, clock.now() + 100000, signal, async () =>
    order.push('metric'),
  );
  await Promise.all([sync, metric]);
  assert.ok(order.indexOf('metric') < order.indexOf('new sync'));
  await assert.rejects(
    () => budget.run('sync', 1, clock.now(), signal, async () => {}),
    /deadline/,
  );
  const cancelled = new AbortController();
  cancelled.abort(new Error('caller gone'));
  await assert.rejects(
    () => budget.run('sync', 1, clock.now() + 100000, cancelled.signal, async () => {}),
    /caller gone/,
  );
});
test('429 Retry-After and network retries are charged; cooldown survives process role/restart', async () => {
  const clock = new FakeClock(),
    store = memoryCooldown(),
    budget = new ProviderBudget('worker', store, clock);
  let attempts = 0;
  const transport = async (body) => {
    attempts++;
    return {
      status: attempts === 1 ? 429 : 200,
      retryAfter: '120',
      body: (async function* () {
        yield Buffer.from(
          JSON.stringify(
            JSON.parse(body).map((r) => ({ jsonrpc: '2.0', id: r.id, result: '0x1' })),
          ),
        );
      })(),
    };
  };
  const rpc = new RpcClient('alias-one', null, 1, CONTRACT, transport, budget);
  assert.equal(await rpc.call('eth_chainId', [], signal), '0x1');
  assert.equal(budget.counters.attempts, 2);
  assert.equal(budget.counters.logical, 2);
  assert.equal(rpc.counters.retries, 1);
  assert.ok(clock.now() >= 180000);
  const alias = new RpcClient('alias-two', null, 1, CONTRACT, transport, budget);
  await alias.call('eth_chainId', [], signal);
  assert.equal(budget.counters.attempts, 3);
  await store.extend(clock.now() + 300000);
  const api = new ProviderBudget('api', store, clock);
  const before = clock.now();
  await api.run('address', 1, before + 500000, signal, async () => {});
  assert.ok(clock.now() >= before + 300000);
});
test('real abort timeout and byte-bound rejection retain physical charges', async () => {
  const clock = new FakeClock(),
    budget = new ProviderBudget('worker', memoryCooldown(), clock);
  const hanging = async (body, signal) =>
    new Promise((resolve, reject) =>
      signal.addEventListener('abort', () => reject(signal.reason), { once: true }),
    );
  const rpc = new RpcClient('timeout', null, 1, CONTRACT, hanging, budget);
  await assert.rejects(
    () => rpc.calls([{ method: 'eth_chainId', params: [] }], signal, 60905),
    /deadline|timeout/,
  );
  assert.equal(budget.counters.attempts, 1);
  const large = new RpcClient(
    'large',
    null,
    1,
    CONTRACT,
    async () => ({
      status: 200,
      retryAfter: null,
      body: (async function* () {
        for (let i = 0; i < 257; i++) yield Buffer.alloc(65536, 65);
      })(),
    }),
    budget,
  );
  await assert.rejects(() => large.call('eth_chainId', [], signal), /byte bound/);
  assert.equal(large.counters.requests, 1);
  assert.equal(budget.counters.attempts, 2);
});
