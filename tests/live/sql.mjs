import assert from 'node:assert/strict';
import { readFileSync, writeFileSync } from 'node:fs';
import { setTimeout as pause } from 'node:timers/promises';
import { randomUUID } from 'node:crypto';
import { connect, databaseConfig } from '../../src/db/connect.ts';
import { migrate, initialMigration, migrateCurrent } from '../../src/db/migrate.ts';
import { SqlMetricStore, readMetrics } from '../../src/worker/metrics/store.ts';
import { MetricsService } from '../../src/worker/metrics/service.ts';
import { MetricsJob, runWorkerLifecycle } from '../../src/worker/lifecycle.ts';
import { PriceReader } from '../../src/services/live/price.ts';
import { SqlAddressBaseline } from '../../src/services/live/baseline.ts';
import { AddressService } from '../../src/services/live/address.ts';
import { CanonicalWriter } from '../../src/services/projections/writer.ts';
import { SyncEngine } from '../../src/worker/sync/engine.ts';
import { cooldownFiles } from '../../src/providers/cooldown.ts';
import { ProviderBudget } from '../../src/providers/budget.ts';
import { RpcClient } from '../../src/providers/rpc.ts';
import { fixture as nativeFixture, hash as nativeHash, A as nativeA } from '../sync/fixture.mjs';
import { fixture, ManualClock, HEX, CODE_HASH, A, signal } from './fixture.mjs';
const clients = [],
  results = [];
