import { z } from 'zod';
import { datasets, definitions } from './datasets.ts';
const integer = z.string().regex(/^(0|[1-9][0-9]{0,30})$/);
const hash = z.string().regex(/^[0-9a-f]{64}$/);
const cutoff = z.strictObject({
  blockNumber: integer,
  blockHash: hash,
  blockTime: integer,
  revision: integer,
});
export const bundleSchema = z
  .strictObject({
    id: z.uuid(),
    formatVersion: z.literal(1),
    calculationVersion: z.literal('hex-native-1'),
    chainId: z.union([z.literal(1), z.literal(369)]),
    createdAt: z.iso.datetime(),
    currentIndex: cutoff.extend({ finality: z.enum(['confirmed', 'finalized']) }),
    ranking: cutoff.extend({ day: z.number().int().min(0).max(65535) }).nullable(),
    dailyCutoff: z.number().int().min(0).max(65535).nullable(),
    dailyPayoutBlock: integer.nullable(),
    origins: z
      .array(z.strictObject({ chainId: z.number().int(), fromBlock: integer, toBlock: integer }))
      .max(2),
    markets: z
      .array(
        z.strictObject({
          source: z.string().regex(/^[a-z][a-z0-9_-]{0,63}$/),
          method: z.enum(['sampled-ohlc', 'source-reported']),
          qualification: z.enum(['peg_assumed', 'source_reported_usd']),
          fromDay: z.number().int().min(0).max(65535),
          throughDay: z.number().int().min(0).max(65535).nullable(),
          version: integer,
          intervalSeconds: z.literal(60),
          completeness: z.literal('observed-intervals-only'),
          sourceTime: integer.nullable(),
          blockNumber: integer.nullable(),
          blockHash: hash.nullable(),
        }),
      )
      .max(4),
    files: z
      .array(
        z.strictObject({
          dataset: z.enum(datasets),
          rows: integer,
          bytes: integer,
          sha256: hash,
          columns: z.array(z.strictObject({ name: z.string().max(64), unit: z.string().max(100) })),
        }),
      )
      .length(5),
  })
  .superRefine((v, c) => {
    if (
      new TextEncoder().encode(JSON.stringify(v)).byteLength > 32768 ||
      v.files.some(
        (f) => JSON.stringify(f.columns) !== JSON.stringify(definitions[f.dataset].columns),
      )
    )
      c.addIssue({ code: 'custom', message: 'Invalid dataset metadata.' });
    if (new Set(v.files.map((f) => f.dataset)).size !== 5)
      c.addIssue({ code: 'custom', message: 'Duplicate dataset.' });
  });
export type Bundle = z.infer<typeof bundleSchema>;
