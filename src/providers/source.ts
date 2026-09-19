import { createHash } from 'node:crypto';
import { performance } from 'node:perf_hooks';
import { z } from 'zod';
import { contractDayAt } from '../domain/day.ts';
import {
  hash,
  headerSchema,
  type Header,
  type Batch,
  type Event,
} from '../services/projections/input.ts';
import {
  decodeHeader,
  plainHeader,
  decodeLog,
  rawLogSchema,
  receiptLogSchema,
  quantity,
  q,
  word,
  words,
  topics,
  selectors,
  globalInfo,
  dailyWords,
} from './abi.ts';
import { RpcClient, RangeError, type RpcCall } from './rpc.ts';

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
  // Complete receipt enumeration binds log membership to each header's transaction list.
  // This conservative acquisition profile must pass the workload/capability canary.
  completeness: z.literal('receipts'),
});
export type SourcePolicy = z.infer<typeof policySchema>;
export class Source {
  readonly policy: SourcePolicy;
  private headers = new Map<string, ReturnType<typeof decodeHeader>>();
  readonly counters = { decodeMs: 0, headersPeak: 0, eventsPeak: 0, receiptCalls: 0 };
  readonly rpc: RpcClient;
  constructor(rpc: RpcClient, policy: unknown) {
    this.rpc = rpc;
    this.policy = policySchema.parse(policy);
  }
  invalidateAfter(number: string) {
    for (const n of this.headers.keys()) if (BigInt(n) > BigInt(number)) this.headers.delete(n);
  }
  async header(number: string, signal: AbortSignal, refresh = false) {
    if (!refresh && this.headers.has(number)) return this.headers.get(number)!;
    const h = decodeHeader(await this.rpc.call('eth_getBlockByNumber', [q(number), false], signal));
    if (h.number !== number) throw new Error('Header number mismatch.');
    this.headers.set(number, h);
    while (this.headers.size > 2049) this.headers.delete(this.headers.keys().next().value!);
    this.counters.headersPeak = Math.max(this.counters.headersPeak, this.headers.size);
    return h;
  }
  async rangeHeaders(start: bigint, count: number, signal: AbortSignal) {
    if (!Number.isInteger(count) || count < 1 || count > 2048)
      throw new Error('Header range exceeds checkpoint bound.');
    const result: Header[] = [];
    for (let offset = 0; offset < count; offset += 30) {
      const numbers = Array.from({ length: Math.min(30, count - offset) }, (_, i) =>
        (start + BigInt(offset + i)).toString(),
      );
      const missing = numbers.filter((n) => !this.headers.has(n));
      if (missing.length) {
        const values = await this.rpc.calls(
          missing.map((n) => ({ method: 'eth_getBlockByNumber', params: [q(n), false] })),
          signal,
        );
        for (let i = 0; i < values.length; i++) {
          const h = decodeHeader(values[i]);
          if (h.number !== missing[i]) throw new Error('Header batch identity mismatch.');
          this.headers.set(h.number, h);
        }
      }
      result.push(...numbers.map((n) => plainHeader(this.headers.get(n)!)));
      while (this.headers.size > 2049) this.headers.delete(this.headers.keys().next().value!);
      this.counters.headersPeak = Math.max(this.counters.headersPeak, this.headers.size);
    }
    return result;
  }
  async verify(at: Header, signal: AbortSignal) {
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
    if (finality.mode === 'finalized') return plainHeader(tip);
    const n = BigInt(tip.number) - BigInt(finality.confirmations);
    if (n < 0n) throw new Error('Insufficient confirmation depth.');
    return plainHeader(await this.header(n.toString(), signal, true));
  }
  async callsAt(calls: { data: string }[], h: Header, signal: AbortSignal) {
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
    return (
      await this.callsAt(
        addresses.map((a) => ({ data: selectors.balanceOf + a.slice(2).padStart(64, '0') })),
        h,
        signal,
      )
    ).map((v, i) => ({ address: addresses[i]!, hearts: words(v, 1)[0]!.toString() }));
  }
  async events(headers: Header[], signal: AbortSignal): Promise<Event[]> {
    const first = headers[0]!,
      last = headers.at(-1)!;
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
    const map = new Map(headers.map((h) => [h.number, h]));
    const start = performance.now();
    const logs = response.map((raw) => {
      const input = rawLogSchema.parse(raw),
        h = map.get(BigInt(input.blockNumber).toString());
      if (!h) throw new Error('Out-of-range log.');
      return decodeLog(input, this.rpc.chain, this.rpc.contract, h);
    });
    this.counters.decodeMs += performance.now() - start;
    // A short getLogs array is not completeness evidence. Enumerate every transaction's
    // receipt by identity and compare its entire filtered set, including Transfer.
    const receipts: Event[] = [];
    for (const h of headers) {
      const full = await this.header(h.number, signal);
      for (let i = 0; i < full.transactions.length; i += 30) {
        const txs = full.transactions.slice(i, i + 30);
        this.counters.receiptCalls += txs.length;
        const calls: RpcCall[] = txs.map((tx) => ({
          method: 'eth_getTransactionReceipt',
          params: [tx],
        }));
        const values = await this.rpc.calls(calls, signal);
        for (let j = 0; j < values.length; j++) {
          const r = z
            .object({
              transactionHash: hash,
              transactionIndex: quantity,
              blockHash: hash,
              blockNumber: quantity,
              logs: z.array(receiptLogSchema).max(10000),
            })
            .passthrough()
            .parse(values[j]);
          if (
            r.transactionHash !== txs[j] ||
            BigInt(r.transactionIndex) !== BigInt(i + j) ||
            r.blockHash !== h.hash ||
            BigInt(r.blockNumber).toString() !== h.number
          )
            throw new Error('Receipt identity mismatch.');
          for (const raw of r.logs) {
            if (
              raw.transactionHash !== r.transactionHash ||
              raw.transactionIndex !== r.transactionIndex ||
              raw.blockHash !== r.blockHash ||
              raw.blockNumber !== r.blockNumber
            )
              throw new Error('Receipt log identity mismatch.');
            if (raw.address === this.rpc.contract && Object.values(topics).includes(raw.topics[0]!))
              receipts.push(decodeLog(raw, this.rpc.chain, this.rpc.contract, h));
            if (receipts.length > 2000)
              throw new RangeError('Complete event range exceeds checkpoint bound.');
          }
        }
      }
    }
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
    if (JSON.stringify(normalize(logs)) !== JSON.stringify(normalize(receipts)))
      throw new RangeError('Incomplete/conflicting filtered log range.');
    this.counters.eventsPeak = Math.max(this.counters.eventsPeak, logs.length);
    // Fence reads that straddled a reorg, even when EIP-1898 calls are not needed.
    if ((await this.header(last.number, signal, true)).hash !== last.hash)
      throw new RangeError('Range changed during acquisition.');
    return logs;
  }
  async acquire(
    expected: Batch['expected'],
    headers: Header[],
    sample: string[],
    previous: Header,
    pendingDay: number | null,
    signal: AbortSignal,
  ): Promise<Batch['sources'][number]> {
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
    const last = headers.at(-1)!,
      state = await this.state(last, signal);
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
    return { id: this.rpc.id, operator: this.rpc.operator, headers, events, closes, payouts };
  }
}
