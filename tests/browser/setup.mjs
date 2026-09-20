import assert from 'node:assert/strict';
import pg from 'pg';
import { writeFileSync, readFileSync } from 'node:fs';
import { connect, databaseConfig } from '../../dist/db/connect.js';
import { migrateCurrent } from '../../dist/db/migrate.js';
import { MetricsService } from '../../dist/worker/metrics/service.js';
import { SqlMetricStore } from '../../dist/worker/metrics/store.js';
import { PriceReader } from '../../dist/services/live/price.js';
import { ExportService } from '../../dist/worker/exports/service.js';
import { ReadDatabase } from '../../dist/services/queries/database.js';
import { home } from '../../dist/services/queries/home.js';
import { fixture, CODE_HASH, HEX } from '../live/fixture.mjs';
import { populate } from '../api/fixture.mjs';
export const at = Date.parse('2026-09-19T12:00:00.000Z');
const signal = new AbortController().signal;
assert.equal(process.env.HDD_V2_ALLOW_LIVE_RPC, 'false');
const mode = process.argv[2];
if (mode === 'empty') {
  const migrator = await connect(databaseConfig('migrator'));
  try {
    await migrateCurrent(migrator);
    console.log('PASS new empty schema5 migration');
  } finally {
    await migrator.end();
  }
} else {
  assert.ok(['native', 'scale'].includes(mode));
  const worker = await connect(databaseConfig('worker'));
  const admin = new pg.Client({
    host: 'db',
    database: 'hexdailydata_v2',
    user: 'hdd_v2_admin',
    password: process.env.HDD_V2_ADMIN_PASSWORD,
  });
  await admin.connect();
  const large = mode === 'scale';
  try {
    assert.equal((await worker.query('SELECT count(*)::int n FROM hdd.chains')).rows[0].n, 0);
    const started = performance.now();
    const shape = await populate(worker, admin, large);
    const day = Math.floor((at / 1000 - 1575331200) / 86400),
      shift = day - 400;
    // Keep the retained fixture's native ledger shape, label its shifted synthetic dates explicitly.
    await worker.query('UPDATE hdd.daily_stats SET contract_day=contract_day+$1', [shift]);
    await worker.query('UPDATE hdd.current_state SET contract_day=$1', [day]);
    await worker.query('UPDATE hdd.sync_state SET block_time=$1,ranking_day=$2', [
      String(at / 1000),
      day - 1,
    ]);
    await worker.query('UPDATE hdd.rank_state SET ranking_day=$1,block_time=$2', [
      day - 1,
      String(at / 1000),
    ]);
    const raw = fixture();
    raw.clock.time = at - 60000;
    raw.state.dayCount = day;
    raw.state.update = BigInt(at / 1000 - 90);
    await new MetricsService(
      [raw.rpc('one'), raw.rpc('two')],
      CODE_HASH,
      new PriceReader(raw.price, HEX),
      new SqlMetricStore(worker),
    ).tick(signal);
    const observations = await worker.query('SELECT metric,observation FROM hdd.live_metrics');
    assert.equal(observations.rows.length, 4);
    assert.ok(observations.rows.every((r) => r.observation.status === 'fresh'));
    let bundle;
    if (!large) {
      const exports = new ExportService(() => connect(databaseConfig('worker')), '/exports');
      await exports.startup(signal);
      bundle = await exports.build(369, signal);
      await exports.closeReaders();
    }
    await admin.query('ANALYZE');
    const reads = new ReadDatabase(databaseConfig('api'));
    const queries = [];
    let expected;
    for (let i = 0; i < 21; i++) {
      const t = performance.now();
      expected = await home(reads, 'pulsechain', signal, at, 'production');
      queries.push(performance.now() - t);
    }
    await reads.close();
    const identity = {
      scenario: large ? 'synthetic-million-row-native' : 'synthetic-native-plus-retained-HDS',
      clock: new Date(at).toISOString(),
      shape,
      fixtureBuildMs: performance.now() - started,
      expected,
      homeBytes: Buffer.byteLength(JSON.stringify(expected)),
      homeQueryMs: queries,
      bundle: bundle ?? null,
      rawFakeCalls: raw.attempts.length,
      liveNetworkRequests: 0,
      resources: {
        runnerCpu: readFileSync('/sys/fs/cgroup/cpu.max', 'utf8').trim(),
        runnerMemory: readFileSync('/sys/fs/cgroup/memory.max', 'utf8').trim(),
        db: (
          await admin.query(
            "SELECT pg_read_file('/sys/fs/cgroup/cpu.max') cpu,pg_read_file('/sys/fs/cgroup/memory.max') memory,pg_database_size(current_database())::text bytes",
          )
        ).rows[0],
      },
    };
    writeFileSync('/evidence/fixture.json', JSON.stringify(identity, null, 2));
    console.log(
      'PASS',
      mode,
      shape,
      'four independent compiled metric observations; exact Home fixture written; live requests 0',
    );
  } finally {
    await worker.end();
    await admin.end();
  }
}
