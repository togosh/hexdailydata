import type pg from 'pg';
import { HomeResponseSchema, StatusResponseSchema, type ChainKey } from '../../contracts/api.ts';
import { dayStartSeconds, contractDayAt } from '../../domain/day.ts';
import { displayRatio, formatUnits, payoutHexPerTShare } from '../../domain/units.ts';
import { stakedPercent } from '../../domain/stake.ts';
import { age, unavailable } from '../live/observations.ts';
import { observationStatus } from '../../domain/freshness.ts';
import { metricKeys, type Metric } from '../../worker/metrics/store.ts';
import type { ReadDatabase } from './database.ts';

export const chainId = (chain: ChainKey) => (chain === 'pulsechain' ? 369 : 1);
export const timestamp = (s: string) => new Date(Number(s) * 1000).toISOString();
export const hex = (b: Buffer) => '0x' + b.toString('hex');
export const date = (d: number) => timestamp(dayStartSeconds(d).toString()).slice(0, 10);
export const block = (r: Record<string, any>) => ({
  chainId: r.chain_id,
  blockNumber: r.block_number,
  blockHash: hex(r.block_hash),
  blockTimestamp: timestamp(r.block_time),
});
export const cutoff = (r: Record<string, any>) => ({
  asOf: block(r),
  revision: r.revision,
  finality: r.finality,
  contractDay: r.contract_day,
});
export function headline(r: Record<string, any>) {
  const percent = stakedPercent(BigInt(r.circulating_hearts), BigInt(r.locked_hearts));
  return {
    dateUtc: date(r.contract_day),
    contractDay: r.contract_day,
    displayDay: r.contract_day + 1,
    asOf: {
      chainId: r.origin_chain_id,
      blockNumber: r.close_block,
      blockHash: hex(r.close_hash),
      blockTimestamp: r.close_time == null ? null : timestamp(r.close_time),
    },
    stakedPercent: percent ? displayRatio(percent) : null,
    weightedStakeLengthDays:
      BigInt(r.accounted_hearts) === 0n
        ? null
        : displayRatio({
            numerator: BigInt(r.weighted_days),
            denominator: BigInt(r.accounted_hearts),
          }),
    circulatingHex: formatUnits(BigInt(r.circulating_hearts), 8),
    stakedHex: formatUnits(BigInt(r.locked_hearts), 8),
    holderCount: r.holder_count,
    stakerCount: r.staker_count,
  };
}
export function dailyRow(r: Record<string, any>) {
  return {
    ...headline(r),
    originChainId: r.origin_chain_id,
    circulatingHearts: r.circulating_hearts,
    lockedHearts: r.locked_hearts,
    rawShareRate: r.raw_share_rate,
    payout: {
      status: r.payout_status,
      payoutHearts: r.payout_hearts,
      stakeShares: r.payout_shares,
      hexPerTShare:
        r.payout_status === 'materialized' && BigInt(r.payout_shares) > 0n
          ? displayRatio(payoutHexPerTShare(BigInt(r.payout_hearts), BigInt(r.payout_shares)))
          : null,
      blockNumber: r.payout_block,
      blockHash: r.payout_hash == null ? null : hex(r.payout_hash),
    },
  };
}
export function metrics(raw: Record<string, unknown> | null, chain: ChainKey, now: number) {
  const schema = HomeResponseSchema.shape.live;
  return schema.parse(
    Object.fromEntries(
      metricKeys.map((key) => {
        const parsed = schema.shape[key].safeParse(raw?.[key]);
        let value = parsed.success
          ? parsed.data
          : unavailable(key, raw?.[key] ? 'invalid_observation' : 'not_observed');
        if (value.asOf?.chainId !== undefined && value.asOf.chainId !== chainId(chain))
          value = unavailable(key, 'source_chain_mismatch');
        if (
          key === 'todayPayoutEstimate' &&
          value.value &&
          typeof value.value === 'object' &&
          'contractDay' in value.value &&
          value.value.contractDay !== contractDayAt(BigInt(Math.floor(now / 1000)))
        )
          value = { ...value, status: 'unavailable', value: null, reason: 'estimate_day_expired' };
        return [key, age(value, now, key === 'todayPayoutEstimate')];
      }),
    ),
  );
}
const currentColumns = [
  'contract_day',
  'circulating_hearts',
  'locked_hearts',
  'accounted_hearts',
  'weighted_days',
  'holder_count',
  'staker_count',
  'starts',
  'ends',
  'penalty_hearts',
];
function currentHeadline(r: Record<string, any>, chain: ChainKey) {
  if (r.current_contract_day == null || r.sync_block == null) return null;
  const values = Object.fromEntries(currentColumns.map((key) => [key, r['current_' + key]]));
  const difference = (key: string) =>
    r.previous_day == null ? null : (BigInt(values[key]) - BigInt(r['previous_' + key])).toString();
  const netLocked = difference('locked_hearts');
  const signedHex =
    netLocked == null
      ? null
      : (netLocked.startsWith('-') ? '-' : '') + formatUnits(BigInt(netLocked.replace('-', '')), 8);
  return {
    ...headline({
      ...values,
      origin_chain_id: chainId(chain),
      close_block: r.sync_block,
      close_hash: r.sync_hash,
      close_time: r.sync_time,
    }),
    finality: r.sync_finality,
    activity: {
      newStakes: values.starts,
      endedStakes: values.ends,
      netHolders: difference('holder_count'),
      netStakers: difference('staker_count'),
      netLockedHex: signedHex,
      penaltiesHex: formatUnits(BigInt(values.penalty_hearts), 8),
    },
  };
}
// One current/sync row, latest daily and exact prior-day baseline, four metrics.
// Prior-day absence is unknown, never an implicit zero or an older-day comparison.
export const homeSql = `SELECT d.*, h.timestamp AS close_time,
 s.block_number AS sync_block,s.block_time AS sync_time,s.block_hash AS sync_hash,s.finality AS sync_finality,
 ${currentColumns.map((key) => `c.${key} AS current_${key}`).join(',')},
 previous.contract_day AS previous_day,previous.holder_count AS previous_holder_count,
 previous.staker_count AS previous_staker_count,previous.locked_hearts AS previous_locked_hearts,
 sh.start_block AS history_start,
 (SELECT jsonb_object_agg(metric,observation) FROM hdd.live_metrics WHERE chain_id=$1) AS metrics
 FROM (VALUES(1)) anchor(n)
 LEFT JOIN hdd.sync_state s ON s.chain_id=$1
 LEFT JOIN hdd.current_state c ON c.chain_id=$1
 LEFT JOIN hdd.daily_stats previous ON previous.chain_id=$1 AND previous.contract_day=c.contract_day-1
 LEFT JOIN hdd.source_history sh ON sh.chain_id=$1
 LEFT JOIN LATERAL (SELECT * FROM hdd.daily_stats WHERE chain_id=$1 ORDER BY contract_day DESC LIMIT 1) d ON true
 LEFT JOIN hdd.blocks_recent h ON h.chain_id=d.origin_chain_id AND h.number=d.close_block`;
