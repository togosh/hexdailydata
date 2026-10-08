import { z } from 'zod';
import { UIntStringSchema, TimestampSchema } from './api.ts';
import { dayStartSeconds } from '../domain/day.ts';
import { payoutHexPerTShare } from '../domain/units.ts';

export const ledgerMeaning =
  'Historical daily storage observed on PulseChain at the fixed block; not original materialization, historical closing state or independently reconstructed events.';
export const ledgerPin = {
  chainId: 369 as const,
  blockNumber: '27720851',
  blockHash: '0x8d7a9233e143884558511f15558a03d88567bc2255d63f670707ff45894b3fb8',
  blockTimestamp: '2026-10-05T15:48:05.000Z',
};
export const ledgerArchiveSha256 =
  '685505bdd91bd5dce91616b8077886bcb79c6211ea946dbc0b2d5681084af3c2';
export const ledgerEndExclusive = 2498;
export const ledgerDate = (day: number) =>
  new Date(Number(dayStartSeconds(day)) * 1000).toISOString().slice(0, 10);
const hash = z.string().regex(/^[0-9a-f]{64}$/);
const amount = (bits: number) => UIntStringSchema.refine((n) => BigInt(n) < 1n << BigInt(bits));
const day = z.number().int().min(0).max(65535);
export const ledgerPinSchema = z.strictObject({
  chainId: z.literal(369),
  blockNumber: z.literal(ledgerPin.blockNumber),
  blockHash: z.literal(ledgerPin.blockHash),
  blockTimestamp: z.literal(ledgerPin.blockTimestamp),
});
export const ledgerRateSchema = z.discriminatedUnion('status', [
  z.strictObject({
    status: z.literal('defined'),
    reason: z.null(),
    rational: z.strictObject({
      numerator: UIntStringSchema,
      denominator: UIntStringSchema.refine((v) => BigInt(v) > 0n),
    }),
    displayHalfUp18: z.string().regex(/^[0-9]+\.[0-9]{18}$/),
  }),
  z.strictObject({
    status: z.literal('undefined'),
    reason: z.literal('undefined_zero_shares'),
    rational: z.null(),
    displayHalfUp18: z.null(),
  }),
]);
export function ledgerRate(payout: string, shares: string): z.infer<typeof ledgerRateSchema> {
  if (BigInt(shares) === 0n)
    return {
      status: 'undefined',
      reason: 'undefined_zero_shares',
      rational: null,
      displayHalfUp18: null,
    };
  const value = payoutHexPerTShare(BigInt(payout), BigInt(shares));
  const scale = 10n ** 18n;
  const rounded = (2n * value.numerator * scale + value.denominator) / (2n * value.denominator);
  return {
    status: 'defined',
    reason: null,
    rational: { numerator: String(value.numerator), denominator: String(value.denominator) },
    displayHalfUp18: `${rounded / scale}.${String(rounded % scale).padStart(18, '0')}`,
  };
}
export const ledgerItemSchema = z
  .strictObject({
    contractDay: day,
    nominalDateUtc: z.iso.date(),
    payoutHearts: amount(72),
    stakeShares: amount(72),
    upper56: amount(56),
    packed: amount(200),
    sourceRefs: z.tuple([z.string().max(64), z.string().max(64)]),
    rate: ledgerRateSchema,
  })
  .refine(
    (r) =>
      r.nominalDateUtc === ledgerDate(r.contractDay) &&
      BigInt(r.packed) ===
        BigInt(r.payoutHearts) + (BigInt(r.stakeShares) << 72n) + (BigInt(r.upper56) << 144n) &&
      JSON.stringify(r.rate) === JSON.stringify(ledgerRate(r.payoutHearts, r.stakeShares)),
    'Inconsistent day, packed word or exact ratio.',
  );
