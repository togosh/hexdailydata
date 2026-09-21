import assert from 'node:assert/strict';
import {
  readFile,
  writeFile,
  mkdir,
  readdir,
  copyFile,
  symlink,
  unlink,
  stat,
} from 'node:fs/promises';
import { readFileSync, writeFileSync } from 'node:fs';
import { createHash, randomUUID } from 'node:crypto';
import { fork, spawn } from 'node:child_process';
import { once } from 'node:events';
import { setTimeout as pause } from 'node:timers/promises';
import pg from 'pg';
import { connect, databaseConfig } from '../../src/db/connect.ts';
import { migrate, initialMigration, migrateCurrent } from '../../src/db/migrate.ts';
import { CanonicalWriter } from '../../src/services/projections/writer.ts';
import { SyncEngine } from '../../src/worker/sync/engine.ts';
import { rankAccounts } from '../../src/worker/daily/ranking.ts';
import {
  configureMarket,
  captureSample,
  priceSample,
  importMarketBars,
  finalizeMarkets,
  pruneSamples,
} from '../../src/worker/daily/market.ts';
import { validateDailyState } from '../../src/worker/daily/validate.ts';
import { capturePrice, DailyService } from '../../src/worker/daily/service.ts';
import { ExportService } from '../../src/worker/exports/service.ts';
import { reserve, syncDirectory, uuid } from '../../src/worker/exports/files.ts';
import {
  datasets,
  definitions,
  datasetQueries,
  datasetRow,
} from '../../src/worker/exports/datasets.ts';
import { exportSeed, importSeed } from '../../src/worker/bootstrap/seed.ts';
import { tableNames, tables } from '../../src/worker/bootstrap/manifest.ts';
import { ProviderBudget } from '../../src/providers/budget.ts';
import { SqlAddressBaseline } from '../../src/services/live/baseline.ts';
import {
  fixture,
  FakeClock,
  memoryCooldown,
  hash,
  CODE_HASH,
  CONTRACT,
  LARGE,
} from '../sync/fixture.mjs';
import { scale } from './scale.mjs';
import {
  fixture as liveFixture,
  ManualClock,
  HEX,
  CODE_HASH as LIVE_CODE,
  A as LIVE_A,
} from '../live/fixture.mjs';
import { MetricsService } from '../../src/worker/metrics/service.ts';
import { SqlMetricStore } from '../../src/worker/metrics/store.ts';
import { PriceReader } from '../../src/services/live/price.ts';
import { AddressService } from '../../src/services/live/address.ts';
import { MetricsJob, runWorkerLifecycle } from '../../src/worker/lifecycle.ts';
const phase = process.env.HDD_V2_DAILY_PHASE,
  signal = new AbortController().signal;
const clients = [],
  results = [],
  measurements = { phase, platform: process.platform, node: process.version };
let writer;
async function db(role = 'worker') {
  const c = await connect(databaseConfig(role));
  c.on('error', () => {});
  clients.push(c);
  return c;
}
const fresh = (role = 'worker') => connect(databaseConfig(role));
const admin = new pg.Client({
  host: 'db',
  database: 'hexdailydata_v2',
  user: 'hdd_v2_admin',
  password: process.env.HDD_V2_ADMIN_PASSWORD,
});
async function test(name, fn) {
  const t = performance.now();
  try {
    await fn();
    results.push({ name, result: 'PASS', wallMs: performance.now() - t });
    console.log('PASS', name);
  } catch (e) {
    results.push({ name, result: 'FAIL', error: e.stack, wallMs: performance.now() - t });
    throw e;
  }
}
function parseCsv(s) {
  const rows = [];
  let row = [],
    cell = '',
    quoted = false;
  for (let i = 0; i < s.length; i++) {
    const ch = s[i];
    if (ch === '"') {
      if (quoted && s[i + 1] === '"') {
        cell += '"';
        i++;
      } else quoted = !quoted;
    } else if (ch === ',' && !quoted) {
      row.push(cell);
      cell = '';
    } else if (ch === '\n' && !quoted) {
      row.push(cell);
      rows.push(row);
      row = [];
      cell = '';
    } else cell += ch;
  }
  assert.equal(quoted, false);
  assert.equal(cell, '');
  return rows;
}
const sha = (b) => createHash('sha256').update(b).digest('hex');
async function bytes(service, id, dataset) {
  const r = await service.openStream(id, dataset, signal);
  assert.equal(r.status, 'available');
  const chunks = [];
  for await (const chunk of r.stream) chunks.push(chunk);
  await r.released;
  return Buffer.concat(chunks);
}
const chain = fixture({ last: 620, holdersPerBlock: 2 }),
  clock = new FakeClock(),
  budget = new ProviderBudget('worker', memoryCooldown(), clock);
let api, worker, sync;
async function engine(id) {
  const c = await db();
  writer = await CanonicalWriter.acquire(c, id);
  return new SyncEngine(
    writer,
    api,
    [
      chain.source(id, 'one', clock, undefined, budget),
      chain.source(id, 'two', clock, undefined, budget),
    ],
    '/evidence',
  );
}
const service = new ExportService(() => fresh(), '/exports'),
  reader = new ExportService(() => fresh('api'), '/exports');
