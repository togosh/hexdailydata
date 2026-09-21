import assert from 'node:assert/strict';
import pg from 'pg';
import { readFile, writeFile, readdir, stat } from 'node:fs/promises';
import { connect, databaseConfig } from '../../dist/db/connect.js';
import { reconcile } from '../../dist/services/projections/initialize.js';
import { reserve } from '../../dist/worker/exports/files.js';
import { inspectInput } from '../../dist/worker/history/input.js';
import { importHistory } from '../../dist/worker/history/store.js';
import { sample as historySample, selection } from '../history/fixture.mjs';
import { model, control, baseBlock, bulkAddress } from './fixture.mjs';

const c = control(),
  m = model(c),
  action = process.argv[2];
const admin = new pg.Client({
  host: 'db',
  database: 'hexdailydata_v2',
  user: 'hdd_v2_admin',
  password: (await readFile(process.env.HDD_V2_ADMIN_PASSWORD_FILE, 'utf8')).trim(),
});
await admin.connect();
const worker = await connect(databaseConfig('worker'));
const signal = new AbortController().signal;
try {
  await worker.query('SET statement_timeout=120000');
  await admin.query('SET statement_timeout=120000');
  if (action === 'bulk') {
    const day = c.startDay + 24;
    assert.equal(
      (await worker.query('SELECT block_number FROM hdd.sync_state WHERE chain_id=369')).rows[0]
        .block_number,
      String(baseBlock),
    );
    await reserve('/exports');
    // Lifecycle/cardinality shape is unchanged. Monetary totals are explicitly
    // synthetic, with one precision case, and have no historical raw seed proof.
    await worker.query(`INSERT INTO hdd.accounts SELECT 369,decode(lpad(to_hex(1000000+i),40,'0'),'hex'),
      CASE WHEN i=1 THEN 900719925474099312345::numeric
        ELSE 1000000000000::numeric+i*100000003::numeric END,
      0,0,296,296 FROM generate_series(1,500000) i`);
    await worker.query(
      `INSERT INTO hdd.stakes(chain_id,stake_id,address,origin_chain_id,start_block,start_log,start_day,
      locked_day,staked_days,principal_hearts,stake_shares,is_auto_stake,lifecycle,ga_day,ga_block,end_day,end_block,payout_hearts,penalty_hearts,last_block)
      SELECT 369,1000000+i,decode(lpad(to_hex(1000000+CASE WHEN i<=10000 THEN 1 ELSE (i-1)%500000+1 END),40,'0'),'hex'),
      369,296,i,CASE WHEN i%10 IN(1,2) THEN $1::int-3 WHEN i%10=0 THEN $1::int ELSE $1::int+i%2-1 END,
      CASE WHEN i%10 IN(1,2) THEN $1::int-2 WHEN i%10=0 THEN $1::int+1 ELSE $1::int+i%2 END,
      CASE WHEN i%10 IN(1,2) THEN 1 ELSE 1+i%5555 END,
      100000000000::numeric+(i%10000)*100000000::numeric,1000000000000::numeric+(i%10000)*300000007::numeric,false,
      CASE i%10 WHEN 0 THEN 'cancelled' WHEN 1 THEN 'good_accounted' WHEN 2 THEN 'ended' ELSE 'unsettled' END,
      CASE WHEN i%10=1 THEN $1::int END,CASE WHEN i%10=1 THEN 296 END,
      CASE WHEN i%10 IN(0,2) THEN $1::int END,CASE WHEN i%10 IN(0,2) THEN 296 END,
      CASE WHEN i%10 IN(0,1,2) THEN 0 END,CASE WHEN i%10 IN(0,1,2) THEN 0 END,296
      FROM generate_series(1,1000000) i`,
      [day],
    );
    await worker.query(`UPDATE hdd.accounts a SET accounted_hearts=s.total,stake_count=s.count FROM
      (SELECT address,sum(principal_hearts) total,count(*) count FROM hdd.stakes WHERE chain_id=369 AND stake_id BETWEEN 1000001 AND 2000000 AND lifecycle='unsettled' GROUP BY address) s
      WHERE a.chain_id=369 AND a.address=s.address`);
    await worker.query(`INSERT INTO hdd.events SELECT 369,296,start_log,decode(lpad('128',64,'0'),'hex'),
      decode(lpad(to_hex(stake_id),64,'0'),'hex'),0,1575331200+start_day::bigint*86400+1,'stake_start',stake_id,
      ARRAY[decode(repeat('aa',32),'hex')],'\\x'::bytea,'{}' FROM hdd.stakes
      WHERE chain_id=369 AND stake_id BETWEEN 1000001 AND 2000000`);
    await worker.query(`INSERT INTO hdd.events SELECT 369,296,stake_id+1000000,decode(lpad('128',64,'0'),'hex'),
      decode(lpad(to_hex(stake_id),64,'0'),'hex'),0,1575331200+coalesce(ga_day,end_day)::bigint*86400+1,
      CASE WHEN lifecycle='good_accounted' THEN 'good_accounting' ELSE 'stake_end' END,stake_id,
      ARRAY[decode(repeat('bb',32),'hex')],'\\x'::bytea,'{}' FROM hdd.stakes
      WHERE chain_id=369 AND stake_id BETWEEN 1000001 AND 2000000 AND lifecycle<>'unsettled'`);
    await worker.query(
      `UPDATE hdd.current_state SET circulating_hearts=circulating_hearts+$1,locked_hearts=locked_hearts+$2,
      accounted_hearts=accounted_hearts+$3,active_shares=active_shares+$4,queued_shares=queued_shares+$5,
      holder_count=holder_count+500000,staker_count=(SELECT count(*) FROM hdd.accounts WHERE chain_id=369 AND stake_count>0),
      weighted_days=weighted_days+(SELECT sum(principal_hearts*staked_days) FROM hdd.stakes WHERE chain_id=369 AND stake_id BETWEEN 1000001 AND 2000000 AND lifecycle='unsettled') WHERE chain_id=369`,
      [m.bulk.supply, m.bulk.locked, m.bulk.accounted, m.bulk.earning, m.bulk.queued].map(String),
    );
    await worker.query(
      `INSERT INTO hdd.share_schedule VALUES(369,$1,$2) ON CONFLICT(chain_id,activation_day) DO UPDATE SET shares=hdd.share_schedule.shares+excluded.shares`,
      [day + 1, String(m.bulk.queued)],
    );
    await worker.query('UPDATE hdd.sync_state SET rewind_floor=296 WHERE chain_id=369');
    await reconcile(worker, 369);
    const total = (
      await worker.query(
        'SELECT circulating_hearts,locked_hearts FROM hdd.current_state WHERE chain_id=369',
      )
    ).rows[0];
    assert.equal(total.circulating_hearts, String(m.f.states.get(baseBlock).supply));
    assert.equal(total.locked_hearts, String(m.f.states.get(baseBlock).locked));
    await admin.query('ANALYZE');
    console.log(
      'PASS appended 1M lifecycle/500k address shape; current aggregates reconcile; raw-history/seed audit unqualified',
    );
  } else if (action === 'history') {
    const bytes = historySample();
    const result = await importHistory(worker, inspectInput(bytes, selection(bytes)), signal);
    await writeFile(
      '/evidence/hds-identity.json',
      JSON.stringify(
        {
          kind: 'synthetic-fixture',
          realInputRegression: 'NOT_RUN',
          newDownloadRequests: 0,
          result,
        },
        null,
        2,
      ),
    );
    console.log('PASS synthetic reported archive; retained real input absent');
  } else if (action === 'sample') {
    const label = process.argv[3];
    assert.match(label, /^[a-z0-9-]+$/);
    const tables = (
      await admin.query(`SELECT c.relname,pg_relation_size(c.oid)::text heap_bytes,pg_indexes_size(c.oid)::text index_bytes,
      CASE WHEN c.reltoastrelid=0 THEN '0' ELSE pg_total_relation_size(c.reltoastrelid)::text END toast_bytes,
      s.n_tup_ins::text,s.n_tup_upd::text,s.n_tup_del::text FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
      LEFT JOIN pg_stat_user_tables s ON s.relid=c.oid WHERE n.nspname='hdd' AND c.relkind='r' ORDER BY c.relname`)
    ).rows;
    const stats = (
      await admin.query(`SELECT pg_database_size(current_database())::text db_bytes,pg_current_wal_lsn()::text wal_lsn,
      temp_files::text,temp_bytes::text,(SELECT sum(size)::text FROM pg_ls_waldir()) allocated_wal_bytes,
      (SELECT coalesce(sum(size),0)::text FROM pg_ls_tmpdir()) active_temp_bytes FROM pg_stat_database WHERE datname=current_database()`)
    ).rows[0];
    const memory = (
      await admin.query(`SELECT pg_read_file('/sys/fs/cgroup/memory.current') current,pg_read_file('/sys/fs/cgroup/memory.peak') peak,
      pg_read_file('/sys/fs/cgroup/memory.events') events,pg_read_file('/sys/fs/cgroup/cpu.max') cpu,pg_read_file('/sys/fs/cgroup/memory.max') memory_limit`)
    ).rows[0];
    const files = [];
    for (const name of await readdir('/exports')) {
      const info = await stat('/exports/' + name);
      if (!info.isDirectory()) continue;
      let bytes = 0;
      for (const file of await readdir('/exports/' + name))
        bytes += (await stat('/exports/' + name + '/' + file)).size;
      files.push({ name, bytes });
    }
    const state = (await worker.query('SELECT * FROM hdd.current_state WHERE chain_id=369'))
      .rows[0];
    const cursor = (
      await worker.query(
        'SELECT block_number,block_time,revision,rewind_floor FROM hdd.sync_state WHERE chain_id=369',
      )
    ).rows[0];
    const expected = m.f.states.get(Number(cursor.block_number));
    if (Number(cursor.block_number) > 536) {
      assert.equal(state.circulating_hearts, '901633645423948312402060');
      assert.equal(state.locked_hearts, '480030000000016000');
      assert.equal(state.active_shares, '1750210024504908000');
      assert.equal(state.queued_shares, '0');
    }
    for (const [column, key] of [
      ['circulating_hearts', 'supply'],
      ['locked_hearts', 'locked'],
      ['active_shares', 'active'],
      ['queued_shares', 'queued'],
    ])
      assert.equal(state[column], String(expected[key]), 'Independent raw fixture total ' + column);
    const unchanged = (
      await worker.query(
        'SELECT xmin::text,principal_hearts,stake_shares,last_block FROM hdd.stakes WHERE chain_id=369 AND stake_id=1500043',
      )
    ).rows[0];
    const unchangedAccount = (
      await worker.query(
        'SELECT xmin::text,liquid_hearts,accounted_hearts,stake_count,last_block FROM hdd.accounts WHERE chain_id=369 AND address=$1',
        [Buffer.from(bulkAddress(12043).slice(2), 'hex')],
      )
    ).rows[0];
    const bundles = (
      await worker.query(
        'SELECT id,slot,status,published_at FROM hdd.export_bundles ORDER BY published_at',
      )
    ).rows;
    const metrics = (
      await worker.query('SELECT metric,observation,inputs FROM hdd.live_metrics ORDER BY metric')
    ).rows;
    if (control().capacity && Number(cursor.block_number) > 536) {
      const today = metrics.find((r) => r.metric === 'todayPayoutEstimate');
      assert.equal(today.inputs.current.totalSupply, '901633645423948312402060');
      assert.equal(today.inputs.current.lockedHearts, '480030000000016000');
      assert.equal(today.observation.value.payoutHearts, '89760392869430730732');
      assert.equal(today.observation.value.stakeShares, '1750210024504908000');
    }
    const markets = (
      await worker.query(
        'SELECT source,contract_day,observation FROM hdd.market_daily WHERE chain_id=369 ORDER BY source,contract_day',
      )
    ).rows;
    const counts = (
      await worker.query(
        `SELECT (SELECT count(*)::text FROM hdd.stakes WHERE chain_id=369) stakes,
      (SELECT count(*)::text FROM hdd.accounts WHERE chain_id=369) accounts,(SELECT count(*)::text FROM hdd.daily_stats WHERE chain_id=369) daily,
      (SELECT count(*)::text FROM hdd.stakes WHERE chain_id=369 AND address=$1) large_owner`,
        [Buffer.from(bulkAddress(1).slice(2), 'hex')],
      )
    ).rows[0];
    await writeFile(
      '/evidence/' + label + '.json',
      JSON.stringify(
        {
          label,
          tables,
          stats,
          memory,
          files,
          state,
          cursor,
          unchanged,
          unchangedAccount,
          bundles,
          metrics,
          markets,
          counts,
          disk: await reserve('/exports'),
          rss: process.memoryUsage().rss,
        },
        null,
        2,
      ),
    );
    console.log(JSON.stringify({ label, stats, counts, cursor }));
  } else throw new Error('Unknown integration setup action');
} finally {
  await Promise.allSettled([admin.end(), worker.end()]);
}
