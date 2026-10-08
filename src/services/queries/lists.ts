import type { z } from 'zod';
import type { ChainKey } from '../../contracts/api.ts';
import {
  StakeSchema,
  StakesResponseSchema,
  HoldersResponseSchema,
  type StakesQuery,
  type HoldersQuery,
} from '../../contracts/reads.ts';
import { unavailable, restart } from '../../api/errors.ts';
import type { ReadDatabase } from './database.ts';
import { chainId, readCutoff, hex, timestamp, block } from './home.ts';
import type { PageCursors } from './cursor.ts';

// Bound the page before lifecycle joins; retained event times survive header pruning.
export const stakeColumns = `SELECT s.*,c.contract_day,lineage.parent_block,start.block_time AS started_time,finish.block_time AS ended_time,ga.block_time AS ga_time
 FROM selected s JOIN hdd.current_state c USING(chain_id) JOIN hdd.chains lineage USING(chain_id)
 LEFT JOIN hdd.events start ON start.origin_chain_id=s.origin_chain_id AND start.block_number=s.start_block AND start.log_index=s.start_log AND start.kind='stake_start'
 LEFT JOIN hdd.events finish ON finish.origin_chain_id=CASE WHEN s.chain_id=369 AND s.end_block>lineage.parent_block THEN 369 ELSE 1 END
 AND finish.stake_id=s.stake_id AND finish.block_number=s.end_block AND finish.kind='stake_end'
 LEFT JOIN hdd.events ga ON ga.origin_chain_id=CASE WHEN s.chain_id=369 AND s.ga_block>lineage.parent_block THEN 369 ELSE 1 END
 AND ga.stake_id=s.stake_id AND ga.block_number=s.ga_block AND ga.kind='good_accounting'
 ORDER BY s.stake_id`;
