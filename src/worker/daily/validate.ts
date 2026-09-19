import type pg from 'pg';
import { marketObservationSchema } from './market.ts';
import { rankingQuery } from './ranking.ts';
/** Import/start-of-seed audit only, never an ordinary read or metric callback. */
export async function validateDailyState(client: pg.Client, signal: AbortSignal) {
  const {
    rows: [invalid],
  } = await client.query(`SELECT
    EXISTS(SELECT 1 FROM hdd.sync_state s LEFT JOIN hdd.rank_state r USING(chain_id)
      WHERE s.ranking_day IS DISTINCT FROM r.ranking_day OR r.revision>s.revision OR r.block_number>s.block_number
      OR r.block_time>s.block_time OR (r.block_time-1575331200)/86400-1<>r.ranking_day
      OR (r.block_number=s.block_number AND r.block_hash<>s.block_hash))
    OR EXISTS(SELECT 1 FROM hdd.account_ranks r LEFT JOIN hdd.rank_state s USING(chain_id)
      LEFT JOIN hdd.accounts a USING(chain_id,address) WHERE s.chain_id IS NULL OR a.address IS NULL)
    OR EXISTS(SELECT 1 FROM hdd.account_ranks GROUP BY chain_id HAVING
      count(liquid_rank)<>coalesce(max(liquid_rank),0) OR count(staker_rank)<>coalesce(max(staker_rank),0))
    OR EXISTS(SELECT 1 FROM hdd.market_sources s WHERE
      s.sample_bytes<>(SELECT coalesce(sum(pg_column_size(m)),0) FROM hdd.market_samples m WHERE m.chain_id=s.chain_id AND m.source=s.source)
      OR (s.through_day IS NOT NULL AND (SELECT count(*) FROM hdd.market_daily d WHERE d.chain_id=s.chain_id AND d.source=s.source
        AND d.contract_day BETWEEN s.from_day AND s.through_day)<>s.through_day-s.from_day+1))
    OR EXISTS(SELECT chain_id FROM hdd.market_sources GROUP BY chain_id HAVING count(*)>4) AS bad`);
  if (invalid.bad) throw new Error('Invalid portable daily/rank progress.');
  const { rows: currentRanks } =
    await client.query(`SELECT s.chain_id FROM hdd.sync_state s JOIN hdd.rank_state r USING(chain_id)
    WHERE s.revision=r.revision AND s.block_number=r.block_number`);
  for (const { chain_id } of currentRanks) {
    const {
      rows: [check],
    } = await client.query(
      `WITH expected AS (${rankingQuery}) SELECT EXISTS(
      (SELECT * FROM expected EXCEPT SELECT * FROM hdd.account_ranks WHERE chain_id=$1)
      UNION ALL (SELECT * FROM hdd.account_ranks WHERE chain_id=$1 EXCEPT SELECT * FROM expected)) AS bad`,
      [chain_id],
    );
    if (check.bad) throw new Error('Invalid portable rank values at current checkpoint.');
  }
  for (const table of ['market_samples', 'market_daily'] as const) {
    await client.query(`DECLARE market_audit NO SCROLL CURSOR FOR SELECT m.*,s.method,s.native,s.from_day,s.through_day
      FROM hdd.${table} m JOIN hdd.market_sources s USING(chain_id,source) ORDER BY m.chain_id,m.source,m.contract_day`);
    try {
      for (;;) {
        const { rows } = await client.query('FETCH FORWARD 128 FROM market_audit');
        if (!rows.length) break;
        for (const r of rows) {
          signal.throwIfAborted();
          const o = marketObservationSchema.parse(r.observation);
          if (
            r.contract_day < r.from_day ||
            (table === 'market_daily' && r.contract_day > r.through_day) ||
            (r.native && (o.volume !== null || o.liquidity !== null)) ||
            (o.sourceTime !== null &&
              (BigInt(o.sourceTime) - 1575331200n) / 86400n !== BigInt(r.contract_day)) ||
            (table === 'market_samples' &&
              (o.intervals !== 1 ||
                o.sourceTime !== r.source_time ||
                o.observedTime !== r.observed_time ||
                o.blockNumber !== r.block_number ||
                o.blockHash !== (r.block_hash ? '0x' + r.block_hash.toString('hex') : null) ||
                o.poolTime !== r.pool_time ||
                (r.native && (r.revision !== '0' || o.blockNumber === null)) ||
                (!r.native &&
                  (o.blockNumber !== null ||
                    r.identity !== r.source_time ||
                    BigInt(r.source_time) % 60n !== 0n))))
          )
            throw new Error('Invalid portable market observation.');
        }
      }
    } finally {
      await client.query('CLOSE market_audit');
    }
  }
}
