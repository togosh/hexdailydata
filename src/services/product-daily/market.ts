import { z } from 'zod';
import {
  LedgerAppendSchema,
  baseLedgerTail,
  decodeDailyWord,
  ledgerDate,
} from '../../contracts/protocol-daily.ts';
import { contractDayAt } from '../../domain/day.ts';
import { compare, stable, hash } from '../../history-bootstrap/normalize.ts';
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
  ledgerAppend: LedgerAppendSchema.optional(),
  methodRevision: z.literal(marketMethodRevision).optional(),
});
const same = (a: unknown, b: unknown) => stable(a) === stable(b);
const dateOf = (time: string) => new Date(time).toISOString().slice(0, 10);
export const activeMarketBound = 512;
const dayKey = (r: ProductReading) => dateOf(r.observedAtUtc) + ':' + readingKey(r);
const order = (a: ProductReading, b: ProductReading) =>
  Date.parse(a.observedAtUtc) - Date.parse(b.observedAtUtc) ||
  readingKey(a).localeCompare(readingKey(b));

/** At most one exact last reading per independent key/date, never a fabricated close. */
export function marketCheckpoints(readings: ProductReading[]) {
  const days = new Map<string, ProductReading>();
  for (const r of readings) {
    validateReadings([r]);
    const key = dayKey(r),
      old = days.get(key);
    if (old && Date.parse(old.observedAtUtc) === Date.parse(r.observedAtUtc) && !same(old, r))
      throw Error('SAME_TIME_MARKET_CONFLICT');
    if (!old || Date.parse(r.observedAtUtc) > Date.parse(old.observedAtUtc)) days.set(key, r);
  }
  if (days.size > 60006) throw Error('MARKET_CHECKPOINT_BOUND');
  return [...days.values()].sort(order);
}
export function marketEvidence(metadata: ProductMetadata): ProductReading[] {
  if (!metadata.marketStorage)
    return mergeObservations([], metadata.observations ?? metadata.readings);
  const cp = metadata.marketStorage.checkpoints,
    recent = metadata.observations ?? [];
  if (
    recent.length > activeMarketBound ||
    !same(marketCheckpoints(cp), cp) ||
    !same(mergeObservations([], recent), recent)
  )
    throw Error('MARKET_STORAGE_SHAPE');
  // A compact checkpoint and the recent window may overlap a day, not an exact instant.
  const watermarks = latestReadings(cp);
  for (const r of recent) {
    const old = watermarks.find((p) => readingKey(p) === readingKey(r));
    if (old && Date.parse(r.observedAtUtc) <= Date.parse(old.observedAtUtc))
      throw Error('MARKET_CHECKPOINT_OVERLAP');
  }
  const evidence = [...cp, ...recent].sort(order);
  const cohorts = new Set(
    evidence
      .filter((r) => r.kind === 'tracked-liquidity' || r.kind === 'liquidity')
      .map((r) =>
        r.kind === 'tracked-liquidity'
          ? r.set.id
          : stable(r.kind === 'liquidity' && [r.poolAddress, r.dex, r.version]),
      ),
  );
  if (cohorts.size > 1) throw Error('LIQUIDITY_COHORT_DRIFT');
  return evidence;
}
export function marketJournalEntry(metadata: ProductMetadata, update: unknown) {
  const s = metadata.marketStorage;
  if (!s || s.sequence >= 1000000) throw Error('MARKET_JOURNAL_BOUND');
  const body = {
    sequence: s.sequence + 1,
    previous: s.head,
    update: MarketUpdateSchema.parse(update),
  };
  return { ...body, head: hash(stable(body)) };
}
export function migrateMarketMetadata(metadata: ProductMetadata, seedVersion: string) {
  if (metadata.marketStorage) return metadata;
  digest.parse(seedVersion);
  const original = mergeObservations([], metadata.observations ?? metadata.readings);
  const seedMetadataSha256 = hash(stable(metadata));
  const head = hash(stable({ seedVersion, seedMetadataSha256 }));
  // Migration keeps the entire original window in the one seed receipt. Large old
  // windows compact as a whole so an update pair is never split by an arbitrary slice.
  return ProductMetadataSchema.parse({
    ...metadata,
    observations: original.length <= activeMarketBound ? original : [],
    marketStorage: {
      format: 'market-journal-1',
      seedVersion,
      seedMetadataSha256,
      sequence: 0,
      head,
      checkpoints: original.length <= activeMarketBound ? [] : marketCheckpoints(original),
    },
  });
}
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
  } else if (r.kind !== 'protocol') {
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
  const observations = marketEvidence(metadata);
  if (
    (!metadata.marketStorage && !same(observations, metadata.observations ?? [])) ||
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
  const protocol = update.readings.find((r) => r.kind === 'protocol');
  if (Boolean(protocol) !== Boolean(update.ledgerAppend))
    throw Error('PROTOCOL_LEDGER_ATOMIC_REQUIRED');
  if (
    protocol &&
    (update.readings.length !== 1 || update.liquidityHistory.length || update.methodRevision)
  )
    throw Error('PROTOCOL_ONLY_UPDATE');
  const oldProtocol = base.metadata.readings.find((r) => r.kind === 'protocol');
  if (
    protocol &&
    oldProtocol &&
    !same(protocol, oldProtocol) &&
    protocol.blockNumber <= oldProtocol.blockNumber
  )
    throw Error('PROTOCOL_PIN_REGRESSION');
  const segments = [...(base.metadata.ledgerSegments ?? [])];
  const acceptedEnd = segments.reduce((end, s) => {
    if (s.from !== end) throw Error('LEDGER_SEGMENT_ORDER');
    return end + s.words.length;
  }, 2498);
  let repeated = false;
  if (protocol && update.ledgerAppend) {
    const a = update.ledgerAppend,
      tail = [...baseLedgerTail, ...segments.flatMap((s) => s.words)].slice(-2);
    // Exact replay of an already published transaction is a no-op; altered overlap/receipt is not.
    const last = segments.at(-1);
    repeated = Boolean(
      last &&
      same(last, {
        from: a.from,
        words: a.words,
        blockNumber: protocol.blockNumber,
        blockHash: protocol.blockHash,
        observedAtUtc: protocol.observedAtUtc,
        receiptSha256: update.receiptSha256,
      }) &&
      same(protocol, oldProtocol),
    );
    const expectedTail = repeated
      ? [...baseLedgerTail, ...segments.slice(0, -1).flatMap((s) => s.words)].slice(-2)
      : tail;
    if (
      !same(a.overlap, expectedTail) ||
      (!repeated && a.from !== acceptedEnd) ||
      BigInt(a.from + a.words.length) !== BigInt(protocol.globalWords[4]!)
    )
      throw Error('LEDGER_OVERLAP_OR_BOUNDARY');
    a.words.forEach(decodeDailyWord);
    if (!repeated && a.words.length)
      segments.push({
        from: a.from,
        words: a.words,
        blockNumber: protocol.blockNumber,
        blockHash: protocol.blockHash,
        observedAtUtc: protocol.observedAtUtc,
        receiptSha256: update.receiptSha256,
      });
  }
  let prior = base.metadata.observations ?? base.metadata.readings;
  let storage = base.metadata.marketStorage;
  for (const r of update.readings) {
    const old = base.metadata.readings.find((p) => readingKey(p) === readingKey(r));
    if (old && Date.parse(r.observedAtUtc) < Date.parse(old.observedAtUtc))
      throw Error('OLDER_MARKET_OBSERVATION');
    if (old && Date.parse(r.observedAtUtc) === Date.parse(old.observedAtUtc) && !same(old, r))
      throw Error('SAME_TIME_MARKET_CONFLICT');
  }
  if (
    storage &&
    update.readings.every((r) => base.metadata.readings.some((p) => same(p, r))) &&
    update.liquidityHistory.every((b) => base.metadata.liquidityHistory?.some((p) => same(p, b)))
  )
    return base;
  const additions = storage
    ? update.readings.filter((r) => !base.metadata.readings.some((p) => same(p, r)))
    : update.readings;
  if (storage && prior.length + additions.length > activeMarketBound) {
    storage = { ...storage, checkpoints: marketCheckpoints([...storage.checkpoints, ...prior]) };
    prior = [];
  }
  const observations = mergeObservations(prior, additions);
  if (storage) {
    const entry = marketJournalEntry(base.metadata, update);
    storage = { ...storage, sequence: entry.sequence, head: entry.head };
  }
  const evidence = [...(storage?.checkpoints ?? []), ...observations].sort(order);
  const buckets = new Map((base.metadata.liquidityHistory ?? []).map((b) => [b.dateUtc, b]));
  const latestTime = Math.max(...evidence.map((r) => Date.parse(r.observedAtUtc)));
  validateBuckets(evidence, update.liquidityHistory);
  for (const b of update.liquidityHistory) {
    const old = buckets.get(b.dateUtc);
    if (old && !same(old, b)) throw Error('HISTORY_BUCKET_CONFLICT');
    buckets.set(b.dateUtc, b);
  }
  const end = Math.max(
    Date.parse(base.metadata.through),
    ...evidence.map((r) => Date.parse(dateOf(r.observedAtUtc))),
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
  replay(rows, evidence, liquidityHistory);
  if (update.ledgerAppend && !repeated)
    for (const [i, word] of update.ledgerAppend.words.entries()) {
      const day = update.ledgerAppend.from + i,
        row = rows.find((r) => r.contractDay === day);
      if (!row) throw Error('LEDGER_APPEND_OUTSIDE_DOMAIN');
      const fields = decodeDailyWord(word);
      for (const k of Object.keys(fields) as (keyof typeof fields)[])
        if (row[k] !== null) throw Error('LEDGER_OVERWRITE');
      Object.assign(row, fields);
    }
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
    ...(protocol ? { ledgerSegments: segments } : {}),
    ...(storage ? { marketStorage: storage } : {}),
    liquidityHistory,
    readings: latestReadings(evidence),
    inputHashes: {
      ...base.metadata.inputHashes,
      [storage ? 'market-journal' : 'market-' + update.receiptSha256]: storage
        ? storage.head
        : update.receiptSha256,
    },
    through: rows.at(-1)!.dateUtc,
    rows: rows.length,
    effectiveAtUtc: new Date(
      Math.max(Date.parse(base.metadata.effectiveAtUtc), latestTime),
    ).toISOString(),
    coverage: {
      ...base.metadata.coverage,
      ledgerDates: protocol ? Number(protocol.globalWords[4]) : base.metadata.coverage.ledgerDates,
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
  validateLedgerSegments(rows, metadata);
  return { rows, metadata, exceptions: base.exceptions };
}

/** Selection may extend market observations, but cannot rewrite accepted other fields. */
export function preserveMarketHistory(
  previous: { rows: readonly ProductRow[]; metadata: ProductMetadata },
  next: { rows: readonly ProductRow[]; metadata: ProductMetadata },
) {
  if (previous.metadata.marketStorage || next.metadata.marketStorage) {
    const a = previous.metadata.marketStorage,
      b = next.metadata.marketStorage;
    if (
      !b ||
      (a &&
        (a.seedVersion !== b.seedVersion ||
          a.seedMetadataSha256 !== b.seedMetadataSha256 ||
          b.sequence < a.sequence ||
          (b.sequence === a.sequence && b.head !== a.head)))
    )
      throw Error('MARKET_JOURNAL_REGRESSION');
    if (!a && b.seedMetadataSha256 !== hash(stable(previous.metadata)))
      throw Error('MARKET_SEED_MISMATCH');
    const nextDays = new Map(
      marketCheckpoints(marketEvidence(next.metadata)).map((r) => [dayKey(r), r]),
    );
    for (const old of marketCheckpoints(marketEvidence(previous.metadata))) {
      const n = nextDays.get(dayKey(old));
      if (
        !n ||
        Date.parse(n.observedAtUtc) < Date.parse(old.observedAtUtc) ||
        (Date.parse(n.observedAtUtc) === Date.parse(old.observedAtUtc) && !same(n, old))
      )
        throw Error('MARKET_HISTORY_REGRESSION');
      const latest = previous.metadata.readings.find((r) => readingKey(r) === readingKey(old));
      if (!same(n, old) && (!latest || dateOf(latest.observedAtUtc) !== dateOf(old.observedAtUtc)))
        throw Error('MARKET_CLOSED_DATE_CHANGED');
    }
  } else {
    const nextObservations = next.metadata.observations ?? next.metadata.readings;
    for (const r of previous.metadata.observations ?? previous.metadata.readings)
      if (!nextObservations.some((n) => same(n, r))) throw Error('MARKET_HISTORY_REGRESSION');
  }
  for (const b of previous.metadata.liquidityHistory ?? [])
    if (!next.metadata.liquidityHistory?.some((n) => same(n, b)))
      throw Error('LIQUIDITY_HISTORY_REGRESSION');
  const oldSegments = previous.metadata.ledgerSegments ?? [],
    newSegments = next.metadata.ledgerSegments ?? [];
  if (!same(oldSegments, newSegments.slice(0, oldSegments.length)))
    throw Error('LEDGER_HISTORY_REGRESSION');
  validateLedgerSegments(next.rows, next.metadata);
  const previousEnd = 2498 + oldSegments.reduce((n, s) => n + s.words.length, 0);
  const nextEnd = 2498 + newSegments.reduce((n, s) => n + s.words.length, 0);
  const payoutFields = new Set([
    'payoutHearts',
    'payoutStakeShares',
    'dailyPayoutHEX',
    'payoutPerTshareHEX',
  ]);
  const market = new Set<string>(marketFields);
  for (let i = 0; i < previous.rows.length; i++)
    for (const [k, v] of Object.entries(previous.rows[i]!))
      if (
        !market.has(k) &&
        !(
          payoutFields.has(k) &&
          v === null &&
          previous.rows[i]!.contractDay >= previousEnd &&
          previous.rows[i]!.contractDay < nextEnd
        ) &&
        next.rows[i]?.[k as keyof ProductRow] !== v
      )
        throw Error('ACCEPTED_DAILY_FIELD_CHANGED');
}

export function validateLedgerSegments(rows: readonly ProductRow[], metadata: ProductMetadata) {
  let end = 2498,
    block = 27720851;
  for (const s of metadata.ledgerSegments ?? []) {
    if (s.from !== end || s.blockNumber <= block) throw Error('LEDGER_SEGMENT_ORDER');
    for (const word of s.words) {
      const row = rows.find((r) => r.contractDay === end),
        fields = decodeDailyWord(word);
      if (
        !row ||
        row.dateUtc !== ledgerDate(end) ||
        Object.entries(fields).some(([k, v]) => row[k as keyof ProductRow] !== v)
      )
        throw Error('LEDGER_SEGMENT_VALUE');
      end++;
    }
    block = s.blockNumber;
  }
  if (metadata.ledgerSegments && metadata.coverage.ledgerDates !== end)
    throw Error('LEDGER_COVERAGE');
  const r = metadata.readings.find((r) => r.kind === 'protocol');
  if (r && Number(r.globalWords[4]) !== end) throw Error('PROTOCOL_LEDGER_BOUNDARY');
}
