import assert from 'node:assert/strict';
import { mkdir, readFile, writeFile, rename } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { setTimeout as pause } from 'node:timers/promises';
import { randomUUID } from 'node:crypto';
import pg from 'pg';
import { connect, databaseConfig } from '../../dist/db/connect.js';
import { migrateCurrent } from '../../dist/db/migrate.js';
import { runCanary } from '../../dist/operator/canary.js';
import { CanarySession } from '../../dist/operator/canary-session.js';
import {
  checkCanary,
  canaryAuthority,
  canaryPlanSchema,
  planDigest,
} from '../../dist/operator/canary-plan.js';
import { maintenanceLease } from '../../dist/operator/lease.js';
import { RpcClient } from '../../dist/providers/rpc.js';
import { ProviderBudget } from '../../dist/providers/budget.js';
import { Source } from '../../dist/providers/source.js';
import { CanonicalWriter } from '../../dist/services/projections/writer.js';
import { SyncEngine } from '../../dist/worker/sync/engine.js';
import { profileSources } from '../../dist/worker/sync/profile.js';
import { MetricsService } from '../../dist/worker/metrics/service.js';
import { SqlMetricStore } from '../../dist/worker/metrics/store.js';
import { AddressService } from '../../dist/services/live/address.js';
import { SqlAddressBaseline } from '../../dist/services/live/baseline.js';
import { PriceReader, priceTargets } from '../../dist/services/live/price.js';
import { tables } from '../../dist/worker/bootstrap/manifest.js';
import { plan, inputs, environment, rawFixture } from './fixture.mjs';
import { FakeClock, memoryCooldown } from '../sync/fixture.mjs';
import { sharedProfile } from '../sync/shared-profile.mjs';
import * as live from '../live/fixture.mjs';
import { prefixTests } from './prefix.mjs';

globalThis.fetch = () => {
  throw Error('REAL NETWORK FORBIDDEN');
};
const signal = new AbortController().signal,
  results = [];
