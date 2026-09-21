import assert from 'node:assert/strict';
import { writeFile } from 'node:fs/promises';
import { connect, databaseConfig } from '../../dist/db/connect.js';
import { ReadDatabase } from '../../dist/services/queries/database.js';
import { home, homeSql } from '../../dist/services/queries/home.js';
import {
  maturitiesSql,
  maturities,
  nativeCharts,
  archiveCharts,
} from '../../dist/services/queries/charts.js';
import { SqlAddressBaseline } from '../../dist/services/live/baseline.js';
import { stakesSql, holdersSql } from '../../dist/services/queries/lists.js';
import { dailySql, marketSql } from '../../dist/services/queries/history.js';
import { datasetQueries } from '../../dist/worker/exports/datasets.js';
import { control, clockFor, bulkAddress } from './fixture.mjs';
const db = new ReadDatabase(databaseConfig('api')),
  worker = await connect(databaseConfig('worker'));
const signal = new AbortController().signal,
  clock = clockFor(control()),
  samples = [],
  plans = {},
  other = [];
try {
  await worker.query('SET statement_timeout=120000');
  let response;
  for (let i = 0; i < 101; i++) {
    const at = performance.now();
    response = await home(db, 'pulsechain', signal, clock.now(), 'production');
    samples.push(performance.now() - at);
  }
  const bytes = Buffer.byteLength(JSON.stringify(response));
  assert.ok(bytes <= 25 * 1024);
  const day = (await worker.query('SELECT contract_day FROM hdd.current_state WHERE chain_id=369'))
    .rows[0].contract_day;
  for (const [name, sql, args] of [
    ['home', homeSql, [369]],
    ['maturities', maturitiesSql, [day]],
    ['address-list', stakesSql(true), [369, '0', 100, Buffer.from(bulkAddress(1).slice(2), 'hex')]],
    ['holders', holdersSql('liquid'), [369, '0', 50]],
    ['daily', dailySql, [369, day - 30, day - 1]],
    ['market', marketSql, [369, 'delayed-synthetic-market', day - 30, day - 1]],
    ...Object.entries(datasetQueries).map(([name, sql]) => ['export-' + name, sql, [369]]),
  ])
    plans[name] = (
      await worker.query('EXPLAIN (ANALYZE,BUFFERS,FORMAT JSON) ' + sql, args)
    ).rows[0]['QUERY PLAN'];
  const addressPlanner = new SqlAddressBaseline({
    query: async (sql, args) => {
      plans['address-aggregate-counts-activity-ranks'] = (
        await worker.query('EXPLAIN (ANALYZE,BUFFERS,FORMAT JSON) ' + sql, args)
      ).rows[0]['QUERY PLAN'];
      return worker.query(sql, args);
    },
  });
  await addressPlanner.address(369, bulkAddress(1));
  for (const [name, run] of [
    ['large-address', () => new SqlAddressBaseline(worker).address(369, bulkAddress(1))],
    ['ordinary-address', () => new SqlAddressBaseline(worker).address(369, bulkAddress(12003))],
    ['native-charts', () => nativeCharts(db, signal, clock.now())],
    ['maturities', () => maturities(db, signal)],
    ['archive-charts', () => archiveCharts(db, signal)],
  ]) {
    const at = performance.now();
    try {
      const result = await run();
      other.push({
        name,
        ms: performance.now() - at,
        bytes: Buffer.byteLength(JSON.stringify(result)),
        status: 'available',
      });
    } catch (e) {
      other.push({ name, ms: performance.now() - at, status: 'unavailable', error: e.message });
    }
  }
  await writeFile(
    '/evidence/queries.json',
    JSON.stringify(
      {
        samples,
        bytes,
        plans,
        other,
        p95: [...samples].sort((a, b) => a - b)[Math.ceil(samples.length * 0.95) - 1],
        rss: process.memoryUsage().rss,
      },
      null,
      2,
    ),
  );
  console.log('PASS 101 measured Home reads and actual scale query plans');
} finally {
  await Promise.allSettled([db.close(), worker.end()]);
}
