import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import { z } from 'zod';
import limits from '../../../config/limits.json' with { type: 'json' };
import { address as addressSchema, headerSchema, type Header } from '../projections/input.ts';
import {
  AddressResultSchema,
  LiveStakePageSchema,
  type AddressResult,
} from '../../contracts/api.ts';
import { decodeHeader, plainHeader, q, selectors, word, words } from '../../providers/abi.ts';
import { decodeStake, liveSelectors } from '../../providers/live-abi.ts';
import { RpcClient } from '../../providers/rpc.ts';
import { pinnedCall, verifyCode } from './price.ts';
import { blockRef } from './observations.ts';
import { ByteCache } from './cache.ts';
import type { AddressBaseline } from './baseline.ts';

const cursorSchema = z.strictObject({
  chain: z.union([z.literal(1), z.literal(369)]),
  address: addressSchema,
  header: headerSchema,
  offset: z.string().regex(/^(0|[1-9][0-9]{0,15})$/),
  count: z.string().regex(/^(0|[1-9][0-9]{0,15})$/),
  expires: z.number().int().safe(),
});
type Cursor = z.infer<typeof cursorSchema>;
type Live = NonNullable<AddressResult['live']>;
interface Shared {
  promise: Promise<Live>;
  controller: AbortController;
  callers: number;
}
export class CursorError extends Error {}

