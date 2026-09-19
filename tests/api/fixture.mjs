import { totalColumns } from '../../src/services/projections/reduce.ts';
import { rankAccounts } from '../../src/worker/daily/ranking.ts';
import {
  configureMarket,
  importMarketBars,
  finalizeMarkets,
} from '../../src/worker/daily/market.ts';
export const signal = new AbortController().signal;
export const at = 1609891200000;
export const address = (n) => '0x' + n.toString(16).padStart(40, '0');
export async function populate(worker, admin, large = false) {
  const count = large ? 1000000 : 120,
    accounts = count / 2;
  await worker.query('SET statement_timeout=120000');
  await worker.query(
    `INSERT INTO hdd.chains VALUES(369,decode(repeat('ab',20),'hex'),decode(repeat('cd',32),'hex'),'fork',369,89,decode(lpad('89',64,'0'),'hex'),90,decode(lpad('90',64,'0'),'hex'))`,
  );
  await worker.query(
    `INSERT INTO hdd.sync_state VALUES(369,100,decode(lpad('100',64,'0'),'hex'),1609891200,0,'confirmed',100,'{}',NULL)`,
  );
  await worker.query(
    `INSERT INTO hdd.accounts SELECT 369,decode(lpad(to_hex(i),40,'0'),'hex'),900719925474099300000000::numeric+i,0,0,90,100 FROM generate_series(1,$1::int) i`,
    [accounts],
  );
  await worker.query(
    `INSERT INTO hdd.stakes(chain_id,stake_id,address,origin_chain_id,start_block,start_log,start_day,locked_day,staked_days,principal_hearts,stake_shares,is_auto_stake,lifecycle,end_day,end_block,payout_hearts,penalty_hearts,last_block)
    SELECT 369,i,decode(lpad(to_hex((i-1)%$2::int+1),40,'0'),'hex'),369,90,i,399,400,1+i%5555,
    100000000000::numeric+(i%10000)*100000000::numeric,1000000000000::numeric+(i%10000)*300000007::numeric,false,
    CASE WHEN i%10=0 THEN 'cancelled' ELSE 'unsettled' END,CASE WHEN i%10=0 THEN 399 END,CASE WHEN i%10=0 THEN 91 END,CASE WHEN i%10=0 THEN 0 END,CASE WHEN i%10=0 THEN 0 END,100 FROM generate_series(1,$1::int) i`,
    [count, accounts],
  );
  await worker.query(
    `INSERT INTO hdd.events SELECT 369,90,i,decode(lpad('90',64,'0'),'hex'),decode(lpad(to_hex(i),64,'0'),'hex'),0,1609804801,'stake_start',i,ARRAY[decode(repeat('aa',32),'hex')],'\\x'::bytea,'{}' FROM generate_series(1,$1::int) i`,
    [count],
  );
  await worker.query(
    `INSERT INTO hdd.events SELECT 369,91,i,decode(lpad('91',64,'0'),'hex'),decode(lpad(to_hex(i),64,'0'),'hex'),0,1609804802,'stake_end',i,ARRAY[decode(repeat('bb',32),'hex')],'\\x'::bytea,'{}' FROM generate_series(10,$1::int,10) i`,
    [count],
  );
  if (!large) {
    await worker.query(`UPDATE hdd.stakes SET origin_chain_id=1,start_block=80 WHERE stake_id=1;
      UPDATE hdd.events SET origin_chain_id=1,block_number=80 WHERE stake_id=1;
      UPDATE hdd.stakes SET start_day=400,locked_day=401 WHERE stake_id=2;
      UPDATE hdd.stakes SET start_day=398,locked_day=399,staked_days=1 WHERE stake_id IN(3,4,5);
      UPDATE hdd.stakes SET lifecycle='good_accounted',ga_day=400,ga_block=100,payout_hearts=7,penalty_hearts=2 WHERE stake_id=4;
      UPDATE hdd.stakes SET lifecycle='ended',ga_day=400,ga_block=99,end_day=400,end_block=100,payout_hearts=7,penalty_hearts=2 WHERE stake_id=5;
      INSERT INTO hdd.events VALUES(369,100,5,decode(lpad('100',64,'0'),'hex'),decode(lpad('5',64,'0'),'hex'),0,1609891200,'stake_end',5,ARRAY[decode(repeat('bb',32),'hex')],'\\x'::bytea,'{}');
      INSERT INTO hdd.events VALUES(369,100,4,decode(lpad('100',64,'0'),'hex'),decode(lpad('4',64,'0'),'hex'),0,1609891200,'good_accounting',4,ARRAY[decode(repeat('cc',32),'hex')],'\\x'::bytea,'{}');
      INSERT INTO hdd.events VALUES(369,99,5,decode(lpad('99',64,'0'),'hex'),decode(lpad('5',64,'0'),'hex'),0,1609891200,'good_accounting',5,ARRAY[decode(repeat('cc',32),'hex')],'\\x'::bytea,'{}');`);
  }
  await worker.query(
    `UPDATE hdd.accounts a SET accounted_hearts=s.total,stake_count=s.count FROM (SELECT address,sum(principal_hearts) FILTER(WHERE lifecycle='unsettled') AS total,count(*) AS count FROM hdd.stakes WHERE lifecycle IN('unsettled','good_accounted') GROUP BY address) s WHERE a.address=s.address`,
  );
  await worker.query(
    `INSERT INTO hdd.current_state SELECT 369,400,(SELECT sum(liquid_hearts) FROM hdd.accounts),sum(principal_hearts),sum(principal_hearts),sum(principal_hearts*staked_days),sum(stake_shares),0,$1,(SELECT count(*) FROM hdd.accounts WHERE stake_count>0),100000,0,0,0,0 FROM hdd.stakes WHERE lifecycle='unsettled'`,
    [accounts],
  );
  await worker.query(
    `INSERT INTO hdd.daily_stats(chain_id,contract_day,origin_chain_id,close_block,close_hash,${totalColumns.join(',')}) SELECT 369,d,369,100,decode(lpad('100',64,'0'),'hex'),${totalColumns.map((c) => 's.' + c).join(',')} FROM generate_series(0,399) d CROSS JOIN hdd.current_state s WHERE s.chain_id=369`,
  );
  await worker.query(
    `UPDATE hdd.daily_stats SET payout_status='materialized',payout_hearts=CASE WHEN contract_day%2=0 THEN 1 ELSE 2 END,payout_shares=CASE WHEN contract_day%2=0 THEN 30000 ELSE 70000 END,payout_block=100,payout_hash=close_hash WHERE contract_day>=370`,
  );
  await configureMarket(worker, 369, 'fixture-venue', 'source-reported', 398);
  await importMarketBars(
    worker,
    {
      chain: 369,
      source: 'fixture-venue',
      bars: [398, 399].map((d) => ({
        time: 1575331200 + d * 86400,
        revision: '0',
        open: '0.1',
        high: '0.2',
        low: '0.05',
        close: '0.15',
        volume: null,
        liquidity: null,
      })),
    },
    at / 1000,
    signal,
  );
  await finalizeMarkets(worker, 369, 399, signal);
  await rankAccounts(worker, 369, signal);
  await admin.query('ANALYZE');
  return { count, accounts };
}
