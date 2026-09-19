import { createHash } from 'node:crypto';
import { z } from 'zod';
import { UINT256_MAX } from '../../domain/units.ts';
import { contractDayAt } from '../../domain/day.ts';

export const uint = z
  .string()
  .max(78, { abort: true })
  .regex(/^(0|[1-9][0-9]*)$/, { abort: true })
  .refine((v) => BigInt(v) <= UINT256_MAX);
export const integer = uint.refine((v) => BigInt(v) <= 9223372036854775807n);
export const total = z
  .string()
  .regex(/^(0|[1-9][0-9]*)$/)
  .max(102);
export const address = z.string().regex(/^0x[0-9a-f]{40}$/);
export const hash = z.string().regex(/^0x[0-9a-f]{64}$/);
export const day = z.number().int().min(0).max(65535);
const index = z.number().int().min(0).max(2147483647);
const chain = z.union([z.literal(1), z.literal(369)]);
export const headerSchema = z.strictObject({
  number: integer,
  hash,
  parentHash: hash,
  timestamp: integer,
});
const transfer = z.strictObject({
  kind: z.literal('transfer'),
  sender: address,
  recipient: address,
  hearts: uint,
});
const start = z.strictObject({
  kind: z.literal('stake_start'),
  stakeId: integer,
  address,
  principal: uint,
  shares: uint,
  days: z.number().int().min(1).max(5555),
  auto: z.boolean(),
});
const settlement = {
  stakeId: integer,
  address,
  payout: uint,
  penalty: uint,
  principal: uint.optional(),
  shares: uint.optional(),
};
const end = z.strictObject({
  kind: z.literal('stake_end'),
  ...settlement,
  servedDays: z.number().int().min(0).max(5555),
  prevUnlocked: z.boolean(),
});
const ga = z.strictObject({ kind: z.literal('good_accounting'), ...settlement });
const rate = z.strictObject({
  kind: z.literal('share_rate'),
  rate: uint.refine((v) => BigInt(v) > 0n),
});
const ledger = z.strictObject({ kind: z.literal('daily_update'), beginDay: day, endDay: day });
export const payoutSchema = z.strictObject({
  day,
  payout: uint,
  shares: uint,
  blockNumber: integer,
  blockHash: hash,
});
export type Payout = z.infer<typeof payoutSchema>;
const claim = z.strictObject({ kind: z.literal('claim') });
export const eventSchema = z.strictObject({
  originChainId: chain,
  contract: address,
  blockNumber: integer,
  blockHash: hash,
  transactionHash: hash,
  transactionIndex: index,
  logIndex: index,
  blockTime: integer,
  topics: z.array(hash).max(4),
  data: z
    .string()
    .regex(/^0x(?:[0-9a-f]{2})*$/)
    .max(8194),
  value: z.discriminatedUnion('kind', [transfer, start, end, ga, rate, ledger, claim]),
});
const totals = z.strictObject({ circulating: uint, locked: uint });
export const closeSchema = z.strictObject({
  day,
  blockNumber: integer,
  blockHash: hash,
  ...totals.shape,
  balances: z.array(z.strictObject({ address, hearts: uint })).max(32),
});
const sourceSchema = z.strictObject({
  id: z.string().min(1).max(80),
  operator: z.string().min(1).max(80).nullable(),
  headers: z.array(headerSchema).min(1).max(2048),
  events: z.array(eventSchema).max(2000),
  closes: z.array(closeSchema).max(32),
  payouts: z.array(payoutSchema).max(1024),
});
const batchSchema = z.strictObject({
  chainId: chain,
  contract: address,
  expected: z.strictObject({ blockNumber: integer, blockHash: hash, revision: integer }),
  sources: z.tuple([sourceSchema, sourceSchema]),
});
export type Header = z.infer<typeof headerSchema>;
export type Event = z.infer<typeof eventSchema>;
export type Batch = z.infer<typeof batchSchema>;
export const bytes = (hex: string) => Buffer.from(hex.slice(2), 'hex');
export const hex = (value: Buffer) => '0x' + value.toString('hex');
export function digest(value: unknown) {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex');
}
function normalizeSource(source: Batch['sources'][number], chainId: number, contract: string) {
  const headers = new Map(source.headers.map((h) => [h.number, h]));
  const positionByHash = new Map<string, string>();
  const hashByPosition = new Map<string, string>();
  let previous: Event | undefined;
  const unique: Event[] = [];
  for (const event of source.events) {
    const h = headers.get(event.blockNumber);
    if (
      event.originChainId !== chainId ||
      event.contract !== contract ||
      !h ||
      h.hash !== event.blockHash ||
      h.timestamp !== event.blockTime
    )
      throw new Error('Event chain/contract/header mismatch.');
    const position = `${event.blockNumber}:${event.blockHash}:${event.transactionIndex}`;
    const knownPosition = positionByHash.get(event.transactionHash);
    const knownHash = hashByPosition.get(position);
    if (
      (knownPosition !== undefined && knownPosition !== position) ||
      (knownHash !== undefined && knownHash !== event.transactionHash)
    )
      throw new Error('Conflicting transaction identity.');
    positionByHash.set(event.transactionHash, position);
    hashByPosition.set(position, event.transactionHash);
    if (previous) {
      const order = BigInt(event.blockNumber) - BigInt(previous.blockNumber);
      if (
        order < 0n ||
        (order === 0n &&
          (event.logIndex < previous.logIndex ||
            event.transactionIndex < previous.transactionIndex))
      )
        throw new Error('Events out of canonical order.');
      if (order === 0n && event.logIndex === previous.logIndex) {
        if (JSON.stringify(event) !== JSON.stringify(previous))
          throw new Error('Conflicting duplicate event payload.');
        continue;
      }
    }
    unique.push(event);
    previous = event;
  }
  const payoutDays = new Set<number>();
  for (const payout of source.payouts) {
    const header = headers.get(payout.blockNumber);
    if (
      !header ||
      header.hash !== payout.blockHash ||
      payout.day >= contractDayAt(BigInt(header.timestamp)) ||
      payoutDays.has(payout.day)
    )
      throw new Error('Invalid/duplicate pinned materialized payout.');
    payoutDays.add(payout.day);
  }
  return {
    headers: source.headers,
    events: unique,
    closes: source.closes,
    payouts: source.payouts,
  };
}
/** Compares the actual normalized sets, not caller-provided matching digest assertions.
 * A later acquirer must supply complete decoded responses; agreement cannot prove independence.
 */
