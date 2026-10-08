import { z } from 'zod';
import { contractDayAt } from '../../domain/day.ts';
import { compare, stable } from '../../history-bootstrap/normalize.ts';
import {
  ReadingSchema,
  LiquidityBucketSchema,
  ProductMetadataSchema,
  ProductRowSchema,
  metricKeys,
  digest,
  type ProductMetadata,
  type ProductRow,
  type ProductReading,
  marketMethodRevision,
} from '../../contracts/product-daily.ts';
import { readingKey, validateReadings } from './project.ts';

export const MarketUpdateSchema = z.strictObject({
  readings: z.array(ReadingSchema).max(8),
  liquidityHistory: z.array(LiquidityBucketSchema).max(90),
  receiptSha256: digest,
  methodRevision: z.literal(marketMethodRevision).optional(),
});
const same = (a: unknown, b: unknown) => stable(a) === stable(b);
const dateOf = (time: string) => new Date(time).toISOString().slice(0, 10);
const marketFields = [
  'btcPriceUsd',
  'ethPriceUsd',
  'plsPriceUsd',
  'trackedLiquidityUsd',
  'gasPriceWei',
  'baseFeeWei',
  'priorityFeeWei',
  'btcRecordedAtUtc',
  'ethRecordedAtUtc',
  'plsRecordedAtUtc',
  'gasRecordedAtUtc',
  'liquidityRecordedAtUtc',
] as const;

export function mergeObservations(previous: ProductReading[], additions: ProductReading[]) {
  const found = new Map<string, ProductReading>();
  const liquidityIdentities = new Set<string>();
  for (const r of [...previous, ...additions]) {
    validateReadings([r]);
    if (r.kind === 'tracked-liquidity') liquidityIdentities.add('set:' + r.set.id);
    if (r.kind === 'liquidity')
      liquidityIdentities.add('pool:' + stable([r.poolAddress, r.dex, r.version]));
    if (liquidityIdentities.size > 1) throw Error('LIQUIDITY_COHORT_DRIFT');
    const key = readingKey(r) + ':' + new Date(r.observedAtUtc).toISOString();
    const old = found.get(key);
    if (old && !same(old, r)) throw Error('SAME_TIME_MARKET_CONFLICT');
    found.set(key, r);
  }
  if (found.size > 4096) throw Error('MARKET_HISTORY_BOUND');
  return [...found.values()].sort(
    (a, b) =>
      Date.parse(a.observedAtUtc) - Date.parse(b.observedAtUtc) ||
      readingKey(a).localeCompare(readingKey(b)),
  );
}
function validateBuckets(
  observations: ProductReading[],
  buckets: z.infer<typeof LiquidityBucketSchema>[],
) {
  const observedDates = new Map<string, string>();
  for (const r of observations) {
    if (r.kind !== 'tracked-liquidity') continue;
    const date = dateOf(r.observedAtUtc);
    if (date > (observedDates.get(r.set.id) ?? '')) observedDates.set(r.set.id, date);
  }
  if (new Set(buckets.map((b) => b.dateUtc)).size !== buckets.length)
    throw Error('LIQUIDITY_HISTORY_SET');
  for (const b of buckets) {
    const observedDate = observedDates.get(b.setId);
    if (!observedDate) throw Error('LIQUIDITY_HISTORY_SET');
    if (b.dateUtc >= observedDate) throw Error('INCOMPLETE_UTC_HISTORY_DAY');
    if (b.value !== null && compare(b.value, '0') < 0) throw Error('NEGATIVE_LIQUIDITY_BUCKET');
  }
}
export function latestReadings(observations: ProductReading[]) {
  const latest = new Map<string, ProductReading>();
  for (const r of observations) latest.set(readingKey(r), r);
  return validateReadings(
    [...latest.values()].sort((a, b) => readingKey(a).localeCompare(readingKey(b))),
  );
}
function apply(row: ProductRow, r: ProductReading) {
  if (r.kind === 'market') {
    // Current marginal HEX spot is NEVER a historical HEX reference quote.
    if (r.asset === 'HEX') return;
    const fields = {
      BTC: ['btcPriceUsd', 'btcRecordedAtUtc'],
      ETH: ['ethPriceUsd', 'ethRecordedAtUtc'],
      PLS: ['plsPriceUsd', 'plsRecordedAtUtc'],
    } as const;
    const [value, time] = fields[r.asset];
    row[value] = r.value;
    row[time] = r.observedAtUtc;
  } else if (r.kind === 'gas') {
    row.gasPriceWei = r.gasPriceWei;
    row.baseFeeWei = r.baseFeeWei;
    row.priorityFeeWei = r.priorityFeeWei;
    row.gasRecordedAtUtc = r.observedAtUtc;
  } else {
    row.trackedLiquidityUsd = r.value;
    row.liquidityRecordedAtUtc = r.observedAtUtc;
  }
}
function replay(
  rows: ProductRow[],
  observations: ProductReading[],
  buckets: z.infer<typeof LiquidityBucketSchema>[],
) {
  const byDate = new Map(rows.map((r) => [r.dateUtc, r]));
  for (const b of buckets) {
    const r = byDate.get(b.dateUtc);
    if (!r) throw Error('MARKET_HISTORY_OUTSIDE_DOMAIN');
    r.trackedLiquidityUsd = b.value;
    // The bucket timestamp is not a last-update time or verified daily close.
    r.liquidityRecordedAtUtc = null;
  }
  for (const r of observations) {
    const row = byDate.get(dateOf(r.observedAtUtc));
    if (!row) throw Error('MARKET_OBSERVATION_OUTSIDE_DOMAIN');
    apply(row, r);
  }
}
export function validateMarketHistory(rows: readonly ProductRow[], metadata: ProductMetadata) {
  if (!metadata.observations && !metadata.liquidityHistory) return; // Accepted earlier generation.
  const observations = mergeObservations([], metadata.observations ?? []);
  if (
    !same(observations, metadata.observations ?? []) ||
    !same(latestReadings(observations), metadata.readings)
  )
    throw Error('MARKET_LATEST_HISTORY_MISMATCH');
  const buckets = metadata.liquidityHistory ?? [];
  validateBuckets(observations, buckets);
  const expected = rows.map(
    (r) => ({ ...r, ...Object.fromEntries(marketFields.map((k) => [k, null])) }) as ProductRow,
  );
  replay(expected, observations, buckets);
  for (let i = 0; i < rows.length; i++)
    for (const k of marketFields)
      if (rows[i]![k] !== expected[i]![k]) throw Error('MARKET_ROW_HISTORY_MISMATCH');
}