let writer;
async function db(role) {
  const c = await connect(databaseConfig(role));
  clients.push(c);
  return c;
}
async function test(name, fn) {
  const start = performance.now();
  try {
    await fn();
    results.push({ name, result: 'PASS', wallMs: performance.now() - start });
    console.log('PASS', name);
  } catch (e) {
    results.push({ name, result: 'FAIL', error: e.message, wallMs: performance.now() - start });
    throw e;
  }
}
try {
  console.log('Runner cgroup', {
    cpu: readFileSync('/sys/fs/cgroup/cpu.max', 'utf8').trim(),
    memory: readFileSync('/sys/fs/cgroup/memory.max', 'utf8').trim(),
  });
  const migrator = await db('migrator');
  await test('accepted migrations 1/2 upgrade to 3 with repeated checksum check', async () => {
    await migrate(migrator, await initialMigration(), [
      readFileSync('migrations/0002_recovery.sql', 'utf8'),
    ]);
    assert.deepEqual(
      (await migrator.query('SELECT version FROM hdd.schema_migrations ORDER BY version')).rows.map(
        (x) => x.version,
      ),
      [1, 2],
    );
    await migrateCurrent(migrator);
    await migrateCurrent(migrator);
    assert.deepEqual(
      (await migrator.query('SELECT version FROM hdd.schema_migrations ORDER BY version')).rows.map(
        (x) => x.version,
      ),
      [1, 2, 3],
    );
  });
  const api = await db('api'),
    worker = await db('worker'),
    metricClient = await db('worker');
  const store = new SqlMetricStore(metricClient),
    reads = new SqlMetricStore(api);
  const quotaPath = '/evidence/quota-' + randomUUID();
  const clock = new ManualClock(),
    diskCooldown = await cooldownFiles(quotaPath, 'worker');
  let quotaIo = 0;
  const trackedCooldown = {
    async read() {
      quotaIo++;
      try {
        return await diskCooldown.read();
      } finally {
        quotaIo--;
      }
    },
    extend: (until) => diskCooldown.extend(until),
  };
  const f = fixture({ clock, store: trackedCooldown });
  const primary = f.rpc('metrics-a'),
    secondary = f.rpc('metrics-b');
  const metrics = new MetricsService(
    [primary, secondary],
    CODE_HASH,
    new PriceReader(f.price, HEX),
    store,
  );
  async function drive(promise, max = 1200000) {
    let done = false,
      value,
      error;
    promise.then(
      (v) => {
        done = true;
        value = v;
      },
      (e) => {
        done = true;
        error = e;
      },
    );
    const start = clock.now();
    // SQL/socket operations get real wall time; quota time is separately reported.
    while (!done && clock.now() - start < max) {
      await pause(1);
      while (quotaIo) await pause(1);
      await clock.advance(100);
    }
    if (!done) throw new Error('SQL fixture virtual bound exceeded.');
    if (error) throw error;
    return value;
  }
  await test('actual latest metric writes/readback before canonical bootstrap and role denials', async () => {
    clock.time += 60000;
    const r = await drive(metrics.tick(signal));
    assert.equal(r.price.value.usdPerHex, '25');
    assert.equal(r.shareRate.value.rawShareRate, '123456');
    assert.equal((await api.query('SELECT count(*) FROM hdd.sync_state')).rows[0].count, '0');
    await api.query('SET default_transaction_read_only=off');
    for (const query of [
      'DELETE FROM hdd.live_metrics',
      "UPDATE hdd.live_metrics SET inputs='{}'",
      'DELETE FROM hdd.sync_state',
    ])
      await assert.rejects(() => api.query(query), /permission denied/);
    await assert.rejects(
      () => worker.query('ALTER TABLE hdd.live_metrics ADD COLUMN nope text'),
      /must be owner/,
    );
    await assert.rejects(
      () => worker.query("INSERT INTO hdd.live_metrics VALUES(369,'arbitrary','{}','{}')"),
      /check constraint/,
    );
    const row = (await api.query("SELECT inputs FROM hdd.live_metrics WHERE metric='shareRate'"))
      .rows[0];
    assert.equal(row.inputs.current.totalSupply, '1004489950000');
  });
  await test('SQL restart ages overlays and independently failed price preserves share rate with bounded keys', async () => {
    const before = await reads.read(369);
    clock.time += 180000;
    const restarted = await readMetrics(new SqlMetricStore(api), 369, clock.now());
    assert.equal(restarted.price.status, 'stale');
    f.state.fail = (id) => (id === 'metrics-b' ? new Error('network fixture unavailable') : null);
    await drive(metrics.tick(signal));
    const after = await reads.read(369);
    assert.deepEqual(after.price.asOf, before.price.asOf);
    assert.notDeepEqual(after.shareRate.asOf, before.shareRate.asOf);
    f.state.fail = null;
    for (let i = 0; i < 12; i++) {
      clock.time += 60000;
      await drive(metrics.tick(signal));
    }
    const {
      rows: [growth],
    } = await api.query(
      "SELECT count(*)::int AS keys,pg_total_relation_size('hdd.live_metrics')::text AS bytes FROM hdd.live_metrics",
    );
    assert.equal(growth.keys, 4);
    console.log('LIVE_SQL_GROWTH', growth);
  });
  await test('real native acquisition/replay/audit and metrics share worker budget/clock, independent SQL and recurring lifetime', async () => {
    const native = nativeFixture({ last: 110, holdersPerBlock: 5 });
    const sourceA = native.source(1, 'sync-a', clock, undefined, f.worker),
      sourceB = native.source(1, 'sync-b', clock, undefined, f.worker);
    writer = await CanonicalWriter.acquire(worker, 1);
    const sync = new SyncEngine(writer, api, [sourceA, sourceB], '/evidence');
    const start = clock.now(),
      wall = performance.now(),
      ticks = [];
    const job = new MetricsJob(clock, async (s) => {
      const r = await metrics.tick(s);
      ticks.push({ at: clock.now(), price: r.price.status, cursor: sync.progress.cursor });
    });
    const before = f.worker.counters.attempts;
    await drive(
      runWorkerLifecycle(
        async (s) => {
          await sync.initializeConstructor(native.plain(100), nativeHash(10000), [], s);
          await sync.once(s, native.plain(109));
          await sync.audit(s);
        },
        job,
        signal,
      ),
      3600000,
    );
    assert.ok(ticks.filter((t) => t.price === 'fresh').length >= 2);
    assert.equal((await sync.cursor()).block_number, '109');
    assert.ok(sourceA.rpc.budget === primary.budget && sourceB.rpc.budget === secondary.budget);
    const all = [primary, secondary, sourceA.rpc, sourceB.rpc];
    assert.equal(
      all.reduce((n, r) => n + r.counters.requests, 0),
      f.worker.counters.attempts,
    );
    assert.equal(
      all.reduce((n, r) => n + r.counters.logical, 0),
      f.worker.counters.logical,
    );
    console.log('MIXED_SQL', {
      virtualMs: clock.now() - start,
      wallMs: performance.now() - wall,
      ticks,
      job: job.counters,
      sync: sync.progress,
      worker: f.worker.counters,
      attemptDelta: f.worker.counters.attempts - before,
    });
  });
  await test('dated SQL address baseline remains useful during live failure; live overlays never advance native cursor', async () => {
    const baseline = new SqlAddressBaseline(api);
    const indexed = await baseline.address(1, nativeA);
    assert.ok(indexed);
    assert.equal(indexed.rank, null);
    const template = f.rpc('api', f.api),
      rpc = new RpcClient('api', null, 1, HEX, template.transport, f.api),
      service = new AddressService(rpc, CODE_HASH, baseline);
    f.state.fail = () => new Error('network unavailable');
    const before = (
      await api.query('SELECT block_number,revision FROM hdd.sync_state ORDER BY chain_id')
    ).rows;
    const r = await drive(service.get(nativeA, signal, 3));
    assert.ok(['quota', 'unavailable'].includes(r.outcome));
    assert.equal(r.live, null);
    assert.deepEqual(r.indexed, indexed);
    assert.deepEqual(
      (await api.query('SELECT block_number,revision FROM hdd.sync_state ORDER BY chain_id')).rows,
      before,
    );
    f.state.fail = null;
    const restart = new ProviderBudget('api', await cooldownFiles(quotaPath, 'api'), clock);
    await assert.rejects(() => restart.addressRequest(clock.now() + 10000, 2, signal), /deadline/);
    await diskCooldown.extend(clock.now() + 120000);
    clock.time += 60000;
    await assert.rejects(() => restart.addressRequest(clock.now() + 10000, 2, signal), /deadline/);
  });
  console.log('Actual results', results.length, 'groups', JSON.stringify(results));
} catch (error) {
  console.error(error.stack);
  process.exitCode = 1;
} finally {
  await writer?.close().catch((e) => {
    console.error('Writer cleanup:', e.message);
    process.exitCode = 1;
  });
  for (const c of clients) await c.end().catch(() => {});
  writeFileSync(
    '/evidence/results.json',
    JSON.stringify({ results, exit: process.exitCode ?? 0 }, null, 2),
  );
}
