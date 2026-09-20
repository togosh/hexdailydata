import assert from 'node:assert/strict';
import pg from 'pg';
import { readFileSync, writeFileSync } from 'node:fs';
import { readFile, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import http from 'node:http';
import { setTimeout as pause } from 'node:timers/promises';
import { connect, databaseConfig } from '../../src/db/connect.ts';
import { migrateCurrent } from '../../src/db/migrate.ts';
import { ReadDatabase } from '../../src/services/queries/database.ts';
import { createApp } from '../../src/api/app.ts';
import { sqlBaseline } from '../../src/api/dependencies.ts';
import { routes } from '../../src/api/routes.ts';
import { homeSql, home } from '../../src/services/queries/home.ts';
import { stakesSql, holdersSql } from '../../src/services/queries/lists.ts';
import { dailySql, marketSql } from '../../src/services/queries/history.ts';
import { ExportService } from '../../src/worker/exports/service.ts';
import { reserve } from '../../src/worker/exports/files.ts';
import { SqlMetricStore } from '../../src/worker/metrics/store.ts';
import { MetricsService } from '../../src/worker/metrics/service.ts';
import { PriceReader } from '../../src/services/live/price.ts';
import { AddressService } from '../../src/services/live/address.ts';
import { fixture, ManualClock, CODE_HASH, HEX, A, addr } from '../live/fixture.mjs';
import { liveSelectors } from '../../src/providers/live-abi.ts';
import { populate, signal, at, address } from './fixture.mjs';

const large = process.env.HDD_V2_API_SCALE === '1',
  results = [],
  evidence = {
    large,
    node: process.version,
    platform: process.platform,
    limits: {
      db: '1.5CPU/3GiB',
      runner: '0.25CPU/512MiB',
      image: '0.25CPU/512MiB',
      combined: '2CPU/4GiB',
    },
    http: [],
    plans: {},
    resources: [],
  };
const clients = [],
  apps = [];
const admin = new pg.Client({
  host: 'db',
  database: 'hexdailydata_v2',
  user: 'hdd_v2_admin',
  password: process.env.HDD_V2_ADMIN_PASSWORD,
});
async function db(role = 'worker') {
  const c = await connect(databaseConfig(role));
  c.on('error', () => {});
  clients.push(c);
  return c;
}
async function test(name, fn) {
  const t = performance.now();
  try {
    await fn();
    results.push({ name, status: 'PASS', ms: performance.now() - t });
    console.log('PASS', name);
    writeFileSync('/evidence/results.json', JSON.stringify(results, null, 2));
    writeFileSync('/evidence/measurements.json', JSON.stringify(evidence, null, 2));
  } catch (e) {
    results.push({ name, status: 'FAIL', error: e.stack });
    throw e;
  }
}
async function serve(options) {
  const app = createApp(options);
  apps.push(app);
  await app.listen({ host: '0.0.0.0', port: 0 });
  return { app, url: 'http://127.0.0.1:' + app.server.address().port };
}
async function request(url, path, options = {}, expected = 200) {
  const r = await fetch(url + path, options);
  const text = await r.text();
  assert.equal(r.status, expected, `${path}: ${text}`);
  evidence.http.push({
    path: path
      .split('?')[0]
      .replace(/0x[0-9a-fA-F]{40}/g, ':address')
      .replace(/[0-9a-f]{8}-[0-9a-f-]{27}/g, ':bundle'),
    method: options.method ?? 'GET',
    status: r.status,
    bytes: Buffer.byteLength(text),
  });
  return { r, text, body: text ? JSON.parse(text) : null };
}
const sha = (b) => createHash('sha256').update(b).digest('hex');
let reads, worker, api, server, exporter, reader, clock;
async function sample(label) {
  const db = (
    await admin.query(
      "SELECT pg_read_file('/sys/fs/cgroup/cpu.max') AS cpu,pg_read_file('/sys/fs/cgroup/memory.max') AS limit,pg_read_file('/sys/fs/cgroup/memory.current') AS current,pg_read_file('/sys/fs/cgroup/memory.peak') AS peak,pg_read_file('/sys/fs/cgroup/cpu.stat') AS cpu_stat",
    )
  ).rows[0];
  const storage = (
    await admin.query(
      'SELECT pg_database_size(current_database())::text AS bytes,temp_bytes::text,temp_files::text,(SELECT sum(size)::text FROM pg_ls_waldir()) AS wal_bytes FROM pg_stat_database WHERE datname=current_database()',
    )
  ).rows[0];
  evidence.resources.push({
    label,
    db,
    storage,
    runner: {
      cpu: readFileSync('/sys/fs/cgroup/cpu.max', 'utf8').trim(),
      limit: readFileSync('/sys/fs/cgroup/memory.max', 'utf8').trim(),
      current: readFileSync('/sys/fs/cgroup/memory.current', 'utf8').trim(),
      peak: readFileSync('/sys/fs/cgroup/memory.peak', 'utf8').trim(),
      rss: process.memoryUsage().rss,
    },
    reserve: await reserve('/exports'),
  });
}
try {
  await admin.connect();
  await migrateCurrent(await db('migrator'));
  worker = await db();
  api = await db('api');
  reads = new ReadDatabase(databaseConfig('api'));
  server = await serve({ dependencies: { db: reads }, now: () => clock ?? at });
  await test('empty schema ready; Home unavailable; API SQL role cannot mutate', async () => {
    await request(server.url, '/health/ready');
    await request(server.url, '/api/v2/home', {}, 503);
    assert.equal((await request(server.url, '/api/v2/status')).body.state, 'uninitialized');
    for (const sql of [
      "INSERT INTO hdd.live_metrics(chain_id,metric,observation) VALUES(369,'price','{}')",
      'UPDATE hdd.sync_state SET revision=revision',
      'DELETE FROM hdd.export_bundles',
      'CREATE TABLE hdd.forbidden(n int)',
    ])
      await assert.rejects(api.query(sql), /permission denied|read-only transaction/);
    await api.query('SET default_transaction_read_only=off');
    for (const sql of [
      'UPDATE hdd.sync_state SET revision=revision',
      'DELETE FROM hdd.export_bundles',
      'CREATE TABLE hdd.forbidden(n int)',
    ])
      await assert.rejects(api.query(sql), /permission denied/);
    await api.query('SET default_transaction_read_only=on');
    await admin.query('UPDATE hdd.schema_migrations SET version=6 WHERE version=5');
    const incompatible = new ReadDatabase(databaseConfig('api'));
    await assert.rejects(incompatible.read(signal, (c) => c.query('SELECT 1')));
    await incompatible.close();
    await admin.query('UPDATE hdd.schema_migrations SET version=5 WHERE version=6');
    for (const config of [
      { ...databaseConfig('api'), instance: '00000000-0000-0000-0000-000000000000' },
      { ...databaseConfig('api'), user: 'hdd_v2_worker' },
    ]) {
      if (config.user !== 'hdd_v2_api') assert.throws(() => new ReadDatabase(config));
      else {
        const bad = new ReadDatabase(config);
        await assert.rejects(bad.read(signal, (c) => c.query('SELECT 1')));
        await bad.close();
      }
    }
    await worker.query("INSERT INTO hdd.live_metrics VALUES(369,'price','{}','{}')");
    await worker.query('DELETE FROM hdd.live_metrics');
  });
  await test('metrics-only Home is useful without daily/native bootstrap', async () => {
    const raw = fixture();
    raw.clock.time += 60000;
    const live = new MetricsService(
      [raw.rpc('one'), raw.rpc('two')],
      CODE_HASH,
      new PriceReader(raw.price, HEX),
      new SqlMetricStore(worker),
    );
    await live.tick(signal);
    clock = raw.clock.time;
    const partial = await request(server.url, '/api/v2/home');
    assert.equal(partial.body.daily, null);
    assert.ok(partial.body.live.shareRate.value);
    assert.equal(partial.body.sync.state, 'uninitialized');
    await worker.query('DELETE FROM hdd.live_metrics');
  });
  evidence.fixture = await populate(worker, admin, large);
  await test('exclusive SQL leases; real abort cancels a slow query without cancelling another caller', async () => {
    const cancel = new AbortController();
    const t = performance.now();
    const waiting = reads.read(cancel.signal, (c) => c.query('SELECT pg_sleep(10)'));
    const observed = waiting.then(
      () => false,
      () => true,
    );
    await pause(30);
    cancel.abort();
    const healthy = await reads.read(signal, (c) => c.query('SELECT 42 AS value'));
    assert.equal(healthy.rows[0].value, 42);
    assert.equal(await observed, true);
    assert.ok(performance.now() - t < 1500);
    evidence.sqlCancellationMs = performance.now() - t;
    const dedicated = await reads.connection();
    await dedicated.query('SET statement_timeout=0');
    const clientStart = performance.now();
    await assert.rejects(dedicated.query('SELECT pg_sleep(10)'), /Query read timeout/);
    await dedicated.end();
    evidence.clientDeadlineMs = performance.now() - clientStart;
    assert.ok(evidence.clientDeadlineMs < 4500);
  });
  await sample('populated');
  const f = fixture();
  f.clock.time += 60000;
  const store = new SqlMetricStore(worker),
    metrics = new MetricsService(
      [f.rpc('one'), f.rpc('two')],
      CODE_HASH,
      new PriceReader(f.price, HEX),
      store,
    );
  await metrics.tick(signal);
  clock = f.clock.time;
  await test('one-query Home; independent aging; 200/304 transitions and chain isolation', async () => {
    const queries = reads.counters.dataQueries;
    const statements = [];
    const originalRead = reads.read.bind(reads);
    reads.read = (signal, fn, snapshot) =>
      originalRead(
        signal,
        async (client) => {
          const originalQuery = client.query.bind(client);
          client.query = (...args) => {
            statements.push(args[0]);
            return originalQuery(...args);
          };
          try {
            return await fn(client);
          } finally {
            client.query = originalQuery;
          }
        },
        snapshot,
      );
    const first = await request(server.url, '/api/v2/home');
    const trap = () => {
      throw new Error('Provider/file/hash must not run on Home');
    };
    const isolated = await serve({
      dependencies: {
        db: reads,
        addresses: { get: trap, stake: trap },
        downloads: { catalog: trap, openStream: trap },
      },
      now: () => clock,
    });
    await request(isolated.url, '/api/v2/home');
    await isolated.app.close();
    reads.read = originalRead;
    assert.equal(statements.length, 2);
    assert.ok(statements.every((sql) => sql === homeSql));
    evidence.homeQueryInstrumentation = {
      requests: 2,
      dataStatements: statements.length,
      sql: homeSql,
    };
    assert.equal(reads.counters.dataQueries - queries, 2);
    assert.ok(Buffer.byteLength(first.text) <= 25 * 1024);
    evidence.homeBytes = Buffer.byteLength(first.text);
    evidence.homeExample = first.body;
    assert.equal(first.body.live.price.value.usdPerHex, '25');
    assert.equal(first.body.live.shareRate.value.rawShareRate, '123456');
    assert.equal(first.body.daily.asOf.blockTimestamp, null);
    await request(
      server.url,
      '/api/v2/home',
      { headers: { 'If-None-Match': first.r.headers.get('etag') } },
      304,
    );
    clock += 121000;
    const stale = await request(server.url, '/api/v2/home', {
      headers: { 'If-None-Match': first.r.headers.get('etag') },
    });
    assert.equal(stale.body.live.price.status, 'stale');
    assert.equal(stale.body.live.price.observedAt, first.body.live.price.observedAt);
    clock += 1800000;
    const expired = await request(server.url, '/api/v2/home');
    assert.equal(expired.body.live.price.status, 'unavailable');
    assert.ok(expired.body.daily);
    clock = at + 86400000;
    assert.equal(
      (await request(server.url, '/api/v2/home')).body.live.todayPayoutEstimate.value,
      null,
    );
    clock = f.clock.time;
    await worker.query("UPDATE hdd.live_metrics SET observation='{}' WHERE metric='price'");
    const partial = await request(server.url, '/api/v2/home');
    assert.equal(partial.body.live.price.value, null);
    assert.ok(partial.body.live.shareRate.value);
    await request(server.url, '/api/v2/home?chain=ethereum', {}, 503);
    await store.put(369, 'price', first.body.live.price);
  });
  await test('current Home totals and signed in-day changes use exact adjacent baseline', async () => {
    // Transaction-local synthetic edge cases; production projections remain untouched.
    await worker.query('BEGIN');
    try {
      const db = { counters: { dataQueries: 0 }, read: async (_signal, fn) => fn(worker) };
      await worker.query(`UPDATE hdd.current_state SET holder_count=9007199254740993,
        staker_count=70, starts=9,ends=12,locked_hearts=1234567890123456789,penalty_hearts=123456789`);
      await worker.query(`UPDATE hdd.daily_stats SET holder_count=9007199254740995,
        staker_count=67,locked_hearts=1234567890123456790 WHERE contract_day=399`);
      const result = await home(db, 'pulsechain', signal, clock);
      assert.equal(result.current.holderCount, '9007199254740993');
      assert.equal(result.current.stakerCount, '70');
      assert.equal(result.daily.holderCount, '9007199254740995');
      assert.deepEqual(result.current.activity, {
        newStakes: '9',
        endedStakes: '12',
        netHolders: '-2',
        netStakers: '3',
        netLockedHex: '-0.00000001',
        penaltiesHex: '1.23456789',
      });
      assert.equal(result.current.contractDay, 400);
      assert.equal(result.current.asOf.blockNumber, '100');
      await worker.query('DELETE FROM hdd.daily_stats WHERE contract_day=399');
      const gap = await home(db, 'pulsechain', signal, clock);
      assert.equal(gap.current.activity.netHolders, null);
      assert.equal(gap.current.activity.netStakers, null);
      assert.equal(gap.current.activity.netLockedHex, null);
      assert.equal(gap.current.activity.newStakes, '9');
      assert.equal(gap.daily.contractDay, 398);
      assert.equal(db.counters.dataQueries, 2);
    } finally {
      await worker.query('ROLLBACK');
    }
  });
  await test('bounded date/history/calculator reads and dirty source disclosure', async () => {
    const daily = await request(server.url, '/api/v2/daily?from=2021-01-04&to=2021-01-05');
    assert.equal(daily.body.items.length, 2);
    assert.equal(daily.body.items[1].payout.payoutHearts, '2');
    assert.equal(daily.body.items[1].payout.hexPerTShare, '0.28571428');
    const calculator = await request(server.url, '/api/v2/calculator/inputs');
    assert.equal(calculator.body.presets[1].value.numerator, '13');
    assert.equal(calculator.body.presets[1].value.denominator, '42');
    assert.equal(calculator.body.presets[1].count, 30);
    assert.equal(calculator.body.presets[2].reason, 'pending_days');
    await worker.query('UPDATE hdd.daily_stats SET payout_shares=0 WHERE contract_day=399');
    assert.equal(
      (await request(server.url, '/api/v2/calculator/inputs')).body.presets[0].reason,
      'zero_shares',
    );
    await worker.query('UPDATE hdd.daily_stats SET payout_shares=70000 WHERE contract_day=399');
    const saved = (
      await worker.query(
        'SELECT row_to_json(d)::text AS row FROM hdd.daily_stats d WHERE chain_id=369 AND contract_day=380',
      )
    ).rows[0].row;
    await worker.query('DELETE FROM hdd.daily_stats WHERE chain_id=369 AND contract_day=380');
    assert.equal(
      (await request(server.url, '/api/v2/calculator/inputs')).body.presets[1].reason,
      'missing_days',
    );
    await worker.query(
      'INSERT INTO hdd.daily_stats SELECT * FROM json_populate_record(NULL::hdd.daily_stats,$1::json)',
      [saved],
    );
    const market = await request(server.url, '/api/v2/markets/daily?from=2021-01-04&to=2021-01-05');
    assert.equal(market.body.items.length, 2);
    assert.equal(market.body.sources[0].qualification, 'source_reported_usd');
    await worker.query('UPDATE hdd.market_sources SET dirty_day=399');
    assert.equal(
      (await request(server.url, '/api/v2/markets/daily?from=2021-01-04&to=2021-01-05')).body
        .items[1].state,
      'pending_correction',
    );
    await worker.query('UPDATE hdd.market_sources SET dirty_day=NULL');
  });
  await test('indexed lifecycle pages, deterministic ranks, exact amounts and incompatible cursors', async () => {
    const first = await request(server.url, '/api/v2/stakes?limit=7');
    if (!large)
      assert.deepEqual(
        first.body.items.map((s) => s.status),
        ['open', 'queued', 'mature_open', 'good_accounted', 'ended', 'open', 'open'],
      );
    assert.equal(first.body.items[0].principalHearts, '100100000000');
    if (!large) assert.equal(first.body.items[0].originChainId, 1);
    const next = await request(
      server.url,
      '/api/v2/stakes?limit=7&cursor=' + first.body.nextCursor,
    );
    assert.equal(next.body.items[0].stakeId, '8');
    if (!large) {
      const ids = first.body.items.map((x) => x.stakeId);
      let cursor = first.body.nextCursor;
      while (cursor) {
        const page = await request(server.url, '/api/v2/stakes?limit=7&cursor=' + cursor);
        ids.push(...page.body.items.map((x) => x.stakeId));
        cursor = page.body.nextCursor;
      }
      assert.deepEqual(
        ids,
        Array.from({ length: 120 }, (_, i) => String(i + 1)),
      );
      assert.equal(first.body.items[4].goodAccountedAt, '2021-01-06T00:00:00.000Z');
      assert.equal(first.body.items[4].gaOriginChainId, 369);
    }
    const selective = await request(server.url, '/api/v2/stakes?address=' + address(1));
    assert.equal(selective.body.items.length, 2);
    await request(server.url, '/api/v2/stakes?limit=8&cursor=' + first.body.nextCursor, {}, 409);
    await request(
      server.url,
      '/api/v2/stakes?limit=7&cursor=' + first.body.nextCursor.slice(0, -3) + 'abc',
      {},
      409,
    );
    const h = await request(server.url, '/api/v2/holders?limit=7');
    assert.ok(BigInt(h.body.items[0].liquidHearts) > 2n ** 53n);
    const h2 = await request(server.url, '/api/v2/holders?limit=7&cursor=' + h.body.nextCursor);
    assert.equal(h2.body.items[0].liquidRank, '8');
    if (!large) {
      const all = (await request(server.url, '/api/v2/holders?limit=100')).body.items;
      assert.equal(all.find((a) => a.address === address(1)).liquidRank, '59');
      assert.equal(all.find((a) => a.address === address(2)).liquidRank, '60');
    }
    clock += 60001;
    await request(server.url, '/api/v2/stakes?limit=7&cursor=' + first.body.nextCursor, {}, 409);
    clock -= 60001;
    await worker.query(
      "UPDATE hdd.sync_state SET revision=revision+1,block_number=101,block_hash=decode(lpad('101',64,'0'),'hex'),block_time=block_time+10",
    );
    await request(server.url, '/api/v2/stakes?limit=7&cursor=' + first.body.nextCursor, {}, 409);
    await request(server.url, '/api/v2/holders?limit=7&cursor=' + h.body.nextCursor, {}, 409);
    const detail = await request(server.url, '/api/v2/stakes/10');
    assert.equal(detail.body.indexed.status, 'cancelled');
    assert.equal(detail.body.indexed.endedAt, '2021-01-05T00:00:02.000Z');
    await request(server.url, '/api/v2/stakes/1099511627775', {}, 503);
    const a = await request(server.url, '/api/v2/addresses/' + address(1));
    assert.equal(a.body.outcome, 'unavailable');
    assert.ok(a.body.indexed);
    assert.equal(a.body.indexed.asOf.blockNumber, '101');
    assert.equal(a.body.indexed.rank.asOf.blockNumber, '100');
  });
  await test('all route input/method bounds; sanitized failures and global HTTP admission', async () => {
    for (const path of [
      '/api/v2/home?rpc=http://SECRET.invalid',
      '/api/v2/daily?from=2024-02-30&to=2024-03-01',
      '/api/v2/daily?from=2021-01-05&to=2021-01-04',
      '/api/v2/daily?from=2020-01-01&to=2022-01-01',
      '/api/v2/stakes?limit=101',
      '/api/v2/holders?order=liquid;DROP',
      '/api/v2/addresses/nope',
      '/api/v2/stakes/1099511627776',
      '/api/v2/downloads/not-uuid/daily',
      '/api/v2/home?chain=../',
    ]) {
      const r = await request(server.url, path, {}, 400);
      assert.doesNotMatch(r.text, /SECRET|password|stack|C:\\|\/exports|SELECT/);
    }
    for (const route of routes) {
      const path = route.path
        .replace(':id', '1')
        .replace(':address', address(1))
        .replace(':bundle', 'aaaaaaaa-aaaa-4aaa-aaaa-aaaaaaaaaaaa')
        .replace(':dataset', 'daily');
      await request(server.url, path, { method: 'POST' }, 405);
    }
    const limited = await serve({ admission: { capacity: 2, concurrent: 1 } });
    await request(limited.url, '/health/live');
    await request(limited.url, '/health/live');
    const denied = await request(
      limited.url,
      '/health/live',
      { headers: { 'X-Forwarded-For': '1.2.3.4' } },
      429,
    );
    assert.equal(denied.r.headers.get('retry-after'), '60');
    await limited.app.close();
  });
  await test('raw synthetic AddressService behind HTTP: zero/100/101/10000, shared routes and quotas', async () => {
    evidence.address = [];
    for (const count of [0, 1, 100, 101, 10000]) {
      const live = fixture();
      live.state.count = count;
      live.clock.time = Math.ceil((live.clock.time + 60000) / 10500) * 10500;
      const rpc = live.rpc('api', live.api),
        service = new AddressService(rpc, CODE_HASH, sqlBaseline(reads));
      const host = await serve({ dependencies: { db: reads, addresses: service } });
      const r = await request(host.url, '/api/v2/addresses/' + A + '?limit=100');
      assert.equal(r.body.live.page.stakeCount, String(count));
      assert.equal(r.body.live.page.items.length, Math.min(count, 100));
      assert.equal(r.body.live.page.enumerationComplete, count <= 100);
      const before = rpc.counters.requests;
      await request(host.url, '/api/v2/addresses/' + A + '/stakes?limit=100');
      assert.equal(rpc.counters.requests, before);
      evidence.address.push({
        count,
        items: r.body.live.page.items.length,
        complete: r.body.live.page.enumerationComplete,
        ...rpc.counters,
      });
      if (count === 10000) {
        let useful = 1,
          denied = 0;
        for (let n = 2; n <= 10; n++) {
          live.clock.time = Math.ceil(live.clock.now() / 10500) * 10500;
          const res = await fetch(host.url + '/api/v2/addresses/' + addr(100 + n) + '?limit=100');
          const body = await res.json();
          if (body.live) useful++;
          else denied++;
        }
        evidence.addressOverload = { useful, denied, ...rpc.counters };
        assert.equal(useful, 3);
        assert.equal(denied, 7);
        assert.ok(rpc.counters.requests <= 12 && rpc.counters.logical <= 360);
        await request(
          host.url,
          '/api/v2/addresses/' + A + '?cursor=' + r.body.live.page.nextCursor.slice(0, -3) + 'abc',
          {},
          409,
        );
      }
      await host.app.close();
    }
  });
  exporter = new ExportService(() => connect(databaseConfig('worker')), '/exports');
  reader = new ExportService(() => reads.connection(), '/exports');
  let verifications = 0;
  const verify = reader.verify.bind(reader);
  reader.verify = async (...args) => {
    verifications++;
    return verify(...args);
  };
  await exporter.startup(signal);
  let bundle;
  await test('actual Linux bundle; read-only refresh; immutable HTTP GET/HEAD/304 and replacement', async () => {
    const host = await serve({ dependencies: { db: reads, downloads: reader }, now: () => clock });
    bundle = await exporter.build(369, signal);
    assert.equal((await request(host.url, '/api/v2/downloads')).body.status, 'rebuilding');
    const pending = reader.refresh(signal);
    await request(host.url, '/api/v2/home');
    await pending;
    const catalog = await request(host.url, '/api/v2/downloads');
    assert.equal(catalog.body.bundles[0].id, bundle.id);
    for (const f of bundle.files) {
      const url = host.url + '/api/v2/downloads/' + bundle.id + '/' + f.dataset;
      const r = await fetch(url);
      assert.equal(r.status, 200);
      const digest = createHash('sha256');
      let bytes = 0;
      for await (const chunk of r.body) {
        digest.update(chunk);
        bytes += chunk.length;
      }
      assert.equal(digest.digest('hex'), f.sha256);
      assert.equal(String(bytes), f.bytes);
      assert.equal(r.headers.get('content-length'), f.bytes);
      assert.equal(r.headers.get('accept-ranges'), 'none');
      assert.equal((await fetch(url, { method: 'HEAD' })).status, 200);
      assert.equal(
        (await fetch(url, { headers: { 'If-None-Match': r.headers.get('etag') } })).status,
        304,
      );
      const range = await fetch(url, { headers: { Range: 'bytes=0-1' } });
      assert.equal(range.status, 200);
      let rangeBytes = 0;
      for await (const chunk of range.body) rangeBytes += chunk.length;
      assert.equal(rangeBytes, bytes);
    }
    await reader.refresh(signal);
    await reader.refresh(signal);
    assert.equal(verifications, 1);
    assert.equal(reader.readers, 0);
    assert.equal(reader.attempts.size, 1);
    if (!large) {
      for (const failure of ['abort', 'transient']) {
        const retry = new ExportService(() => reads.connection(), '/exports');
        const originalVerify = retry.verify.bind(retry);
        const cancelled = new AbortController();
        let attempts = 0;
        retry.verify = async (...args) => {
          attempts++;
          if (attempts === 1) {
            if (failure === 'abort') cancelled.abort();
            else throw new Error('Injected transient verification I/O failure');
          }
          return originalVerify(...args);
        };
        if (failure === 'abort') await assert.rejects(retry.refresh(cancelled.signal));
        else await retry.refresh(signal);
        assert.equal((await retry.catalog(369)).status, 'rebuilding');
        await retry.refresh(signal);
        assert.equal((await retry.catalog(369)).status, 'available');
        await retry.refresh(signal);
        assert.equal(attempts, 2);
      }
      evidence.verificationRecovery = {
        cancelledAndTransientRetried: true,
        fileChangesOrRestart: false,
        unchangedSuccessRehashed: false,
      };
    }
    const target = '/exports/' + bundle.id + '/daily.csv',
      original = await readFile(target);
    await writeFile(target, Buffer.from('corrupt'));
    await request(
      host.url,
      '/api/v2/downloads/' + bundle.id + '/daily',
      { headers: { 'If-None-Match': '*' } },
      503,
    );
    await writeFile(target, original);
    await reader.refresh(signal);
    await fetch(host.url + '/api/v2/downloads/' + bundle.id + '/daily').then((r) =>
      r.arrayBuffer(),
    );
    if (!large) {
      const newer = await exporter.build(369, signal);
      await reader.refresh(signal);
      assert.equal((await request(host.url, '/api/v2/downloads')).body.bundles[0].id, newer.id);
      assert.equal(reader.attempts.size, 2);
      await worker.query(
        "UPDATE hdd.export_bundles SET published_at=now()-interval '61 seconds' WHERE slot='prior'",
      );
      bundle = await exporter.build(369, signal);
      await reader.refresh(signal);
      assert.equal(reader.attempts.size, 2);
      await request(
        host.url,
        '/api/v2/downloads/' + catalog.body.bundles[0].id + '/daily',
        { headers: { 'If-None-Match': '*' } },
        410,
      );
    }
    await host.app.close();
  });
  await test('40 real HTTP opens reserve 32 slots before connection waits and release HEAD/304', async () => {
    let release,
      blocked = false;
    const gate = new Promise((resolve) => {
      release = resolve;
    });
    const admission = new ExportService(async () => {
      if (blocked) await gate;
      return reads.connection();
    }, '/exports');
    await admission.refresh(signal);
    const host = await serve({
      dependencies: { db: reads, downloads: admission },
      now: () => clock,
    });
    blocked = true;
    const requests = Array.from({ length: 40 }, () =>
      fetch(host.url + '/api/v2/downloads/' + bundle.id + '/daily').then(async (r) => {
        await r.arrayBuffer();
        return r.status;
      }),
    );
    for (let i = 0; i < 400 && admission.readers < 32; i++) await pause(5);
    assert.equal(admission.readers, 32);
    await pause(100);
    release();
    const statuses = await Promise.all(requests);
    assert.equal(statuses.filter((s) => s === 200).length, 32);
    assert.equal(statuses.filter((s) => s === 503).length, 8);
    for (let i = 0; i < 400 && admission.readers; i++) await pause(5);
    assert.equal(admission.readers, 0);
    const bursts = await Promise.all(
      Array.from({ length: 32 }, (_, i) =>
        fetch(
          host.url + '/api/v2/downloads/' + bundle.id + '/daily',
          i % 2 ? { method: 'HEAD' } : { headers: { 'If-None-Match': '*' } },
        ),
      ),
    );
    assert.ok(bursts.every((r) => [200, 304].includes(r.status)));
    assert.equal(admission.readers, 0);
    evidence.downloadAdmission = {
      get200: 32,
      refused503: 8,
      headOr304: bursts.length,
      remainingReaders: admission.readers,
    };
    await host.app.close();
  });
  if (large)
    await test('real slow reader backpressure, HTTP disconnect and lost advisory session release', async () => {
      const sessions = [];
      const slow = new ExportService(async () => {
        const c = await reads.connection();
        sessions.push(c);
        return c;
      }, '/exports');
      await slow.refresh(signal);
      const host = await serve({ dependencies: { db: reads, downloads: slow }, now: () => clock });
      for (const loss of ['disconnect', 'lock', 'shutdown']) {
        const res = await new Promise((resolve, reject) => {
          http
            .get(host.url + '/api/v2/downloads/' + bundle.id + '/stakes', resolve)
            .on('error', reject);
        });
        res.on('error', () => {});
        res.pause();
        await pause(150);
        assert.equal(slow.readers, 1);
        if (loss === 'disconnect') res.destroy();
        else if (loss === 'lock') await sessions.at(-1).end();
        else await slow.closeReaders();
        for (let i = 0; i < 400 && slow.readers; i++) await pause(5);
        assert.equal(slow.readers, 0);
        res.destroy();
      }
      evidence.slowReader = {
        backpressure: true,
        disconnectReleased: true,
        lockLossReleased: true,
        shutdownReleased: true,
      };
      await host.app.close();
    });
  await test('SQL plans and populated HTTP/query distributions; mixed metric/export/HTTP work', async () => {
    const queries = {
      home: [homeSql, [369]],
      stakes: [stakesSql(false), [369, '0', 51]],
      addressStakes: [stakesSql(true), [369, '0', 51, Buffer.from(address(1).slice(2), 'hex')]],
      holders: [holdersSql('liquid'), [369, '0', 51]],
      daily: [dailySql, [369, 370, 399]],
      markets: [marketSql, [369, 'fixture-venue', 398, 399]],
    };
    for (const [name, [sql, values]] of Object.entries(queries))
      evidence.plans[name] = (
        await api.query('EXPLAIN (ANALYZE,BUFFERS,FORMAT JSON) ' + sql, values)
      ).rows[0]['QUERY PLAN'];
    let mixedClock;
    const serving = { db: reads, downloads: reader };
    const host = await serve({ dependencies: serving, now: () => mixedClock?.now() ?? clock });
    const queryTimes = [],
      httpTimes = [],
      cachedTimes = [];
    const coldDb = new ReadDatabase(databaseConfig('api'));
    const cold = await serve({
      dependencies: { db: coldDb, close: () => coldDb.close() },
      now: () => clock,
    });
    const first = performance.now();
    await request(cold.url, '/api/v2/home');
    evidence.firstHttpMs = performance.now() - first;
    evidence.firstConnection = {
      ...coldDb.counters,
      classification: 'fresh API connection / warm SQL data; not cold disk',
    };
    await cold.app.close();
    const response = await request(host.url, '/api/v2/home');
    for (let i = 0; i < 101; i++) {
      let t = performance.now();
      await api.query(homeSql, [369]);
      queryTimes.push(performance.now() - t);
      t = performance.now();
      await request(host.url, '/api/v2/home');
      httpTimes.push(performance.now() - t);
      t = performance.now();
      await request(
        host.url,
        '/api/v2/home',
        { headers: { 'If-None-Match': response.r.headers.get('etag') } },
        304,
      );
      cachedTimes.push(performance.now() - t);
    }
    const distribution = (values) => {
      const sorted = [...values].sort((a, b) => a - b);
      return { p50: sorted[50], p95: sorted[95], samples: values };
    };
    evidence.timings = {
      query: distribution(queryTimes),
      http: distribution(httpTimes),
      revalidation: distribution(cachedTimes),
    };
    assert.ok(evidence.timings.query.p95 <= 250);
    await worker.query(
      "UPDATE hdd.export_bundles SET published_at=now()-interval '61 seconds' WHERE slot='prior'",
    );
    let done = false,
      exportMs;
    const exportStart = performance.now();
    const exporting = exporter.build(369, signal).then(async (b) => {
      exportMs = performance.now() - exportStart;
      bundle = b;
      await reader.refresh(signal);
      done = true;
      return b;
    });
    const mixed = [];
    const metricsClient = await db();
    const mixedStore = new SqlMetricStore(metricsClient);
    const raw = fixture({ clock: new ManualClock() });
    mixedClock = raw.clock;
    mixedClock.time = Math.ceil((clock + 60000) / 10500) * 10500;
    raw.state.count = 100;
    raw.state.delay = (s) => pause(10, undefined, { signal: s });
    raw.state.change = (rows, calls) =>
      rows.map((row, i) =>
        calls[i].params[0]?.data?.slice(0, 10) === liveSelectors.getReserves
          ? {
              jsonrpc: '2.0',
              id: row.id,
              error: { code: -32000, message: 'synthetic_price_unavailable' },
            }
          : row,
      );
    const rpcA = raw.rpc('mixed-one'),
      rpcB = raw.rpc('mixed-two'),
      addressRpc = raw.rpc('mixed-api', raw.api);
    const metricJob = new MetricsService(
      [rpcA, rpcB],
      CODE_HASH,
      new PriceReader(raw.price, HEX),
      mixedStore,
    );
    serving.addresses = new AddressService(addressRpc, CODE_HASH, sqlBaseline(reads));
    const coldAddresses = Promise.all(
      Array.from({ length: 10 }, (_, i) =>
        fetch(host.url + '/api/v2/addresses/' + addr(10000 + i) + '?limit=100').then(async (r) => {
          const b = await r.json();
          return {
            status: r.status,
            liveItems: b.live?.page.items.length ?? 0,
            outcome: b.outcome ?? b.error?.code,
          };
        }),
      ),
    );
    const driveMixed = (work) => {
      // Yield real time for HTTP, SQL and injected transport latency between clock steps.
      // The pure-RPC fixture's unpaced driver can exhaust virtual time before I/O returns.
      const driven = (async () => {
        let settled = false,
          failure;
        work.then(
          () => {
            settled = true;
          },
          (error) => {
            settled = true;
            failure = error;
          },
        );
        for (let elapsed = 0; !settled && elapsed < 180000; elapsed += 100) {
          await pause(10);
          await mixedClock.advance(100);
        }
        if (!settled) throw new Error('Mixed fixture did not settle within its clock bound.');
        if (failure) throw failure;
      })();
      void driven.catch(() => {});
      return driven;
    };
    let metricWork = driveMixed(Promise.all([metricJob.tick(signal), coldAddresses]));
    // Driver time is explicitly synthetic for provider quotas; HTTP/SQL/CPU timings remain real.
    while (!done || mixed.length < 101) {
      if (mixed.length > 0 && mixed.length % 20 === 0) {
        await metricWork;
        mixedClock.time += 60000;
        metricWork = driveMixed(metricJob.tick(signal));
      }
      const start = performance.now();
      const [h, list, csv] = await Promise.all([
        fetch(host.url + '/api/v2/home'),
        fetch(host.url + '/api/v2/holders?limit=50'),
        fetch(host.url + '/api/v2/downloads/' + bundle.id + '/daily'),
      ]);
      const body = await h.json();
      await list.arrayBuffer();
      await csv.arrayBuffer();
      mixed.push({
        ms: performance.now() - start,
        home: h.status,
        holders: list.status,
        download: csv.status,
        useful: Boolean(body.daily),
        price: body.live?.price.status,
        shareRate: body.live?.shareRate.status,
      });
      if (mixed.length > 2000) throw new Error('Export mixed test bound');
      await pause(200);
    }
    await exporting;
    await metricWork;
    const addressOutcomes = await coldAddresses;
    evidence.mixed = {
      exportAndRequestsMs: performance.now() - exportStart,
      exportMs,
      metricService: metricJob.counters,
      providerClock: 'ManualClock; no real provider latency/cost qualification',
      workerRpc: [rpcA.counters, rpcB.counters],
      addressRpc: addressRpc.counters,
      addressOutcomes,
      responses: mixed,
      csvBytes: bundle.files.reduce((n, f) => n + Number(f.bytes), 0),
    };
    assert.ok(mixed.every((r) => r.home === 200 && r.holders === 200 && r.useful));
    assert.ok(metricJob.counters.updates > 0 && metricJob.counters.failures > 0);
    assert.ok(addressOutcomes.filter((r) => r.liveItems === 0).length >= 7);
    await host.app.close();
  });
  await sample('completed');
  // Leave a valid fresh bundle for the separate compiled-image smoke.
  evidence.connections = reads.counters;
} catch (e) {
  console.error(e.stack);
  process.exitCode = 1;
} finally {
  for (const app of apps) await app.close().catch(() => {});
  await reads?.close();
  await Promise.allSettled(clients.map((c) => c.end()));
  await admin.end();
  writeFileSync('/evidence/results.json', JSON.stringify(results, null, 2));
  writeFileSync('/evidence/measurements.json', JSON.stringify(evidence, null, 2));
}
