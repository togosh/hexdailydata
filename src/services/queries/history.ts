import type { z } from 'zod';
import type { ChainKey } from '../../contracts/api.ts';
import {
  DailyResponseSchema,
  MarketResponseSchema,
  CalculatorResponseSchema,
  type RangeQuery,
  type MarketQuery,
} from '../../contracts/reads.ts';
import { contractDayAt } from '../../domain/day.ts';
import { payoutPreset } from '../../domain/payout.ts';
import { displayRatio } from '../../domain/units.ts';
import type { ReadDatabase } from './database.ts';
import { unavailable } from '../../api/errors.ts';
import { chainId, dailyRow, date, metrics, readCutoff } from './home.ts';
import { reportedHistory } from '../../worker/history/store.ts';
import { DailyQuery } from '../../contracts/reads.ts';

export function range(q: { from: string; to: string }) {
  return [
    contractDayAt(BigInt(Date.parse(q.from) / 1000)),
    contractDayAt(BigInt(Date.parse(q.to) / 1000)),
  ] as const;
}
export function coverage(fromDay: number, toDay: number, days: number[]) {
  const found = new Set(days);
  const missingDays = Array.from({ length: toDay - fromDay + 1 }, (_, i) => fromDay + i).filter(
    (d) => !found.has(d),
  );
  return { fromDay, toDay, expected: toDay - fromDay + 1, count: found.size, missingDays };
}
export const dailySql = `SELECT d.*,h.timestamp AS close_time FROM hdd.daily_stats d
 LEFT JOIN hdd.blocks_recent h ON h.chain_id=d.origin_chain_id AND h.number=d.close_block
 WHERE d.chain_id=$1 AND d.contract_day BETWEEN $2 AND $3 ORDER BY d.contract_day LIMIT 366`;
export async function daily(db: ReadDatabase, q: z.infer<typeof DailyQuery>, signal: AbortSignal) {
  if (q.source === 'hexdailystats') return reportedHistory(db, q, signal);
  return db.read(
    signal,
    async (c) => {
      const cut = await readCutoff(c, q.chain),
        [from, to] = range(q);
      const { rows } = await c.query(dailySql, [chainId(q.chain), from, to]);
      if (!cut && rows.length === 0) throw unavailable();
      return DailyResponseSchema.parse({
        chain: q.chain,
        cutoff: cut,
        coverage: coverage(
          from,
          to,
          rows.map((r) => r.contract_day),
        ),
        items: rows.map(dailyRow),
      });
    },
    true,
  );
}
export const marketSql = `SELECT d.* FROM hdd.market_daily d WHERE d.chain_id=$1 AND d.source=$2
 AND d.contract_day BETWEEN $3 AND $4 ORDER BY d.contract_day LIMIT 366`;
export async function markets(
  db: ReadDatabase,
  q: z.infer<typeof MarketQuery>,
  signal: AbortSignal,
) {
  return db.read(
    signal,
    async (c) => {
      const [from, to] = range(q);
      const { rows: sources } = await c.query(
        'SELECT * FROM hdd.market_sources WHERE chain_id=$1 AND ($2::text IS NULL OR source=$2) ORDER BY source LIMIT 4',
        [chainId(q.chain), q.source ?? null],
      );
      const items = [];
      if (sources.length === 0) throw unavailable();
      const covers = [];
      for (const s of sources) {
        const { rows } = await c.query(marketSql, [chainId(q.chain), s.source, from, to]);
        items.push(
          ...rows.map((r) => ({
            source: r.source,
            contractDay: r.contract_day,
            displayDay: r.contract_day + 1,
            dateUtc: date(r.contract_day),
            state:
              s.dirty_day !== null && r.contract_day >= s.dirty_day
                ? 'pending_correction'
                : 'accepted',
            observation: r.observation,
          })),
        );
        covers.push({
          ...coverage(
            from,
            to,
            rows
              .filter(
                (r) =>
                  r.observation.coverage !== 'missing' &&
                  (s.dirty_day === null || r.contract_day < s.dirty_day),
              )
              .map((r) => r.contract_day),
          ),
          source: s.source,
        });
      }
      return MarketResponseSchema.parse({
        chain: q.chain,
        sources: sources.map((s) => ({
          source: s.source,
          method: s.method,
          qualification: s.qualification,
          fromDay: s.from_day,
          throughDay: s.through_day,
          dirtyDay: s.dirty_day,
          version: s.version,
          captureStatus: s.capture_status,
        })),
        items,
        coverage: covers,
      });
    },
    true,
  );
}
export async function calculator(
  db: ReadDatabase,
  chain: ChainKey,
  signal: AbortSignal,
  now: number,
) {
  return db.read(
    signal,
    async (c) => {
      const { rows: live } = await c.query(
        "SELECT observation FROM hdd.live_metrics WHERE chain_id=$1 AND metric='shareRate'",
        [chainId(chain)],
      );
      const { rows } = await c.query(
        `SELECT contract_day,payout_status,payout_hearts,payout_shares FROM hdd.daily_stats
      WHERE chain_id=$1 AND contract_day <= (SELECT contract_day FROM hdd.daily_stats WHERE chain_id=$1 AND payout_status='materialized' AND contract_day<$2 ORDER BY contract_day DESC LIMIT 1)
      ORDER BY contract_day DESC LIMIT 365`,
        [chainId(chain), contractDayAt(BigInt(Math.floor(now / 1000)))],
      );
      const last = rows[0]?.contract_day ?? null;
      const presets = ([1, 30, 365] as const).map((window) => {
        const selected =
          last === null ? [] : rows.filter((r) => r.contract_day >= last - window + 1).reverse();
        const result =
          last === null
            ? { status: 'unavailable' as const, value: null, reason: 'missing_days' as const }
            : payoutPreset(
                selected.map((r) => ({
                  contractDay: r.contract_day,
                  status: r.payout_status === 'materialized' ? 'completed' : 'pending',
                  payoutHearts: r.payout_hearts === null ? null : BigInt(r.payout_hearts),
                  stakeShares: r.payout_shares === null ? null : BigInt(r.payout_shares),
                })),
                window,
                last,
                contractDayAt(BigInt(Math.floor(now / 1000))),
              );
        return {
          window,
          fromDay: last === null ? null : last - window + 1,
          toDay: last,
          count: selected.length,
          status: result.status,
          reason: result.status === 'available' ? null : result.reason,
          value: result.value
            ? {
                numerator: result.value.numerator.toString(),
                denominator: result.value.denominator.toString(),
                hexPerTShare: displayRatio(result.value),
              }
            : null,
        };
      });
      const shareRate = metrics({ shareRate: live[0]?.observation }, chain, now).shareRate;
      if (shareRate.value === null && presets.every((p) => p.value === null)) throw unavailable();
      return CalculatorResponseSchema.parse({
        chain,
        calculationVersion: 'hex-native-1',
        shareRate,
        presets,
      });
    },
    true,
  );
}
