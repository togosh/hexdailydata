import type pg from 'pg';
import {
  sourceHistorySchema,
  assertObservation,
  assertEventRange,
  type SourceBinding,
} from '../../providers/binding.ts';
import { digest, hex } from './input.ts';

/** Compact boundary checks shared by resume, portable state and checkpoint restore. */
export async function validateSourceHistory(
  client: pg.Client,
  chainId: number,
  expected?: SourceBinding,
) {
  const {
    rows: [row],
  } = await client.query(
    `SELECT c.*,h.start_block,h.start_hash,h.start_time,h.sources,
    s.block_number,s.block_hash,s.block_time,s.acceptance
    FROM hdd.chains c JOIN hdd.source_history h USING(chain_id)
    JOIN hdd.sync_state s USING(chain_id) WHERE chain_id=$1`,
    [chainId],
  );
  if (!row) throw new Error('Missing source binding provenance.');
  const metadata = sourceHistorySchema.parse(row.sources),
    binding = metadata.binding;
  if (
    binding.originChainId !== chainId ||
    binding.contract !== hex(row.contract_address) ||
    binding.codeHash !== hex(row.code_hash) ||
    row.origin_chain_id !== chainId ||
    row.acceptance.bindingDigest !== digest(binding) ||
    (expected && digest(expected) !== digest(binding))
  )
    throw new Error('Stored source binding mismatch.');
  assertObservation(binding, row.block_number);
  if (row.acceptance.range)
    assertEventRange(binding, row.acceptance.range.fromBlock, row.acceptance.range.toBlock);
  const common = binding.common;
  if (common) {
    const start = chainId === 1 ? common.constructor : common.entry;
    if (
      row.start_block !== start.number ||
      hex(row.start_hash) !== start.hash ||
      row.start_time !== start.timestamp
    )
      throw new Error('Source binding start mismatch.');
    for (const h of [common.constructor, common.parent, common.entry]) {
      if (
        row.block_number === h.number &&
        (hex(row.block_hash) !== h.hash || row.block_time !== h.timestamp)
      )
        throw new Error('Source binding checkpoint mismatch.');
      const {
        rows: [retained],
      } = await client.query('SELECT * FROM hdd.blocks_recent WHERE chain_id=$1 AND number=$2', [
        chainId,
        h.number,
      ]);
      if (
        retained &&
        (hex(retained.hash) !== h.hash ||
          hex(retained.parent_hash) !== h.parentHash ||
          retained.timestamp !== h.timestamp)
      )
        throw new Error('Source binding retained header mismatch.');
    }
    if (chainId === 369) {
      if (
        row.parent_block !== common.parent.number ||
        hex(row.parent_hash) !== common.parent.hash ||
        row.entry_block !== common.entry.number ||
        hex(row.entry_hash) !== common.entry.hash
      )
        throw new Error('Source binding fork mismatch.');
      const {
        rows: [parent],
      } = await client.query('SELECT sources FROM hdd.source_history WHERE chain_id=1');
      if (
        !parent ||
        digest(sourceHistorySchema.parse(parent.sources).binding.common) !== digest(common)
      )
        throw new Error('Source binding inherited provenance mismatch.');
    }
  }
  return metadata;
}

/** Portable/restore audit only. Ordinary resume checks its compact current boundary. */
export async function validateSourceCheckpoints(client: pg.Client) {
  for (const { chain_id: chain } of (
    await client.query('SELECT chain_id FROM hdd.chains ORDER BY chain_id')
  ).rows) {
    const { binding } = await validateSourceHistory(client, chain);
    const { rows } = await client.query(
      `SELECT previous_sync->>'chain_id' AS chain_id,
      previous_sync->>'block_number' AS block_number,previous_sync->'acceptance' AS acceptance
      FROM hdd.checkpoints_recent WHERE chain_id=$1 ORDER BY block_number LIMIT 4097`,
      [chain],
    );
    if (rows.length > 4096) throw new Error('Source checkpoint bound exceeded.');
    for (const previous of rows) {
      if (
        previous.chain_id !== String(chain) ||
        previous.acceptance?.bindingDigest !== digest(binding)
      )
        throw new Error('Retained source binding mismatch.');
      assertObservation(binding, String(previous.block_number));
      if (previous.acceptance.range)
        assertEventRange(
          binding,
          previous.acceptance.range.fromBlock,
          previous.acceptance.range.toBlock,
        );
    }
  }
}