export function validateBatch(input: unknown) {
  const batch = batchSchema.parse(input);
  const [a, b] = batch.sources;
  if (a.id === b.id || (a.operator !== null && a.operator === b.operator))
    throw new Error('Two distinct upstreams required.');
  const first = normalizeSource(a, batch.chainId, batch.contract),
    second = normalizeSource(b, batch.chainId, batch.contract);
  if (JSON.stringify(first) !== JSON.stringify(second))
    throw new Error('Native source disagreement.');
  let prior = batch.expected.blockNumber,
    priorHash = batch.expected.blockHash,
    priorTime: bigint | undefined;
  for (const h of first.headers) {
    if (
      BigInt(h.number) !== BigInt(prior) + 1n ||
      h.parentHash !== priorHash ||
      (priorTime !== undefined && BigInt(h.timestamp) <= priorTime)
    )
      throw new Error('Noncontiguous header range.');
    contractDayAt(BigInt(h.timestamp));
    prior = h.number;
    priorHash = h.hash;
    priorTime = BigInt(h.timestamp);
  }
  const last = first.headers.at(-1)!;
  return {
    batch,
    ...first,
    last,
    batchDigest: digest({
      ...batch,
      sources: [
        { ...a, ...first },
        { ...b, ...second },
      ],
    }),
    acceptance: {
      sources: [
        { id: a.id, operator: a.operator },
        { id: b.id, operator: b.operator },
      ],
      eventCount: first.events.length,
      eventDigest: digest(first.events),
      headerDigest: digest(first.headers),
      payoutDigest: digest(first.payouts),
      policy: 'full-range-corroboration-v1',
    },
  };
}
