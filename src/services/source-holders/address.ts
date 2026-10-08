import { createHash } from 'node:crypto';
import { SourceAddressResponseSchema as StakeAddressSchema, SourceStakeSnapshotSchema, sourceUnits } from '../../contracts/source-stakes.ts';
import { SourceHolderLookupSchema, type SourceHolderLookup } from '../../contracts/source-holders.ts';
import { SourceAddressResponseSchema } from '../../contracts/source-address.ts';
import { ApiFailure, restart } from '../../api/errors.ts';
import type { SourceStakeReader } from '../source-stakes/store.ts';
import type { SourceHolderReader } from './store.ts';
import { PageCursors } from '../queries/cursor.ts';

const missing = (reason: 'not_configured' | 'reader_unavailable'): SourceHolderLookup => ({
  state: 'unavailable', reason, holderDatasetVersion: null, snapshot: null, item: null,
  replacementStatus: reason === 'not_configured' ? 'not_configured' : 'rejected',
});

/** Same-pin composition, after access validation; the accepted stake reader stays unchanged. */
export async function sourceAddress(
  stakes: SourceStakeReader, holders: SourceHolderReader | undefined,
  route: 'address' | 'addressStakes',
  q: { chain: 'pulsechain'; source: 'subgraph'; datasetVersion?: string; holderDatasetVersion?: string; limit: number; cursor?: string },
  address: string, signal: AbortSignal, cursors: PageCursors, now: number,
) {
  let holder = missing('not_configured');
  if (!holders && q.holderDatasetVersion) throw restart();
  if (holders) {
    try { holder = await holders.lookup(address, q.holderDatasetVersion, signal); }
    catch (error) {
      signal.throwIfAborted();
      if (error instanceof ApiFailure && error.status !== 503) throw error;
      holder = missing('reader_unavailable');
    }
  }
  if (holder.snapshot !== null && !SourceStakeSnapshotSchema.safeParse(holder.snapshot).success)
    throw new ApiFailure(409, 'source_snapshot_incompatible', 'Saved source snapshots are incompatible.');
  holder = SourceHolderLookupSchema.parse(holder);
  const context = JSON.stringify([holder.holderDatasetVersion, holder.snapshot, holder.state === 'unavailable' ? holder.reason : 'available']);
  const bind = (inner: string) => createHash('sha256').update(JSON.stringify([inner, context])).digest('hex');
  // Reuse the existing signer and public/paid authorities. No new token protocol.
  const combinedCursors = new Proxy(cursors, {
    get(target, key) {
      if (key === 'encode') return (binding: string, identity: string, value: string, time: number, expires?: number) =>
        target.encode(bind(binding), identity, value, time, expires);
      if (key === 'decode') return (text: string | undefined, binding: string, time: number) => target.decode(text, bind(binding), time);
      return Reflect.get(target, key);
    },
  });
  const { holderDatasetVersion: _holderVersion, ...stakeQuery } = q;
  const saved = StakeAddressSchema.parse(await stakes.read(route, stakeQuery, { address }, signal, combinedCursors, now));
  if (holder.snapshot && JSON.stringify(holder.snapshot) !== JSON.stringify(saved.snapshot))
    throw new ApiFailure(409, 'source_snapshot_incompatible', 'Saved source snapshots are incompatible.');
  const liquidBalance = holder.state === 'present_in_saved_inventory' ? {
    sourceToken: holder.item.reported.tokenBalance,
    sourceReportedHex: sourceUnits(holder.item.reported.tokenBalance, 8),
    attribution: 'source_reported_at_saved_pin' as const,
  } : null;
  return SourceAddressResponseSchema.parse({ ...saved, holder, liquidBalance });
}