export const ledgerSourceSchema = z.strictObject({
  id: z.string().max(64),
  provider: z.enum(['pulsechainOfficial', 'g4mm4Pulsechain']),
  endpoint: z.enum(['https://rpc.pulsechain.com/', 'https://rpc-pulsechain.g4mm4.io/']),
  attempt: z.number().int().min(1).max(54),
  beginInclusive: day,
  endExclusive: z.number().int().min(1).max(2498),
  responseSha256: hash,
  requestSha256: hash,
  resultSha256: hash,
  captureStartedAt: TimestampSchema,
  captureFinishedAt: TimestampSchema,
});
export const ledgerMetadataSchema = z.strictObject({
  sourceArchiveSha256: z.literal(ledgerArchiveSha256),
  source: z.literal('contract-ledger'),
  contract: z.literal('0x2b591e99afe9f32eaa6214f7b7629768c40eeb39'),
  runtimeSha256: z.literal('331e6384b4acbab47e393ee5f85290cbdd8783be817b52643441c02bc0164511'),
  observationPin: ledgerPinSchema,
  fetchedAt: TimestampSchema,
  captureStartedAt: TimestampSchema,
  state: z.literal('saved'),
  refresh: z.literal('disabled'),
  meaning: z.literal(ledgerMeaning),
  domain: z.strictObject({
    beginInclusive: z.literal(0),
    endExclusive: z.literal(2498),
    materializedEnd: z.literal(2498),
  }),
  checks: z.strictObject({
    pairedIdentity: z.literal(true),
    pairedWords: z.literal(true),
    selectedGetters: z.literal(true),
    repeats: z.literal(true),
    closure: z.literal(true),
  }),
});
export const ledgerDatasetSchema = z.strictObject({
  format: z.literal('hdd-contract-ledger-1'),
  metadata: ledgerMetadataSchema,
  sources: z.array(ledgerSourceSchema).length(20),
  items: z.array(ledgerItemSchema).length(2498),
});
export const ledgerManifestSchema = z.strictObject({
  format: z.literal('hdd-contract-ledger-manifest-1'),
  version: hash,
  datasetSha256: hash,
  datasetBytes: z
    .number()
    .int()
    .positive()
    .max(8 * 1024 * 1024),
  sourceArchiveSha256: z.literal(ledgerArchiveSha256),
  selectedFileHashes: z.record(z.string().max(256), hash),
});
export const ledgerUnavailable = {
  holderCount: 'not_acquired',
  stakerCount: 'not_acquired',
  prices: 'not_acquired',
  closingState: 'not_a_day_close_observation',
  shareRateAtDayClose: 'not_a_day_close_observation',
  activity: 'not_acquired',
  historicalOrigin: 'not_established',
  materialization: 'not_established',
  finality: 'not_independently_verified',
} as const;
export const DailyLedgerResponseSchema = z.strictObject({
  chain: z.literal('pulsechain'),
  source: z.literal('contract-ledger'),
  datasetVersion: hash,
  manifestSha256: hash,
  metadata: ledgerMetadataSchema,
  sources: z.array(ledgerSourceSchema).max(20),
  unavailable: z.strictObject(
    Object.fromEntries(Object.entries(ledgerUnavailable).map(([k, v]) => [k, z.literal(v)])) as {
      [K in keyof typeof ledgerUnavailable]: z.ZodLiteral<(typeof ledgerUnavailable)[K]>;
    },
  ),
  coverage: z.strictObject({
    from: z.iso.date(),
    to: z.iso.date(),
    requested: z.number().int().min(1).max(366),
    returned: z.number().int().min(0).max(366),
    missing: z
      .array(
        z.strictObject({
          contractDay: day,
          nominalDateUtc: z.iso.date(),
          reason: z.literal('outside_captured_domain'),
        }),
      )
      .max(366),
  }),
  items: z.array(ledgerItemSchema).max(366),
});
export type DailyLedgerResponse = z.infer<typeof DailyLedgerResponseSchema>;