/** Offline bounded extension of an admitted generation; no provider access or pointer writes. */
export function applyMarketUpdate(
  base: {
    rows: readonly ProductRow[];
    metadata: ProductMetadata;
    exceptions: Record<string, unknown>[];
  },
  unknownUpdate: unknown,
) {
  const update = MarketUpdateSchema.parse(unknownUpdate);
  validateReadings(update.readings);
  const prior = base.metadata.observations ?? base.metadata.readings;
  const observations = mergeObservations(prior, update.readings);
  for (const r of update.readings) {
    const old = base.metadata.readings.find((p) => readingKey(p) === readingKey(r));
    if (old && Date.parse(r.observedAtUtc) < Date.parse(old.observedAtUtc))
      throw Error('OLDER_MARKET_OBSERVATION');
  }
  const buckets = new Map((base.metadata.liquidityHistory ?? []).map((b) => [b.dateUtc, b]));
  const latestTime = Math.max(...observations.map((r) => Date.parse(r.observedAtUtc)));
  validateBuckets(observations, update.liquidityHistory);
  for (const b of update.liquidityHistory) {
    const old = buckets.get(b.dateUtc);
    if (old && !same(old, b)) throw Error('HISTORY_BUCKET_CONFLICT');
    buckets.set(b.dateUtc, b);
  }
  const end = Math.max(
    Date.parse(base.metadata.through),
    ...observations.map((r) => Date.parse(dateOf(r.observedAtUtc))),
  );
  if ((end - Date.parse(base.metadata.from)) / 86400000 > 10000) throw Error('MARKET_DATE_BOUND');
  const rows = base.rows.map((r) => ({ ...r }));
  for (let time = Date.parse(base.metadata.through) + 86400000; time <= end; time += 86400000) {
    rows.push(
      ProductRowSchema.parse({
        ...rows.at(-1),
        contractDay: contractDayAt(BigInt(time / 1000)),
        dateUtc: dateOf(new Date(time).toISOString()),
        ...Object.fromEntries(metricKeys.map((k) => [k, null])),
        snapshotRecordedAtUtc: null,
        priceRecordedAtUtc: null,
        priceEra: null,
        btcRecordedAtUtc: null,
        ethRecordedAtUtc: null,
        plsRecordedAtUtc: null,
        gasRecordedAtUtc: null,
        liquidityRecordedAtUtc: null,
      }),
    );
  }
  const liquidityHistory = [...buckets.values()].sort((a, b) => a.dateUtc.localeCompare(b.dateUtc));
  replay(rows, observations, liquidityHistory);
  const gaps: { field: string; from: string; to: string }[] = [];
  for (const field of metricKeys) {
    let gap: (typeof gaps)[number] | undefined;
    for (const row of rows) {
      if (row[field] === null) {
        if (gap) gap.to = row.dateUtc;
        else gap = { field, from: row.dateUtc, to: row.dateUtc };
      } else if (gap) {
        gaps.push(gap);
        gap = undefined;
      }
    }
    if (gap) gaps.push(gap);
  }
  const metadata = ProductMetadataSchema.parse({
    ...base.metadata,
    observations,
    liquidityHistory,
    readings: latestReadings(observations),
    inputHashes: {
      ...base.metadata.inputHashes,
      ['market-' + update.receiptSha256]: update.receiptSha256,
    },
    through: rows.at(-1)!.dateUtc,
    rows: rows.length,
    effectiveAtUtc: new Date(
      Math.max(Date.parse(base.metadata.effectiveAtUtc), latestTime),
    ).toISOString(),
    coverage: {
      ...base.metadata.coverage,
      structuralDates: rows.filter((r) => r.snapshotRecordedAtUtc === null).length,
      gaps,
    },
    methods: [
      ...new Set([
        ...base.metadata.methods,
        'Tracked HEX liquidity is a bounded contemporary pool cohort and a source-derived two-sided USD estimate. Daily reserve buckets are not verified closes; missing constituents are gaps. Live HEX spot never replaces historical reference quotes.',
        ...(update.methodRevision ||
        observations.some((r) => r.kind === 'tracked-liquidity' && r.set.methodRevision)
          ? [
              'Reserve-based method pulsex-four-pool-derived-usd-2: one primary HEX price from materially funded pools corroborated across venues and distinct quote addresses; every HEX reserve uses that common price, each quote reserve its source USD reference. Fixed four-pool cohort. Cached reserveUSD is diagnostic, not the valuation. Shared source inputs are not an independent oracle or token-backing proof.',
            ]
          : []),
      ]),
    ],
    credits: base.metadata.credits.includes('PulseX subgraphs')
      ? base.metadata.credits
      : base.metadata.credits +
        ' Market observations: PulseX subgraphs on PulseChain; paired public RPC pool checks. USD pricing shares source inputs.',
  });
  validateMarketHistory(rows, metadata);
  return { rows, metadata, exceptions: base.exceptions };
}

/** Selection may extend market observations, but cannot rewrite accepted other fields. */
export function preserveMarketHistory(
  previous: { rows: readonly ProductRow[]; metadata: ProductMetadata },
  next: { rows: readonly ProductRow[]; metadata: ProductMetadata },
) {
  const nextObservations = next.metadata.observations ?? next.metadata.readings;
  for (const r of previous.metadata.observations ?? previous.metadata.readings)
    if (!nextObservations.some((n) => same(n, r))) throw Error('MARKET_HISTORY_REGRESSION');
  for (const b of previous.metadata.liquidityHistory ?? [])
    if (!next.metadata.liquidityHistory?.some((n) => same(n, b)))
      throw Error('LIQUIDITY_HISTORY_REGRESSION');
  const market = new Set<string>(marketFields);
  for (let i = 0; i < previous.rows.length; i++)
    for (const [k, v] of Object.entries(previous.rows[i]!))
      if (!market.has(k) && next.rows[i]?.[k as keyof ProductRow] !== v)
        throw Error('ACCEPTED_DAILY_FIELD_CHANGED');
}
