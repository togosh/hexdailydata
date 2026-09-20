import { z } from 'zod';
const integer = z.string().regex(/^(0|[1-9][0-9]{0,199})$/);
const ratioSchema = z
  .strictObject({ numerator: integer, denominator: integer })
  .refine(
    (r) => BigInt(r.numerator) > 0n && BigInt(r.denominator) > 0n,
    'Positive market ratio required',
  );
export const marketObservationSchema = z
  .strictObject({
    open: ratioSchema.nullable(),
    high: ratioSchema.nullable(),
    low: ratioSchema.nullable(),
    close: ratioSchema.nullable(),
    volume: integer.nullable(),
    liquidity: integer.nullable(),
    intervals: z.number().int().min(0).max(1440),
    expectedIntervals: z.literal(1440),
    coverage: z.enum(['complete', 'partial', 'missing']),
    sourceTime: z
      .string()
      .regex(/^[0-9]{1,12}$/)
      .nullable(),
    observedTime: z
      .string()
      .regex(/^[0-9]{1,12}$/)
      .nullable(),
    blockNumber: z
      .string()
      .regex(/^[0-9]{1,20}$/)
      .nullable(),
    blockHash: z
      .string()
      .regex(/^0x[0-9a-f]{64}$/)
      .nullable(),
    poolTime: z
      .string()
      .regex(/^[0-9]{1,12}$/)
      .nullable(),
  })
  .superRefine((r, c) => {
    const missing = r.intervals === 0;
    if (
      r.coverage !== (missing ? 'missing' : r.intervals === 1440 ? 'complete' : 'partial') ||
      [r.open, r.high, r.low, r.close, r.sourceTime, r.observedTime].some(
        (x) => (x === null) !== missing,
      )
    )
      c.addIssue({ code: 'custom', message: 'Market completeness mismatch.' });
    const invalid = (message: string) => c.addIssue({ code: 'custom', message });
    if (
      missing &&
      [r.volume, r.liquidity, r.blockNumber, r.blockHash, r.poolTime].some((v) => v !== null)
    )
      invalid('Missing interval has values.');
    if (!missing && r.open && r.high && r.low && r.close) {
      if (
        compare(r.high, r.open) < 0 ||
        compare(r.high, r.close) < 0 ||
        compare(r.low, r.open) > 0 ||
        compare(r.low, r.close) > 0 ||
        compare(r.low, r.high) > 0
      )
        invalid('Invalid OHLC bounds.');
      if (BigInt(r.observedTime!) < BigInt(r.sourceTime!))
        invalid('Collection precedes observation.');
      if (r.poolTime !== null && BigInt(r.poolTime) > BigInt(r.sourceTime!))
        invalid('Future pool update.');
    }
    if ((r.blockNumber === null) !== (r.blockHash === null))
      invalid('Incomplete market block identity.');
  });
type Observation = z.infer<typeof marketObservationSchema>;
const compare = (a: NonNullable<Observation['open']>, b: NonNullable<Observation['open']>) =>
  BigInt(a.numerator) * BigInt(b.denominator) - BigInt(b.numerator) * BigInt(a.denominator);