export class AddressService {
  readonly rpc: RpcClient;
  readonly codeHash: string;
  readonly baseline: AddressBaseline;
  readonly cache: ByteCache<Live>;
  private secret = randomBytes(32);
  private inflight = new Map<string, Shared>();
  readonly counters = { hits: 0, coalesced: 0, started: 0, cancelled: 0 };
  constructor(
    rpc: RpcClient,
    codeHash: string,
    baseline: AddressBaseline,
    cacheBytes = limits.addressReads.cacheBytes,
  ) {
    if (rpc.budget.role !== 'api') throw new Error('Address service needs API budget.');
    this.rpc = rpc;
    this.codeHash = codeHash;
    this.baseline = baseline;
    this.cache = new ByteCache(cacheBytes);
  }
  private encode(value: Cursor) {
    const body = Buffer.from(JSON.stringify(value)).toString('base64url');
    return body + '.' + createHmac('sha256', this.secret).update(body).digest('base64url');
  }
  private decode(text: string, address: string): Cursor {
    try {
      if (text.length > 2048) throw new Error();
      const parts = text.split('.');
      if (parts.length !== 2) throw new Error();
      const mac = Buffer.from(parts[1]!, 'base64url');
      const expected = createHmac('sha256', this.secret).update(parts[0]!).digest();
      if (mac.length !== expected.length || !timingSafeEqual(mac, expected)) throw new Error();
      const value = cursorSchema.parse(
        JSON.parse(Buffer.from(parts[0]!, 'base64url').toString('utf8')),
      );
      if (
        value.chain !== this.rpc.chain ||
        value.address !== address ||
        value.expires <= this.rpc.budget.clock.now() ||
        BigInt(value.offset) >= BigInt(value.count)
      )
        throw new Error();
      return value;
    } catch {
      throw new CursorError('Expired or incompatible observation cursor.');
    }
  }
  async get(
    address: string,
    signal: AbortSignal,
    pageSize = 100,
    cursor?: string,
    jobDeadline = this.rpc.budget.clock.now() + 10000,
  ): Promise<AddressResult> {
    addressSchema.parse(address);
    if (!Number.isInteger(pageSize) || pageSize < 1 || pageSize > 100)
      throw new Error('Invalid page size.');
    signal.throwIfAborted();
    const started = this.rpc.budget.clock.now();
    const deadline = Math.min(jobDeadline, started + 10000);
    let continuation: Cursor | undefined;
    try {
      continuation = cursor ? this.decode(cursor, address) : undefined;
    } catch {
      return {
        outcome: 'expired',
        reason: 'cursor_expired_or_incompatible',
        indexed: null,
        live: null,
      };
    }
    // Baseline is independent, bounded SQL, never merged into live exact totals.
    const indexedPromise = within(
      this.baseline.address(this.rpc.chain, address, signal),
      signal,
      deadline - started,
    ).catch(() => null);
    let live: Live | null = null,
      outcome: AddressResult['outcome'] = 'unavailable',
      reason: string | null = null;
    try {
      if (started >= deadline) throw new Error('Address deadline expired.');
      const key = `${this.rpc.chain}/${address}/${pageSize}/${cursor ?? 'latest'}`;
      const cached = this.cache.get(key, started);
      if (cached) {
        this.counters.hits++;
        live = cached;
      } else {
        let shared = this.inflight.get(key);
        if (shared) this.counters.coalesced++;
        else {
          if (this.inflight.size >= limits.addressReads.maximumInflight)
            throw new Error('Address queue saturated.');
          const controller = new AbortController();
          const promise = this.fetch(
            address,
            pageSize,
            continuation,
            deadline,
            controller.signal,
          ).then((value) => {
            this.cache.put(key, value, Date.parse(value.expiresAt), this.rpc.budget.clock.now());
            return value;
          });
          shared = { promise, controller, callers: 0 };
          this.inflight.set(key, shared);
          this.counters.started++;
          void promise
            .finally(() => {
              if (this.inflight.get(key) === shared) this.inflight.delete(key);
            })
            .catch(() => {});
        }
        live = await this.join(shared, signal, deadline);
      }
      outcome = live.page.enumerationComplete ? 'available' : 'partial';
    } catch (error) {
      signal.throwIfAborted();
      outcome =
        error instanceof CursorError
          ? 'expired'
          : error instanceof Error && /quota|cap|queue|deadline/i.test(error.message)
            ? 'quota'
            : 'unavailable';
      reason =
        outcome === 'expired'
          ? 'cursor_expired_or_incompatible'
          : outcome === 'quota'
            ? 'request_budget_or_deadline'
            : 'live_source_unavailable';
    }
    const indexed = await indexedPromise;
    signal.throwIfAborted();
    return AddressResultSchema.parse({ outcome, reason, indexed, live });
  }
  private join(shared: Shared, signal: AbortSignal, deadline: number): Promise<Live> {
    shared.callers++;
    return new Promise((resolve, reject) => {
      let done = false;
      const finish = (error: unknown, value?: Live) => {
        if (done) return;
        done = true;
        clearTimeout(timer);
        signal.removeEventListener('abort', abort);
        shared.callers--;
        if (error) reject(error);
        else resolve(structuredClone(value!));
        if (shared.callers === 0 && error) {
          shared.controller.abort(new Error('Last caller left.'));
          this.counters.cancelled++;
        }
      };
      const abort = () => finish(signal.reason ?? new Error('Caller cancelled.'));
      const timer = setTimeout(
        () => finish(new Error('Address deadline expired.')),
        Math.max(0, deadline - this.rpc.budget.clock.now()),
      );
      signal.addEventListener('abort', abort, { once: true });
      if (signal.aborted) abort();
      shared.promise.then(
        (value) => finish(null, value),
        (error) => finish(error),
      );
    });
  }
  private async fetch(
    address: string,
    size: number,
    cursor: Cursor | undefined,
    deadline: number,
    signal: AbortSignal,
  ): Promise<Live> {
    const rpc = this.rpc,
      clock = rpc.budget.clock;
    const request = await rpc.budget.addressRequest(deadline, cursor ? 1 : 2, signal);
    try {
      let h: Header, countHint: bigint;
      const offset = BigInt(cursor?.offset ?? '0');
      if (cursor) {
        h = cursor.header;
        countHint = BigInt(cursor.count);
      } else {
        // This unpinned count ONLY sizes the next batch. It is never an observation.
        const [chain, raw, hint] = await rpc.calls(
          [
            { method: 'eth_chainId', params: [] },
            { method: 'eth_getBlockByNumber', params: ['latest', false] },
            {
              method: 'eth_call',
              params: [
                { to: rpc.contract, data: liveSelectors.stakeCount + word(BigInt(address)) },
                'latest',
              ],
            },
          ],
          signal,
          deadline,
          'address',
          { request, addressDiscovery: true },
        );
        if (chain !== q(rpc.chain)) throw new Error('Wrong address source chain.');
        h = plainHeader(decodeHeader(raw));
        countHint = words(hint, 1)[0]!;
      }
      const sourceMs = Number(h.timestamp) * 1000;
      if (sourceMs > clock.now() || clock.now() - sourceMs >= 60000)
        throw new CursorError('Observation is outside address freshness.');
      const expires = cursor?.expires ?? Math.min(sourceMs + 60000, clock.now() + 60000);
      const count = Number(
        countHint > offset
          ? countHint - offset < BigInt(size)
            ? countHint - offset
            : BigInt(size)
          : 0n,
      );
      const rows = await rpc.calls(
        [
          { method: 'eth_getBlockByNumber', params: [q(h.number), false] },
          { method: 'eth_getCode', params: [rpc.contract, q(h.number)] },
          pinnedCall(rpc.contract, selectors.balanceOf + word(BigInt(address)), h),
          pinnedCall(rpc.contract, liveSelectors.stakeCount + word(BigInt(address)), h),
          ...Array.from({ length: count }, (_, i) =>
            pinnedCall(
              rpc.contract,
              liveSelectors.stakeLists + word(BigInt(address)) + word(offset + BigInt(i)),
              h,
            ),
          ),
        ],
        signal,
        deadline,
        'address',
        { request, addressPage: true },
      );
      if (!isDeepStrictEqual(plainHeader(decodeHeader(rows[0])), h))
        throw new CursorError('Block no longer canonical.');
      verifyCode(rows[1], this.codeHash);
      const balance = words(rows[2], 1)[0]!,
        total = words(rows[3], 1)[0]!;
      if (total > BigInt(Number.MAX_SAFE_INTEGER) || (cursor && total !== countHint))
        throw new CursorError('Incompatible pinned count.');
      const length = Number(
        total > offset ? (total - offset < BigInt(count) ? total - offset : BigInt(count)) : 0n,
      );
      const items = rows.slice(4, 4 + length).map(decodeStake);
      if (offset > total || clock.now() >= expires || clock.now() >= deadline)
        throw new CursorError('Observation expired.');
      const nextOffset = offset + BigInt(items.length);
      // Zero delivered on a racing discovery still returns a usable balance/count.
      const nextCursor =
        nextOffset < total
          ? this.encode({
              chain: rpc.chain,
              address,
              header: h,
              offset: nextOffset.toString(),
              count: total.toString(),
              expires,
            })
          : null;
      const page = LiveStakePageSchema.parse({
        address,
        asOf: blockRef(rpc.chain, h),
        observedAt: new Date(clock.now()).toISOString(),
        finality: 'provisional',
        stakeCount: total.toString(),
        items,
        nextCursor,
        enumerationComplete: offset === 0n && BigInt(items.length) === total,
      });
      return {
        balanceHearts: balance.toString(),
        page,
        offset: offset.toString(),
        expiresAt: new Date(expires).toISOString(),
      };
    } finally {
      request.close();
    }
  }
  async stake(id: string, signal: AbortSignal, address?: string) {
    if (!/^(0|[1-9][0-9]{0,12})$/.test(id) || BigInt(id) >= 1n << 40n)
      throw new Error('Invalid stake ID.');
    if (address !== undefined) addressSchema.parse(address);
    signal.throwIfAborted();
    const deadline = this.rpc.budget.clock.now() + 10000;
    const indexed = await within(
      this.baseline.stake(this.rpc.chain, id, signal),
      signal,
      10000,
    ).catch(() => null);
    signal.throwIfAborted();
    if (indexed && address !== undefined && address !== indexed.address)
      return { outcome: 'incompatible_owner' as const, indexed, live: null };
    const owner = indexed?.address ?? address;
    if (!owner) return { outcome: 'indexing' as const, indexed, live: null };
    const result = await this.get(owner, signal, 100, undefined, deadline);
    const item = result.live?.page.items.find((x) => x.stakeId === id) ?? null;
    return {
      outcome: item
        ? ('observed' as const)
        : indexed && result.live?.page.enumerationComplete
          ? ('not_current_at_block' as const)
          : result.outcome === 'quota'
            ? ('quota' as const)
            : result.outcome === 'unavailable'
              ? ('unavailable' as const)
              : ('indexing' as const),
      indexed,
      live: item,
      observation: result.live?.page.asOf ?? null,
      observedAt: result.live?.page.observedAt ?? null,
      expiresAt: result.live?.expiresAt ?? null,
    };
  }
}

function within<T>(promise: Promise<T>, signal: AbortSignal, ms: number): Promise<T> {
  return new Promise((resolve, reject) => {
    let done = false;
    const finish = (error: unknown, value?: T) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      signal.removeEventListener('abort', abort);
      if (error) reject(error);
      else resolve(value!);
    };
    const abort = () => finish(signal.reason ?? new Error('Caller cancelled.'));
    const timer = setTimeout(() => finish(new Error('Address deadline expired.')), Math.max(0, ms));
    signal.addEventListener('abort', abort, { once: true });
    if (signal.aborted) abort();
    promise.then(
      (value) => finish(null, value),
      (error) => finish(error),
    );
  });
}
