import type pg from 'pg';
export { bundleSchema, type Bundle } from '../../contracts/downloads.ts';
export async function snapshotIdentity(client: pg.Client, chain: 1 | 369) {
  const {
    rows: [s],
  } = await client.query('SELECT * FROM hdd.sync_state WHERE chain_id=$1', [chain]);
  if (!s) throw new Error('Native checkpoint unavailable.');
  const {
    rows: [r],
  } = await client.query('SELECT * FROM hdd.rank_state WHERE chain_id=$1', [chain]);
  const {
    rows: [d],
  } = await client.query(
    'SELECT max(contract_day) AS day,max(payout_block) AS payout_block FROM hdd.daily_stats WHERE chain_id=$1',
    [chain],
  );
  const { rows: history } = await client.query(
    `SELECT h.chain_id,h.start_block,s.block_number FROM hdd.source_history h
    JOIN hdd.sync_state s USING(chain_id) WHERE (h.chain_id=$1 OR ($1=369 AND h.chain_id=1))
      AND h.start_block<=s.block_number ORDER BY h.chain_id`,
    [chain],
  );
  const { rows: markets } = await client.query(
    `SELECT s.*,d.observation FROM hdd.market_sources s
    LEFT JOIN LATERAL (SELECT observation FROM hdd.market_daily WHERE chain_id=s.chain_id AND source=s.source
      AND observation->>'sourceTime' IS NOT NULL ORDER BY contract_day DESC LIMIT 1) d ON true
    WHERE s.chain_id=$1 ORDER BY s.source`,
    [chain],
  );
  const at = (v: typeof s) => ({
    blockNumber: v.block_number,
    blockHash: v.block_hash.toString('hex'),
    blockTime: v.block_time,
    revision: v.revision,
  });
  return {
    chainId: chain,
    currentIndex: { ...at(s), finality: s.finality },
    ranking: r ? { ...at(r), day: r.ranking_day } : null,
    dailyCutoff: d.day,
    dailyPayoutBlock: d.payout_block,
    origins: history.map((h) => ({
      chainId: h.chain_id,
      fromBlock: h.start_block,
      toBlock: h.block_number,
    })),
    markets: markets.map((m) => ({
      source: m.source,
      method: m.method,
      qualification: m.qualification,
      fromDay: m.from_day,
      throughDay: m.through_day,
      version: m.version,
      intervalSeconds: 60 as const,
      completeness: 'observed-intervals-only' as const,
      sourceTime: m.observation?.sourceTime ?? null,
      blockNumber: m.observation?.blockNumber ?? null,
      blockHash: m.observation?.blockHash?.slice(2) ?? null,
    })),
  };
}
