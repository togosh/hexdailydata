import { keccak_256 } from '@noble/hashes/sha3.js';
import { z } from 'zod';
import {
  eventSchema,
  headerSchema,
  hash,
  address,
  type Header,
  type Event,
} from '../services/projections/input.ts';

export const signature = (text: string) =>
  '0x' + Buffer.from(keccak_256(new TextEncoder().encode(text))).toString('hex');
export const topics = {
  transfer: signature('Transfer(address,address,uint256)'),
  stake_start: signature('StakeStart(uint256,address,uint40)'),
  good_accounting: signature('StakeGoodAccounting(uint256,uint256,address,uint40,address)'),
  stake_end: signature('StakeEnd(uint256,uint256,address,uint40)'),
  share_rate: signature('ShareRateChange(uint256,uint40)'),
  daily_update: signature('DailyDataUpdate(uint256,address)'),
  claim: signature('Claim(uint256,uint256,bytes20,address,address)'),
  claim_assist: signature('ClaimAssist(uint256,uint256,uint256,address)'),
} as const;
export const selectors = {
  totalSupply: signature('totalSupply()').slice(0, 10),
  globalInfo: signature('globalInfo()').slice(0, 10),
  balanceOf: signature('balanceOf(address)').slice(0, 10),
  dailyDataRange: signature('dailyDataRange(uint256,uint256)').slice(0, 10),
} as const;
export const quantity = z
  .string()
  .regex(/^0x(?:0|[1-9a-f][0-9a-f]*)$/)
  .max(66);
export const dataHex = z.string().regex(/^0x(?:[0-9a-f]{2})*$/);
export const rpcNumber = (v: unknown) => BigInt(quantity.parse(v));
export const q = (v: bigint | string | number) => '0x' + BigInt(v).toString(16);
export const word = (v: bigint | string | number) => BigInt(v).toString(16).padStart(64, '0');
export function words(data: unknown, length: number) {
  const text = dataHex.parse(data);
  if (text.length !== 2 + length * 64) throw new Error('Malformed ABI word count.');
  return Array.from({ length }, (_, i) => BigInt('0x' + text.slice(2 + i * 64, 66 + i * 64)));
}
const bits = (v: bigint, offset: number, width: number) =>
  (v >> BigInt(offset)) & ((1n << BigInt(width)) - 1n);
function padding(v: bigint, width: number) {
  if (v >> BigInt(width)) throw new Error('Noncanonical ABI padding.');
}
function flag(v: bigint) {
  if (v > 1n) throw new Error('Noncanonical ABI boolean.');
  return v === 1n;
}
function topicAddress(v: string) {
  padding(BigInt(v), 160);
  return address.parse('0x' + v.slice(-40));
}
export const rawLogSchema = z.object({
  address,
  blockNumber: quantity,
  blockHash: hash,
  transactionHash: hash,
  transactionIndex: quantity,
  logIndex: quantity,
  removed: z.literal(false),
  topics: z.array(hash).min(1).max(4),
  data: dataHex.max(8194),
});
export type RawLog = z.infer<typeof rawLogSchema>;
export function plainHeader(h: Header): Header {
  return { number: h.number, hash: h.hash, parentHash: h.parentHash, timestamp: h.timestamp };
}
export function decodeHeader(input: unknown): Header & { transactions: string[] } {
  const raw = z
    .object({
      number: quantity,
      hash,
      parentHash: hash,
      timestamp: quantity,
      transactions: z.array(hash).max(16384),
    })
    .parse(input);
  if (new Set(raw.transactions).size !== raw.transactions.length)
    throw new Error('Duplicate header transaction.');
  return {
    ...headerSchema.parse({
      number: rpcNumber(raw.number).toString(),
      hash: raw.hash,
      parentHash: raw.parentHash,
      timestamp: rpcNumber(raw.timestamp).toString(),
    }),
    transactions: raw.transactions,
  };
}
/** Layouts are interface facts checked against the explorer Solidity event emitters.
 * Every retained decoded value is derived here from raw bytes, never supplied by a provider.
 */