async function agePrior() {
  await worker.query(
    "UPDATE hdd.export_bundles SET published_at=now()-interval '61 seconds' WHERE slot='prior'",
  );
}
async function verifyBundle(b, expected) {
  const parsed = {};
  await reader.startup(signal);
  for (const name of datasets) {
    const f = b.files.find((f) => f.dataset === name),
      data = await bytes(reader, b.id, name),
      rows = parseCsv(data.toString('utf8'));
    assert.equal(data.includes(13), false);
    assert.equal(sha(data), f.sha256);
    assert.equal(String(data.length), f.bytes);
    assert.deepEqual(
      rows.shift(),
      definitions[name].columns.map((c) => c.name),
    );
    assert.equal(String(rows.length), f.rows);
    if (expected)
      assert.deepEqual(
        rows,
        expected[name].map((r) => r.map((v) => (v === null ? '' : String(v)))),
      );
    parsed[name] = rows;
  }
  writeFileSync(
    '/evidence/csv-comparison.json',
    JSON.stringify({ manifest: b, rows: parsed }, null, 2),
  );
  return parsed;
}
async function sqlRows() {
  await api.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
  const expected = {};
  try {
    for (const name of datasets)
      expected[name] = (await api.query(datasetQueries[name], [369])).rows.map((r) =>
        datasetRow(name, r),
      );
    await api.query('COMMIT');
    return expected;
  } catch (e) {
    await api.query('ROLLBACK');
    throw e;
  }
}
async function portableDigest() {
  const out = {};
  for (const table of tableNames) {
    const { rows } = await api.query(
      `SELECT to_jsonb(t)::text AS v FROM hdd.${table} t ORDER BY ${tables[table].join(',')}`,
    );
    out[table] = sha(rows.map((r) => r.v).join('\n'));
  }
  return out;
}
try {
  await admin.connect();
  measurements.reserve = await reserve('/exports');
  measurements.runner = {
    cpu: readFileSync('/sys/fs/cgroup/cpu.max', 'utf8').trim(),
    memory: readFileSync('/sys/fs/cgroup/memory.max', 'utf8').trim(),
  };
  const migrator = await db('migrator');
  if (phase === 'functional')
    await migrate(migrator, await initialMigration(), [
      readFileSync('migrations/0002_recovery.sql', 'utf8'),
      readFileSync('migrations/0003_live.sql', 'utf8'),
    ]);
  else await migrateCurrent(migrator);
  api = await db('api');
  worker = await db();
  if (phase === 'scale') {
    await scale({ admin, api, worker, fresh, test, measurements });
  } else if (phase === 'restore') {
    await test('DB-only pg_dump restore rejects absent original IDs, rebuilds new IDs and preserves healthy reads', async () => {
      const before = (await api.query('SELECT id,manifest FROM hdd.export_bundles ORDER BY slot'))
        .rows;
      assert.equal(before.length, 2);
      await reader.startup(signal);
      assert.equal((await reader.catalog(369)).status, 'rebuilding');
      assert.equal((await reader.openStream(before[0].id, 'daily', signal)).status, 'unavailable');
      assert.ok((await api.query('SELECT count(*) FROM hdd.daily_stats')).rows[0].count > 0);
      await service.startup(signal);
      await agePrior();
      const rebuilt = await service.build(369, signal);
      assert.ok(before.every((b) => b.id !== rebuilt.id));
      await reader.startup(signal);
      assert.equal(
        (await reader.openStream(before.find((b) => b.id !== rebuilt.id).id, 'daily', signal))
          .status,
        'retired',
      );
      await verifyBundle(rebuilt);
      sync = await engine(369);
      await sync.once(signal, chain.plain(548));
      await sync.audit(signal);
      await rankAccounts(worker, 369, signal);
      await agePrior();
      const continued = await service.build(369, signal);
      assert.notEqual(continued.id, rebuilt.id);
      assert.equal(continued.currentIndex.blockNumber, '548');
      assert.equal(continued.currentIndex.blockHash, hash(548).slice(2));
      await verifyBundle(continued, await sqlRows());
      measurements.restoreContinuation = {
        restored: rebuilt.currentIndex,
        continued: continued.currentIndex,
        originalIds: before.map((b) => b.id),
        rebuiltId: rebuilt.id,
        continuedId: continued.id,
      };
      assert.equal((await readdir('/exports')).filter((n) => uuid.test(n)).length, 2);
    });
  } else if (phase === 'import') {
    await test('new logical format imports required rank/market/progress without live cache or file publication', async () => {
      const expectation = JSON.parse(await readFile('/evidence/seed-expectation.json', 'utf8'));
      await importSeed(
        worker,
        '/evidence/daily.seed.tar.gz',
        { ...expectation, instance: databaseConfig('worker').instance },
        signal,
      );
      assert.deepEqual(
        await portableDigest(),
        JSON.parse(await readFile('/evidence/seed-digests.json', 'utf8')),
      );
      assert.equal((await api.query('SELECT count(*) FROM hdd.export_bundles')).rows[0].count, '0');
      assert.equal((await api.query('SELECT count(*) FROM hdd.live_metrics')).rows[0].count, '0');
      await finalizeMarkets(worker, 1, 27, signal);
      await pruneSamples(worker, 1);
      assert.deepEqual(
        (
          await api.query(
            "SELECT observation->'close' AS close FROM hdd.market_daily WHERE chain_id=1 AND source='consumer-audit' AND contract_day=20",
          )
        ).rows[0].close,
        { numerator: '2', denominator: '1' },
      );
      assert.equal(
        (
          await api.query(
            "SELECT count(*) FROM hdd.market_samples WHERE chain_id=1 AND source='consumer-audit'",
          )
        ).rows[0].count,
        '0',
      );
      await assert.rejects(
        () =>
          importSeed(
            worker,
            '/evidence/daily.seed.tar.gz',
            { ...expectation, instance: databaseConfig('worker').instance },
            signal,
          ),
        /empty/,
      );
      sync = await engine(369);
      await sync.once(signal, chain.plain(548));
      await sync.audit(signal);
      await rankAccounts(worker, 369, signal);
      await worker.query('BEGIN');
      await validateDailyState(worker, signal);
      await worker.query('COMMIT');
      await service.startup(signal);
      const b = await service.build(369, signal);
      assert.equal(b.currentIndex.blockNumber, '548');
      await verifyBundle(b);
    });
  } else {
    await test('populated schema3 upgrade preserves genuine retained checkpoints and migrations1-3', async () => {
      sync = await engine(1);
      await sync.initializeConstructor(chain.plain(100), hash(10000), [], signal);
      await sync.once(signal, chain.plain(180));
      await sync.audit(signal);
      await writer.close();
      sync = await engine(369);
      await sync.fork(chain.plain(180), chain.plain(181), signal);
      const gaRow = datasetRow(
        'stakes',
        (await api.query(datasetQueries.stakes, [369])).rows.find((r) => r.stake_id === '1'),
      );
      assert.equal(gaRow[7], 'good_accounted');
      assert.equal(gaRow[9], null);
      assert.equal(gaRow[10], '0.0000001');
      measurements.goodAccountedRow = gaRow;
      await sync.once(signal, chain.plain(181));
      const old = (await api.query('SELECT * FROM hdd.schema_migrations ORDER BY version')).rows;
      const checkpoints = (await api.query('SELECT count(*) FROM hdd.checkpoints_recent')).rows;
      await migrateCurrent(migrator);
      await migrateCurrent(migrator);
      assert.deepEqual(
        (await api.query('SELECT * FROM hdd.schema_migrations ORDER BY version LIMIT 3')).rows,
        old,
      );
      assert.deepEqual(
        (await api.query('SELECT count(*) FROM hdd.checkpoints_recent')).rows,
        checkpoints,
      );
      for (const table of [
        'account_ranks',
        'rank_state',
        'market_daily',
        'market_samples',
        'market_sources',
        'export_bundles',
      ]) {
        await api.query(`SELECT * FROM hdd.${table} LIMIT 1`);
        await assert.rejects(() => api.query(`DELETE FROM hdd.${table}`), /permission|read-only/);
        await assert.rejects(
          () => worker.query(`ALTER TABLE hdd.${table} ADD COLUMN bad int`),
          /owner|permission/,
        );
      }
    });
    await service.startup(signal);
    await test('daily ranks atomic cutoff, interruption, ties, exact membership and unchanged row churn', async () => {
      const before = (
        await api.query(
          'SELECT address,xmin::text AS xmin FROM hdd.accounts WHERE chain_id=369 ORDER BY address',
        )
      ).rows;
      await assert.rejects(
        () =>
          rankAccounts(worker, 369, signal, {
            beforeCommit: async () => {
              assert.equal(
                (await api.query('SELECT count(*) FROM hdd.account_ranks')).rows[0].count,
                '0',
              );
              throw new Error('rank interruption');
            },
          }),
        /interruption/,
      );
      assert.equal(
        (await api.query('SELECT ranking_day FROM hdd.sync_state WHERE chain_id=369')).rows[0]
          .ranking_day,
        null,
      );
      await rankAccounts(worker, 369, signal);
      assert.deepEqual(
        (
          await api.query(
            'SELECT address,xmin::text AS xmin FROM hdd.accounts WHERE chain_id=369 ORDER BY address',
          )
        ).rows,
        before,
      );
      const rows = (
        await api.query(
          "SELECT encode(address,'hex') AS address,liquid_rank,staker_rank FROM hdd.account_ranks WHERE chain_id=369 ORDER BY address",
        )
      ).rows;
      assert.deepEqual(
        rows.map((r) => [r.liquid_rank, r.staker_rank]),
        [
          ['1', null],
          ['2', '1'],
          ['3', null],
        ],
      );
      const baseline = await new SqlAddressBaseline(api).address(369, '0x' + '11'.repeat(20));
      assert.equal(baseline.rank.asOf.blockNumber, '181');
      const b = await service.build(369, signal);
      const parsed = await verifyBundle(b, await sqlRows());
      assert.equal(parsed.stakes.find((s) => s[0] === '3')[7], 'cancelled');
      assert.equal(parsed.stakes.find((s) => s[0] === '3')[10], '0');
      assert.equal(parsed.stakes.find((s) => s[0] === '1')[7], 'ended');
      assert.equal(parsed.stakes.find((s) => s[0] === '1')[10], '0.0000001');
      assert.equal(parsed.stakes.find((s) => s[0] === '8')[7], 'mature_open');
      assert.equal(parsed.stakes.find((s) => s[0] === '7')[7], 'queued');
      assert.equal(parsed.stakes.find((s) => s[0] === '4')[12], '1');
      assert.equal(parsed.holders[0][1], '9007199254740993.12345677');
      assert.equal(b.ranking.blockNumber, '181');
      assert.equal(b.dailyCutoff, 9);
    });
    await test('raw minute bars and qualified rational samples: UTC, stalls, source gaps, lag and correction', async () => {
      await configureMarket(worker, 369, 'venue', 'source-reported', 10);
      await configureMarket(worker, 369, 'route', 'sampled-ohlc', 10);
      const base = 1575331200 + 10 * 86400;
      const sample = priceSample({
        identity: 'block-200',
        sourceTime: String(base + 86399),
        observedTime: String(base + 86420),
        blockNumber: '200',
        blockHash: hash(200),
        poolTime: String(base + 2),
        price: { numerator: 1n, denominator: 3n },
      });
      assert.equal(await captureSample(worker, 369, 'route', sample), true);
      assert.equal(
        await captureSample(worker, 369, 'route', {
          ...sample,
          observedTime: String(base + 90000),
          observation: { ...sample.observation, observedTime: String(base + 90000) },
        }),
        false,
      );
      await captureSample(
        worker,
        369,
        'route',
        priceSample({
          identity: 'block-201',
          sourceTime: String(base + 86400),
          observedTime: String(base + 86401),
          blockNumber: '201',
          blockHash: hash(201),
          poolTime: String(base + 2),
          price: { numerator: 2n, denominator: 7n },
        }),
      );
      const bars = Array.from({ length: 1440 }, (_, i) => ({
        time: base + i * 60,
        revision: '0',
        open: '1.000000000000000000000001',
        high: '2',
        low: '0.5',
        close: i === 1439 ? '1.5' : '1',
        volume: '0',
        liquidity: null,
      }));
      await importMarketBars(
        worker,
        { chain: 369, source: 'venue', bars },
        base + 3 * 86400,
        signal,
      );
      await finalizeMarkets(worker, 369, 12, signal);
      const daily = (
        await api.query(
          'SELECT * FROM hdd.market_daily WHERE chain_id=369 ORDER BY source,contract_day',
        )
      ).rows;
      assert.equal(
        daily.find((r) => r.source === 'route' && r.contract_day === 10).observation.open
          .denominator,
        '3',
      );
      assert.equal(
        daily.find((r) => r.source === 'route' && r.contract_day === 10).observation.intervals,
        1,
      );
      assert.equal(
        daily.find((r) => r.source === 'route' && r.contract_day === 12).observation.coverage,
        'missing',
      );
      const venue = daily.find((r) => r.source === 'venue' && r.contract_day === 10).observation;
      assert.equal(venue.coverage, 'complete');
      assert.equal(venue.volume, '0');
      assert.equal(venue.liquidity, null);
      await importMarketBars(
        worker,
        {
          chain: 369,
          source: 'venue',
          bars: [{ ...bars[1439], revision: '1', high: '3', close: '2.5' }],
        },
        base + 4 * 86400,
        signal,
      );
      await finalizeMarkets(worker, 369, 12, signal);
      const corrected = (
        await api.query(
          "SELECT observation FROM hdd.market_daily WHERE source='venue' AND contract_day=10",
        )
      ).rows[0].observation;
      assert.deepEqual(corrected.close, { numerator: '5', denominator: '2' });
      assert.equal(corrected.high.numerator, '3');
      const b = await service.build(369, signal);
      const parsed = await verifyBundle(b, await sqlRows());
      assert.equal(parsed.markets.find((r) => r[7] === 'route')[1], '0.333333333333333333333333');
      assert.equal(parsed.markets.find((r) => r[7] === 'route')[5], '');
      assert.ok(b.markets.some((s) => s.qualification === 'peg_assumed'));
      await assert.rejects(() => configureMarket(worker, 369, '=bad', 'source-reported', 10));
      await assert.rejects(
        () =>
          importMarketBars(
            worker,
            { chain: 369, source: 'missing', bars: [bars[0]] },
            base + 86400,
            signal,
          ),
        /NOT_CONFIGURED/,
      );
      measurements.market = {
        sourceReportedMinutes: 1440,
        lagDays: 2,
        nativeSamples: 2,
        live: 'NOT_CONFIGURED',
        sampledOHLC: 'not all trades',
      };
    });
    await test('snapshot concurrent native progress, prune pin, preserved event times and rewind invalidation', async () => {
      await agePrior();
      const expected = await sqlRows();
      let snapshotBlock;
      const b = await service.build(369, signal, async (stage) => {
        if (stage === 'snapshot') {
          snapshotBlock = (await sync.cursor()).block_number;
          assert.equal((await writer.prune()).blocker, 'active snapshot');
          await sync.once(signal, chain.plain(296));
        }
      });
      assert.equal(b.currentIndex.blockNumber, snapshotBlock);
      await verifyBundle(b, expected);
      await writer.prune();
      assert.equal(
        (await api.query('SELECT min(number)::text AS n FROM hdd.blocks_recent WHERE chain_id=369'))
          .rows[0].n > '180',
        true,
      );
      await agePrior();
      const p = await service.build(369, signal);
      const parsed = await verifyBundle(p, await sqlRows());
      assert.ok(parsed.stakes.every((r) => r[8].endsWith('Z')));
      await rankAccounts(worker, 369, signal);
      const target = (
        await api.query(
          'SELECT block_number FROM hdd.checkpoints_recent WHERE chain_id=369 AND block_number<296 ORDER BY block_number DESC LIMIT 1',
        )
      ).rows[0].block_number;
      const s = await sync.cursor();
      await writer.rewind(target, {
        blockNumber: s.block_number,
        blockHash: '0x' + s.block_hash.toString('hex'),
        revision: s.revision,
      });
      assert.equal(
        (await api.query('SELECT ranking_day FROM hdd.sync_state WHERE chain_id=369')).rows[0]
          .ranking_day,
        null,
      );
      assert.equal(
        (await api.query('SELECT count(*) FROM hdd.account_ranks WHERE chain_id=369')).rows[0]
          .count,
        '0',
      );
      assert.equal(
        (await api.query("SELECT count(*) FROM hdd.market_daily WHERE source='venue'")).rows[0]
          .count,
        '3',
      );
      assert.equal((await reader.catalog(369)).status, 'rebuilding');
      await sync.once(signal, chain.plain(296));
    });
    await test('actual native/metrics/market/export lifecycle shares budget with a completed address request', async () => {
      const clock = new ManualClock(),
        f = liveFixture({ clock });
      clock.time += 60000;
      const metricClient = await db(),
        marketClient = await db();
      const metrics = new MetricsService(
        [f.rpc('metrics-a'), f.rpc('metrics-b')],
        LIVE_CODE,
        new PriceReader(f.price, HEX),
        new SqlMetricStore(metricClient),
        (source, sample) => capturePrice(metricClient, 369, source, sample),
      );
      const attempts = [];
      const native = [
        chain.source(
          369,
          'mixed-one',
          clock,
          (r, c) => {
            attempts.push({ at: clock.now(), calls: c.length });
            return r;
          },
          f.worker,
        ),
        chain.source(
          369,
          'mixed-two',
          clock,
          (r, c) => {
            attempts.push({ at: clock.now(), calls: c.length });
            return r;
          },
          f.worker,
        ),
      ];
      const mixedSync = new SyncEngine(writer, api, native, '/evidence');
      const stop = new AbortController();
      let pumping = true;
      const pump = (async () => {
        while (pumping) {
          await pause(2);
          await clock.advance(100);
        }
      })();
      const address = new AddressService(
        f.rpc('api', f.api),
        LIVE_CODE,
        new SqlAddressBaseline(await db('api')),
      );
      const addressRequest = address.get(LIVE_A, signal, 3);
      await agePrior();
      let aggregateJobs = 0;
      try {
        await runWorkerLifecycle(
          async (s) => {
            await Promise.all([
              mixedSync.once(s, chain.plain(300)),
              service.build(369, s, async (stage) => {
                if (stage === 'snapshot')
                  while (metrics.counters.ticks < 3) {
                    s.throwIfAborted();
                    await pause(2);
                  }
              }),
            ]);
          },
          new MetricsJob(clock, (s) => metrics.tick(s)),
          stop.signal,
          false,
          [
            new MetricsJob(clock, async (s) => {
              aggregateJobs++;
              await finalizeMarkets(marketClient, 369, 12, s);
            }),
          ],
        );
      } finally {
        pumping = false;
        await pump;
      }
      const result = await addressRequest;
      assert.ok(result.live);
      assert.equal(result.live.page.enumerationComplete, true);
      assert.equal((await mixedSync.cursor()).block_number, '300');
      assert.ok(metrics.counters.updates >= 8);
      assert.ok(aggregateJobs >= 2);
      assert.equal(
        f.worker.counters.attempts,
        attempts.length + f.attempts.filter((r) => r.id !== 'api').length,
      );
      assert.equal(f.api.counters.attempts, f.attempts.filter((r) => r.id === 'api').length);
      const all = [...attempts, ...f.attempts];
      for (const end of all) {
        const w = all.filter((r) => r.at > end.at - 60000 && r.at <= end.at);
        assert.ok(w.length <= 30);
        assert.ok(w.reduce((n, r) => n + r.calls, 0) <= 900);
      }
      measurements.mixed = {
        nativeBlock: '300',
        metrics: metrics.counters,
        aggregateJobs,
        worker: f.worker.counters,
        api: f.api.counters,
        address: result.outcome,
        virtualMs: clock.now() - 1609891200000,
      };
    });
    await test('publication fault stages, durable orphans, uncertain commit and real child termination', async () => {
      await assert.rejects(() => reserve('/dev/shm'), /reserve/); // Actual small Linux tmpfs, no filling.
      for (const fault of [
        'file-sync',
        'verified',
        'directory-sync',
        'before-rename',
        'after-rename',
        'durable',
        'before-publication',
        'inside-publication',
      ]) {
        await agePrior();
        const before = (await api.query("SELECT id FROM hdd.export_bundles WHERE slot='current'"))
          .rows[0].id;
        await assert.rejects(
          () =>
            service.build(369, signal, async (stage) => {
              if (stage === fault) throw new Error('fault-' + fault);
            }),
          new RegExp('fault-' + fault),
        );
        assert.equal(
          (await api.query("SELECT id FROM hdd.export_bundles WHERE slot='current'")).rows[0].id,
          before,
        );
      }
      await agePrior();
      let tampered = false;
      await assert.rejects(
        () =>
          service.build(369, signal, async (stage, id) => {
            if (stage === 'file-sync' && !tampered) {
              tampered = true;
              await writeFile('/exports/.work-' + id + '/daily.csv', 'wrong bytes');
            }
          }),
        /verification mismatch/,
      );
      await assert.rejects(
        () =>
          service.build(369, signal, async (stage, id) => {
            if (stage === 'before-rename') await mkdir('/exports/' + id);
          }),
        /Duplicate immutable/,
      );
      await assert.rejects(
        () =>
          service.build(369, signal, async (stage) => {
            if (stage === 'file-sync') {
              const e = new Error('injected ENOSPC');
              e.code = 'ENOSPC';
              throw e;
            }
          }),
        /ENOSPC/,
      );
      await agePrior();
      let committed;
      const ack = await service.build(369, signal, async (s, id) => {
        if (s === 'after-commit') {
          committed = id;
          throw new Error('lost ack');
        }
      });
      assert.equal(ack.id, committed);
      for (const stage of ['after-rename', 'after-commit']) {
        await agePrior();
        const child = fork('tests/daily/child.mjs', [stage], {
          stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
        });
        let stderr = '';
        child.stderr.on('data', (b) => (stderr += b));
        const timeout = setTimeout(() => child.kill('SIGKILL'), 30000);
        const message = await Promise.race([
          once(child, 'message'),
          once(child, 'exit').then(() => {
            throw new Error('child exited: ' + stderr);
          }),
        ]);
        child.kill('SIGKILL');
        await once(child, 'exit');
        clearTimeout(timeout);
        const found = (
          await api.query('SELECT id FROM hdd.export_bundles WHERE id=$1', [message[0].id])
        ).rowCount;
        assert.equal(found, stage === 'after-commit' ? 1 : 0);
        await service.startup(signal);
        measurements.crashes ??= [];
        measurements.crashes.push({
          stage,
          id: message[0].id,
          signal: 'SIGKILL',
          catalogRows: found,
        });
      }
      await agePrior();
      await service.build(369, signal);
      assert.ok((await readdir('/exports')).filter((n) => uuid.test(n)).length <= 2);
    });
    await test('reader retirement, pause, cancelled stream, corruption and symlink refusal', async () => {
      await reader.startup(signal);
      const id = (await api.query("SELECT id FROM hdd.export_bundles WHERE slot='current'")).rows[0]
        .id;
      async function burst() {
        const opened = await Promise.all(
          Array.from({ length: 40 }, () => reader.openStream(id, 'stakes', signal)),
        );
        assert.equal(opened.filter((r) => r.status === 'available').length, 32);
        assert.equal(opened.filter((r) => r.status === 'unavailable').length, 8);
        for (const r of opened) if (r.status === 'available') r.stream.destroy();
        await Promise.all(opened.filter((r) => r.status === 'available').map((r) => r.released));
      }
      await burst();
      await burst();
      const failed = new ExportService(async () => {
        throw new Error('injected connection failure');
      }, '/exports');
      for (let i = 0; i < 40; i++)
        await assert.rejects(
          () => failed.openStream(id, 'stakes', signal),
          /injected connection failure/,
        );
      const aborted = AbortSignal.abort(new Error('injected cancelled open'));
      for (let i = 0; i < 40; i++)
        await assert.rejects(
          () => reader.openStream(id, 'stakes', aborted),
          /injected cancelled open/,
        );
      await burst();
      measurements.concurrentReaders = {
        attempted: 40,
        admitted: 32,
        refused: 8,
        repeats: 3,
        failedConnections: 40,
        abortedOpens: 40,
      };
      const held = await reader.openStream(id, 'stakes', signal);
      assert.equal(held.status, 'available');
      await worker.query(
        "UPDATE hdd.export_bundles SET published_at=now()-interval '1 day' WHERE id=$1",
        [id],
      );
      await agePrior();
      await service.build(369, signal);
      const priorAge = (
        await api.query(
          'SELECT extract(epoch FROM clock_timestamp()-published_at)*1000 AS ms FROM hdd.export_bundles WHERE id=$1',
          [id],
        )
      ).rows[0].ms;
      assert.ok(Number(priorAge) < 60000);
      await assert.rejects(() => service.build(369, signal), /prior bundle grace/);
      measurements.priorGrace = {
        previousCurrentAgeMs: 86400000,
        newPriorAgeMs: Number(priorAge),
        immediatePublication: 'paused',
      };
      await agePrior();
      await assert.rejects(() => service.build(369, signal), /active prior readers/);
      held.stream.destroy();
      await held.released;
      await service.build(369, signal);
      assert.equal((await reader.openStream(id, 'stakes', signal)).status, 'retired');
      const victim = (await api.query("SELECT id FROM hdd.export_bundles WHERE slot='prior'"))
        .rows[0].id;
      await writeFile('/exports/' + victim + '/daily.csv', 'changed');
      await reader.startup(signal);
      assert.equal((await reader.openStream(victim, 'daily', signal)).status, 'unavailable');
      await unlink('/exports/' + victim + '/daily.csv');
      await symlink('/etc/passwd', '/exports/' + victim + '/daily.csv');
      await agePrior();
      await assert.rejects(() => service.build(369, signal), /Unsafe cleanup/);
      await unlink('/exports/' + victim + '/daily.csv');
      await agePrior();
      await service.build(369, signal);
      await assert.rejects(() => reader.openStream('../secret', 'daily', signal), /Invalid/);
    });
    await test('consumer lag beyond seven days protects samples, pressure pauses capture, restart aggregates then prunes', async () => {
      await configureMarket(worker, 369, 'lag', 'source-reported', 0);
      const raw = {
        chain: 369,
        source: 'lag',
        bars: [
          {
            time: 1575331200,
            revision: '0',
            open: '1',
            high: '1',
            low: '1',
            close: '1',
            volume: null,
            liquidity: null,
          },
        ],
      };
      await importMarketBars(worker, raw, 1575331200 + 10 * 86400, signal);
      await pruneSamples(worker, 369);
      assert.equal(
        (await api.query("SELECT count(*) FROM hdd.market_samples WHERE source='lag'")).rows[0]
          .count,
        '1',
      );
      await worker.query("UPDATE hdd.market_sources SET sample_bytes=67108864 WHERE source='lag'");
      await assert.rejects(
        () =>
          importMarketBars(
            worker,
            { ...raw, bars: [{ ...raw.bars[0], time: 1575331260 }] },
            1575331200 + 10 * 86400,
            signal,
          ),
        /byte_pressure/,
      );
      assert.equal(
        (await api.query("SELECT capture_status FROM hdd.market_sources WHERE source='lag'"))
          .rows[0].capture_status,
        'byte_pressure',
      );
      await worker.query(
        "UPDATE hdd.market_sources s SET sample_bytes=(SELECT sum(pg_column_size(m)) FROM hdd.market_samples m WHERE m.source=s.source AND m.chain_id=s.chain_id) WHERE source='lag'",
      );
      const restarted = await db();
      await finalizeMarkets(restarted, 369, 10, signal);
      await pruneSamples(restarted, 369);
      assert.equal(
        (await api.query("SELECT count(*) FROM hdd.market_samples WHERE source='lag'")).rows[0]
          .count,
        '0',
      );
      assert.equal(
        (
          await api.query(
            "SELECT observation->>'coverage' AS coverage FROM hdd.market_daily WHERE source='lag' AND contract_day=0",
          )
        ).rows[0].coverage,
        'partial',
      );
    });
    await test('30 accepted daily cycles: bounded bundles, no copies of unchanged stakes, coalesced rebuild publication', async () => {
      const initial = (
        await api.query(
          'SELECT stake_id,xmin::text AS xmin FROM hdd.stakes WHERE chain_id=369 ORDER BY stake_id',
        )
      ).rows;
      const cycles = [];
      for (let day = 0; day < 30; day++) {
        await sync.once(signal, chain.plain(304 + day * 8));
        await rankAccounts(worker, 369, signal);
        await finalizeMarkets(worker, 369, 25 + day, signal);
        await pruneSamples(worker, 369);
        await agePrior();
        const b = await service.build(369, signal);
        const files = (await readdir('/exports')).filter((n) => uuid.test(n));
        assert.equal(files.length, 2);
        const c = (
          await api.query(`SELECT (SELECT count(*) FROM hdd.stakes WHERE chain_id=369)::text AS stakes,
          (SELECT count(*) FROM hdd.accounts WHERE chain_id=369)::text AS accounts,(SELECT count(*) FROM hdd.market_samples)::text AS samples,
          (SELECT count(*) FROM hdd.market_daily)::text AS market_days,(SELECT count(*) FROM hdd.export_bundles)::text AS bundles`)
        ).rows[0];
        cycles.push({
          day,
          block: b.currentIndex.blockNumber,
          ...c,
          bytes: b.files.reduce((s, f) => s + Number(f.bytes), 0),
        });
      }
      assert.deepEqual(
        (
          await api.query(
            'SELECT stake_id,xmin::text AS xmin FROM hdd.stakes WHERE chain_id=369 ORDER BY stake_id',
          )
        ).rows,
        initial,
      );
      measurements.cycles = cycles;
      assert.equal((await sync.cursor()).block_number, '536');
      // Actual lifecycle entry point uses the same durable cutoff test, once at a useful endpoint.
      await sync.once(signal, chain.plain(540));
      await agePrior();
      const daily = new DailyService(() => fresh(), '/exports');
      await daily.exports.startup(signal);
      await daily.tick(signal, Number(chain.plain(540).timestamp) * 1000, true);
      assert.equal(daily.status.exports, 1);
      // Real grace expiry, no forced publication or active readers. The repeated
      // normal tick must only inspect bounded metadata, not rebuild native/rank/files.
      await pause(61000);
      const noDueSnapshot = async () => ({
        native: (
          await api.query(
            'SELECT chain_id,stake_id,xmin::text FROM hdd.stakes ORDER BY chain_id,stake_id',
          )
        ).rows,
        ranks: (await api.query('SELECT *,xmin::text FROM hdd.rank_state ORDER BY chain_id')).rows,
        accountRanks: (
          await api.query('SELECT *,xmin::text FROM hdd.account_ranks ORDER BY chain_id,address')
        ).rows,
        accounts: (
          await api.query('SELECT *,xmin::text FROM hdd.accounts ORDER BY chain_id,address')
        ).rows,
        cursor: (await api.query('SELECT * FROM hdd.sync_state ORDER BY chain_id')).rows,
        bundles: (
          await api.query(
            'SELECT id,slot,status,manifest,xmin::text FROM hdd.export_bundles ORDER BY id',
          )
        ).rows,
        files: await Promise.all(
          (await readdir('/exports'))
            .filter((n) => uuid.test(n))
            .sort()
            .map(async (id) => ({
              id,
              files: await Promise.all(
                (await readdir('/exports/' + id)).sort().map(async (name) => {
                  const s = await stat('/exports/' + id + '/' + name);
                  return { name, size: s.size, mtime: s.mtimeMs, ino: s.ino };
                }),
              ),
            })),
        ),
      });
      const beforeNoDue = await noDueSnapshot(),
        noDueQueries = [];
      const observedDaily = daily,
        previousConnect = daily.connect,
        previousStatus = { ...daily.status };
      observedDaily.connect = async () => {
        const c = await previousConnect(),
          query = c.query.bind(c);
        c.query = (...args) => {
          noDueQueries.push(typeof args[0] === 'string' ? args[0] : args[0].text);
          return query(...args);
        };
        return c;
      };
      const noDueStart = performance.now();
      await observedDaily.tick(signal, Number(chain.plain(540).timestamp) * 1000);
      assert.deepEqual(await noDueSnapshot(), beforeNoDue);
      assert.deepEqual(observedDaily.status, {
        ...previousStatus,
        ticks: previousStatus.ticks + 1,
        marketError: null,
        exportError: null,
      });
      assert.ok(noDueQueries.length < 60, 'Bounded operational SQL');
      assert.ok(
        noDueQueries.every(
          (q) =>
            !/(COPY|rank\(\)|dense_rank|UPDATE hdd\.(accounts|stakes)|INSERT INTO hdd\.export_bundles)/i.test(
              q,
            ),
        ),
      );
      measurements.strictNoDue = {
        status: { ...observedDaily.status },
        graceWaitMilliseconds: 61000,
        elapsedMs: performance.now() - noDueStart,
        queries: [...noDueQueries],
        before: beforeNoDue,
      };
      observedDaily.connect = previousConnect;
      await daily.tick(signal, Number(chain.plain(540).timestamp) * 1000);
      assert.equal(daily.status.exports, 1, 'unchanged cutoffs must not repeat a full export');
      measurements.daily = daily.status;
    });
    await test('portable daily state validates then streams seed; corrupted rank and market metadata rejected', async () => {
      await worker.query('BEGIN');
      await validateDailyState(worker, signal);
      await worker.query('ROLLBACK');
      await worker.query('BEGIN');
      await worker.query('UPDATE hdd.rank_state SET ranking_day=0 WHERE chain_id=369');
      await assert.rejects(() => validateDailyState(worker, signal), /Invalid portable/);
      await worker.query('ROLLBACK');
      await worker.query('BEGIN');
      await worker.query(
        "UPDATE hdd.market_daily SET observation=jsonb_set(observation,'{coverage}','\"complete\"') WHERE source='lag' AND contract_day=0",
      );
      await assert.rejects(() => validateDailyState(worker, signal));
      await worker.query('ROLLBACK');
      await configureMarket(worker, 1, 'consumer-audit', 'source-reported', 20);
      const time = 1575331200 + 20 * 86400;
      const bar = {
        time,
        revision: '0',
        open: '1',
        high: '1',
        low: '1',
        close: '1',
        volume: null,
        liquidity: null,
      };
      await importMarketBars(
        worker,
        { chain: 1, source: 'consumer-audit', bars: [bar] },
        time + 86400,
        signal,
      );
      await finalizeMarkets(worker, 1, 20, signal);
      await importMarketBars(
        worker,
        {
          chain: 1,
          source: 'consumer-audit',
          bars: [{ ...bar, revision: '1', open: '2', high: '2', low: '2', close: '2' }],
        },
        time + 86401,
        signal,
      );
      await worker.query('BEGIN');
      await validateDailyState(worker, signal); // A real pending correction remains portable.
      await worker.query('ROLLBACK');
      for (const dirty of [null, 21]) {
        await worker.query('BEGIN');
        await worker.query(
          "UPDATE hdd.market_sources SET dirty_day=$1 WHERE chain_id=1 AND source='consumer-audit'",
          [dirty],
        );
        await assert.rejects(
          () => validateDailyState(worker, signal),
          /Invalid portable market consumer/,
        );
        await worker.query('ROLLBACK');
      }
      measurements.consumerAudit = {
        pendingCorrection: 'accepted',
        lostDirtyMarker: 'rejected',
        advancedDirtyMarker: 'rejected',
      };
      const out = await exportSeed(worker, '/evidence/daily.seed.tar.gz', signal);
      await writeFile(
        '/evidence/seed-expectation.json',
        JSON.stringify({
          sha256: out.sha256,
          contract: CONTRACT,
          codeHash: CODE_HASH,
          checkpointHash: hash(540),
        }),
      );
      await writeFile('/evidence/seed-digests.json', JSON.stringify(await portableDigest()));
      measurements.seed = {
        sha256: out.sha256,
        ms: out.ms,
        formatVersion: out.manifest.formatVersion,
        schemaVersion: out.manifest.schemaVersion,
      };
    });
    await test('offline daily and export commands use actual worker entry without live flags', async () => {
      async function command(name) {
        await agePrior();
        const child = spawn(process.execPath, ['src/worker/main.ts', name], {
          env: { ...process.env, HDD_V2_ALLOW_LIVE_RPC: 'false', HDD_V2_EXPORT_PATH: '/exports' },
          stdio: ['ignore', 'pipe', 'pipe'],
        });
        let output = '';
        child.stdout.on('data', (b) => (output += b));
        child.stderr.on('data', (b) => (output += b));
        const [code] = await once(child, 'exit');
        assert.equal(code, 0, output);
        return { command: 'node src/worker/main.ts ' + name, exit: code, output };
      }
      measurements.commands = [await command('daily'), await command('export')];
    });
  }
} catch (e) {
  console.error(e.stack);
  process.exitCode = 1;
} finally {
  await writer?.close().catch(() => {});
  await Promise.all(clients.map((c) => c.end().catch(() => {})));
  await admin.end().catch(() => {});
  writeFileSync(`/evidence/${phase}-results.json`, JSON.stringify(results, null, 2));
  writeFileSync(`/evidence/${phase}-measurements.json`, JSON.stringify(measurements, null, 2));
}
