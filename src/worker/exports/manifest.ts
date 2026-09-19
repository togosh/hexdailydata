import { z } from 'zod';
import type pg from 'pg';
import { datasets, definitions } from './datasets.ts';
import { isDeepStrictEqual } from 'node:util';
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
      Buffer.byteLength(JSON.stringify(v)) > 32768 ||
      v.files.some((f) => !isDeepStrictEqual(f.columns, definitions[f.dataset].columns))
    )
      c.addIssue({ code: 'custom', message: 'Invalid dataset metadata.' });
    if (new Set(v.files.map((f) => f.dataset)).size !== 5)
      c.addIssue({ code: 'custom', message: 'Duplicate dataset.' });
  });
export type Bundle = z.infer<typeof bundleSchema>;
export async function snapshotIdentity(client: pg.Client, chain: 1 | 369) {
  const {
    rows: [s],
  } = await client.query('SELECT * FROM hdd.sync_state WHERE chain_id=$1', [chain]);
  if (!s) throw new Error('Native checkpoint unavailable.');
  const {
    rows: [r],
  } = await client.query('SELECT * FROM hdd.rank_state WHERE chain_id=$1', [chain]);
  const {
    rows: [d],
  } = await client.query(
    'SELECT max(contract_day) AS day,max(payout_block) AS payout_block FROM hdd.daily_stats WHERE chain_id=$1',
    [chain],
  );
  const { rows: history } = await client.query(
    `SELECT h.chain_id,h.start_block,s.block_number FROM hdd.source_history h
    JOIN hdd.sync_state s USING(chain_id) WHERE (h.chain_id=$1 OR ($1=369 AND h.chain_id=1))
      AND h.start_block<=s.block_number ORDER BY h.chain_id`,
    [chain],
  );
  const { rows: markets } = await client.query(
    `SELECT s.*,d.observation FROM hdd.market_sources s
    LEFT JOIN LATERAL (SELECT observation FROM hdd.market_daily WHERE chain_id=s.chain_id AND source=s.source
      AND observation->>'sourceTime' IS NOT NULL ORDER BY contract_day DESC LIMIT 1) d ON true
    WHERE s.chain_id=$1 ORDER BY s.source`,
    [chain],
  );
  const at = (v: typeof s) => ({
    blockNumber: v.block_number,
    blockHash: v.block_hash.toString('hex'),
    blockTime: v.block_time,
    revision: v.revision,
  });
  return {
    chainId: chain,
    currentIndex: { ...at(s), finality: s.finality },
    ranking: r ? { ...at(r), day: r.ranking_day } : null,
    dailyCutoff: d.day,
    dailyPayoutBlock: d.payout_block,
    origins: history.map((h) => ({
      chainId: h.chain_id,
      fromBlock: h.start_block,
      toBlock: h.block_number,
    })),
    markets: markets.map((m) => ({
      source: m.source,
      method: m.method,
      qualification: m.qualification,
      fromDay: m.from_day,
      throughDay: m.through_day,
      version: m.version,
      intervalSeconds: 60 as const,
      completeness: 'observed-intervals-only' as const,
      sourceTime: m.observation?.sourceTime ?? null,
      blockNumber: m.observation?.blockNumber ?? null,
      blockHash: m.observation?.blockHash?.slice(2) ?? null,
    })),
  };
}
