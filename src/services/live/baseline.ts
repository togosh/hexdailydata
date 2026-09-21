import type pg from 'pg';
import { IndexedAddressSchema, type IndexedAddress } from '../../contracts/api.ts';
import { address as addressSchema, hex } from '../projections/input.ts';

export interface AddressBaseline {
  address(chain: 1 | 369, address: string, signal?: AbortSignal): Promise<IndexedAddress | null>;
  stake(
    chain: 1 | 369,
    id: string,
    signal?: AbortSignal,
  ): Promise<{ address: string; lifecycle: string; asOfBlock: string } | null>;
}
export class SqlAddressBaseline implements AddressBaseline {
  readonly client: pg.Client;
  constructor(client: pg.Client) {
    this.client = client;
  }
  async address(chain: 1 | 369, address: string) {
    addressSchema.parse(address);
    const {
      rows: [row],
    } = await this.client.query(
      `WITH owned AS MATERIALIZED (SELECT * FROM hdd.stakes WHERE chain_id=$1 AND address=$2)
      SELECT s.*,c.contract_day,a.liquid_hearts,a.accounted_hearts,a.stake_count,r.liquid_rank,r.staker_rank,
      totals.*,activity.items AS activity,
      d.block_number AS rank_block,d.block_hash AS rank_hash,d.block_time AS rank_time
      FROM hdd.sync_state s JOIN hdd.current_state c USING(chain_id)
      LEFT JOIN hdd.accounts a ON a.chain_id=s.chain_id AND a.address=$2
      LEFT JOIN hdd.account_ranks r ON r.chain_id=s.chain_id AND r.address=$2
      LEFT JOIN hdd.rank_state d ON d.chain_id=s.chain_id
      CROSS JOIN LATERAL (
        SELECT coalesce(sum(principal_hearts) FILTER(WHERE lifecycle IN('unsettled','good_accounted')),0)::text AS locked,
        coalesce(sum(principal_hearts) FILTER(WHERE lifecycle='good_accounted'),0)::text AS ga_principal,
        coalesce(sum(stake_shares) FILTER(WHERE lifecycle='unsettled'),0)::text AS shares,
        count(*) FILTER(WHERE lifecycle='unsettled')::text AS open_count,
        count(*) FILTER(WHERE lifecycle='good_accounted')::text AS ga_count,
        count(*) FILTER(WHERE lifecycle IN('ended','cancelled'))::text AS ended_count,
        min(start_day) AS first_day,
        min(locked_day+staked_days) FILTER(WHERE lifecycle='unsettled' AND locked_day+staked_days>=c.contract_day) AS next_day
        FROM owned
      ) totals
      CROSS JOIN LATERAL (
        SELECT coalesce(jsonb_agg(item ORDER BY block_number DESC,log_index DESC),'[]'::jsonb) AS items FROM (
          SELECT e.block_number,e.log_index,jsonb_build_object(
            'stakeId',t.stake_id::text,'kind',CASE e.kind WHEN 'stake_start' THEN 'start'
              WHEN 'good_accounting' THEN 'good_accounting' ELSE CASE WHEN t.lifecycle='cancelled' THEN 'cancel' ELSE 'end' END END,
            'originChainId',e.origin_chain_id,'blockNumber',e.block_number::text,
            'at',to_char(to_timestamp(e.block_time) AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')) AS item
          FROM owned t JOIN hdd.chains lineage ON lineage.chain_id=t.chain_id
          CROSS JOIN LATERAL (VALUES
            (t.origin_chain_id,t.start_block,'stake_start'),
            (CASE WHEN t.chain_id=369 AND t.ga_block>lineage.parent_block THEN 369 ELSE 1 END,t.ga_block,'good_accounting'),
            (CASE WHEN t.chain_id=369 AND t.end_block>lineage.parent_block THEN 369 ELSE 1 END,t.end_block,'stake_end')
          ) ref(origin,block,kind)
          JOIN hdd.events e ON e.origin_chain_id=ref.origin AND e.block_number=ref.block
            AND e.stake_id=t.stake_id AND e.kind=ref.kind
          ORDER BY e.block_number DESC,e.log_index DESC LIMIT 5
        ) latest
      ) activity
      WHERE s.chain_id=$1`,
      [chain, Buffer.from(address.slice(2), 'hex')],
    );
    if (!row) return null;
    return IndexedAddressSchema.parse({
      asOf: {
        chainId: chain,
        blockNumber: row.block_number,
        blockHash: hex(row.block_hash),
        blockTimestamp: new Date(Number(row.block_time) * 1000).toISOString(),
      },
      finality: row.finality,
      liquidHearts: row.liquid_hearts,
      accountedHearts: row.accounted_hearts,
      stakeCount: row.stake_count,
      staking: {
        contractDay: row.contract_day,
        lockedHearts: row.locked,
        goodAccountedHearts: row.ga_principal,
        accountedShares: row.shares,
        openCount: row.open_count,
        goodAccountedCount: row.ga_count,
        endedCount: row.ended_count,
        firstStakeDay: row.first_day,
        nextMaturityDay: row.next_day,
        activity: row.activity,
      },
      rankingDay: row.ranking_day,
      rank:
        row.rank_block === null
          ? null
          : {
              liquid: row.liquid_rank,
              staker: row.staker_rank,
              asOf: {
                chainId: chain,
                blockNumber: row.rank_block,
                blockHash: hex(row.rank_hash),
                blockTimestamp: new Date(Number(row.rank_time) * 1000).toISOString(),
              },
            },
    });
  }
  async stake(chain: 1 | 369, id: string) {
    if (!/^(0|[1-9][0-9]{0,12})$/.test(id) || BigInt(id) >= 1n << 40n)
      throw new Error('Invalid stake ID.');
    const {
      rows: [row],
    } = await this.client.query(
      `SELECT t.address,t.lifecycle,s.block_number
      FROM hdd.stakes t JOIN hdd.sync_state s USING(chain_id) WHERE t.chain_id=$1 AND t.stake_id=$2`,
      [chain, id],
    );
    return row
      ? { address: hex(row.address), lifecycle: row.lifecycle, asOfBlock: row.block_number }
      : null;
  }
}
