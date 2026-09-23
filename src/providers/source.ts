import { createHash } from 'node:crypto';
import { performance } from 'node:perf_hooks';
import { z } from 'zod';
import { contractDayAt } from '../domain/day.ts';
import { hash, type Header, type Batch, type Event } from '../services/projections/input.ts';
import {
  decodeHeader,
  plainHeader,
  decodeLog,
  rawLogSchema,
  q,
  word,
  words,
  topics,
  selectors,
  globalInfo,
  dailyWords,
} from './abi.ts';
import { RpcClient, RangeError } from './rpc.ts';
import {
  bindingSchema,
  assertEventRange,
  assertObservation,
  assertDeclaredHeader,
  type SourceBinding,
  type SourceIdentity,
} from './binding.ts';

export const policySchema = z.strictObject({
  codeHash: hash,
  finality: z.discriminatedUnion('mode', [
    z.strictObject({ mode: z.literal('finalized') }),
    z.strictObject({
      mode: z.literal('confirmed'),
      confirmations: z.number().int().min(1).max(100000),
      rollbackBlocks: z.number().int().min(1).max(100000),
    }),
  ]),
  // Complete filtered sets are corroborated, not a proof against shared omissions.
  completeness: z.literal('filtered-ranges'),
});
export type SourcePolicy = z.infer<typeof policySchema>;
export class Source {
  readonly policy: SourcePolicy;
  private headers = new Map<string, Header>();
  readonly counters = {
    decodeMs: 0,
    headersPeak: 0,
    eventsPeak: 0,
    receiptCalls: 0,
    searchCalls: 0,
    observationsPeak: 0,
  };
  readonly rpc: RpcClient;
  readonly binding: SourceBinding;
  readonly identity: SourceIdentity;
  get originChainId() {
    return this.binding.originChainId;
  }
  constructor(rpc: RpcClient, policy: unknown, binding?: unknown, identity?: SourceIdentity) {
    this.rpc = rpc;
    this.policy = policySchema.parse(policy);
    this.binding = bindingSchema.parse(
      binding ?? {
        version: 1,
        networkChainId: rpc.chain,
        originChainId: rpc.chain,
        contract: rpc.contract,
        codeHash: this.policy.codeHash,
        common: null,
      },
    );
    if (
      this.binding.networkChainId !== rpc.chain ||
      this.binding.contract !== rpc.contract ||
      this.binding.codeHash !== this.policy.codeHash
    )
      throw new Error('Source transport/code binding mismatch.');
    this.identity = identity ?? {
      id: rpc.id,
      operator: rpc.operator,
      accountGroup: null,
      endpointAlias: null,
    };
    if (this.identity.id !== rpc.id || this.identity.operator !== rpc.operator)
      throw new Error('Source identity mismatch.');
  }
  invalidateAfter(number: string) {
    for (const n of this.headers.keys()) if (BigInt(n) > BigInt(number)) this.headers.delete(n);
  }
  async header(number: string, signal: AbortSignal, refresh = false) {
    assertObservation(this.binding, number);
    if (!refresh && this.headers.has(number)) return this.headers.get(number)!;
    const h = decodeHeader(await this.rpc.call('eth_getBlockByNumber', [q(number), false], signal));
    if (h.number !== number) throw new Error('Header number mismatch.');
    assertDeclaredHeader(this.binding, plainHeader(h));
    this.headers.set(number, plainHeader(h));
    while (this.headers.size > 2049) this.headers.delete(this.headers.keys().next().value!);
    this.counters.headersPeak = Math.max(this.counters.headersPeak, this.headers.size);
    return h;
  }
  /** Select actual observations without allocating an entry per skipped block. */
  private async plan(expected: Batch['expected'], to: string, signal: AbortSignal) {
    assertObservation(this.binding, expected.blockNumber);
    assertEventRange(this.binding, (BigInt(expected.blockNumber) + 1n).toString(), to);
    const observations = new Map<string, Header>();
    const observe = async (number: string) => {
      if (observations.has(number)) return observations.get(number)!;
      if (observations.size >= 2048) throw new RangeError('Verified header bound exceeded.');
      const h = plainHeader(await this.header(number, signal, true));
      observations.set(number, h);
      this.counters.observationsPeak = Math.max(this.counters.observationsPeak, observations.size);
      return h;
    };
    const previous = await observe(expected.blockNumber);
    if (previous.hash !== expected.blockHash) throw new RangeError('Previous boundary changed.');
    const from = (BigInt(expected.blockNumber) + 1n).toString();
    if (BigInt(to) < BigInt(from) || BigInt(to) - BigInt(from) >= 1048576n)
      throw new Error('Requested block span exceeds bound.');
    const first = await observe(from);
    let last = await observe(to);
    let next: Header | null = null;
    const day = contractDayAt(BigInt(first.timestamp));
    if (day - contractDayAt(BigInt(previous.timestamp)) > 32)
      throw new RangeError('Too many day transitions.');
    // Checked binary brackets find the real last-before / first-after pair.
    // No timestamp interpolation or claim of parent linkage across an observed gap.
    if (contractDayAt(BigInt(last.timestamp)) > day) {
      let low = first,
        high = last;
      while (BigInt(high.number) - BigInt(low.number) > 1n) {
        this.counters.searchCalls++;
        const mid = await observe(((BigInt(low.number) + BigInt(high.number)) / 2n).toString());
        if (
          BigInt(mid.timestamp) <= BigInt(low.timestamp) ||
          BigInt(mid.timestamp) >= BigInt(high.timestamp)
        )
          throw new RangeError('Contradictory day-search bracket.');
        if (contractDayAt(BigInt(mid.timestamp)) === day) low = mid;
        else high = mid;
      }
      if (high.parentHash !== low.hash) throw new RangeError('Day boundary parent disagreement.');
      last = low;
      next = high;
    }
    return { previous, first, last, next, observations };
  }
  async verify(at: Header, signal: AbortSignal) {
    assertDeclaredHeader(this.binding, at);
    const [chain, code] = await this.rpc.calls(
      [
        { method: 'eth_chainId', params: [] },
        { method: 'eth_getCode', params: [this.rpc.contract, q(at.number)] },
      ],
      signal,
    );
    if (
      chain !== q(this.rpc.chain) ||
      typeof code !== 'string' ||
      !/^0x(?:[0-9a-f]{2})+$/.test(code) ||
      '0x' +
        createHash('sha256')
          .update(Buffer.from(code.slice(2), 'hex'))
          .digest('hex') !==
        this.policy.codeHash
    )
      throw new Error('Wrong provider chain/deployed code.');
    const observed = await this.header(at.number, signal, true);
    if (JSON.stringify(plainHeader(observed)) !== JSON.stringify(at))
      throw new Error('Configured boundary identity differs from provider.');
  }
  async target(signal: AbortSignal) {
    const finality = this.policy.finality;
    const tip = decodeHeader(
      await this.rpc.call(
        'eth_getBlockByNumber',
        [finality.mode === 'finalized' ? 'finalized' : 'latest', false],
        signal,
      ),
    );
    const n =
      BigInt(tip.number) - (finality.mode === 'confirmed' ? BigInt(finality.confirmations) : 0n);
    if (n < 0n) throw new Error('Insufficient confirmation depth.');
    // Head discovery remains honest, charged transport work. It cannot expand origin1.
    const parent = this.originChainId === 1 ? this.binding.common?.parent : undefined;
    if (parent && n > BigInt(parent.number) && finality.mode === 'finalized') {
      const identity = plainHeader(
        decodeHeader(await this.rpc.call('eth_getBlockByNumber', [q(tip.number), false], signal)),
      );
      if (JSON.stringify(identity) !== JSON.stringify(plainHeader(tip)))
        throw new Error('Finality target identity disagreement.');
    }
    const target = parent && n > BigInt(parent.number) ? parent.number : n.toString();
    const observed = plainHeader(await this.header(target, signal, true));
    // A numbered refresh cannot replace the identity actually reported as finalized.
    if (target === tip.number && JSON.stringify(observed) !== JSON.stringify(plainHeader(tip)))
      throw new Error('Finality target identity disagreement.');
    return observed;
  }
  async callsAt(calls: { data: string }[], h: Header, signal: AbortSignal) {
    assertDeclaredHeader(this.binding, h);
    const results: unknown[] = [];
    for (let i = 0; i < calls.length; i += 30)
      results.push(
        ...(await this.rpc.calls(
          calls.slice(i, i + 30).map((x) => ({
            method: 'eth_call',
            params: [
              { to: this.rpc.contract, data: x.data },
              { blockHash: h.hash, requireCanonical: true },
            ],
          })),
          signal,
        )),
      );
    return results;
  }
  async state(h: Header, signal: AbortSignal) {
    const [global, supply] = await this.callsAt(
      [{ data: selectors.globalInfo }, { data: selectors.totalSupply }],
      h,
      signal,
    );
    const state = globalInfo(global, h);
    if (words(supply, 1)[0]!.toString() !== state.circulating)
      throw new Error('Pinned supply/globalInfo mismatch.');
    return state;
  }
  async balances(addresses: string[], h: Header, signal: AbortSignal) {
    assertDeclaredHeader(this.binding, h);
    const balances: { address: string; hearts: string }[] = [];
    // Keep the complete pinned sample; only the transport page is smaller.
    for (let offset = 0; offset < addresses.length; offset += 10) {
      const page = addresses.slice(offset, offset + 10);
      const values = await this.callsAt(
        page.map((a) => ({ data: selectors.balanceOf + a.slice(2).padStart(64, '0') })),
        h,
        signal,
      );
      balances.push(
        ...values.map((v, i) => ({ address: page[i]!, hearts: words(v, 1)[0]!.toString() })),
      );
    }
    return balances;
  }
  async events(headers: Header[], signal: AbortSignal): Promise<Event[]> {
    if (!headers.length) throw new Error('Event headers required.');
    const first = headers[0]!,
      last = headers.at(-1)!;
    assertEventRange(this.binding, first.number, last.number);
    for (const h of headers) assertDeclaredHeader(this.binding, h);
    const response = await this.rpc.call(
      'eth_getLogs',
      [
        {
          address: this.rpc.contract,
          fromBlock: q(first.number),
          toBlock: q(last.number),
          topics: [Object.values(topics)],
        },
      ],
      signal,
    );
    if (!Array.isArray(response) || response.length > 2000)
      throw new RangeError('Log range too large or malformed.');
    const raw = response.map((value) => rawLogSchema.parse(value));
    const numbers = [...new Set(raw.map((log) => BigInt(log.blockNumber).toString()))];
    if (numbers.some((n) => BigInt(n) < BigInt(first.number) || BigInt(n) > BigInt(last.number)))
      throw new Error('Out-of-range log.');
    const logs: Event[] = [];
    const decoded = new Map<string, ReturnType<typeof decodeHeader>>();
    // Only event blocks need transaction membership checks; discard transaction lists
    // after decoding each bounded group, rather than retaining unrelated transactions.
    for (let offset = 0; offset < numbers.length; offset += 30) {
      const group = numbers.slice(offset, offset + 30);
      const values = await this.rpc.calls(
        group.map((n) => ({ method: 'eth_getBlockByNumber', params: [q(n), false] })),
        signal,
      );
      for (let i = 0; i < group.length; i++) {
        const h = decodeHeader(values[i]);
        if (h.number !== group[i]) throw new Error('Event header number mismatch.');
        assertDeclaredHeader(this.binding, plainHeader(h));
        const prior = headers.find((v) => v.number === h.number);
        if (prior && JSON.stringify(prior) !== JSON.stringify(plainHeader(h)))
          throw new RangeError('Event boundary header disagreement.');
        if (!prior) headers.push(plainHeader(h));
        decoded.set(h.number, h);
      }
      const start = performance.now();
      for (const input of raw) {
        const h = decoded.get(BigInt(input.blockNumber).toString());
        if (!h) continue;
        if (h.transactions[Number(BigInt(input.transactionIndex))] !== input.transactionHash)
          throw new Error('Event transaction/header identity mismatch.');
        logs.push(decodeLog(input, this.originChainId, this.rpc.contract, h));
      }
      this.counters.decodeMs += performance.now() - start;
      decoded.clear();
    }
    // Check ordering in the raw response as well: grouping must never repair it.
    for (let i = 1; i < raw.length; i++) {
      const a = raw[i - 1]!,
        b = raw[i]!;
      if (
        BigInt(b.blockNumber) < BigInt(a.blockNumber) ||
        (b.blockNumber === a.blockNumber &&
          (BigInt(b.logIndex) < BigInt(a.logIndex) ||
            BigInt(b.transactionIndex) < BigInt(a.transactionIndex)))
      )
        throw new Error('Misordered source logs.');
    }
    headers.sort((a, b) => (BigInt(a.number) < BigInt(b.number) ? -1 : 1));
    const normalize = (events: Event[]) => {
      const result: Event[] = [];
      for (const e of events) {
        const prior = result.at(-1);
        if (
          prior &&
          (BigInt(e.blockNumber) < BigInt(prior.blockNumber) ||
            (e.blockNumber === prior.blockNumber &&
              (e.logIndex < prior.logIndex || e.transactionIndex < prior.transactionIndex)))
        )
          throw new Error('Misordered source logs.');
        if (prior?.blockNumber === e.blockNumber && prior.logIndex === e.logIndex) {
          if (JSON.stringify(prior) !== JSON.stringify(e))
            throw new Error('Conflicting source duplicate.');
        } else result.push(e);
      }
      return result;
    };
    normalize(logs);
    this.counters.eventsPeak = Math.max(this.counters.eventsPeak, logs.length);
    // Fence reads that straddled a reorg, even when EIP-1898 calls are not needed.
    if ((await this.header(last.number, signal, true)).hash !== last.hash)
      throw new RangeError('Range changed during acquisition.');
    return logs;
  }
  async acquire(
    expected: Batch['expected'],
    to: string,
    sample: string[],
    pendingDay: number | null,
    signal: AbortSignal,
  ): Promise<Batch['sources'][number]> {
    const { previous, first, last, next, observations } = await this.plan(expected, to, signal);
    const headers = first.number === last.number ? [first] : [first, last];
    const events = await this.events(headers, signal),
      closes: Batch['sources'][number]['closes'] = [],
      payouts: Batch['sources'][number]['payouts'] = [];
    const firstDay = contractDayAt(BigInt(headers[0]!.timestamp)),
      priorDay = contractDayAt(BigInt(previous.timestamp));
    if (firstDay - priorDay > 32) throw new RangeError('Too many day transitions.');
    if (firstDay > priorDay) {
      const state = await this.state(previous, signal),
        balances = await this.balances(sample, previous, signal);
      for (let day = priorDay; day < firstDay; day++)
        closes.push({
          day,
          blockNumber: expected.blockNumber,
          blockHash: expected.blockHash,
          circulating: state.circulating,
          locked: state.locked,
          balances: day === priorDay ? balances : [],
        });
    }
    const state = await this.state(last, signal);
    const begin = pendingDay ?? priorDay,
      end = Math.min(state.dailyCount, firstDay, begin + 1024);
    if (begin < end) {
      const [result] = await this.callsAt(
        [{ data: selectors.dailyDataRange + word(begin) + word(end) }],
        last,
        signal,
      );
      payouts.push(
        ...dailyWords(result, begin, end).map((p) => ({
          ...p,
          blockNumber: last.number,
          blockHash: last.hash,
        })),
      );
    }
    for (const h of headers) {
      const known = observations.get(h.number);
      if (known && JSON.stringify(known) !== JSON.stringify(h))
        throw new RangeError('Contradictory verified observation.');
      observations.set(h.number, h);
    }
    if (observations.size > 2048) throw new RangeError('Verified header bound exceeded.');
    this.counters.observationsPeak = Math.max(this.counters.observationsPeak, observations.size);
    const ordered = [...observations.values()].sort((a, b) =>
      BigInt(a.number) < BigInt(b.number) ? -1 : 1,
    );
    for (let i = 1; i < ordered.length; i++) {
      const a = ordered[i - 1]!,
        b = ordered[i]!;
      if (
        BigInt(b.timestamp) <= BigInt(a.timestamp) ||
        (BigInt(b.number) === BigInt(a.number) + 1n && b.parentHash !== a.hash)
      )
        throw new RangeError('Contradictory observed headers.');
    }
    // Fence boundary/state reads after all acquisition, including day search lookahead.
    const fences = [previous, first, last, ...(next ? [next] : []), ordered.at(-1)!];
    for (const h of new Map(fences.map((v) => [v.number, v])).values())
      if (
        JSON.stringify(plainHeader(await this.header(h.number, signal, true))) !== JSON.stringify(h)
      )
        throw new RangeError('Range boundary changed during acquisition.');
    return {
      id: this.rpc.id,
      operator: this.rpc.operator,
      previous,
      next,
      headers,
      events,
      closes,
      payouts,
    };
  }
}
