import { z } from 'zod';
import { performance } from 'node:perf_hooks';
import limits from '../../config/limits.json' with { type: 'json' };
import { ProviderBudget, type Lane } from './budget.ts';
import { address, hash } from '../services/projections/input.ts';
import { quantity, dataHex, selectors, topics } from './abi.ts';
import { liveSelectors } from './live-abi.ts';
import {
  RpcExchange,
  attachRpcDiagnostic,
  rpcDiagnostic,
  safeRpcError,
  type RpcDiagnostic,
} from './rpc-diagnostic.ts';

export type ReadTargets = {
  tokens: readonly string[];
  pools: readonly string[];
  factories: readonly string[];
};
export type AddressRequest = Awaited<ReturnType<ProviderBudget['addressRequest']>>;
interface CallOptions {
  request?: AddressRequest;
  addressDiscovery?: boolean;
  addressPage?: boolean;
  settledMetrics?: boolean;
}

export interface RpcCall {
  method: string;
  params: unknown[];
}
export type Transport = (
  body: string,
  signal: AbortSignal,
  /** Absolute attempt deadline, already clipped to the original logical deadline. */
  deadline?: number,
) => Promise<{
  status: number;
  retryAfter: string | null;
  body: AsyncIterable<Uint8Array>;
  close?: () => Promise<void>;
  /** Internal observation shared with a bounded transport wrapper; never a payload. */
  exchange?: RpcExchange;
}>;
export function httpTransport(endpoint: string): Transport {
  const url = new URL(endpoint);
  if (url.protocol !== 'https:' || url.username || url.password || url.hash)
    throw new Error('Explicit HTTPS provider endpoint required.');
  return async (body, signal) => {
    const response = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body,
      signal,
      redirect: 'error',
    });
    if (!response.body) throw new Error('Missing provider response body.');
    return {
      status: response.status,
      retryAfter: response.headers.get('retry-after'),
      body: response.body,
    };
  };
}
export class RangeError extends Error {}
export class RpcError extends Error {
  readonly code: number;
  constructor(code: number) {
    super(`RPC error ${code}`);
    this.code = code;
  }
}
export function validateCall(
  call: RpcCall,
  contract: string,
  targets?: ReadTargets,
  discovery = false,
) {
  const p = call.params;
  if (call.method === 'eth_chainId' && p.length === 0) return;
  if (
    call.method === 'eth_getBlockByNumber' &&
    p.length === 2 &&
    p[1] === false &&
    (p[0] === 'finalized' || p[0] === 'latest' || quantity.safeParse(p[0]).success)
  )
    return;
  if (call.method === 'eth_getTransactionReceipt' && p.length === 1 && hash.safeParse(p[0]).success)
    return;
  if (
    call.method === 'eth_getCode' &&
    p.length === 2 &&
    (p[0] === contract ||
      (typeof p[0] === 'string' &&
        targets &&
        [...targets.tokens, ...targets.pools, ...targets.factories].includes(p[0]))) &&
    quantity.safeParse(p[1]).success
  )
    return;
  if (call.method === 'eth_getLogs' && p.length === 1) {
    const filter = z
      .strictObject({
        address: z.literal(contract),
        fromBlock: quantity,
        toBlock: quantity,
        topics: z.tuple([z.array(z.enum(Object.values(topics) as [string, ...string[]])).min(1)]),
      })
      .parse(p[0]);
    if (BigInt(filter.fromBlock) <= BigInt(filter.toBlock)) return;
  }
  if (call.method === 'eth_call' && p.length === 2) {
    const input = z.strictObject({ to: address, data: dataHex }).parse(p[0]);
    const selector = input.data.slice(0, 10),
      args = input.data.slice(10);
    if (
      discovery &&
      input.to === contract &&
      selector === liveSelectors.stakeCount &&
      p[1] === 'latest' &&
      /^0{24}[0-9a-f]{40}$/.test(args)
    )
      return;
    z.strictObject({ blockHash: hash, requireCanonical: z.literal(true) }).parse(p[1]);
    if (input.to !== contract) {
      if (targets?.tokens.includes(input.to) && selector === liveSelectors.decimals && !args)
        return;
      if (
        targets?.pools.includes(input.to) &&
        [
          liveSelectors.factory,
          liveSelectors.token0,
          liveSelectors.token1,
          liveSelectors.getReserves,
        ].includes(selector) &&
        !args
      )
        return;
      if (
        targets?.factories.includes(input.to) &&
        selector === liveSelectors.getPair &&
        /^0{24}[0-9a-f]{40}0{24}[0-9a-f]{40}$/.test(args)
      )
        return;
      throw new Error('Read-only RPC target rejected.');
    }
    if (
      (selector === liveSelectors.currentDay ||
        (targets?.tokens.includes(contract) && selector === liveSelectors.decimals)) &&
      !args
    )
      return;
    if (selector === liveSelectors.stakeCount && /^0{24}[0-9a-f]{40}$/.test(args)) return;
    if (selector === liveSelectors.stakeLists && /^0{24}[0-9a-f]{104}$/.test(args)) return;
    if ((selector === selectors.totalSupply || selector === selectors.globalInfo) && args === '')
      return;
    if (selector === selectors.balanceOf && /^0{24}[0-9a-f]{40}$/.test(args)) return;
    if (selector === selectors.dailyDataRange && /^[0-9a-f]{128}$/.test(args)) {
      const a = BigInt('0x' + args.slice(0, 64)),
        b = BigInt('0x' + args.slice(64));
      if (a < b && b <= 65536n && b - a <= 1024n) return;
    }
  }
  throw new Error('Read-only RPC allowlist rejected request.');
}
export class RpcClient {
  private nextId = 1;
  readonly counters = {
    bytes: 0,
    requests: 0,
    logical: 0,
    retries: 0,
    transportMs: 0,
    guardsMs: 0,
    methods: {} as Record<string, number>,
    physicalMethods: {} as Record<string, number>,
    selectors: {} as Record<string, number>,
  };
  readonly id: string;
  readonly operator: string | null;
  readonly chain: 1 | 369;
  readonly contract: string;
  readonly transport: Transport;
  readonly budget: ProviderBudget;
  readonly targets: ReadTargets | undefined;
  constructor(
    id: string,
    operator: string | null,
    chain: 1 | 369,
    contract: string,
    transport: Transport,
    budget: ProviderBudget,
    targets?: ReadTargets,
  ) {
    address.parse(contract);
    this.id = id;
    this.operator = operator;
    this.chain = chain;
    this.contract = contract;
    this.transport = transport;
    this.budget = budget;
    if (targets) {
      if (targets.tokens.length > 3 || targets.pools.length > 3 || targets.factories.length > 2)
        throw new Error('Price allowlist too large.');
      for (const value of [...targets.tokens, ...targets.pools, ...targets.factories])
        address.parse(value);
    }
    this.targets = targets;
  }
  async calls(
    calls: RpcCall[],
    signal: AbortSignal,
    deadline = this.budget.clock.now() + 300_000,
    lane: Lane = 'sync',
    options: CallOptions = {},
  ): Promise<unknown[]> {
    if (lane === 'address' && !options.request)
      throw new Error('Address request reservation required.');
    if (options.settledMetrics && lane !== 'metrics')
      throw new Error('Metrics batch scope required.');
    if (
      (options.addressPage || options.addressDiscovery) &&
      (lane !== 'address' || !options.request)
    )
      throw new Error('Address batch scope required.');
    if (options.request && deadline !== options.request.deadline)
      throw new Error('Request deadline cannot be renewed.');
    if (!calls.length || calls.length > (options.addressPage ? 104 : 30))
      throw new Error('RPC batch size out of bounds.');
    if (
      options.addressDiscovery &&
      (calls.length !== 3 ||
        calls[0]?.method !== 'eth_chainId' ||
        calls[1]?.method !== 'eth_getBlockByNumber' ||
        calls[2]?.method !== 'eth_call')
    )
      throw new Error('Invalid discovery batch.');
    if (
      options.addressPage &&
      calls.some(
        (c) =>
          !['eth_getBlockByNumber', 'eth_getCode', 'eth_call'].includes(c.method) ||
          (c.method === 'eth_call' &&
            ![selectors.balanceOf, liveSelectors.stakeCount, liveSelectors.stakeLists].includes(
              (c.params[0] as { data: string }).data.slice(0, 10),
            )),
      )
    )
      throw new Error('Invalid bounded address batch.');
    const guard = performance.now();
    for (const call of calls)
      validateCall(call, this.contract, this.targets, options.addressDiscovery);
    const requests = calls.map((call) => ({ jsonrpc: '2.0', id: this.nextId++, ...call }));
    const body = JSON.stringify(requests);
    this.counters.guardsMs += performance.now() - guard;
    // A queue/deadline/backoff refusal can end retrying before another exchange.
    // Retain only the latest failed exchange, separately from the terminal error.
    let lastDiagnostic: RpcDiagnostic | undefined;
    for (let attempt = 0; ; attempt++) {
      try {
        options.request?.check(calls.length);
        return await this.budget.run(
          lane,
          calls.length,
          deadline,
          signal,
          async () => {
            const remaining = deadline - this.budget.clock.now();
            if (remaining <= 0) throw new Error('Provider deadline expired.');
            const attemptDeadline = Math.min(
              deadline,
              this.budget.clock.now() + limits.provider.requestTimeoutSeconds * 1000,
            );
            const controller = new AbortController();
            const timeout = setTimeout(
              () => controller.abort(new Error('Provider timeout.')),
              Math.min(remaining, limits.provider.requestTimeoutSeconds * 1000),
            );
            const combined = AbortSignal.any([signal, controller.signal]);
            const start = performance.now();
            this.counters.requests++;
            this.counters.logical += calls.length;
            for (const method of new Set(calls.map((call) => call.method)))
              this.counters.physicalMethods[method] =
                (this.counters.physicalMethods[method] ?? 0) + 1;
            for (const call of calls)
              this.counters.methods[call.method] = (this.counters.methods[call.method] ?? 0) + 1;
            for (const call of calls)
              if (call.method === 'eth_call') {
                const selector = (call.params[0] as { data: string }).data.slice(0, 10);
                this.counters.selectors[selector] = (this.counters.selectors[selector] ?? 0) + 1;
              }
            let response: Awaited<ReturnType<Transport>> | undefined;
            let exchange = new RpcExchange(
              this.id,
              requests,
              this.contract,
              this.counters.requests,
              this.budget.clock.now(),
              attemptDeadline,
            );
            const buffers: Buffer[] = [];
            let size = 0;
            let primary: unknown;
            try {
              response = await this.transport(body, combined, attemptDeadline);
              exchange = response.exchange ?? exchange;
              exchange.headers(response.status, response.retryAfter);
              combined.throwIfAborted();
              for await (const chunk of response.body) {
                if (!response.exchange) exchange.observe(chunk);
                combined.throwIfAborted();
                size += chunk.byteLength;
                this.counters.bytes += chunk.byteLength;
                if (size > limits.provider.maximumResponseBytes) {
                  controller.abort();
                  throw new RangeError('Provider response exceeds byte bound.');
                }
                buffers.push(Buffer.from(chunk));
              }
              exchange.complete = true;
              if (response.status === 429 || response.status >= 500) {
                const retry = response.retryAfter;
                const delay =
                  retry && /^\d+$/.test(retry)
                    ? Number(retry) * 1000
                    : retry
                      ? Date.parse(retry) - this.budget.clock.now()
                      : 0;
                await this.budget.backoff(
                  this.budget.clock.now() +
                    Math.max(Number.isFinite(delay) ? delay : 0, 1000 * 2 ** attempt),
                );
                throw new RpcError(response.status);
              }
              if (response.status !== 200)
                throw new Error(`Provider HTTP status ${response.status}.`);
              const parsed: unknown = JSON.parse(
                new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(buffers, size)),
              );
              const rows = z
                .array(
                  z
                    .object({
                      jsonrpc: z.literal('2.0'),
                      id: z.number().int(),
                      result: z.unknown().optional(),
                      error: z.object({ code: z.number().int() }).passthrough().optional(),
                    })
                    .strict(),
                )
                .length(requests.length)
                .parse(parsed);
              const byId = new Map(rows.map((row) => [row.id, row]));
              if (byId.size !== requests.length)
                throw new Error('Duplicate RPC response identity.');
              return requests.map((request) => {
                const row = byId.get(request.id);
                if (!row || 'result' in row === 'error' in row)
                  throw new Error('Missing/conflicting RPC response identity.');
                if (row.error) {
                  if (options.settledMetrics) return { metricReadError: row.error.code };
                  // Speculative indices are never values. The address service may ignore
                  // these ONLY when the authoritative pinned count proves index >= count.
                  if (
                    options.addressPage &&
                    request.method === 'eth_call' &&
                    (request.params[0] as { data: string }).data.startsWith(
                      liveSelectors.stakeLists,
                    )
                  )
                    return { stakeReadError: row.error.code };
                  if ([-32005, -32602].includes(row.error.code))
                    throw new RangeError('Provider range/capability error.');
                  throw new RpcError(row.error.code);
                }
                return row.result;
              });
            } catch (error) {
              primary = rpcDiagnostic(error) ? error : safeRpcError(error);
              attachRpcDiagnostic(
                primary,
                exchange.failure(
                  'rpc',
                  this.budget.clock.now(),
                  Buffer.concat(buffers),
                  combined.aborted || this.budget.clock.now() >= attemptDeadline
                    ? 'deadline'
                    : response
                      ? 'envelope'
                      : 'transport',
                ),
              );
              throw primary;
            } finally {
              clearTimeout(timeout);
              this.counters.transportMs += performance.now() - start;
              try {
                await response?.close?.();
              } catch (error) {
                if (primary) {
                  const diagnostic = rpcDiagnostic(primary);
                  if (diagnostic) diagnostic.cleanupFailed = true;
                } else {
                  attachRpcDiagnostic(
                    error,
                    exchange.failure('rpc', this.budget.clock.now(), undefined, 'close'),
                  );
                  throw error;
                }
              }
            }
          },
          options.request ? () => options.request!.charge(calls.length) : undefined,
        );
      } catch (error) {
        lastDiagnostic = rpcDiagnostic(error) ?? lastDiagnostic;
        if (lastDiagnostic) attachRpcDiagnostic(error, lastDiagnostic);
        if (signal.aborted && rpcDiagnostic(error)) throw error;
        signal.throwIfAborted();
        if (
          error instanceof RangeError ||
          !(
            error instanceof RpcError ||
            (error instanceof Error && /timeout|fetch failed|network/i.test(error.message))
          ) ||
          attempt >= limits.provider.maximumRetriesPerRequest
        )
          throw error;
        this.counters.retries++;
        try {
          await this.budget.backoff(this.budget.clock.now() + 1000 * 2 ** attempt);
        } catch (error) {
          if (lastDiagnostic) attachRpcDiagnostic(error, lastDiagnostic);
          throw error;
        }
      }
    }
  }
  async call(method: string, params: unknown[], signal: AbortSignal) {
    return (await this.calls([{ method, params }], signal))[0];
  }
}