export function stakeRow(r: Record<string, any>) {
  if (
    r.started_time === null ||
    (r.end_block !== null && r.ended_time === null) ||
    (r.ga_block !== null && r.ga_time === null)
  )
    throw unavailable();
  return StakeSchema.parse({
    stakeId: r.stake_id,
    address: hex(r.address),
    originChainId: r.origin_chain_id,
    principalHearts: r.principal_hearts,
    stakeShares: r.stake_shares,
    startDay: r.start_day,
    lockedDay: r.locked_day,
    stakedDays: r.staked_days,
    maturityDay: r.locked_day + r.staked_days,
    status:
      r.lifecycle !== 'unsettled'
        ? r.lifecycle
        : r.contract_day < r.locked_day
          ? 'queued'
          : r.contract_day < r.locked_day + r.staked_days
            ? 'open'
            : 'mature_open',
    isAutoStake: r.is_auto_stake,
    startBlock: r.start_block,
    startedAt: timestamp(r.started_time),
    gaDay: r.ga_day,
    gaBlock: r.ga_block,
    gaOriginChainId:
      r.ga_block === null
        ? null
        : r.chain_id === 369 && BigInt(r.ga_block) > BigInt(r.parent_block)
          ? 369
          : 1,
    goodAccountedAt: r.ga_time === null ? null : timestamp(r.ga_time),
    endDay: r.end_day,
    endBlock: r.end_block,
    endOriginChainId:
      r.end_block === null
        ? null
        : r.chain_id === 369 && BigInt(r.end_block) > BigInt(r.parent_block)
          ? 369
          : 1,
    endedAt: r.ended_time === null ? null : timestamp(r.ended_time),
    payoutHearts: r.payout_hearts,
    penaltyHearts: r.penalty_hearts,
  });
}
export const stakesSql = (
  address: boolean,
  lifecycle?: 'open' | 'good_accounted' | 'ended',
  maturity = false,
) => {
  const filter =
    lifecycle === 'open'
      ? "AND lifecycle='unsettled'"
      : lifecycle === 'good_accounted'
        ? "AND lifecycle='good_accounted'"
        : lifecycle === 'ended'
          ? "AND lifecycle IN('ended','cancelled')"
          : '';
  const first = address ? 5 : 4;
  const window = maturity
    ? ` AND locked_day+staked_days BETWEEN $${first}::int AND $${first + 1}::int AND principal_hearts>=$${first + 2}::numeric`
    : '';
  return `WITH selected AS MATERIALIZED (SELECT * FROM hdd.stakes WHERE chain_id=$1 AND stake_id>$2 ${address ? 'AND address=$4' : ''} ${filter}${window} ORDER BY stake_id LIMIT $3) ${stakeColumns}`;
};
export async function stakes(
  db: ReadDatabase,
  q: z.infer<typeof StakesQuery>,
  signal: AbortSignal,
  cursors: PageCursors,
  now: number,
) {
  const maturity = q.maturityFromDay !== undefined;
  // Keep old bindings byte-for-byte; filtered selections have a distinct namespace.
  const binding = maturity
    ? `stakes-maturity1/${q.chain}/${q.address ?? ''}/${q.limit}/${q.lifecycle}/${q.maturityFromDay}/${q.maturityToDay}/${q.minPrincipalHearts ?? '0'}`
    : `stakes/${q.chain}/${q.address ?? ''}/${q.limit}/${q.lifecycle ?? ''}`;
  const cursor = cursors.decode(q.cursor, binding, now);
  return db.read(
    signal,
    async (c) => {
      const cut = await readCutoff(c, q.chain);
      if (!cut) throw unavailable();
      const identity = JSON.stringify(cut);
      if (cursor && cursor.identity !== identity) throw restart();
      const values: unknown[] = [chainId(q.chain), cursor?.key ?? '-1', q.limit + 1];
      if (q.address) values.push(Buffer.from(q.address.slice(2), 'hex'));
      if (maturity) values.push(q.maturityFromDay, q.maturityToDay, q.minPrincipalHearts ?? '0');
      const { rows } = await c.query(stakesSql(Boolean(q.address), q.lifecycle, maturity), values);
      const page = rows.slice(0, q.limit);
      return StakesResponseSchema.parse({
        chain: q.chain,
        cutoff: cut,
        items: page.map(stakeRow),
        nextCursor:
          rows.length > q.limit
            ? cursors.encode(binding, identity, page.at(-1)!.stake_id, now, cursor?.expires)
            : null,
      });
    },
    true,
  );
}
export async function indexedStake(
  db: ReadDatabase,
  chain: ChainKey,
  id: string,
  signal: AbortSignal,
) {
  return db.read(
    signal,
    async (c) => {
      const cut = await readCutoff(c, chain);
      const { rows } = await c.query(
        `WITH selected AS (SELECT * FROM hdd.stakes WHERE chain_id=$1 AND stake_id=$2) ${stakeColumns}`,
        [chainId(chain), id],
      );
      return { cutoff: cut, indexed: rows[0] ? stakeRow(rows[0]) : null };
    },
    true,
  );
}
export const holdersSql = (order: 'liquid' | 'staker') => {
  const rank = order === 'liquid' ? 'liquid_rank' : 'staker_rank';
  return `SELECT r.*,a.liquid_hearts,a.accounted_hearts,a.stake_count FROM hdd.account_ranks r
    JOIN hdd.accounts a USING(chain_id,address) WHERE r.chain_id=$1 AND r.${rank}>$2
    ORDER BY r.${rank},r.address LIMIT $3`;
};
export async function holders(
  db: ReadDatabase,
  q: z.infer<typeof HoldersQuery>,
  signal: AbortSignal,
  cursors: PageCursors,
  now: number,
) {
  const binding = `holders/${q.chain}/${q.order}/${q.limit}`,
    cursor = cursors.decode(q.cursor, binding, now);
  return db.read(
    signal,
    async (c) => {
      const cut = await readCutoff(c, q.chain);
      const {
        rows: [r],
      } = await c.query('SELECT * FROM hdd.rank_state WHERE chain_id=$1', [chainId(q.chain)]);
      if (!cut || !r) {
        if (cursor) throw restart();
        throw unavailable();
      }
      const rankAsOf = block(r),
        identity = JSON.stringify([cut, rankAsOf, r.revision, r.ranking_day]);
      if (cursor && cursor.identity !== identity) throw restart();
      const { rows } = await c.query(holdersSql(q.order), [
        chainId(q.chain),
        cursor?.key ?? '0',
        q.limit + 1,
      ]);
      const page = rows.slice(0, q.limit);
      return HoldersResponseSchema.parse({
        chain: q.chain,
        cutoff: cut,
        rankAsOf,
        rankingDay: r.ranking_day,
        order: q.order,
        items: page.map((a) => ({
          address: hex(a.address),
          liquidHearts: a.liquid_hearts,
          accountedHearts: a.accounted_hearts,
          stakeCount: a.stake_count,
          liquidRank: a.liquid_rank,
          stakerRank: a.staker_rank,
        })),
        nextCursor:
          rows.length > q.limit
            ? cursors.encode(
                binding,
                identity,
                page.at(-1)![q.order === 'liquid' ? 'liquid_rank' : 'staker_rank'],
                now,
                cursor?.expires,
              )
            : null,
      });
    },
    true,
  );
}
