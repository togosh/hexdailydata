import type pg from 'pg';
import contract from '../../contracts/datasets.json' with { type: 'json' };
import { dayStartSeconds } from '../../domain/day.ts';
import {
  displayRatio,
  formatUnits,
  hexPerTShareBeforeBonuses,
  payoutHexPerTShare,
} from '../../domain/units.ts';
import { stakedPercent } from '../../domain/stake.ts';
import { marketObservationSchema } from '../daily/market.ts';

export const datasets = ['daily', 'stakes', 'holders', 'maturities', 'markets'] as const;
export type Dataset = (typeof datasets)[number];
export const definitions = Object.fromEntries(contract.datasets.map((d) => [d.name, d])) as Record<
  Dataset,
  (typeof contract.datasets)[number]
>;
export const date = (day: number) =>
  new Date(Number(dayStartSeconds(day)) * 1000).toISOString().slice(0, 10);
const timestamp = (seconds: string) => new Date(Number(seconds) * 1000).toISOString();
const hex = (value: string | null) => (value === null ? null : formatUnits(BigInt(value), 8));
const shares = (value: string) => formatUnits(BigInt(value), 12);
const ratio = (n: string, d: string, dp = 8) =>
  BigInt(d) === 0n ? null : displayRatio({ numerator: BigInt(n), denominator: BigInt(d) }, dp);
export const datasetQueries: Record<Dataset, string> = {
  daily: `SELECT * FROM hdd.daily_stats WHERE chain_id=$1 ORDER BY contract_day`,
  stakes: `SELECT s.*,c.contract_day,start.block_time AS started_time,finish.block_time AS ended_time
    FROM hdd.stakes s JOIN hdd.current_state c USING(chain_id) JOIN hdd.chains lineage USING(chain_id)
    LEFT JOIN hdd.events start ON start.origin_chain_id=s.origin_chain_id AND start.block_number=s.start_block AND start.log_index=s.start_log AND start.kind='stake_start'
    LEFT JOIN hdd.events finish ON finish.origin_chain_id=CASE WHEN s.chain_id=369 AND s.end_block>lineage.parent_block THEN 369 ELSE 1 END
      AND finish.stake_id=s.stake_id AND finish.block_number=s.end_block AND finish.kind='stake_end'
    WHERE s.chain_id=$1 ORDER BY s.stake_id`,
  holders: `SELECT a.*,r.liquid_rank,r.staker_rank,s.ranking_day FROM hdd.accounts a
    JOIN hdd.sync_state s USING(chain_id) LEFT JOIN hdd.account_ranks r USING(chain_id,address)
    WHERE a.chain_id=$1 AND (a.liquid_hearts>0 OR a.accounted_hearts>0) ORDER BY a.address`,
  maturities: `SELECT locked_day+staked_days AS day,count(*)::text AS count,
    sum(principal_hearts)::text AS principal,sum(stake_shares)::text AS shares
    FROM hdd.stakes s JOIN hdd.current_state c USING(chain_id) WHERE s.chain_id=$1
      AND lifecycle='unsettled' AND locked_day+staked_days>c.contract_day
    GROUP BY locked_day+staked_days ORDER BY day`,
  markets: `SELECT d.*,s.method FROM hdd.market_daily d JOIN hdd.market_sources s USING(chain_id,source)
    WHERE d.chain_id=$1 ORDER BY contract_day,source`,
};
/** Shared query/serialization boundary; native amounts are already reduced by the writer. */
export function datasetRow(name: Dataset, r: Record<string, any>): (string | number | null)[] {
  switch (name) {
    case 'daily': {
      const percent = stakedPercent(BigInt(r.circulating_hearts), BigInt(r.locked_hearts));
      return [
        date(r.contract_day),
        r.contract_day + 1,
        r.origin_chain_id,
        r.payout_status === 'materialized' && BigInt(r.payout_shares) > 0n
          ? displayRatio(payoutHexPerTShare(BigInt(r.payout_hearts), BigInt(r.payout_shares)), 12)
          : null,
        r.payout_status,
        displayRatio(hexPerTShareBeforeBonuses(BigInt(r.raw_share_rate)), 12),
        percent ? displayRatio(percent) : null,
        ratio(r.weighted_days, r.accounted_hearts),
        hex(r.circulating_hearts),
        hex(r.locked_hearts),
        r.holder_count,
        r.staker_count,
        r.starts,
        r.ends,
        hex(r.penalty_hearts),
      ];
    }
    case 'stakes':
      if (r.started_time === null || (r.end_block !== null && r.ended_time === null))
        throw new Error('Missing retained lifecycle event timestamp.');
      return [
        r.stake_id,
        '0x' + r.address.toString('hex'),
        hex(r.principal_hearts),
        shares(r.stake_shares),
        r.locked_day,
        r.staked_days,
        timestamp(dayStartSeconds(r.locked_day + r.staked_days).toString()),
        r.lifecycle !== 'unsettled'
          ? r.lifecycle
          : r.contract_day < r.locked_day
            ? 'queued'
            : r.contract_day < r.locked_day + r.staked_days
              ? 'open'
              : 'mature_open',
        timestamp(r.started_time),
        r.ended_time === null ? null : timestamp(r.ended_time),
        hex(r.payout_hearts),
        hex(r.penalty_hearts),
        r.origin_chain_id,
      ];
    case 'holders':
      return [
        '0x' + r.address.toString('hex'),
        hex(r.liquid_hearts),
        hex(r.accounted_hearts),
        hex((BigInt(r.liquid_hearts) + BigInt(r.accounted_hearts)).toString()),
        r.stake_count,
        r.liquid_rank,
        r.staker_rank,
        r.ranking_day === null ? null : date(r.ranking_day),
      ];
    case 'maturities':
      return [date(r.day), r.day + 1, r.count, hex(r.principal), shares(r.shares)];
    case 'markets': {
      const o = marketObservationSchema.parse(r.observation);
      return [
        date(r.contract_day),
        ...[o.open, o.high, o.low, o.close].map((p) =>
          p ? ratio(p.numerator, p.denominator, 24) : null,
        ),
        o.volume === null ? null : formatUnits(BigInt(o.volume), 24),
        o.liquidity === null ? null : formatUnits(BigInt(o.liquidity), 24),
        r.source,
        r.method,
        o.coverage,
      ];
    }
  }
}
export function csvLine(
  values: readonly (string | number | null)[],
  numericColumns: ReadonlySet<number> = new Set(),
) {
  return (
    values
      .map((v, index) => {
        if (v === null) return '';
        let s = String(v);
        const numeric =
          numericColumns.has(index) && /^-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d{1,3})?$/.test(s);
        if (!numeric && /^[=+@\-\t\r]/.test(s)) s = "'" + s;
        return /[",\r\n]/.test(s) ? '"' + s.replaceAll('"', '""') + '"' : s;
      })
      .join(',') + '\n'
  );
}
export async function* datasetRows(
  client: pg.Client,
  name: Dataset,
  chain: 1 | 369,
  signal: AbortSignal,
) {
  await client.query(`DECLARE export_rows NO SCROLL CURSOR FOR ${datasetQueries[name]}`, [chain]);
  try {
    for (;;) {
      signal.throwIfAborted();
      const { rows } = await client.query('FETCH FORWARD 256 FROM export_rows');
      if (!rows.length) break;
      for (const row of rows) {
        signal.throwIfAborted();
        yield datasetRow(name, row);
      }
    }
  } finally {
    await client.query('CLOSE export_rows').catch(() => {});
  }
}
