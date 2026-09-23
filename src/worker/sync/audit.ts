import type pg from 'pg';
import type { Source } from '../../providers/source.ts';
import { plainHeader } from '../../providers/abi.ts';
import { hex, digest, type Header } from '../../services/projections/input.ts';
import { reconcile } from '../../services/projections/initialize.ts';

export type AuditAccount = { address: string; hearts: string };
export type AuditBatch = {
  source: string;
  probe: boolean;
  offset: number;
  expected: AuditAccount[];
  observed?: AuditAccount[];
};
export interface AuditOptions {
  batchSize?: 10 | 30;
  header?: Header;
  batch?: (event: AuditBatch) => Promise<void>;
  /** Optional bounded/resumable iterator; aggregate comparisons remain shared. */
  balances?: (source: Source, header: Header) => Promise<void>;
}

/** Same exact balance comparison for ordinary audits, probes and bounded partitions. */
export async function compareAccounts(
  source: Source,
  expected: AuditAccount[],
  header: Header,
  signal: AbortSignal,
  options: AuditOptions = {},
  offset = 0,
  probe = false,
) {
  const event = { source: source.identity.id, probe, offset, expected };
  await options.batch?.(event);
  const observed = await source.balances(
    expected.map((r) => r.address),
    header,
    signal,
  );
  await options.batch?.({ ...event, observed });
  if (
    observed.length !== expected.length ||
    observed.some((v, i) => v.address !== expected[i]!.address || v.hearts !== expected[i]!.hearts)
  )
    throw new Error('Full current address reconciliation mismatch.');
}

export async function auditBalances(
  reader: pg.Client,
  source: Source,
  chain: number,
  h: Header,
  signal: AbortSignal,
  options: AuditOptions = {},
) {
  let after = Buffer.alloc(0),
    offset = 0;
  for (;;) {
    signal.throwIfAborted();
    const { rows } = await reader.query(
      'SELECT address,liquid_hearts FROM hdd.accounts WHERE chain_id=$1 AND address>$2 ORDER BY address LIMIT 30',
      [chain, after],
    );
    if (!rows.length) break;
    const size = options.batchSize ?? 30;
    for (let i = 0; i < rows.length; i += size) {
      const expected = rows
        .slice(i, i + size)
        .map((r) => ({ address: hex(r.address), hearts: r.liquid_hearts as string }));
      await compareAccounts(source, expected, h, signal, options, offset);
      offset += expected.length;
    }
    after = rows.at(-1)!.address;
  }
}

/** Comparisons only: no writer, initialization, recovery or canonical mutation. */
export async function auditState(
  reader: pg.Client,
  chain: number,
  sources: readonly Source[],
  signal: AbortSignal,
  options: AuditOptions = {},
) {
  const {
    rows: [cursor],
  } = await reader.query('SELECT * FROM hdd.sync_state WHERE chain_id=$1', [chain]);
  if (!cursor) throw new Error('Chain not initialized.');
  await reconcile(reader, chain);
  const {
    rows: [current],
  } = await reader.query('SELECT * FROM hdd.current_state WHERE chain_id=$1', [chain]);
  for (const source of sources) {
    const h = plainHeader(await source.header(cursor.block_number, signal, true));
    if (
      h.hash !== hex(cursor.block_hash) ||
      (options.header && digest(h) !== digest(options.header))
    )
      throw new Error('Reconciliation checkpoint changed.');
    const state = await source.state(h, signal);
    if (
      state.circulating !== current.circulating_hearts ||
      state.locked !== current.locked_hearts ||
      state.active !== current.active_shares ||
      state.queued !== current.queued_shares ||
      state.shareRate !== current.raw_share_rate
    )
      throw new Error('Final external aggregate reconciliation mismatch.');
    if (options.balances) await options.balances(source, h);
    else await auditBalances(reader, source, chain, h, signal, options);
  }
}
