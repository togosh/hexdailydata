import type pg from 'pg';

export const rankingQuery = `WITH liquid AS (
 SELECT address,row_number() OVER(ORDER BY liquid_hearts DESC,address) AS liquid_rank
 FROM hdd.accounts WHERE chain_id=$1 AND liquid_hearts>0
), staker AS (
 SELECT address,row_number() OVER(ORDER BY accounted_hearts DESC,address) AS staker_rank
 FROM hdd.accounts WHERE chain_id=$1 AND accounted_hearts>0
) SELECT $1::integer AS chain_id,coalesce(l.address,s.address) AS address,liquid_rank,staker_rank
 FROM liquid l FULL JOIN staker s USING(address)`;

/** Only the compact rank relation changes. Serializable conflicts retry next tick. */
export async function rankAccounts(
  client: pg.Client,
  chain: 1 | 369,
  signal: AbortSignal,
  hooks: { beforeCommit?: () => Promise<void> } = {},
) {
  await client.query('BEGIN ISOLATION LEVEL SERIALIZABLE');
  try {
    await client.query("SET LOCAL statement_timeout='120s'");
    const {
      rows: [lock],
    } = await client.query('SELECT pg_try_advisory_xact_lock(4245,$1) AS held', [chain]);
    if (!lock.held) throw new Error('Ranking already active.');
    const {
      rows: [s],
    } = await client.query(
      `SELECT s.*,c.contract_day,r.revision AS ranked_revision
      FROM hdd.sync_state s JOIN hdd.current_state c USING(chain_id)
      LEFT JOIN hdd.rank_state r USING(chain_id) WHERE s.chain_id=$1`,
      [chain],
    );
    if (!s || s.contract_day === 0) {
      await client.query('COMMIT');
      return null;
    }
    if (s.ranked_revision === s.revision) {
      await client.query('COMMIT');
      return s.ranking_day;
    }
    signal.throwIfAborted();
    // Deferred uniqueness allows swaps without date-only rewrites or a full staging relation.
    await client.query(
      `DELETE FROM hdd.account_ranks r WHERE chain_id=$1 AND NOT EXISTS
      (SELECT 1 FROM hdd.accounts a WHERE a.chain_id=r.chain_id AND a.address=r.address
        AND (a.liquid_hearts>0 OR a.accounted_hearts>0))`,
      [chain],
    );
    await client.query(
      `INSERT INTO hdd.account_ranks ${rankingQuery}
      ON CONFLICT(chain_id,address) DO UPDATE SET liquid_rank=excluded.liquid_rank,staker_rank=excluded.staker_rank
      WHERE hdd.account_ranks.liquid_rank IS DISTINCT FROM excluded.liquid_rank
        OR hdd.account_ranks.staker_rank IS DISTINCT FROM excluded.staker_rank`,
      [chain],
    );
    await client.query(
      `INSERT INTO hdd.rank_state VALUES($1,$2,$3,$4,$5,$6)
      ON CONFLICT(chain_id) DO UPDATE SET block_number=excluded.block_number,block_hash=excluded.block_hash,
      block_time=excluded.block_time,revision=excluded.revision,ranking_day=excluded.ranking_day`,
      [chain, s.block_number, s.block_hash, s.block_time, s.revision, s.contract_day - 1],
    );
    await client.query('UPDATE hdd.sync_state SET ranking_day=$2 WHERE chain_id=$1', [
      chain,
      s.contract_day - 1,
    ]);
    await hooks.beforeCommit?.();
    signal.throwIfAborted();
    await client.query('COMMIT');
    return s.contract_day - 1;
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {});
    throw error;
  }
}