export async function home(
  db: ReadDatabase,
  chain: ChainKey,
  signal: AbortSignal,
  now: number,
  mode: 'development' | 'production' = 'development',
) {
  return db.read(signal, async (c) => {
    db.counters.dataQueries++;
    const {
      rows: [r],
    } = await c.query(homeSql, [chainId(chain)]);
    return HomeResponseSchema.parse({
      schemaVersion: 1,
      chain,
      mode,
      daily: r.contract_day == null ? null : headline(r),
      current: currentHeadline(r, chain),
      live: metrics(r.metrics, chain, now),
      sync: {
        state:
          r.sync_block == null
            ? 'uninitialized'
            : r.history_start !== null &&
                observationStatus(BigInt(r.sync_time), BigInt(Math.floor(now / 1000))) === 'fresh'
              ? 'current'
              : 'syncing',
        message: r.sync_block == null ? 'Native index unavailable for this chain.' : null,
      },
    });
  });
}
export async function readCutoff(c: pg.Client, chain: ChainKey) {
  const {
    rows: [r],
  } = await c.query(
    'SELECT s.*,c.contract_day FROM hdd.sync_state s JOIN hdd.current_state c USING(chain_id) WHERE chain_id=$1',
    [chainId(chain)],
  );
  return r ? cutoff(r) : null;
}
export async function status(
  db: ReadDatabase | undefined,
  chain: ChainKey,
  signal: AbortSignal,
  now: number,
  live = false,
  mode: 'development' | 'production' = 'development',
) {
  let database: 'ready' | 'unavailable' | 'unconfigured' = db ? 'unavailable' : 'unconfigured';
  let streams: any[] = [];
  let observations: any[] = [],
    marketStatus: any[] = [];
  if (db)
    try {
      streams = await db.read(
        signal,
        async (c) => {
          const { rows } = await c.query(
            `SELECT s.*,h.start_block,d.contract_day AS daily_day FROM hdd.sync_state s LEFT JOIN hdd.source_history h USING(chain_id)
           LEFT JOIN LATERAL (SELECT contract_day FROM hdd.daily_stats WHERE chain_id=s.chain_id ORDER BY contract_day DESC LIMIT 1) d ON true
           ORDER BY s.chain_id LIMIT 2`,
          );
          const { rows: current } = await c.query(
            'SELECT chain_id,metric,observation FROM hdd.live_metrics ORDER BY chain_id,metric LIMIT 8',
          );
          observations = current.map((r) => {
            const key = r.chain_id === 369 ? 'pulsechain' : 'ethereum';
            const value = metrics({ [r.metric]: r.observation }, key, now)[r.metric as Metric];
            return {
              chain: key,
              metric: r.metric,
              status: value.status,
              asOf: value.asOf,
              observedAt: value.observedAt,
            };
          });
          const { rows: sources } = await c.query(
            'SELECT chain_id,source,from_day,through_day,dirty_day,capture_status FROM hdd.market_sources ORDER BY chain_id,source LIMIT 8',
          );
          marketStatus = sources.map((r) => ({
            chain: r.chain_id === 369 ? 'pulsechain' : 'ethereum',
            source: r.source,
            fromDay: r.from_day,
            throughDay: r.through_day,
            dirtyDay: r.dirty_day,
            state: r.capture_status,
          }));
          return rows.map((r) => ({
            chain: r.chain_id === 369 ? 'pulsechain' : 'ethereum',
            asOf: block(r),
            revision: r.revision,
            finality: r.finality,
            freshness: observationStatus(BigInt(r.block_time), BigInt(Math.floor(now / 1000))),
            fromBlock: r.start_block,
            rewindFloor: r.rewind_floor,
            rankingDay: r.ranking_day,
            dailyThroughDay: r.daily_day,
          }));
        },
        true,
      );
      database = 'ready';
    } catch {
      /* Public status never exposes connection errors. */
    }
  const own = streams.find((s) => s.chain === chain);
  return StatusResponseSchema.parse({
    mode,
    chain,
    state:
      database === 'unavailable'
        ? 'degraded'
        : !own
          ? 'uninitialized'
          : own.fromBlock !== null && own.freshness === 'fresh'
            ? 'current'
            : 'syncing',
    productionReady: false,
    chainSyncImplemented: true,
    liveProvidersEnabled: live,
    database,
    qualification: 'offline_only_live_not_qualified',
    streams,
    observations,
    markets: marketStatus,
  });
}
