import {
  ArchiveChartsSchema,
  NativeChartsSchema,
  MaturitiesSchema,
  archiveChartFields,
} from '../../contracts/charts.ts';
import { historyLimit } from '../../contracts/history.ts';
import { contractDayAt } from '../../domain/day.ts';
import { displayRatio, formatUnits, hexPerTShareBeforeBonuses } from '../../domain/units.ts';
import { unavailable } from '../../api/errors.ts';
import { dailyRow, date, readCutoff } from './home.ts';
import type { ReadDatabase } from './database.ts';

export async function archiveCharts(db: ReadDatabase, signal: AbortSignal) {
  return db.read(
    signal,
    async (c) => {
      const {
        rows: [source],
      } = await c.query(
        "SELECT revision,metadata FROM hdd.history_source WHERE source='hexdailystats'",
      );
      if (!source) throw unavailable();
      // One bounded scan shared by every reported chart. Original tokens/statuses remain in /daily.
      const fields = archiveChartFields.map((field) =>
        field === 'price'
          ? "payload->'referencePriceUsd'->'value'"
          : `payload->'metrics'->'${field}'->'value'`,
      );
      const { rows } =
        await c.query(`SELECT source_day AS day,to_char(record_date,'YYYY-MM-DD') AS date,
      jsonb_build_array(${fields.join(',')}) AS values FROM hdd.history_daily
      WHERE source='hexdailystats' ORDER BY record_date,source_day LIMIT ${historyLimit + 1}`);
      return ArchiveChartsSchema.parse({
        chain: 'pulsechain',
        source: 'hexdailystats',
        ...source,
        items: rows,
      });
    },
    true,
  );
}

export async function nativeCharts(db: ReadDatabase, signal: AbortSignal, now: number) {
  return db.read(
    signal,
    async (c) => {
      const cutoff = await readCutoff(c, 'pulsechain');
      if (!cutoff) throw unavailable();
      const { rows } = await c.query(
        `SELECT * FROM hdd.daily_stats WHERE chain_id=369
      AND contract_day<$1 ORDER BY contract_day DESC LIMIT ${historyLimit + 1}`,
        [Math.min(cutoff.contractDay, contractDayAt(BigInt(Math.floor(now / 1000))))],
      );
      return NativeChartsSchema.parse({
        chain: 'pulsechain',
        source: 'native',
        cutoff,
        truncated: rows.length > historyLimit,
        items: rows
          .slice(0, historyLimit)
          .reverse()
          .map((r) => {
            const d = dailyRow(r);
            return {
              day: d.contractDay,
              date: d.dateUtc,
              originChainId: d.originChainId,
              values: [
                d.payout.hexPerTShare,
                displayRatio(hexPerTShareBeforeBonuses(BigInt(d.rawShareRate))),
                d.stakedHex,
                d.stakedPercent,
                d.weightedStakeLengthDays,
                d.stakerCount,
                d.circulatingHex,
                d.holderCount,
                d.activity.newStakes,
                d.activity.endedStakes,
                d.activity.penaltiesHex,
              ],
            };
          }),
      });
    },
    true,
  );
}

// Same future/unsettled inclusion as the accepted maturities export; GA is not upcoming.
export const maturitiesSql = `SELECT locked_day+staked_days AS day,count(*)::text AS count,
  sum(principal_hearts)::text AS principal_hearts,sum(stake_shares)::text AS stake_shares
  FROM hdd.stakes WHERE chain_id=369 AND lifecycle='unsettled'
  AND locked_day+staked_days>$1 AND locked_day+staked_days<=$1+5556
  GROUP BY locked_day+staked_days ORDER BY day LIMIT 5556`;
export async function maturities(db: ReadDatabase, signal: AbortSignal) {
  return db.read(
    signal,
    async (c) => {
      const cutoff = await readCutoff(c, 'pulsechain');
      if (!cutoff) throw unavailable();
      const { rows } = await c.query(maturitiesSql, [cutoff.contractDay]);
      return MaturitiesSchema.parse({
        chain: 'pulsechain',
        cutoff,
        items: rows.map((r) => ({
          day: r.day,
          date: date(r.day),
          principalHearts: r.principal_hearts,
          stakeShares: r.stake_shares,
          count: r.count,
        })),
      });
    },
    true,
  );
}
