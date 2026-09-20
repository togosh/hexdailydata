// Explicit SYNTHETIC presentation fixture, applied only to this run's existing
// disposable native test DB after the original extreme-boundary journey finishes.
import assert from 'node:assert/strict';
import { writeFileSync } from 'node:fs';
import { connect, databaseConfig } from '../../dist/db/connect.js';
import { totalColumns } from '../../src/services/projections/reduce.ts';
import { rankAccounts } from '../../dist/worker/daily/ranking.js';
import { MetricsService } from '../../dist/worker/metrics/service.js';
import { SqlMetricStore } from '../../dist/worker/metrics/store.js';
import { PriceReader } from '../../dist/services/live/price.js';
import { ReadDatabase } from '../../dist/services/queries/database.js';
import { home } from '../../dist/services/queries/home.js';
import { fixture, CODE_HASH, HEX, ANCHOR } from '../live/fixture.mjs';
assert.equal(process.env.HDD_V2_ALLOW_LIVE_RPC, 'false');
assert.match(process.env.HDD_V2_PROJECT, /^hexdailydata-v2-web-/);
const at = Date.parse('2026-09-19T12:00:00.000Z');
const day = Math.floor((at / 1000 - 1575331200) / 86400);
const signal = new AbortController().signal;
const worker = await connect(databaseConfig('worker'));
try {
  assert.equal((await worker.query('SELECT count(*)::int n FROM hdd.stakes')).rows[0].n, 120);
  await worker.query('UPDATE hdd.accounts SET liquid_hearts=87000000000000000');
  await worker.query(
    `UPDATE hdd.stakes SET principal_hearts=581500000000000000,
    stake_shares=floor(581500000000000000::numeric*100000/466866)`,
  );
  await worker.query(
    `UPDATE hdd.stakes SET start_day=$1,locked_day=$1+1,staked_days=3562+stake_id%3 WHERE lifecycle='unsettled'`,
    [day - 2000],
  );
  await worker.query(
    `UPDATE hdd.stakes SET start_day=$1-4,locked_day=$1-3,staked_days=1,
    ga_day=CASE WHEN ga_day IS NOT NULL THEN $1-1 END,
    end_day=CASE WHEN lifecycle='cancelled' THEN $1-4 WHEN end_day IS NOT NULL THEN $1-1 END WHERE lifecycle<>'unsettled'`,
    [day],
  );
  await worker.query(`UPDATE hdd.accounts a SET accounted_hearts=coalesce(s.total,0),stake_count=s.count
    FROM (SELECT address,sum(principal_hearts) FILTER(WHERE lifecycle='unsettled') total,count(*) count
    FROM hdd.stakes WHERE lifecycle IN('unsettled','good_accounted') GROUP BY address) s WHERE a.address=s.address`);
  await worker.query(`UPDATE hdd.current_state SET
    circulating_hearts=(SELECT sum(liquid_hearts) FROM hdd.accounts),
    locked_hearts=(SELECT sum(principal_hearts) FROM hdd.stakes WHERE lifecycle IN('unsettled','good_accounted')),
    accounted_hearts=(SELECT sum(principal_hearts) FROM hdd.stakes WHERE lifecycle='unsettled'),
    weighted_days=(SELECT sum(principal_hearts*staked_days) FROM hdd.stakes WHERE lifecycle='unsettled'),
    active_shares=(SELECT sum(stake_shares) FROM hdd.stakes WHERE lifecycle='unsettled'),
    queued_shares=0,raw_share_rate=466866`);
  const current = (await worker.query('SELECT * FROM hdd.current_state')).rows[0];
  const shares = BigInt(current.active_shares);
  const payout = (shares * 1654n) / 10000000n;
  await worker.query(`UPDATE hdd.daily_stats d SET ${totalColumns.map((c) => `${c}=s.${c}`).join(',')}
    FROM hdd.current_state s WHERE d.chain_id=s.chain_id`);
  // A coherent synthetic 30-day payout series; never supplied by production startup.
  const shape = [
    1654, 1662, 1648, 1660, 1681, 1658, 1642, 1637, 1651, 1640, 1632, 1655, 1661, 1673, 1692, 1684,
    1712, 1724, 1815, 1730, 1694, 1701, 1680, 1671, 1658, 1669, 1692, 1681, 1665, 1654,
  ];
  for (let i = 0; i < shape.length; i++) {
    await worker.query(
      'UPDATE hdd.daily_stats SET payout_hearts=$1,payout_shares=$2 WHERE contract_day=$3',
      [((shares * BigInt(shape[i])) / 10000000n).toString(), shares.toString(), day - 30 + i],
    );
  }
  const raw = fixture();
  Object.assign(raw.state, {
    dayCount: day,
    shares,
    nextShares: 0n,
    penalty: 0n,
    supply: BigInt(current.circulating_hearts),
    locked: BigInt(current.locked_hearts),
    shareRate: 466866n,
    dailyPayoutHearts: payout,
    dailyPayoutShares: shares,
    update: BigInt(at / 1000 - 90),
    reserves: { [HEX]: 1000000000n * 100000000n, [ANCHOR]: 3876000n * 1000000n },
  });
  raw.clock.time = at - 60000;
  await new MetricsService(
    [raw.rpc('one'), raw.rpc('two')],
    CODE_HASH,
    new PriceReader(raw.price, HEX),
    new SqlMetricStore(worker),
  ).tick(signal);
  await rankAccounts(worker, 369, signal);
  const invariant = (
    await worker.query(`SELECT
    s.circulating_hearts=(SELECT sum(liquid_hearts) FROM hdd.accounts) liquid,
    s.accounted_hearts=(SELECT sum(accounted_hearts) FROM hdd.accounts) accounted,
    s.active_shares=(SELECT sum(stake_shares) FROM hdd.stakes WHERE lifecycle='unsettled') shares,
    s.weighted_days=(SELECT sum(principal_hearts*staked_days) FROM hdd.stakes WHERE lifecycle='unsettled') weighted
    FROM hdd.current_state s`)
  ).rows[0];
  assert.ok(Object.values(invariant).every(Boolean));
  const reads = new ReadDatabase(databaseConfig('api'));
  const expected = await home(reads, 'pulsechain', signal, at, 'production');
  await reads.close();
  assert.equal(expected.live.price.value.usdPerHex, '0.003876');
  assert.equal(expected.live.latestCompletedPayout.value.payoutHearts, payout.toString());
  assert.ok(Object.values(expected.live).every((r) => r.status === 'fresh'));
  writeFileSync(
    '/evidence/visual-fixture.json',
    JSON.stringify(
      {
        scenario:
          'SYNTHETIC realistic-magnitude native presentation; 120 stakes / 60 accounts, not current chain values',
        at,
        invariant,
        current,
        expected,
        homeBytes: Buffer.byteLength(JSON.stringify(expected)),
        liveRequests: 0,
      },
      null,
      2,
    ),
  );
  console.log(
    'PASS coherent SYNTHETIC visual fixture; compiled metrics and SQL Home; invariants',
    invariant,
  );
} finally {
  await worker.end();
}
