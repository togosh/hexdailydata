import { z } from 'zod';
import { contractDayAt } from '../domain/day.ts';
import { formatUnits, hexPerTShareBeforeBonuses, displayRatio } from '../domain/units.ts';
import { ledgerRate, ledgerDate } from './daily-ledger.ts';

const uint = z
  .string()
  .max(78)
  .regex(/^(0|[1-9]\d*)$/)
  .refine((v) => BigInt(v) < 1n << 256n);
export const ProtocolReadingSchema = z
  .strictObject({
    kind: z.literal('protocol'),
    chainId: z.literal(369),
    blockNumber: z.number().int().min(27720852).max(Number.MAX_SAFE_INTEGER),
    blockHash: z.string().regex(/^0x[0-9a-f]{64}$/),
    observedAtUtc: z.iso.datetime({ offset: true }),
    globalWords: z.array(uint).length(13),
  })
  .refine((r) => {
    const w = r.globalWords.map(BigInt),
      time = Date.parse(r.observedAtUtc) / 1000;
    return (
      Number.isInteger(time) &&
      w[10] === BigInt(time) &&
      w[2]! > 0n &&
      w[4]! <= BigInt(contractDayAt(w[10]!))
    );
  }, 'Pinned globals/time/materialized count');
export type ProtocolReading = z.infer<typeof ProtocolReadingSchema>;
export const LedgerAppendSchema = z.strictObject({
  from: z.number().int().min(2498).max(65535),
  overlap: z.array(uint).length(2),
  words: z.array(uint).max(32),
});
export const LedgerSegmentSchema = z.strictObject({
  from: z.number().int().min(2498).max(65535),
  words: z.array(uint).min(1).max(32),
  blockNumber: ProtocolReadingSchema.shape.blockNumber,
  blockHash: ProtocolReadingSchema.shape.blockHash,
  observedAtUtc: ProtocolReadingSchema.shape.observedAtUtc,
  receiptSha256: z.string().regex(/^[0-9a-f]{64}$/),
});
export const baseLedgerTail = [
  '39843667585415780402054842749992773873163573541193571208195',
  '39843667585415780402007518833040386995262157612152416642428',
] as const;
export function decodeDailyWord(value: string) {
  const n = BigInt(uint.parse(value));
  if (n >> 200n) throw Error('DAILY_WORD_PADDING');
  const payout = String(n & ((1n << 72n) - 1n)),
    shares = String((n >> 72n) & ((1n << 72n) - 1n));
  return {
    payoutHearts: payout,
    payoutStakeShares: shares,
    dailyPayoutHEX: formatUnits(BigInt(payout), 8),
    payoutPerTshareHEX: ledgerRate(payout, shares).displayHalfUp18,
  };
}
export function protocolValues(r: ProtocolReading) {
  const w = ProtocolReadingSchema.parse(r).globalWords.map(BigInt);
  return {
    circulatingHEX: formatUnits(w[11]!, 8),
    lockedPrincipalHEX: formatUnits(w[0]!, 8),
    totalHEX: formatUnits(w[11]! + w[0]!, 8),
    tshareRateHEX: displayRatio(hexPerTShareBeforeBonuses(w[2]!), 1),
    activeTshares: formatUnits(w[5]!, 12),
    queuedTshares: formatUnits(w[1]!, 12),
  };
}
export { ledgerDate };
