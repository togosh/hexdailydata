import { query as measuredQuery } from '../../db/measure.ts';
import type pg from 'pg';
import {
  createStake,
  settleStake,
  metricIncludes,
  stakeStatus,
  type Stake,
} from '../../domain/stake.ts';
import { bytes, hex, type Event, type Payout } from './input.ts';

export const totalColumns = [
  'circulating_hearts',
  'locked_hearts',
  'accounted_hearts',
  'weighted_days',
  'active_shares',
  'queued_shares',
  'holder_count',
  'staker_count',
  'raw_share_rate',
  'starts',
  'ends',
  'payout_recorded',
  'penalty_hearts',
] as const;
type TotalName = (typeof totalColumns)[number];
export type Totals = Record<TotalName, bigint>;
export type Current = Totals & { contract_day: number; sampled_addresses: string[] };
export function readCurrent(row: Record<string, unknown>): Current {
  const totals = Object.fromEntries(
    totalColumns.map((k) => [k, BigInt(row[k] as string)]),
  ) as Totals;
  return {
    ...totals,
    contract_day: row.contract_day as number,
    sampled_addresses: (row.sampled_addresses as Buffer[]).map(hex),
  };
}
export async function saveCurrent(client: pg.Client, chain: number, state: Current) {
  await measuredQuery(
    client,
    `UPDATE hdd.current_state SET contract_day=$2,${totalColumns.map((c, i) => `${c}=$${i + 3}`).join(',')},sampled_addresses=$16 WHERE chain_id=$1`,
    [
      chain,
      state.contract_day,
      ...totalColumns.map((k) => state[k].toString()),
      state.sampled_addresses.map(bytes),
    ],
  );
}
export function stakeFromRow(row: pg.QueryResultRow): Stake {
  return {
    startDay: row.start_day,
    lockedDay: row.locked_day,
    stakedDays: row.staked_days,
    principalHearts: BigInt(row.principal_hearts),
    stakeShares: BigInt(row.stake_shares),
    isAutoStake: row.is_auto_stake,
    goodAccounting:
      row.ga_day === null
        ? null
        : {
            day: row.ga_day,
            payoutHearts: BigInt(row.payout_hearts),
            penaltyHearts: BigInt(row.penalty_hearts),
          },
    end:
      row.end_day === null
        ? null
        : {
            day: row.end_day,
            payoutHearts: BigInt(row.payout_hearts),
            penaltyHearts: BigInt(row.penalty_hearts),
          },
  };
}
async function account(
  client: pg.Client,
  chain: number,
  address: string,
  block: string,
  state: Current,
  liquid: bigint,
  principal: bigint,
  count: bigint,
) {
  if (liquid === 0n && principal === 0n && count === 0n) return;
  state.sampled_addresses = [...new Set([...state.sampled_addresses, address])].sort().slice(0, 32);
  const {
    rows: [old],
  } = await measuredQuery(client, 'SELECT * FROM hdd.accounts WHERE chain_id=$1 AND address=$2', [
    chain,
    bytes(address),
  ]);
  const beforeLiquid = BigInt(old?.liquid_hearts ?? '0'),
    beforeCount = BigInt(old?.stake_count ?? '0');
  const nextLiquid = beforeLiquid + liquid,
    nextCount = beforeCount + count,
    nextPrincipal = BigInt(old?.accounted_hearts ?? '0') + principal;
  if (nextLiquid < 0n || nextCount < 0n || nextPrincipal < 0n)
    throw new Error('Negative account projection.');
  state.holder_count += BigInt(Number(nextLiquid > 0n) - Number(beforeLiquid > 0n));
  state.staker_count += BigInt(Number(nextCount > 0n) - Number(beforeCount > 0n));
  await measuredQuery(
    client,
    `INSERT INTO hdd.accounts VALUES($1,$2,$3,$4,$5,$6,$6)
 ON CONFLICT(chain_id,address) DO UPDATE SET liquid_hearts=excluded.liquid_hearts,
 accounted_hearts=excluded.accounted_hearts,stake_count=excluded.stake_count,last_block=excluded.last_block`,
    [
      chain,
      bytes(address),
      nextLiquid.toString(),
      nextPrincipal.toString(),
      nextCount.toString(),
      block,
    ],
  );
}
async function schedule(client: pg.Client, chain: number, day: number, delta: bigint) {
  if (delta < 0n) {
    const { rowCount } = await measuredQuery(
      client,
      'UPDATE hdd.share_schedule SET shares=shares+$3 WHERE chain_id=$1 AND activation_day=$2',
      [chain, day, delta.toString()],
    );
    if (rowCount !== 1) throw new Error('Missing queued share schedule.');
  } else {
    await measuredQuery(
      client,
      `INSERT INTO hdd.share_schedule VALUES($1,$2,$3)
 ON CONFLICT(chain_id,activation_day) DO UPDATE SET shares=hdd.share_schedule.shares+$3`,
      [chain, day, delta.toString()],
    );
  }
  await measuredQuery(
    client,
    'DELETE FROM hdd.share_schedule WHERE chain_id=$1 AND activation_day=$2 AND shares=0',
    [chain, day],
  );
}
export async function closeDay(
  client: pg.Client,
  chain: number,
  origin: number,
  state: Current,
  block: string,
  hash: Buffer,
) {
  await measuredQuery(
    client,
    `INSERT INTO hdd.daily_stats(chain_id,contract_day,origin_chain_id,close_block,close_hash,${totalColumns.join(',')})
 VALUES($1,$2,$3,$4,$5,${totalColumns.map((_, i) => `$${i + 6}`).join(',')})`,
    [
      chain,
      state.contract_day,
      origin,
      block,
      hash,
      ...totalColumns.map((k) => state[k].toString()),
    ],
  );
  state.contract_day++;
  state.sampled_addresses = [];
  state.starts = 0n;
  state.ends = 0n;
  state.payout_recorded = 0n;
  state.penalty_hearts = 0n;
  const {
    rows: [row],
  } = await measuredQuery(
    client,
    'DELETE FROM hdd.share_schedule WHERE chain_id=$1 AND activation_day=$2 RETURNING shares',
    [chain, state.contract_day],
  );
  const shares = BigInt(row?.shares ?? '0');
  state.queued_shares -= shares;
  state.active_shares += shares;
}
export async function applyEvent(client: pg.Client, chain: number, state: Current, event: Event) {
  const v = event.value,
    block = event.blockNumber;
  const common = [
    event.originChainId,
    block,
    event.logIndex,
    bytes(event.blockHash),
    bytes(event.transactionHash),
    event.transactionIndex,
    event.blockTime,
  ];
  const raw = [event.topics.map(bytes), bytes(event.data), JSON.stringify(event)];
  // Duplicate whole-batch retries are resolved before the transaction. Event PKs reject overlaps.
  if (v.kind === 'transfer') {
    await measuredQuery(
      client,
      'INSERT INTO hdd.transfers_recent VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)',
      [...common, bytes(v.sender), bytes(v.recipient), v.hearts, ...raw],
    );
    const zero = '0x' + '0'.repeat(40),
      amount = BigInt(v.hearts);
    if (v.sender === zero && v.recipient === zero) {
      if (amount !== 0n) throw new Error('Nonzero zero-to-zero transfer.');
      return;
    }
    if (v.sender === v.recipient) {
      const {
        rows: [row],
      } = await measuredQuery(
        client,
        'SELECT liquid_hearts FROM hdd.accounts WHERE chain_id=$1 AND address=$2',
        [chain, bytes(v.sender)],
      );
      if (BigInt(row?.liquid_hearts ?? '0') < amount)
        throw new Error('Self-transfer exceeds balance.');
      return;
    }
    if (v.sender === zero) state.circulating_hearts += amount;
    else await account(client, chain, v.sender, block, state, -amount, 0n, 0n);
    if (v.recipient === zero) state.circulating_hearts -= amount;
    else await account(client, chain, v.recipient, block, state, amount, 0n, 0n);
    return;
  }
  await measuredQuery(
    client,
    'INSERT INTO hdd.events VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)',
    [...common, v.kind, 'stakeId' in v ? v.stakeId : null, ...raw],
  );
  if (v.kind === 'stake_start') {
    const stake = createStake({
      startSeconds: BigInt(event.blockTime),
      stakedDays: v.days,
      principalHearts: BigInt(v.principal),
      stakeShares: BigInt(v.shares),
      isAutoStake: v.auto,
    });
    await measuredQuery(
      client,
      `INSERT INTO hdd.stakes(chain_id,stake_id,address,origin_chain_id,start_block,start_log,start_day,locked_day,staked_days,principal_hearts,stake_shares,is_auto_stake,lifecycle,last_block)
   VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,'unsettled',$5)`,
      [
        chain,
        v.stakeId,
        bytes(v.address),
        event.originChainId,
        block,
        event.logIndex,
        stake.startDay,
        stake.lockedDay,
        v.days,
        v.principal,
        v.shares,
        v.auto,
      ],
    );
    state.locked_hearts += stake.principalHearts;
    state.accounted_hearts += stake.principalHearts;
    state.weighted_days += stake.principalHearts * BigInt(stake.stakedDays);
    state.queued_shares += stake.stakeShares;
    state.starts++;
    await account(client, chain, v.address, block, state, 0n, stake.principalHearts, 1n);
    await schedule(client, chain, stake.lockedDay, stake.stakeShares);
  } else if (v.kind === 'stake_end' || v.kind === 'good_accounting') {
    const {
      rows: [row],
    } = await measuredQuery(client, 'SELECT * FROM hdd.stakes WHERE chain_id=$1 AND stake_id=$2', [
      chain,
      v.stakeId,
    ]);
    if (!row || hex(row.address) !== v.address) throw new Error('Unknown stake/owner.');
    if (
      (v.principal !== undefined && v.principal !== row.principal_hearts) ||
      (v.shares !== undefined && v.shares !== row.stake_shares)
    )
      throw new Error('Settlement raw principal/shares disagree with stake.');
    const stake = stakeFromRow(row),
      before = stakeStatus(stake, state.contract_day);
    const settlement = {
      day: state.contract_day,
      payoutHearts: BigInt(v.payout),
      penaltyHearts: BigInt(v.penalty),
    };
    const result = settleStake(
      stake,
      v.kind === 'good_accounting'
        ? { ...settlement, kind: 'good_accounting' }
        : { ...settlement, kind: 'end', servedDays: v.servedDays, prevUnlocked: v.prevUnlocked },
    );
    const status = stakeStatus(result.stake, state.contract_day),
      effects = result.effects;
    await measuredQuery(
      client,
      `UPDATE hdd.stakes SET lifecycle=$3,ga_day=$4,ga_block=$5,end_day=$6,end_block=$7,payout_hearts=$8,penalty_hearts=$9,last_block=$10 WHERE chain_id=$1 AND stake_id=$2`,
      [
        chain,
        v.stakeId,
        status,
        v.kind === 'good_accounting' ? state.contract_day : row.ga_day,
        v.kind === 'good_accounting' ? block : row.ga_block,
        v.kind === 'stake_end' ? state.contract_day : null,
        v.kind === 'stake_end' ? block : null,
        v.payout,
        v.penalty,
        block,
      ],
    );
    state.locked_hearts += effects.lockedHeartsDelta;
    state.active_shares += effects.accountedSharesDelta;
    state.queued_shares += effects.queuedSharesDelta;
    state.payout_recorded += effects.payoutRecordedHearts;
    state.penalty_hearts += effects.penaltyRecordedHearts;
    if (v.kind === 'stake_end') state.ends++;
    if (metricIncludes.accountedPrincipal(before)) {
      state.accounted_hearts -= stake.principalHearts;
      state.weighted_days -= stake.principalHearts * BigInt(stake.stakedDays);
      await account(client, chain, v.address, block, state, 0n, -stake.principalHearts, -1n);
    }
    if (effects.queuedSharesDelta)
      await schedule(client, chain, stake.lockedDay, effects.queuedSharesDelta);
  } else if (v.kind === 'share_rate') {
    if (BigInt(v.rate) < state.raw_share_rate) throw new Error('Share rate decreased.');
    state.raw_share_rate = BigInt(v.rate);
  }
  // Claim/DailyDataUpdate logs retain evidence. Supply and materialized words have separate owners.
}
export async function applyPayout(client: pg.Client, chain: number, currentDay: number, v: Payout) {
  if (v.day >= currentDay) throw new Error('Cannot materialize current/future day.');
  const {
    rows: [row],
  } = await measuredQuery(
    client,
    'SELECT * FROM hdd.daily_stats WHERE chain_id=$1 AND contract_day=$2',
    [chain, v.day],
  );
  if (!row) throw new Error('Daily native row missing.');
  if (row.payout_status === 'materialized') {
    if (row.payout_hearts !== v.payout || row.payout_shares !== v.shares)
      throw new Error('Conflicting materialized payout.');
  } else
    await measuredQuery(
      client,
      `UPDATE hdd.daily_stats SET payout_status='materialized',payout_hearts=$3,payout_shares=$4,payout_block=$5,payout_hash=$6 WHERE chain_id=$1 AND contract_day=$2`,
      [chain, v.day, v.payout, v.shares, v.blockNumber, bytes(v.blockHash)],
    );
}
export function currentStakeStatus(row: pg.QueryResultRow, day: number) {
  return stakeStatus(stakeFromRow(row), day);
}