export function decodeLog(input: unknown, chain: 1 | 369, contract: string, header: Header): Event {
  const log = rawLogSchema.parse(input);
  if (
    log.address !== contract ||
    rpcNumber(log.blockNumber).toString() !== header.number ||
    log.blockHash !== header.hash
  )
    throw new Error('Log affinity mismatch.');
  const kind = Object.entries(topics).find(([, topic]) => topic === log.topics[0])?.[0] as
    keyof typeof topics | undefined;
  if (!kind) throw new Error('Unallowlisted log topic.');
  const topicCount = {
    transfer: 3,
    stake_start: 3,
    good_accounting: 4,
    stake_end: 3,
    share_rate: 2,
    daily_update: 2,
    claim: 4,
    claim_assist: 2,
  }[kind];
  if (log.topics.length !== topicCount) throw new Error('Malformed indexed ABI layout.');
  const count =
    kind === 'claim_assist' ? 3 : ['good_accounting', 'stake_end', 'claim'].includes(kind) ? 2 : 1;
  const w = words(log.data, count),
    a = w[0]!,
    b = w[1] ?? 0n;
  if (kind !== 'transfer' && bits(a, 0, 40).toString() !== header.timestamp)
    throw new Error('Packed event timestamp mismatch.');
  let value: Event['value'];
  if (kind === 'transfer')
    value = {
      kind,
      sender: topicAddress(log.topics[1]!),
      recipient: topicAddress(log.topics[2]!),
      hearts: a.toString(),
    };
  else if (kind === 'stake_start') {
    padding(a, 208);
    padding(BigInt(log.topics[2]!), 40);
    value = {
      kind,
      address: topicAddress(log.topics[1]!),
      stakeId: BigInt(log.topics[2]!).toString(),
      principal: bits(a, 40, 72).toString(),
      shares: bits(a, 112, 72).toString(),
      days: Number(bits(a, 184, 16)),
      auto: flag(bits(a, 200, 8)),
    };
  } else if (kind === 'stake_end' || kind === 'good_accounting') {
    padding(b, kind === 'stake_end' ? 96 : 72);
    padding(BigInt(log.topics[2]!), 40);
    if (kind === 'good_accounting') topicAddress(log.topics[3]!);
    const settlement = {
      address: topicAddress(log.topics[1]!),
      stakeId: BigInt(log.topics[2]!).toString(),
      principal: bits(a, 40, 72).toString(),
      shares: bits(a, 112, 72).toString(),
      payout: bits(a, 184, 72).toString(),
      penalty: bits(b, 0, 72).toString(),
    };
    value =
      kind === 'stake_end'
        ? {
            kind,
            ...settlement,
            servedDays: Number(bits(b, 72, 16)),
            prevUnlocked: flag(bits(b, 88, 8)),
          }
        : { kind, ...settlement };
  } else if (kind === 'share_rate') {
    padding(a, 80);
    padding(BigInt(log.topics[1]!), 40);
    value = { kind, rate: bits(a, 40, 40).toString() };
  } else if (kind === 'daily_update') {
    padding(a, 80);
    flag(bits(a, 72, 8));
    topicAddress(log.topics[1]!);
    const beginDay = Number(bits(a, 40, 16)),
      endDay = Number(bits(a, 56, 16));
    if (beginDay >= endDay) throw new Error('Invalid daily update interval.');
    value = { kind, beginDay, endDay };
  } else {
    if (kind === 'claim') {
      padding(a, 232);
      padding(b, 160);
      if (BigInt(log.topics[1]!) & ((1n << 96n) - 1n))
        throw new Error('Noncanonical bytes20 padding.');
      topicAddress(log.topics[2]!);
      topicAddress(log.topics[3]!);
    } else {
      padding(b, 224);
      padding(w[2]!, 232);
      topicAddress(log.topics[1]!);
    }
    value = { kind: 'claim' };
  }
  return eventSchema.parse({
    originChainId: chain,
    contract,
    blockNumber: header.number,
    blockHash: header.hash,
    transactionHash: log.transactionHash,
    transactionIndex: Number(rpcNumber(log.transactionIndex)),
    logIndex: Number(rpcNumber(log.logIndex)),
    blockTime: header.timestamp,
    topics: log.topics,
    data: log.data,
    value,
  });
}
export function globalInfo(input: unknown, header: Header) {
  const w = words(input, 13);
  if (w[10]!.toString() !== header.timestamp || w[4]! > 65536n || w[2] === 0n)
    throw new Error('Invalid pinned globalInfo.');
  return {
    locked: w[0]!.toString(),
    queued: w[1]!.toString(),
    shareRate: w[2]!.toString(),
    dailyCount: Number(w[4]),
    active: w[5]!.toString(),
    circulating: w[11]!.toString(),
  };
}
export function dailyWords(input: unknown, begin: number, end: number) {
  const w = words(input, 2 + end - begin);
  if (w[0] !== 32n || w[1] !== BigInt(end - begin)) throw new Error('Malformed dailyDataRange.');
  return w.slice(2).map((v, i) => {
    padding(v, 200);
    return {
      day: begin + i,
      payout: bits(v, 0, 72).toString(),
      shares: bits(v, 72, 72).toString(),
    };
  });
}
