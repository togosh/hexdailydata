import type pg from 'pg';
import { query } from '../../db/measure.ts';

const rewindTables: Record<string, string[]> = {
  accounts: ['chain_id', 'address'],
  stakes: ['chain_id', 'stake_id'],
  current_state: ['chain_id'],
  share_schedule: ['chain_id', 'activation_day'],
  daily_stats: ['chain_id', 'contract_day'],
  events: ['origin_chain_id', 'block_number', 'log_index'],
  transfers_recent: ['origin_chain_id', 'block_number', 'log_index'],
  blocks_recent: ['chain_id', 'number'],
};
/** Caller owns a transaction, canonical locks and hdd.rewinding. Import uses this
 * same restore path under a rollback-only savepoint; rows remain exact SQL JSON text.
 */
export async function restoreCheckpoint(
  client: pg.Client,
  chain: number,
  revision: string,
  signal?: AbortSignal,
) {
  await query(
    client,
    `DECLARE restore_undo NO SCROLL CURSOR FOR
    SELECT relation_name,row_key::text,previous_value::text FROM hdd.undo_recent
    WHERE chain_id=$1 AND revision=$2 ORDER BY sequence DESC`,
    [chain, revision],
  );
  for (;;) {
    const { rows } = await query(client, 'FETCH FORWARD 128 FROM restore_undo');
    if (!rows.length) break;
    for (const row of rows) {
      signal?.throwIfAborted();
      const keys = rewindTables[row.relation_name];
      if (!keys) throw new Error('Unsupported undo relation.');
      const table = `hdd.${row.relation_name}`;
      await query(
        client,
        `DELETE FROM ${table} WHERE ${keys.map((k) => `${k}=(jsonb_populate_record(NULL::${table},$1::jsonb)).${k}`).join(' AND ')}`,
        [row.row_key],
      );
      if (row.previous_value !== null)
        await query(
          client,
          `INSERT INTO ${table} SELECT * FROM jsonb_populate_record(NULL::${table},$1::jsonb)`,
          [row.previous_value],
        );
    }
  }
  await query(client, 'CLOSE restore_undo');
  await query(client, 'DELETE FROM hdd.checkpoints_recent WHERE chain_id=$1 AND revision=$2', [
    chain,
    revision,
  ]);
}
export async function restoreCursor(
  client: pg.Client,
  chain: number,
  previous: string,
  floor: string,
  revision: string | null = null,
) {
  await query(
    client,
    `UPDATE hdd.sync_state SET
    (block_number,block_hash,block_time,finality,rewind_floor,acceptance,ranking_day,revision)=
    (SELECT block_number,block_hash,block_time,finality,greatest(rewind_floor,$4::bigint),acceptance,ranking_day,
      coalesce($3::bigint,revision) FROM jsonb_populate_record(NULL::hdd.sync_state,$2::jsonb))
    WHERE chain_id=$1`,
    [chain, previous, revision, floor],
  );
}
