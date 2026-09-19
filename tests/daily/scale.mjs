import assert from 'node:assert/strict';
import { readFileSync, writeFileSync } from 'node:fs';
import { readdir, stat } from 'node:fs/promises';
import { setTimeout as pause } from 'node:timers/promises';
import { rankAccounts, rankingQuery } from '../../src/worker/daily/ranking.ts';
import { ExportService } from '../../src/worker/exports/service.ts';
import { datasetQueries } from '../../src/worker/exports/datasets.ts';
import { MetricsService } from '../../src/worker/metrics/service.ts';
import { SqlMetricStore } from '../../src/worker/metrics/store.ts';
import { capturePrice, DailyService } from '../../src/worker/daily/service.ts';
import { PriceReader } from '../../src/services/live/price.ts';
import { MetricsJob, runWorkerLifecycle } from '../../src/worker/lifecycle.ts';
import { fixture, ManualClock, CODE_HASH, HEX, A } from '../live/fixture.mjs';
import { SqlAddressBaseline } from '../../src/services/live/baseline.ts';
import { AddressService } from '../../src/services/live/address.ts';
import { reserve, uuid } from '../../src/worker/exports/files.ts';
import { totalColumns, applyPayout } from '../../src/services/projections/reduce.ts';
import { dailyWords, word } from '../../src/providers/abi.ts';
import {
  configureMarket,
  importMarketBars,
  finalizeMarkets,
} from '../../src/worker/daily/market.ts';
const signal = new AbortController().signal;
export async function scale({ admin, api, worker, fresh, test, measurements }) {
  await worker.query('SET statement_timeout=120000');
  await admin.query('SET statement_timeout=120000');
  measurements.storage = [];
  async function sample(label) {
    await admin.query('CREATE TEMP TABLE IF NOT EXISTS disk_probe(line text)');
    await admin.query('TRUNCATE disk_probe');
    await admin.query("COPY disk_probe FROM PROGRAM 'df -Pk /var/lib/postgresql/data'");
    const fields = (await admin.query('SELECT line FROM disk_probe')).rows
      .at(-1)
      .line.trim()
      .split(/\s+/);
    assert.ok(
      BigInt(fields[3]) * 1024n >= 8n * 1024n ** 3n && BigInt(fields[3]) * 5n >= BigInt(fields[1]),
    );
    await admin.query('SELECT pg_stat_clear_snapshot()');
    const tables = (
      await admin.query(`SELECT c.relname,pg_relation_size(c.oid)::text AS heap_bytes,pg_indexes_size(c.oid)::text AS index_bytes,
      CASE WHEN c.reltoastrelid=0 THEN '0' ELSE pg_total_relation_size(c.reltoastrelid)::text END AS toast_bytes FROM pg_class c
      JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='hdd' AND c.relkind='r' ORDER BY c.relname`)
    ).rows;
    const stats = (
      await admin.query(`SELECT pg_database_size(current_database())::text AS db_bytes,pg_current_wal_lsn()::text AS wal_lsn,
      temp_files::text,temp_bytes::text,(SELECT sum(size)::text FROM pg_ls_waldir()) AS allocated_wal_bytes
      FROM pg_stat_database WHERE datname=current_database()`)
    ).rows[0];
    const db = (
      await admin.query(
        "SELECT pg_read_file('/sys/fs/cgroup/memory.current') AS current,pg_read_file('/sys/fs/cgroup/memory.peak') AS peak,pg_read_file('/sys/fs/cgroup/cpu.max') AS cpu,pg_read_file('/sys/fs/cgroup/memory.max') AS limit",
      )
    ).rows[0];
    const dirs = [];
    for (const dir of await readdir('/exports'))
      if (uuid.test(dir) || dir.startsWith('.work-')) {
        let bytes = 0;
        for (const f of await readdir('/exports/' + dir))
          bytes += (await stat('/exports/' + dir + '/' + f)).size;
        dirs.push({ dir, bytes });
      }
    measurements.storage.push({
      label,
      tables,
      ...stats,
      db,
      runner: {
        rss: process.memoryUsage().rss,
        current: readFileSync('/sys/fs/cgroup/memory.current', 'utf8').trim(),
        peak: readFileSync('/sys/fs/cgroup/memory.peak', 'utf8').trim(),
      },
      dirs,
      disk: await reserve('/exports'),
    });
  }
  await sample('empty');
  await test('full-size fixture: one million lifecycle rows, 500000 exact accounts and preserved event times', async () => {
    await worker.query(
      `INSERT INTO hdd.chains VALUES(369,decode(repeat('ab',20),'hex'),decode(repeat('cd',32),'hex'),'fork',369,89,decode(lpad('89',64,'0'),'hex'),90,decode(lpad('90',64,'0'),'hex'))`,
    );
    await worker.query(
      `INSERT INTO hdd.sync_state VALUES(369,100,decode(lpad('100',64,'0'),'hex'),1609891200,0,'confirmed',100,'{}',NULL)`,
    );
    await worker.query(
      `INSERT INTO hdd.accounts SELECT 369,decode(lpad(to_hex(i),40,'0'),'hex'),900719925474099300000000::numeric+i,0,0,90,100 FROM generate_series(1,500000) i`,
    );
    await worker.query(`INSERT INTO hdd.stakes(chain_id,stake_id,address,origin_chain_id,start_block,start_log,start_day,locked_day,staked_days,principal_hearts,stake_shares,is_auto_stake,lifecycle,end_day,end_block,payout_hearts,penalty_hearts,last_block)
      SELECT 369,i,decode(lpad(to_hex((i-1)%500000+1),40,'0'),'hex'),369,90,i,399,400,1+i%5555,
      100000000000::numeric+(i%10000)*100000000::numeric,1000000000000::numeric+(i%10000)*300000007::numeric,false,
      CASE WHEN i%10=0 THEN 'cancelled' ELSE 'unsettled' END,CASE WHEN i%10=0 THEN 399 END,CASE WHEN i%10=0 THEN 91 END,
      CASE WHEN i%10=0 THEN 0 END,CASE WHEN i%10=0 THEN 0 END,100 FROM generate_series(1,1000000) i`);
    await worker.query(`INSERT INTO hdd.events SELECT 369,90,i,decode(lpad('90',64,'0'),'hex'),decode(lpad(to_hex(i),64,'0'),'hex'),0,1609804801,'stake_start',i,
      ARRAY[decode(repeat('aa',32),'hex')],'\\x'::bytea,'{}' FROM generate_series(1,1000000) i`);
    await worker.query(`INSERT INTO hdd.events SELECT 369,91,i,decode(lpad('91',64,'0'),'hex'),decode(lpad(to_hex(i),64,'0'),'hex'),0,1609804802,'stake_end',i,
      ARRAY[decode(repeat('bb',32),'hex')],'\\x'::bytea,'{}' FROM generate_series(10,1000000,10) i`);
    await worker.query(`UPDATE hdd.accounts a SET accounted_hearts=s.total,stake_count=s.count FROM
      (SELECT address,sum(principal_hearts) AS total,count(*) AS count FROM hdd.stakes WHERE lifecycle='unsettled' GROUP BY address) s WHERE a.address=s.address`);
    await worker.query(`INSERT INTO hdd.current_state SELECT 369,400,(SELECT sum(liquid_hearts) FROM hdd.accounts),sum(principal_hearts),sum(principal_hearts),sum(principal_hearts*staked_days),sum(stake_shares),0,
      500000,(SELECT count(*) FROM hdd.accounts WHERE stake_count>0),100000,0,0,0,0 FROM hdd.stakes WHERE lifecycle='unsettled'`);
    await worker.query(`INSERT INTO hdd.daily_stats(chain_id,contract_day,origin_chain_id,close_block,close_hash,${totalColumns.join(',')})
      SELECT 369,d,369,100,decode(lpad('100',64,'0'),'hex'),${totalColumns.map((c) => 's.' + c).join(',')}
      FROM generate_series(0,399) d CROSS JOIN hdd.current_state s WHERE s.chain_id=369`);
    const raw = '0x' + word(32) + word(1) + word(1000000000000000003n + (3000000000000n << 72n));
    const ledger = dailyWords(raw, 351, 352)[0];
    const nativeBefore = (
      await api.query(
        'SELECT circulating_hearts,accounted_hearts,starts,ends FROM hdd.daily_stats WHERE contract_day=351',
      )
    ).rows;
    await applyPayout(worker, 369, 400, {
      ...ledger,
      blockNumber: '100',
      blockHash: '0x' + '100'.padStart(64, '0'),
    });
    assert.deepEqual(
      (
        await api.query(
          'SELECT circulating_hearts,accounted_hearts,starts,ends FROM hdd.daily_stats WHERE contract_day=351',
        )
      ).rows,
      nativeBefore,
    );
    await configureMarket(worker, 369, 'scale-venue', 'source-reported', 369);
    const bars = Array.from({ length: 31 }, (_, i) => ({
      time: 1575331200 + (369 + i) * 86400,
      revision: '0',
      open: '0.1',
      high: '0.2',
      low: '0.05',
      close: '0.15',
      volume: null,
      liquidity: null,
    }));
    await importMarketBars(worker, { chain: 369, source: 'scale-venue', bars }, 1609891200, signal);
    await finalizeMarkets(worker, 369, 399, signal);
    await admin.query('ANALYZE');
    await sample('loaded');
  });
  const service = new ExportService(() => fresh(), '/exports');
  await service.startup(signal);
  await test('full ranking with SQL plans and no date-only account writes', async () => {
    const before = (
      await api.query('SELECT sum(xmin::text::bigint)::text AS total FROM hdd.accounts')
    ).rows[0];
    const t = performance.now();
    await rankAccounts(worker, 369, signal);
    measurements.rankWallMs = performance.now() - t;
    assert.deepEqual(
      (await api.query('SELECT sum(xmin::text::bigint)::text AS total FROM hdd.accounts')).rows[0],
      before,
    );
    assert.equal(
      (await api.query('SELECT count(*) FROM hdd.account_ranks')).rows[0].count,
      '500000',
    );
    for (const [name, sql] of Object.entries({
      rank: rankingQuery,
      stakes: datasetQueries.stakes,
      holders: datasetQueries.holders,
      maturities: datasetQueries.maturities,
    })) {
      const result = await worker.query('EXPLAIN (ANALYZE,BUFFERS,FORMAT JSON) ' + sql, [369]);
      writeFileSync(
        '/evidence/plan-' + name + '.json',
        JSON.stringify(result.rows[0]['QUERY PLAN'], null, 2),
      );
    }
    await sample('ranked');
  });
  await test('full five-file streaming, concurrent metrics/address lane, bounded reader and current/prior/build overlap', async () => {
    const first = await service.build(369, signal);
    const nativeRows = readFileSync('/exports/' + first.id + '/daily.csv', 'utf8')
      .trim()
      .split('\n')
      .map((r) => r.split(','));
    assert.equal(nativeRows.find((r) => r[1] === '352')[3], '3333333333.333333343333');
    assert.equal(first.files.find((f) => f.dataset === 'daily').rows, '400');
    assert.equal(first.files.find((f) => f.dataset === 'markets').rows, '31');
    assert.equal(first.files.find((f) => f.dataset === 'stakes').rows, '1000000');
    const reader = new ExportService(() => fresh('api'), '/exports');
    await reader.startup(signal);
    const held = await reader.openStream(first.id, 'holders', signal);
    assert.equal(held.status, 'available');
    let readBytes = 0;
    const download = (async () => {
      for await (const b of held.stream) readBytes += b.length;
      await held.released;
    })();
    const clock = new ManualClock();
    const f = fixture({ clock }),
      mclient = await fresh();
    const metrics = new MetricsService(
      [f.rpc('one'), f.rpc('two')],
      CODE_HASH,
      new PriceReader(f.price, HEX),
      new SqlMetricStore(mclient),
      (source, sample) => capturePrice(mclient, 369, source, sample),
    );
    const job = new MetricsJob(clock, (s) => metrics.tick(s)),
      controller = new AbortController();
    let pumping = true;
    clock.time += 60000; // Advance the conservative startup quota window; not measured wall time.
    const address = new AddressService(f.rpc('api', f.api), CODE_HASH, new SqlAddressBaseline(api));
    const addressRequest = address.get(A, signal, 3);
    const pump = (async () => {
      while (pumping) {
        await pause(5);
        await clock.advance(1000);
      }
    })();
    let overlap = false;
    const t = performance.now();
    let second;
    try {
      second = await runWorkerLifecycle(
        async (s) =>
          service.build(369, s, async (stage) => {
            if (stage === 'chunk' && !overlap) {
              overlap = true;
              await sample('current-plus-build');
            }
          }),
        job,
        controller.signal,
      );
    } finally {
      pumping = false;
      await pump;
      await mclient.end();
    }
    const addressResult = await addressRequest;
    measurements.addressResult = addressResult;
    assert.ok(addressResult.live);
    assert.equal(addressResult.live.page.enumerationComplete, true);
    measurements.addressOutcome = addressResult.outcome;
    await download;
    assert.equal(String(readBytes), first.files.find((f) => f.dataset === 'holders').bytes);
    measurements.exportWallMs = performance.now() - t;
    measurements.metrics = {
      ...metrics.counters,
      job: job.counters,
      virtualMs: clock.now() - 1609891200000,
    };
    assert.ok(metrics.counters.updates > 4);
    assert.ok(job.counters.scheduled > 1);
    assert.equal(second.files.find((f) => f.dataset === 'holders').rows, '500000');
    // The existing address service's real request budget is independently exercised in test:live.
    measurements.workerBudget = f.worker.counters;
    measurements.apiBudget = f.api.counters;
    assert.equal(f.attempts.filter((a) => a.id !== 'api').length, f.worker.counters.attempts);
    assert.equal(f.attempts.filter((a) => a.id === 'api').length, f.api.counters.attempts);
    for (const end of f.attempts) {
      const w = f.attempts.filter((a) => a.at > end.at - 60000 && a.at <= end.at);
      assert.ok(w.length <= 30);
      assert.ok(w.reduce((n, a) => n + a.calls, 0) <= 900);
    }
    measurements.files = second.files;
    await sample('current-plus-prior');
    await worker.query(
      "UPDATE hdd.export_bundles SET published_at=now()-interval '61 seconds' WHERE slot='prior'",
    );
    let thirdOverlap = false;
    await service.build(369, signal, async (stage) => {
      if (stage === 'chunk' && !thirdOverlap) {
        thirdOverlap = true;
        await sample('retired-prior-current-plus-build');
      }
    });
    assert.equal((await readdir('/exports')).filter((n) => uuid.test(n)).length, 2);
    await sample('settled');
    measurements.walGeneratedBytes = (
      await admin.query('SELECT pg_wal_lsn_diff($1,$2)::text AS bytes', [
        measurements.storage.at(-1).wal_lsn,
        measurements.storage[0].wal_lsn,
      ])
    ).rows[0].bytes;
    measurements.rowUpdates = (
      await admin.query(
        "SELECT relname,n_tup_ins::text,n_tup_upd::text,n_tup_del::text FROM pg_stat_user_tables WHERE schemaname='hdd' ORDER BY relname",
      )
    ).rows;
    measurements.peakLimitations =
      'Milestone snapshots and cgroup memory peak; cumulative temp/WAL is not a continuously sampled disk peak. Raw fixture construction is not source acquisition qualification.';
  });
}