const root = '/canary-test/' + randomUUID();
await mkdir(root);
async function test(name, fn) {
  const at = performance.now();
  try {
    await fn();
    results.push({ name, status: 'PASS', ms: performance.now() - at });
    console.log('PASS', name);
  } catch (e) {
    results.push({ name, status: 'FAIL', reason: e.stack });
    throw e;
  }
}
async function fresh(overrides = {}) {
  const p = plan(root + '/' + randomUUID(), overrides);
  await inputs(p);
  return p;
}
const json = async (path) => JSON.parse(await readFile(path, 'utf8'));
async function state(p) {
  return json(p.sessionPath);
}
function child(args, env = process.env) {
  const c = spawn('node', args, { env, stdio: ['ignore', 'pipe', 'pipe'] });
  let out = '';
  for (const s of [c.stdout, c.stderr])
    s.on('data', (b) => {
      out += b;
    });
  const done = new Promise((r, j) => {
    c.on('error', j);
    c.on('close', (code, sig) => r({ code, sig, out }));
  });
  return { c, done };
}
async function cli(p, action, mode = 'normal', expected = 0) {
  const r = await child(['tests/canary/child.mjs', action, p.storagePath + '/plan.json', mode])
    .done;
  assert.equal(r.code, expected, r.out);
  return r;
}
async function reset() {
  const c = new pg.Client({
    host: 'db',
    database: 'hexdailydata_v2',
    user: 'hdd_v2_admin',
    password: process.env.HDD_V2_ADMIN_PASSWORD,
  });
  await c.connect();
  try {
    await c.query(
      'TRUNCATE ' +
        [...Object.keys(tables), 'live_metrics', 'export_bundles']
          .map((t) => 'hdd.' + t)
          .join(',') +
        ' CASCADE',
    );
  } finally {
    await c.end();
  }
}
async function snapshot() {
  const c = await connect(databaseConfig('worker'));
  try {
    const out = {};
    for (const table of [
      'chains',
      'sync_state',
      'current_state',
      'accounts',
      'stakes',
      'share_schedule',
      'daily_stats',
    ]) {
      // pg keeps int8/numeric columns as decimal strings; JSONB would coerce large
      // numbers through JSON.parse and could hide precisely the mismatch tested here.
      const rows = (await c.query(`SELECT * FROM hdd.${table} ORDER BY ${tables[table].join(',')}`))
        .rows;
      for (const r of rows)
        for (const k of [
          'updated_at',
          'observed_at',
          'created_at',
          'last_success_at',
          'progress',
          'undo_bytes',
          'rewind_floor',
        ])
          delete r[k];
      out[table] = rows;
    }
    return out;
  } finally {
    await c.end();
  }
}
async function control(p, targets = null) {
  const f = rawFixture(p);
  f.clock.time = Date.now();
  const budget = new ProviderBudget('worker', memoryCooldown(), f.clock);
  const reader = await connect(databaseConfig('worker'));
  try {
    for (const chain of [1, 369]) {
      if (targets && !targets[chain]) continue;
      const c = await connect(databaseConfig('worker'));
      const w = await CanonicalWriter.acquire(c, chain);
      try {
        const pair = profileSources(
          p.profile,
          chain,
          (s) => f.transport('https://' + s.id + '.invalid'),
          budget,
        );
        const engine = new SyncEngine(w, reader, pair, p.storagePath);
        if (chain === 1)
          await engine.initializeConstructor(
            p.profile.constructor.checkpoint,
            p.profile.constructor.transactionHash,
            [],
            signal,
          );
        else await engine.fork(p.profile.fork.parent, p.profile.fork.entry, signal);
        await engine.once(
          signal,
          targets
            ? f.f.plain(Number(targets[chain]))
            : chain === 1
              ? p.profile.fork.parent
              : p.profile.target,
        );
        await engine.audit(signal);
      } finally {
        await w.close();
      }
    }
    return { snapshot: await snapshot(), raw: f.raw };
  } finally {
    await reader.end();
  }
}
try {
  const migration = await connect(databaseConfig('migrator'));
  try {
    await migrateCurrent(migration);
  } finally {
    await migration.end();
  }
  await prefixTests({ root, test, reset, snapshot, cli });
  await test('shared transport compiled canary replay charges reused aliases and preserves logical range authorization', async () => {
    const p = await fresh({
      profile: sharedProfile(),
      ranges: [
        { chain: 1, from: '100', to: '180' },
        { chain: 369, from: '180', to: '220' },
      ],
    });
    const f = rawFixture(p, new FakeClock(), true);
    f.clock.time = Date.now();
    const options = { env: environment(p), clock: f.clock, transport: f.transport };
    await runCanary(['prepare', p.storagePath + '/plan.json'], signal, options);
    const result = await runCanary(
      ['run', p.storagePath + '/plan.json', p.storagePath + '/approval.json'],
      signal,
      options,
    );
    assert.equal(result.status, 'complete', JSON.stringify(result));
    assert.ok(result.results[0].result[0].splits > 0);
    assert.equal(result.http, f.raw.http);
    assert.equal(result.logical, f.raw.logical);
    assert.equal(result.observedBytes, f.raw.bytes);
    const c = await connect(databaseConfig('worker'));
    try {
      const rows = (
        await c.query('SELECT chain_id,sources FROM hdd.source_history ORDER BY chain_id')
      ).rows;
      assert.deepEqual(
        rows.map((r) => [r.sources.binding.networkChainId, r.sources.binding.originChainId]),
        [
          [369, 1],
          [369, 369],
        ],
      );
      assert.equal(
        rows[0].sources.providers[0].endpointAlias,
        rows[1].sources.providers[0].endpointAlias,
      );
      assert.equal(
        (
          await c.query(
            'SELECT count(*) FROM hdd.events WHERE origin_chain_id=369 AND block_number=181',
          )
        ).rows[0].count,
        '1',
      );
    } finally {
      await c.end();
    }
    results.push({ name: 'shared canary raw counters', status: 'MEASURED_OFFLINE', raw: f.raw });
    await reset();
    const old = { ...p, version: 1 };
    assert.equal(checkCanary(old).state, 'NOT_CONFIGURED');
    const changed = canaryPlanSchema.parse({
      ...p,
      profile: { ...p.profile, commonHistory: 'ethereum' },
    });
    assert.notEqual(planDigest(changed), planDigest(p));
    assert.throws(
      () =>
        canaryAuthority(
          changed,
          {
            session: p.session,
            planDigest: planDigest(p),
            release: p.release,
            instance: p.instance,
            decision: 'owner-approved-bounded-canary',
          },
          environment(changed),
        ),
      /approval/,
    );
    assert.equal(checkCanary({ ...p, allowHeadObservation: false }).state, 'NOT_CONFIGURED');
    const bounded = await fresh({
      profile: sharedProfile(),
      ranges: p.ranges,
      allowHeadObservation: false,
      phases: [
        {
          kind: 'capabilities',
          purpose: 'Offline no-head boundary fixture',
          chain: 1,
          at: p.profile.fork.parent,
        },
      ],
    });
    const s = await CanarySession.prepare(bounded, f.clock);
    await s.start(false);
    let dispatched = 0;
    const guard = s.transport(1, async () => {
      dispatched++;
      throw Error('forbidden');
    });
    for (const call of [
      { method: 'eth_getBlockByNumber', params: ['latest', false] },
      { method: 'eth_getBlockByNumber', params: ['0xb5', false] },
      { method: 'eth_getCode', params: [p.profile.contract, '0xb5'] },
      { method: 'eth_getLogs', params: [{ fromBlock: '0xb4', toBlock: '0xb5' }] },
    ])
      await assert.rejects(guard(JSON.stringify([call]), signal), /outside/);
    assert.equal(dispatched, 0);
    assert.equal(s.state.http, 0);
    await s.close();
  });
  await test('compiled help/check and authority/configuration negatives construct zero transports', async () => {
    const p = await fresh();
    let constructed = 0;
    const options = {
      env: environment(p),
      transport: () => {
        constructed++;
        throw Error('transport forbidden');
      },
    };
    const help = await child(['dist/operator/main.js', 'canary', 'help']).done;
    assert.equal(help.code, 0, help.out);
    for (const input of [
      {},
      { ...p, profile: null },
      { ...p, caps: { ...p.caps, http: 2501 } },
      { ...p, ranges: [] },
      { ...p, instance: 'missing' },
      {
        ...p,
        profile: {
          ...p.profile,
          ethereum: [p.profile.ethereum[0], { ...p.profile.ethereum[1], operator: 'fixture-1' }],
        },
      },
    ])
      assert.equal(checkCanary(input).state, 'NOT_CONFIGURED');
    const bad = p.storagePath + '/bad.json';
    await writeFile(bad, '{}');
    const checked = await child(['dist/operator/main.js', 'canary', 'check', bad]).done;
    assert.equal(checked.code, 2, checked.out);
    await assert.rejects(
      runCanary(['run', p.storagePath + '/plan.json'], signal, options),
      /approval/,
    );
    for (const key of [
      'HDD_V2_ALLOW_LIVE_RPC',
      'HDD_V2_CANARY_OPT_IN',
      'HDD_V2_CANARY_RELEASE',
      'HDD_V2_DB_INSTANCE',
      'HDD_V2_PROJECT',
    ]) {
      const env = { ...environment(p), [key]: 'wrong' };
      await assert.rejects(
        runCanary(['run', p.storagePath + '/plan.json', p.storagePath + '/approval.json'], signal, {
          ...options,
          env,
        }),
      );
    }
    await assert.rejects(
      runCanary(
        ['resume', p.storagePath + '/plan.json', p.storagePath + '/approval.json'],
        signal,
        options,
      ),
    );
    assert.equal(constructed, 0);
    assert.throws(() => canaryAuthority(p, null, environment(p)));
  });
  await test('HTTP/logical/elapsed byte boundaries, malformed bodies/retries and honest chunk overrun', async () => {
    async function session(caps) {
      const p = await fresh({
        caps: {
          milliseconds: 3600000,
          http: 10,
          logical: 20,
          bytes: 10000,
          responseBytes: 100,
          ...caps,
        },
      });
      const clock = new FakeClock();
      clock.time = 1000;
      const s = await CanarySession.prepare(p, clock);
      await s.start(false);
      return { s, p, clock };
    }
    const raw = async () => ({
      status: 200,
      retryAfter: null,
      body: (async function* () {
        yield Buffer.from('[]');
      })(),
    });
    const consume = async (t, calls = 1) => {
      const r = await t(
        JSON.stringify(
          Array.from({ length: calls }, () => ({ method: 'eth_chainId', params: [] })),
        ),
        signal,
      );
      for await (const b of r.body) void b;
      await r.close?.();
    };
    for (const caps of [{ http: 2 }, { logical: 2 }]) {
      const { s } = await session(caps);
      const t = s.transport(1, raw);
      await consume(t);
      await consume(t);
      await assert.rejects(consume(t), /cap/);
      assert.equal(s.state.http, 2);
      assert.equal(s.state.observedBytes, 4);
      await s.close();
    }
    {
      // Literal whole-session ceiling wins over42*60=2520. This is synthetic
      // transport/virtual time and never opens a provider connection.
      const { s } = await session({
        http: 2500,
        logical: 20000,
        bytes: 536870912,
        responseBytes: 16777216,
      });
      const t = s.transport(1, raw);
      for (let i = 0; i < 2500; i++) await consume(t);
      await assert.rejects(consume(t), /cap/);
      assert.equal(s.state.http, 2500);
      assert.equal(s.state.observedBytes, 5000);
      await s.close();
    }
    {
      const { s, clock } = await session({ milliseconds: 100 });
      clock.time = 1099;
      await consume(s.transport(1, raw));
      clock.time = 1100;
      await assert.rejects(consume(s.transport(1, raw)), /elapsed/);
      assert.equal(s.state.http, 1);
      await s.close();
    }
    {
      const { s } = await session({ bytes: 200, responseBytes: 100 });
      const full = async () => ({
        ...(await raw()),
        body: (async function* () {
          yield Buffer.alloc(100);
        })(),
      });
      await consume(s.transport(1, full));
      await assert.rejects(consume(s.transport(1, full)), /reservation/);
      assert.equal(s.state.chargedBytes, 100);
      await s.close();
    }
    {
      const { s } = await session({ bytes: 200, responseBytes: 100 });
      let ended = false;
      const t = s.transport(1, async () => ({
        ...(await raw()),
        body: (async function* () {
          try {
            yield Buffer.alloc(99);
            yield Buffer.alloc(250);
          } finally {
            ended = true;
          }
        })(),
      }));
      await assert.rejects(consume(t), /byte cap/);
      assert.equal(s.state.observedBytes, 349);
      assert.equal(s.state.chargedBytes, 349);
      assert.equal(ended, true);
      await s.finish('stopped', 'overrun');
      await s.close();
      const again = await CanarySession.load(s.plan, s.clock);
      await assert.rejects(again.start(true), /terminal/);
    }
    {
      const { s, clock } = await session({ responseBytes: 1024, bytes: 100000, http: 10 });
      let count = 0;
      const t = s.transport(1, async (body) => ({
        status: ++count < 3 ? (count === 1 ? 429 : 503) : 200,
        retryAfter: '0',
        body: (async function* () {
          yield Buffer.from(
            count === 3
              ? 'invalid'
              : JSON.stringify(
                  JSON.parse(body).map((c) => ({ jsonrpc: '2.0', id: c.id, result: '0x1' })),
                ),
          );
        })(),
      }));
      const rpc = new RpcClient(
        'one',
        null,
        1,
        s.plan.profile.contract,
        t,
        new ProviderBudget('worker', memoryCooldown(), clock),
      );
      await assert.rejects(rpc.call('eth_chainId', [], signal));
      assert.equal(s.state.http, 3);
      assert.equal(s.state.logical, 3);
      assert.ok(s.state.observedBytes > 7);
      await s.close();
    }
    {
      const { s, clock } = await session({});
      clock.time = 999;
      assert.throws(() => s.time(), /clock/);
      await s.close();
    }
    {
      const { s, p } = await session({});
      await rename(p.storagePath, p.storagePath + '-moved');
      await assert.rejects(s.save(), /persistence/);
      assert.equal(s.controller.signal.aborted, true);
      await s.close();
    }
  });
  await test('separate Linux processes reject ownership; SIGKILL retains deadline and unknown reservation', async () => {
    for (const mode of ['reserved', 'delivered']) {
      const p = await fresh();
      const clock = new FakeClock();
      clock.time = Date.now();
      await CanarySession.prepare(p, clock);
      const c = child(['tests/canary/child.mjs', 'lease', p.storagePath + '/plan.json', mode]);
      for (let i = 0; i < 200; i++) {
        try {
          if (
            (await readFile(p.storagePath + '/stage.txt', 'utf8')) ===
            (mode === 'delivered' ? 'delivered' : 'reserved')
          )
            break;
        } catch {}
        await pause(20);
        if (i === 199) throw Error('child did not reach crash point');
      }
      await assert.rejects(maintenanceLease([p.storagePath, p.quotaPath], signal), /active/);
      const before = await state(p);
      assert.equal(before.pending, true);
      c.c.kill('SIGKILL');
      const killed = await c.done;
      assert.equal(killed.sig, 'SIGKILL');
      const release = await maintenanceLease([p.storagePath, p.quotaPath], signal);
      try {
        clock.time = before.highWater;
        const next = await CanarySession.load(p, clock);
        await next.start(true);
        assert.equal(next.state.start, before.start);
        assert.equal(next.state.deadline, before.deadline);
        assert.equal(next.state.http, 1);
        assert.equal(next.state.chargedBytes, 2 * p.caps.responseBytes);
        assert.equal(next.state.uncertainAttempts, 1);
        await next.finish('stopped', 'crash witness');
        await next.close();
      } finally {
        await release();
      }
      const original = await readFile(p.sessionPath);
      await writeFile(p.sessionPath, '{');
      await assert.rejects(CanarySession.load(p, clock));
      await writeFile(p.sessionPath, original);
      await assert.rejects(CanarySession.load({ ...p, session: randomUUID() }, clock), /state/);
      await assert.rejects(
        CanarySession.load({ ...p, release: 'sha256:' + 'c'.repeat(64) }, clock),
        /state/,
      );
    }
  });
  let completeControl;
  await test('queue time, scope, checksum, cloned roots and expired resume fail closed', async () => {
    const p = await fresh({
      caps: { milliseconds: 100, http: 10, logical: 20, bytes: 10000, responseBytes: 100 },
    });
    const clock = new FakeClock();
    clock.time = 1000;
    const s = await CanarySession.prepare(p, clock);
    await s.start(false);
    let calls = 0;
    const rpc = new RpcClient(
      'one',
      null,
      1,
      p.profile.contract,
      s.transport(1, async () => {
        calls++;
        throw Error('forbidden');
      }),
      new ProviderBudget('worker', memoryCooldown(), clock),
    );
    await assert.rejects(rpc.call('eth_chainId', [], signal), /elapsed/);
    assert.equal(calls, 0);
    await s.finish('stopped', 'queue elapsed');
    await s.close();
    const stopped = await runCanary(
      ['resume', p.storagePath + '/plan.json', p.storagePath + '/approval.json'],
      signal,
      {
        env: environment(p),
        clock,
        transport: () => {
          calls++;
          throw Error('forbidden');
        },
      },
    );
    assert.equal(stopped.status, 'stopped');
    assert.equal(calls, 0);
    const raw = await json(p.sessionPath);
    raw.http = 0;
    raw.reason = 'corrupted';
    await writeFile(p.sessionPath, JSON.stringify(raw));
    await assert.rejects(CanarySession.load(p, clock), /checksum/);
    const p2 = await fresh();
    clock.time = Date.now();
    const s2 = await CanarySession.prepare(p2, clock);
    await s2.start(false);
    const outside = s2.transport(1, async () => {
      calls++;
      throw Error('forbidden');
    });
    await assert.rejects(
      outside('[{"method":"eth_getBlockByNumber","params":["0x1",false]}]', signal),
      /outside/,
    );
    assert.equal(calls, 0);
    assert.equal(s2.state.http, 0);
    await s2.close();
    await rename(p2.quotaPath, p2.quotaPath + '-original');
    await mkdir(p2.quotaPath);
    await assert.rejects(CanarySession.load(p2, clock), /state/);
  });
  await test('compiled runner cap preserves exact accepted SQL checkpoint versus uncapped CONTROL FIXTURE', async () => {
    const p = await fresh({
      caps: {
        milliseconds: 3600000,
        http: 120,
        logical: 20000,
        bytes: 536870912,
        responseBytes: 1048576,
      },
    });
    await cli(p, 'prepare');
    const r = await cli(p, 'run', 'normal', 2);
    const stopped = await state(p);
    assert.equal(stopped.http, 120, r.out);
    assert.equal(stopped.status, 'stopped');
    const bounded = await snapshot();
    assert.ok(bounded.sync_state.length > 0);
    assert.equal(typeof bounded.current_state[0].circulating_hearts, 'string');
    assert.ok(
      bounded.accounts.some((a) => BigInt(a.liquid_hearts) > BigInt(Number.MAX_SAFE_INTEGER)),
    );
    const resumed = await cli(p, 'resume', 'normal', 2);
    assert.match(resumed.out, /"http":0,"logical":0,"bytes":0/);
    assert.deepEqual(await snapshot(), bounded);
    const target = Object.fromEntries(bounded.sync_state.map((s) => [s.chain_id, s.block_number]));
    await reset();
    const controlResult = await control(p, target);
    assert.deepEqual(bounded, controlResult.snapshot);
    await reset();
    completeControl = await control(p);
    await reset();
    results.push({
      name: 'CONTROL FIXTURE counts',
      raw: completeControl.raw,
      status: 'MEASURED_OFFLINE',
    });
  });
  await test('compiled real SIGTERM around COMMIT then same-session resume preserves exact SQL', async () => {
    const p = await fresh();
    await cli(p, 'prepare');
    await cli(p, 'run', 'signal', 2);
    const before = await state(p);
    assert.equal(before.status, 'stopped');
    assert.ok(before.http > 0);
    const r = await cli(p, 'resume');
    const after = await state(p);
    assert.equal(after.start, before.start);
    assert.equal(after.deadline, before.deadline);
    assert.equal(after.status, 'complete', r.out);
    assert.deepEqual(await snapshot(), completeControl.snapshot);
    assert.ok(after.http > before.http);
    const other = await fresh();
    let constructed = 0;
    await assert.rejects(
      runCanary(['prepare', other.storagePath + '/plan.json'], signal, {
        env: environment(other),
        transport: () => {
          constructed++;
          throw Error('forbidden');
        },
      }),
      /empty/,
    );
    assert.equal(constructed, 0);
    results.push({ name: 'compiled resumed session', state: after, status: 'MEASURED_OFFLINE' });
    await reset();
  });
  await test('compiled lost COMMIT acknowledgement resolves without duplicate additive effects', async () => {
    const p = await fresh();
    await cli(p, 'prepare');
    await cli(p, 'run', 'lost-ack', 2);
    const r = await cli(p, 'resume');
    assert.equal((await state(p)).status, 'complete', r.out);
    assert.deepEqual(await snapshot(), completeControl.snapshot);
    await reset();
  });
  await test('actual Source, metrics/price and address paths share both roles and one durable transport', async () => {
    const p = await fresh(),
      clock = new live.SequentialClock(),
      f = live.fixture({ clock });
    p.profile.contract = live.HEX;
    p.profile.codeHash = live.CODE_HASH;
    p.price = live.profile();
    p.ranges = [
      { chain: 1, from: '0', to: '100000' },
      { chain: 369, from: '0', to: '100000' },
    ];
    await inputs(p);
    const s = await CanarySession.prepare(p, clock);
    await s.start(false);
    const store = memoryCooldown(),
      worker = new ProviderBudget('worker', store, clock),
      api = new ProviderBudget('api', store, clock);
    const pair = ['one', 'two'].map(
      (id) =>
        new RpcClient(
          id,
          id,
          369,
          live.HEX,
          s.transport(369, f.rpc(id).transport),
          worker,
          priceTargets(p.price),
        ),
    );
    const c = await connect(databaseConfig('worker'));
    try {
      const h = await pair[0].calls(
        [{ method: 'eth_getBlockByNumber', params: ['latest', false] }],
        signal,
      );
      const raw = h[0];
      const at = {
        number: BigInt(raw.number).toString(),
        hash: raw.hash,
        parentHash: raw.parentHash,
        timestamp: BigInt(raw.timestamp).toString(),
      };
      await new Source(pair[0], {
        codeHash: live.CODE_HASH,
        finality: { mode: 'confirmed', confirmations: 1, rollbackBlocks: 128 },
        completeness: 'filtered-ranges',
      }).verify(at, signal);
      const metrics = new MetricsService(
        pair,
        live.CODE_HASH,
        new PriceReader(p.price, live.HEX),
        new SqlMetricStore(c),
      );
      await metrics.tick(signal);
      assert.equal(metrics.counters.updates, 4);
      const rpc = new RpcClient(
        'address',
        'one',
        369,
        live.HEX,
        s.transport(369, f.rpc('address').transport),
        api,
      );
      const a = new AddressService(rpc, live.CODE_HASH, new SqlAddressBaseline(c));
      const page = await a.get(live.A, signal, 3);
      assert.equal(page.outcome, 'available');
      assert.equal(s.state.http, f.attempts.length);
      assert.equal(
        s.state.logical,
        f.attempts.reduce((n, x) => n + x.calls, 0),
      );
      assert.equal(
        s.state.observedBytes,
        f.attempts.reduce((n, x) => n + x.bytes, 0),
      );
      await s.finish('complete', 'mixed raw paths');
      results.push({ name: 'mixed raw counters', state: s.state, status: 'MEASURED_OFFLINE' });
    } finally {
      await c.end();
      await s.close();
    }
    await reset();
  });
  await test('compiled acquisition-only capability/probe records actual interval without canonical origin', async () => {
    const base = await fresh();
    const p = await fresh({
      phases: [
        {
          kind: 'capabilities',
          purpose: 'Synthetic pinned code and state',
          chain: 1,
          at: base.profile.constructor.checkpoint,
        },
        {
          kind: 'probe',
          purpose: 'Synthetic historical acquisition only',
          chain: 369,
          previous: base.profile.fork.parent,
          to: '188',
        },
      ],
    });
    await cli(p, 'prepare');
    const r = await cli(p, 'run');
    const s = await state(p);
    assert.equal(s.status, 'complete', r.out);
    assert.equal(s.results[1].result.acquisitionOnly, true);
    assert.equal(s.results[1].result.through, '187');
    assert.equal((await snapshot()).chains.length, 0);
    assert.ok(s.http > 0);
    const freshPlan = await fresh();
    const owner = await connect(databaseConfig('worker'));
    try {
      await owner.query('SELECT pg_advisory_lock(4244,1)');
      await assert.rejects(
        runCanary(['prepare', freshPlan.storagePath + '/plan.json'], signal, {
          env: environment(freshPlan),
        }),
        /exclusive/,
      );
    } finally {
      await owner.end();
    }
  });
  await test('compiled adaptive range split and both source chains reconcile raw durable totals', async () => {
    const p = await fresh();
    await cli(p, 'prepare');
    const r = await cli(p, 'run', 'split');
    const s = await state(p);
    const raw = JSON.parse(
      r.out
        .trim()
        .split('\n')
        .findLast((l) => l.includes('fixtureTransport')),
    ).fixtureTransport;
    assert.equal(s.http, raw.http);
    assert.equal(s.logical, raw.logical);
    assert.equal(s.observedBytes, raw.bytes);
    assert.equal(raw.peak, 1);
    assert.ok(s.results[0].result.reduce((n, v) => n + v.splits, 0) > 0);
    assert.equal((await snapshot()).sync_state.at(-1).block_number, '188');
    results.push({
      name: 'split counters',
      http: s.http,
      logical: s.logical,
      observedBytes: s.observedBytes,
      status: 'MEASURED_OFFLINE',
    });
    await reset();
  });
  await test('paired source failure drains sibling writes before durable stop and safe resume', async () => {
    const p = await fresh(),
      clock = new FakeClock();
    clock.time = Date.now();
    const f = rawFixture(p, clock);
    let injected = false,
      dispatched = 0,
      saves = 0,
      maximumSaves = 0;
    const originalSave = CanarySession.prototype.save;
    CanarySession.prototype.save = async function () {
      saves++;
      maximumSaves = Math.max(maximumSaves, saves);
      try {
        return await originalSave.call(this);
      } finally {
        saves--;
      }
    };
    const options = {
      env: environment(p),
      clock,
      transport: (endpoint) => {
        const raw = f.transport(endpoint);
        return async (body, active) => {
          dispatched++;
          const calls = JSON.parse(body);
          if (
            !injected &&
            endpoint.includes('fixture-1-1') &&
            calls.some((c) => c.method === 'eth_getBlockByNumber' && c.params[0] === 'latest')
          ) {
            injected = true;
            return {
              status: 200,
              retryAfter: null,
              body: (async function* () {
                yield Buffer.from('invalid');
              })(),
            };
          }
          return raw(body, active);
        };
      },
    };
    try {
      await runCanary(['prepare', p.storagePath + '/plan.json'], signal, options);
      const stopped = await runCanary(
        ['run', p.storagePath + '/plan.json', p.storagePath + '/approval.json'],
        signal,
        options,
      );
      assert.equal(injected, true);
      assert.equal(stopped.status, 'stopped');
      assert.equal(maximumSaves, 1);
      const { checksum, ...stored } = await state(p);
      assert.deepEqual(stopped, stored);
      assert.equal(stored.pending, false);
      assert.equal(stored.terminal, false);
      assert.ok(stored.http >= dispatched);
      await CanarySession.load(p, clock);
      const resumed = await runCanary(
        ['resume', p.storagePath + '/plan.json', p.storagePath + '/approval.json'],
        signal,
        options,
      );
      assert.equal(resumed.status, 'complete');
      assert.equal(resumed.start, stored.start);
      assert.equal(resumed.deadline, stored.deadline);
      assert.equal(maximumSaves, 1);
      assert.deepEqual(await snapshot(), completeControl.snapshot);
      const before = await readFile(p.sessionPath, 'utf8');
      let constructed = 0;
      await assert.rejects(
        runCanary(
          ['resume', p.storagePath + '/plan.json', p.storagePath + '/approval.json'],
          signal,
          {
            ...options,
            transport: () => {
              constructed++;
              throw Error('forbidden');
            },
          },
        ),
        /complete/,
      );
      assert.equal(constructed, 0);
      assert.equal(await readFile(p.sessionPath, 'utf8'), before);
      results.push({
        name: 'paired failure shutdown',
        maximumSaves,
        durableReturnedStateEqual: true,
        startPreserved: true,
        remainingCreditOnly: true,
        status: 'MEASURED_OFFLINE',
      });
    } finally {
      CanarySession.prototype.save = originalSave;
      await reset();
    }
  });
  console.log(
    JSON.stringify({
      groups: results.filter((r) => r.status === 'PASS').length,
      realProviderCalls: 0,
      virtualTimeIsNotThroughput: true,
    }),
  );
} finally {
  await writeFile(
    '/evidence/results.json',
    JSON.stringify({ results, realProviderCalls: 0 }, null, 2),
  );
}
