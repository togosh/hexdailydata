// Fresh, run-owned SQL only. Ordinary synthetic history; no provider or retained owner input.
import assert from 'node:assert/strict';
import { writeFileSync } from 'node:fs';
import pg from 'pg';
import { connect, databaseConfig } from '../../dist/db/connect.js';
import { migrateCurrent } from '../../dist/db/migrate.js';
import { inspectInput } from '../../dist/worker/history/input.js';
import { importHistory } from '../../dist/worker/history/store.js';
import { populate } from '../api/fixture.mjs';
import { rawRow, selection } from '../history/fixture.mjs';
const mode = process.argv[2];
assert.equal(process.env.HDD_V2_ALLOW_LIVE_RPC, 'false');
assert.match(process.env.HDD_V2_PROJECT, /^hexdailydata-v2-web-/);
const at = Date.parse('2026-09-19T12:00:00Z'),
  day = Math.floor((at / 1000 - 1575331200) / 86400);
const first = day - 1228;
if (mode === 'archive') {
  const m = await connect(databaseConfig('migrator'));
  await migrateCurrent(m);
  await m.end();
}
const worker = await connect(databaseConfig('worker'));
try {
  if (mode === 'archive') {
    const rows = Array.from({ length: 1228 }, (_, i) => {
      const locked = 590000000000n + BigInt(i) * 25000000n,
        circulating = 56000000000n - BigInt(i) * 1000000n;
      return rawRow(first + i, {
        circulatingHEX: circulating.toString(),
        stakedHEX: locked.toString(),
        stakedHEXGA: '21000000000',
        totalHEX: (locked + circulating).toString(),
        tshareRateHEX: (25000 + i * 18).toString(),
        totalTshares: (40000000 + i * 1700).toString(),
        payoutPerTshareHEX: (5.3 + Math.sin(i / 53) * 0.2 + Math.sin(i / 11) * 0.025).toFixed(4),
        dailyPayoutHEX: '230000000',
        averageStakeLength: i === 1227 ? null : `${7 + Math.floor(i / 50) / 10}`,
        penaltiesHEX: String(750000 + ((i * 137123) % 3000000)),
        stakedHEXPercent: ((locked * 10000n) / (locked + circulating) / 100n).toString(),
        currentHolders: String(285000 + i * 19),
        currentStakerCount: String(95000 + i * 8),
        numberOfHolders: '900000',
        totalStakerCount: '250000',
        pricePulseX:
          i === 1210
            ? null
            : (
                (1200 +
                  Math.floor(i / 4) +
                  Math.round(Math.sin(i / 31) * 400) +
                  Math.round(Math.sin(i / 7) * 90)) /
                1000000
              ).toFixed(6),
      });
    }).filter((_, i) => i !== 750);
    const bytes = Buffer.from(JSON.stringify(rows));
    const input = inspectInput(
      bytes,
      selection(bytes, {
        fromSourceDay: first,
        toSourceDay: day - 1,
        fromDate: rows[0].date.slice(0, 10),
        toDate: rows.at(-1).date.slice(0, 10),
      }),
    );
    await importHistory(worker, input, new AbortController().signal);
    const expiredPrice = {
      status: 'fresh',
      value: { usdPerHex: '0.99', valuation: 'peg_assumed', kind: 'spot_estimate' },
      asOf: {
        chainId: 369,
        blockNumber: '100',
        blockHash: '0x' + 'aa'.repeat(32),
        blockTimestamp: '2026-09-18T00:00:00.000Z',
      },
      observedAt: '2026-09-18T00:00:01.000Z',
      finality: 'provisional',
      method: 'synthetic-expired-price',
      notes: ['Offline expiry fixture; not a provider observation.'],
    };
    await worker.query("INSERT INTO hdd.live_metrics VALUES(369,'price',$1::jsonb,'{}')", [
      JSON.stringify(expiredPrice),
    ]);
    writeFileSync(
      '/evidence/charts-fixture.json',
      JSON.stringify(
        {
          at,
          day,
          first,
          records: 1227,
          provenance:
            'SYNTHETIC ordinary presentation; one date gap and one missing price. Native projection fixture added in next phase.',
          liveRequests: 0,
        },
        null,
        2,
      ),
    );
  } else if (mode === 'both') {
    const admin = new pg.Client({
      host: 'db',
      database: 'hexdailydata_v2',
      user: 'hdd_v2_admin',
      password: process.env.HDD_V2_ADMIN_PASSWORD,
    });
    await admin.connect();
    try {
      await populate(worker, admin);
      await worker.query(
        `UPDATE hdd.stakes SET start_day=$1-100,locked_day=$1-99,staked_days=120+stake_id*12,
        principal_hearts=stake_id*1250000000000::numeric,stake_shares=stake_id*4000000000000::numeric WHERE lifecycle='unsettled'`,
        [day],
      );
      await worker.query('UPDATE hdd.current_state SET contract_day=$1', [day]);
      await worker.query('UPDATE hdd.sync_state SET block_time=$1', [at / 1000 - 120]);
      await worker.query('DELETE FROM hdd.daily_stats');
      await worker.query(
        `INSERT INTO hdd.daily_stats(chain_id,contract_day,origin_chain_id,close_block,close_hash,circulating_hearts,locked_hearts,accounted_hearts,weighted_days,active_shares,queued_shares,holder_count,staker_count,raw_share_rate,starts,ends,payout_recorded,penalty_hearts,payout_status,payout_hearts,payout_shares,payout_block,payout_hash)
        SELECT 369,d,369,100,decode(lpad('100',64,'0'),'hex'),(56000000000::numeric-(d-$1)*1000000)*1e8,
        (590000000000::numeric+(d-$1)::numeric*25000000)*1e8,(569000000000::numeric+(d-$1)::numeric*25000000)*1e8,
        (569000000000::numeric+(d-$1)::numeric*25000000)*1e8*(2500+(d-$1)/2),42000000::numeric*1e12,0,
        285000+(d-$1)*19,95000+(d-$1)*8,250000+(d-$1)*180,
        900+(d*17)%1200,300+(d*13)%400,0,(750000+(d*137123)%3000000)::numeric*1e8,
        'materialized',(222600000+round(sin((d-$1)/53.0)*8400000)+round(sin((d-$1)/11.0)*1050000))::numeric*1e8,42000000::numeric*1e12,100,decode(lpad('100',64,'0'),'hex')
        FROM generate_series($1::int,$2::int) d`,
        [first, day - 1],
      );
      await admin.query('ANALYZE');
    } finally {
      await admin.end();
    }
  } else if (mode === 'native') {
    await worker.query('DELETE FROM hdd.history_daily');
    await worker.query('DELETE FROM hdd.history_source');
  } else if (mode === 'later') {
    await worker.query(
      "DELETE FROM hdd.stakes WHERE lifecycle='unsettled' AND locked_day+staked_days <= $1+90",
      [day],
    );
  } else if (mode === 'none') {
    await worker.query("DELETE FROM hdd.stakes WHERE lifecycle='unsettled'");
  } else throw new Error('Unknown fixture mode.');
  console.log('PASS synthetic chart fixture phase', mode);
} finally {
  await worker.end();
}
