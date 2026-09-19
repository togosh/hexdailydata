import type pg from 'pg';
import { IndexedAddressSchema, type IndexedAddress } from '../../contracts/api.ts';
import { address as addressSchema, hex } from '../projections/input.ts';

export interface AddressBaseline {
  address(chain: 1 | 369, address: string): Promise<IndexedAddress | null>;
  stake(
    chain: 1 | 369,
    id: string,
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
      `SELECT s.*,a.liquid_hearts,a.accounted_hearts,a.stake_count,r.liquid_rank,r.staker_rank,
      d.block_number AS rank_block,d.block_hash AS rank_hash,d.block_time AS rank_time
      FROM hdd.sync_state s LEFT JOIN hdd.accounts a ON a.chain_id=s.chain_id AND a.address=$2
      LEFT JOIN hdd.account_ranks r ON r.chain_id=s.chain_id AND r.address=$2
      LEFT JOIN hdd.rank_state d ON d.chain_id=s.chain_id
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
