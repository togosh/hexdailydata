import { observationStatus } from '../../domain/freshness.ts';
import { contractDayAt } from '../../domain/day.ts';
import type { BlockRef, Observation } from '../../contracts/api.ts';
import type { Header } from '../projections/input.ts';

export function blockRef(chainId: 1 | 369, h: Header): BlockRef {
  return {
    chainId,
    blockNumber: h.number,
    blockHash: h.hash,
    blockTimestamp: new Date(Number(h.timestamp) * 1000).toISOString(),
  };
}
export function unavailable<T>(method: string, reason: string): Observation<T> {
  return {
    status: 'unavailable',
    value: null,
    asOf: null,
    observedAt: null,
    finality: 'provisional',
    method,
    notes: [],
    reason,
  };
}
export function observed<T>(
  value: T,
  asOf: BlockRef,
  now: number,
  method: string,
  notes: string[] = [],
): Observation<T> {
  const row: Observation<T> = {
    value,
    asOf,
    observedAt: new Date(now).toISOString(),
    status: 'fresh',
    finality: 'provisional',
    method,
    notes,
  };
  return age(row, now);
}
export function age<T>(row: Observation<T>, now: number, estimate = false): Observation<T> {
  if (row.status === 'unavailable') return row;
  const source = BigInt(Math.floor(Date.parse(row.asOf.blockTimestamp) / 1000));
  const status = observationStatus(source, BigInt(Math.floor(now / 1000)));
  // Expiry invalidates a previous day's estimate; it never manufactures a new day.
  if (
    status === 'unavailable' ||
    (estimate && contractDayAt(source) !== contractDayAt(BigInt(Math.floor(now / 1000))))
  )
    return {
      ...row,
      status: 'unavailable',
      value: null,
      reason: estimate ? 'estimate_day_expired' : 'source_expired_or_future',
    };
  return { ...row, status };
}
