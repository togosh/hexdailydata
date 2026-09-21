// Address-only coherent synthetic fixture. No provider or retained owner data.
import assert from 'node:assert/strict';
import { connect, databaseConfig } from '../../dist/db/connect.js';
import { migrateCurrent } from '../../dist/db/migrate.js';
import { populate } from '../api/fixture.mjs';
import { rankAccounts } from '../../dist/worker/daily/ranking.js';
import { totalColumns } from '../../src/services/projections/reduce.ts';
import pg from 'pg';
assert.equal(process.env.HDD_V2_ALLOW_LIVE_RPC, 'false');
assert.match(process.env.HDD_V2_PROJECT, /^hexdailydata-v2-web-/);
const at = Date.parse('2026-09-19T12:00:00Z'),
  day = ((at / 1000 - 1575331200) / 86400) | 0;
const migrator = await connect(databaseConfig('migrator'));
await migrateCurrent(migrator);
await migrator.end();
const worker = await connect(databaseConfig('worker'));
const admin = new pg.Client({
  host: 'db',
  database: 'hexdailydata_v2',
  user: 'hdd_v2_admin',
  password: process.env.HDD_V2_ADMIN_PASSWORD,
});
await admin.connect();
try {
  await populate(worker, admin);
  await worker.query('DELETE FROM hdd.events');
  await worker.query(
    `UPDATE hdd.stakes SET address=decode(lpad(CASE WHEN stake_id<=32 THEN '1' ELSE '2' END,40,'0'),'hex'),
    origin_chain_id=CASE WHEN stake_id=2 THEN 1 ELSE 369 END,
    start_block=CASE WHEN stake_id=2 THEN 80 WHEN stake_id=1 THEN 99999 WHEN stake_id BETWEEN 3 AND 24 THEN 50000 ELSE 1000 END,
    start_day=CASE WHEN stake_id=2 THEN 1100 WHEN stake_id=1 THEN $1 WHEN stake_id BETWEEN 3 AND 24 THEN $1-100 ELSE $1-367 END,
    locked_day=CASE WHEN stake_id=2 THEN 1101 WHEN stake_id=1 THEN $1+1 WHEN stake_id BETWEEN 3 AND 24 THEN $1-99 ELSE $1-366 END,
    staked_days=CASE WHEN stake_id BETWEEN 3 AND 24 THEN 120+stake_id*15 ELSE 365 END,
    principal_hearts=stake_id*1250000000000::numeric,stake_shares=stake_id*4000000000000::numeric,
    lifecycle=CASE WHEN stake_id<=24 THEN 'unsettled' WHEN stake_id<=27 THEN 'good_accounted' WHEN stake_id<=30 THEN 'ended' ELSE 'cancelled' END,
    ga_day=CASE WHEN stake_id BETWEEN 25 AND 28 THEN $1-1 END,ga_block=CASE WHEN stake_id BETWEEN 25 AND 28 THEN 99000 END,
    end_day=CASE WHEN stake_id BETWEEN 28 AND 30 THEN $1 WHEN stake_id>30 THEN $1-367 END,
    end_block=CASE WHEN stake_id BETWEEN 28 AND 30 THEN 100000 WHEN stake_id>30 THEN 1001 END,last_block=100000,
    payout_hearts=CASE WHEN stake_id>=25 THEN 0 END,penalty_hearts=CASE WHEN stake_id>=25 THEN 0 END`,
    [day],
  );
  await worker.query(`INSERT INTO hdd.events SELECT s.origin_chain_id,s.start_block,s.start_log,decode(lpad(s.start_block::text,64,'0'),'hex'),decode(lpad(s.stake_id::text,64,'0'),'hex'),0,
    1575331200+s.start_day::bigint*86400,'stake_start',s.stake_id,ARRAY[decode(repeat('aa',32),'hex')],'\\x'::bytea,'{}' FROM hdd.stakes s`);
  for (const [column, kind, log] of [
    ['ga', 'good_accounting', 200],
    ['end', 'stake_end', 400],
  ]) {
    await worker.query(
      `INSERT INTO hdd.events SELECT 369,s.${column}_block,s.stake_id+$1,decode(lpad(s.${column}_block::text,64,'0'),'hex'),decode(lpad(s.stake_id::text,64,'0'),'hex'),0,
      CASE WHEN s.${column}_block=100000 THEN $2 ELSE 1575331200+s.${column}_day::bigint*86400 END,'${kind}',s.stake_id,ARRAY[decode(repeat('bb',32),'hex')],'\\x'::bytea,'{}' FROM hdd.stakes s WHERE s.${column}_block IS NOT NULL`,
      [log, at / 1000 - 120],
    );
  }
  await worker.query(
    `UPDATE hdd.accounts SET liquid_hearts=12543087654321,accounted_hearts=0,stake_count=0`,
  );
  await worker.query(`UPDATE hdd.accounts a SET accounted_hearts=s.total,stake_count=s.count FROM
    (SELECT address,coalesce(sum(principal_hearts) FILTER(WHERE lifecycle='unsettled'),0) total,count(*) FILTER(WHERE lifecycle IN('unsettled','good_accounted')) count FROM hdd.stakes GROUP BY address) s WHERE a.address=s.address`);
  await worker.query(
    `UPDATE hdd.current_state SET contract_day=$1,
    circulating_hearts=(SELECT sum(liquid_hearts) FROM hdd.accounts),
    locked_hearts=(SELECT sum(principal_hearts) FROM hdd.stakes WHERE lifecycle IN('unsettled','good_accounted')),
    accounted_hearts=(SELECT sum(accounted_hearts) FROM hdd.accounts),
    active_shares=(SELECT sum(stake_shares) FROM hdd.stakes WHERE lifecycle='unsettled' AND locked_day<=$1),
    queued_shares=(SELECT sum(stake_shares) FROM hdd.stakes WHERE lifecycle='unsettled' AND locked_day>$1),
    weighted_days=(SELECT sum(principal_hearts*staked_days) FROM hdd.stakes WHERE lifecycle='unsettled')`,
    [day],
  );
  await worker.query(
    `UPDATE hdd.daily_stats d SET ${totalColumns.map((c) => `${c}=s.${c}`).join(',')} FROM hdd.current_state s WHERE d.chain_id=s.chain_id`,
  );
  await worker.query(
    "UPDATE hdd.sync_state SET block_number=100000,block_hash=decode(lpad('100000',64,'0'),'hex'),block_time=$1,ranking_day=$2,revision=revision+1",
    [at / 1000 - 120, day - 1],
  );
  await worker.query('UPDATE hdd.daily_stats SET contract_day=contract_day+$1', [day - 400]);
  await rankAccounts(worker, 369, new AbortController().signal);
  await admin.query('ANALYZE');
  console.log(
    'PASS synthetic Address fixture: 24 open (queued/active/mature), 3 GA, 3 ended, 2 cancelled; 27 live unended; inherited start; ordinary exact amounts.',
  );
} finally {
  await worker.end();
  await admin.end();
}
