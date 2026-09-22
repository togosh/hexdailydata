import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFile, writeFile, rename } from 'node:fs/promises';
import { setTimeout as pause } from 'node:timers/promises';
import { prefixPlan, prefixEnvironment, prefixFixture } from './prefix-fixture.mjs';
import { inputs } from './fixture.mjs';
import { CanarySession } from '../../dist/operator/canary-session.js';
import { PrefixScope } from '../../dist/operator/canary-prefix.js';
import { runCanary } from '../../dist/operator/canary.js';
import { canaryPlanSchema } from '../../dist/operator/canary-plan.js';
import { FakeClock, A, B, hash, memoryCooldown } from '../sync/fixture.mjs';
import { ProviderBudget } from '../../dist/providers/budget.js';
import { RpcClient } from '../../dist/providers/rpc.js';
import { connect, databaseConfig } from '../../dist/db/connect.js';
const signal = new AbortController().signal;
export async function prefixTests({ root, test, reset, snapshot, cli }) {
  async function fresh(overrides) {
    const p = prefixPlan(root + '/' + randomUUID(), overrides);
    await inputs(p);
    return p;
  }
  const path = (p) => p.storagePath + '/plan.json';
  const approval = (p) => p.storagePath + '/approval.json';
  const state = async (p) => JSON.parse(await readFile(p.sessionPath, 'utf8'));
  await test('prefix schema rejects mixed/native/full phases, range, finality and endpoint changes', async () => {
    const p = await fresh();
    for (const change of [
      (q) => q.phases.push({ kind: 'metrics', purpose: 'forbidden phase' }),
      (q) => (q.phases[0].through = '99'),
      (q) => (q.phases[0].through = '181'),
      (q) => (q.ranges[0].chain = 369),
      (q) => (q.profile.commonHistory = 'ethereum'),
      (q) => (q.profile.fork.entry.parentHash = hash(999)),
      (q) => (q.phases[0].endpoints[1] = q.phases[0].endpoints[0]),
      (q) => (q.phases[0].cadence.spacingMilliseconds = 1400),
      (q) => (q.phases[0].finalityHeaders.maximum = '187'),
    ]) {
      const q = structuredClone(p);
      change(q);
      assert.equal(canaryPlanSchema.safeParse(q).success, false);
    }
    await cli(p, 'check');
  });
  let successHttp;
  await test('compiled CLI verifies literal day-zero constructor, nonempty exact stop and all balances on origin1/network369', async () => {
    const p = await fresh();
    await cli(p, 'prepare');
    const r = await cli(p, 'run');
    const s = await state(p),
      sql = await snapshot();
    assert.equal(s.status, 'complete', r.out);
    assert.equal(s.prefix.stopHeader.number, '103');
    assert.equal(sql.chains.length, 1);
    assert.equal(sql.chains[0].chain_id, 1);
    assert.equal(sql.sync_state[0].block_number, '103');
    assert.equal(sql.current_state.length, 1);
    const c = sql.current_state[0];
    for (const [key, value] of Object.entries({
      circulating_hearts: '9007199254750693',
      locked_hearts: '300',
      active_shares: '0',
      queued_shares: '150',
      raw_share_rate: '100000',
      holder_count: '2',
      staker_count: '2',
    }))
      assert.equal(String(c[key]), value, key);
    assert.deepEqual(
      sql.accounts.map((a) => [a.address.toString('hex'), a.liquid_hearts]),
      [
        [A.slice(2), '9007199254740893'],
        [B.slice(2), '9800'],
      ],
    );
    assert.equal(sql.stakes.length, 2);
    assert.equal(sql.share_schedule.length, 1);
    assert.deepEqual(sql.share_schedule[0], { chain_id: 1, activation_day: 2, shares: '150' });
    assert.equal(sql.daily_stats.length, 0);
    const db = await connect(databaseConfig('worker'));
    try {
      const history = (await db.query('SELECT sources FROM hdd.source_history WHERE chain_id=1'))
        .rows[0].sources;
      assert.equal(history.binding.networkChainId, 369);
      assert.equal(history.binding.originChainId, 1);
    } finally {
      await db.end();
    }
    assert.equal(s.results[0].result.audit, 'all-prefix-addresses');
    const raw = JSON.parse(r.out.trim().split('\n').at(-1)).fixtureTransport;
    assert.equal(raw.peak, 1);
    assert.equal(raw.http, s.http);
    assert.equal(raw.logical, s.logical);
    assert.equal(raw.bytes, s.observedBytes);
    const balances = raw.calls.filter(
      (c) => c.method === 'eth_call' && c.params[0].data.startsWith('0x70a08231'),
    );
    assert.equal(balances.length, 4);
    assert.ok(
      balances.every(
        (c) => c.params[1].blockHash === hash(103) && c.params[1].requireCanonical === true,
      ),
    );
    assert.ok(
      !raw.calls.some((c) => c.method === 'eth_call' && c.params[0].data.startsWith('0x6a210a0e')),
    );
    for (const call of raw.calls)
      if (call.method === 'eth_getBlockByNumber' && call.params[0] !== 'finalized')
        assert.ok([100n, 101n, 102n, 103n, 180n, 189n].includes(BigInt(call.params[0])));
    for (let i = 1; i < raw.starts.length; i++)
      assert.ok(raw.starts[i].at - raw.starts[i - 1].at >= 2100);
    for (const start of raw.starts) {
      const window = raw.starts.filter((s) => s.at <= start.at && s.at > start.at - 60000);
      assert.ok(window.length <= 12);
      assert.ok(window.reduce((n, s) => n + s.logical, 0) <= 360);
    }
    successHttp = s.http;
    await writeFile('/evidence/prefix-sql.json', JSON.stringify({ state: s, sql, raw }, null, 2));
    await cli(p, 'resume', 'normal', 1);
    await cli(p, 'run', 'normal', 1);
    await reset();
  });
  await test('prefix real request guard denies broader methods, pins, inventory and contradictory finality', async () => {
    const p = await fresh(),
      f = prefixFixture(p),
      g = new PrefixScope(p, p.phases[0]);
    const req = (method, params) => ({ id: 1, method, params });
    for (const [chain, c] of [
      [369, req('eth_chainId', [])],
      [1, req('eth_getBlockByNumber', ['latest', false])],
      [1, req('eth_getBlockByNumber', ['0x64', true])],
      [1, req('eth_getBlockByNumber', ['0x68', false])],
      [1, req('eth_getCode', [p.profile.contract, '0xb4'])],
      [1, req('eth_getCode', [p.profile.contract, '0x68'])],
      [1, req('eth_getTransactionReceipt', [hash(10001)])],
      [
        1,
        req('eth_call', [
          { to: p.profile.contract, data: '0x18160ddd' },
          { blockHash: hash(180), requireCanonical: true },
        ]),
      ],
      [
        1,
        req('eth_call', [
          { to: p.profile.contract, data: '0x18160ddd' },
          { blockHash: hash(189), requireCanonical: true },
        ]),
      ],
      [
        1,
        req('eth_call', [
          { to: p.profile.contract, data: '0x70a08231' + A.slice(2).padStart(64, '0') },
          { blockHash: hash(100), requireCanonical: true },
        ]),
      ],
    ])
      assert.throws(() => g.request(chain, [c]));
    const finalized = req('eth_getBlockByNumber', ['finalized', false]);
    const h = {
      ...f.f.headers.get(189),
      number: '0xbd',
      timestamp: '0x' + BigInt(f.f.plain(189).timestamp).toString(16),
    };
    const respond = (c, h) =>
      g.response([c], JSON.stringify([{ jsonrpc: '2.0', id: 1, result: h }]));
    assert.throws(() => respond(finalized, { ...h, number: '0x5f5e101' }), /corridor/);
    respond(finalized, h);
    g.request(1, [req('eth_getBlockByNumber', ['0xbd', false])]);
    assert.throws(
      () => respond(req('eth_getBlockByNumber', ['0xbd', false]), { ...h, hash: hash(999) }),
      /contradiction/,
    );
    g.request(1, [req('eth_getBlockByNumber', ['0xb4', false])]);
  });
  await test('prefix approved endpoints and ownership bindings fail before any raw requests', async () => {
    const p = await fresh(),
      clock = new FakeClock();
    clock.time = Date.now();
    let sent = 0;
    for (const key of [
      'HDD_V2_CANARY_RELEASE',
      'HDD_V2_DB_INSTANCE',
      'HDD_V2_PROVIDER_PULSE_OFFICIAL',
      'HDD_V2_CANARY_OPT_IN',
      'HDD_V2_ALLOW_LIVE_RPC',
    ]) {
      const env = prefixEnvironment(p);
      env[key] = 'wrong';
      await assert.rejects(
        runCanary(['run', path(p), approval(p)], signal, {
          env,
          clock,
          transport: () => {
            sent++;
            throw Error('forbidden');
          },
        }),
      );
    }
    await assert.rejects(
      runCanary(['run', path(p)], signal, {
        env: prefixEnvironment(p),
        clock,
        transport: () => {
          sent++;
          throw Error('forbidden');
        },
      }),
    );
    assert.equal(sent, 0);
  });
  await test('prefix audit allowance stop retains exact cursor; retry and adaptive split consume same session', async () => {
    const base = await fresh();
    for (const mode of ['cap', 'retry', 'split', 'lost-ack', 'signal', 'disagree']) {
      const p = await fresh(
        mode === 'cap' ? { caps: { ...base.caps, http: successHttp - 1 } } : undefined,
      );
      await cli(p, 'prepare');
      const stopped = ['cap', 'lost-ack', 'signal', 'disagree'].includes(mode);
      await cli(p, 'run', mode === 'cap' ? 'normal' : mode, stopped ? 2 : 0);
      const s = await state(p),
        sql = await snapshot();
      assert.equal(s.status, stopped ? 'stopped' : 'complete');
      assert.equal(sql.chains.length, 1);
      assert.equal(sql.sync_state[0].block_number, mode === 'disagree' ? '100' : '103');
      if (stopped) assert.equal(s.results.length, 0);
      if (mode === 'cap') assert.equal(s.http, successHttp - 1);
      if (mode === 'retry') assert.ok(s.prefix.accounting.some((a) => a.rpc.retries === 1));
      await reset();
    }
  });
  await test('prefix delayed final save and cleanup fault cannot claim complete; primary survives', async () => {
    for (const mode of ['expiry', 'cleanup', 'save']) {
      const p = await fresh(),
        clock = new FakeClock();
      clock.time = Date.now();
      const f = prefixFixture(p, clock);
      const options = { env: prefixEnvironment(p), clock, transport: f.transport };
      await runCanary(['prepare', path(p)], signal, options);
      options.sessionHooks = {
        beforeFinalSave: async () => {
          if (mode === 'expiry') clock.time += 1800000;
          if (mode === 'save') await rename(p.storagePath, p.storagePath + '-moved');
        },
      };
      if (mode === 'cleanup')
        options.cleanupHook = async () => {
          throw Error('injected cleanup failure');
        };
      const s = await runCanary(['run', path(p), approval(p)], signal, options);
      assert.equal(s.status, 'stopped');
      if (mode === 'cleanup') assert.match(s.reason, /cleanup/);
      if (mode === 'save') assert.match(s.reason, /persistence/);
      await reset();
    }
  });
  await test('prefix pacing counts rolling constituents after late persistence; short real deadline drains without dispatch', async () => {
    const p = await fresh(),
      clock = new FakeClock();
    clock.time = Date.now();
    const s = await CanarySession.prepare(p, clock, {
      beforeDispatch: async () => {
        clock.time += 1700;
      },
    });
    await s.start(false);
    const starts = [];
    const wrapped = s.transport(1, async (body) => {
      starts.push(clock.now());
      return {
        status: 200,
        retryAfter: null,
        body: (async function* () {
          yield Buffer.from(
            JSON.stringify(
              JSON.parse(body).map((c) => ({ jsonrpc: '2.0', id: c.id, result: '0x171' })),
            ),
          );
        })(),
      };
    });
    const body = JSON.stringify(
      Array.from({ length: 30 }, (_, id) => ({ id, method: 'eth_chainId', params: [] })),
    );
    for (let i = 0; i < 14; i++) {
      const r = await wrapped(body, signal);
      for await (const c of r.body) void c;
    }
    assert.ok(starts[0] - s.state.start >= 60000);
    for (let i = 1; i < starts.length; i++) assert.ok(starts[i] - starts[i - 1] >= 2100);
    for (let i = 12; i < starts.length; i++) assert.ok(starts[i] - starts[i - 12] >= 60000);
    await s.finish('stopped', 'TEST pacing complete');
    const p3 = await fresh(),
      broken = await CanarySession.prepare(p3, clock, {
        beforeSettlement: async () => {
          await rename(p3.storagePath, p3.storagePath + '-fault');
          throw Error('primary transport witness');
        },
      });
    await broken.start(false);
    const response = await broken.transport(1, async (raw) => ({
      status: 200,
      retryAfter: null,
      body: (async function* () {
        yield Buffer.from(
          JSON.stringify(
            JSON.parse(raw).map((c) => ({ jsonrpc: '2.0', id: c.id, result: '0x171' })),
          ),
        );
      })(),
    }))(body, signal);
    await assert.rejects(async () => {
      for await (const c of response.body) void c;
    }, /primary transport witness/);
    assert.match(broken.state.prefix.secondary[0], /persistence uncertain/);
    await broken.close();
    const p2 = await fresh({ caps: { ...p.caps, milliseconds: 150 } }),
      real = await CanarySession.prepare(p2);
    await real.start(false);
    let dispatched = 0;
    const begin = performance.now();
    const pending = real.transport(1, async () => {
      dispatched++;
      throw Error('forbidden');
    })(body, signal);
    await assert.rejects(pending, /elapsed/);
    await real.finish('stopped', 'TEST real expiry');
    assert.equal(dispatched, 0);
    assert.equal(real.state.pending, false);
    assert.ok(performance.now() - begin >= 100);
    await writeFile(
      '/evidence/prefix-real-time.json',
      JSON.stringify({ elapsedMs: performance.now() - begin, dispatched, state: real.state }),
    );
  });
}
