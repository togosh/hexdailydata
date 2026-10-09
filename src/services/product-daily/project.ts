import { ProtocolReadingSchema } from '../../contracts/protocol-daily.ts';
import { contractDayAt, dayStartSeconds } from '../../domain/day.ts';
import {
  exact,
  add,
  compare,
  csv,
  hash,
  stable,
  type Daily,
  type Price,
  type Exception,
} from '../../history-bootstrap/normalize.ts';
import { ledgerDatasetSchema } from '../../contracts/daily-ledger.ts';
import {
  metricKeys,
  productMetrics,
  ProductRowSchema,
  ProductMetadataSchema,
  ReadingSchema,
  type ProductMetric,
  type ProductRow,
  type ProductPair,
  type ProductReading,
  productSchemaVersion,
  marketMethodRevision,
  reserveBasedPools,
} from '../../contracts/product-daily.ts';

export const columns = [
  'contractDay',
  'dateUtc',
  'snapshotRecordedAtUtc',
  'priceRecordedAtUtc',
  'btcRecordedAtUtc',
  'ethRecordedAtUtc',
  'plsRecordedAtUtc',
  'gasRecordedAtUtc',
  'liquidityRecordedAtUtc',
  'priceEra',
  ...metricKeys,
];
const dateOf = (value: string) => new Date(value).toISOString().slice(0, 10);
const changes: Partial<Record<ProductMetric, ProductMetric>> = {
  circulatingSupplyChange: 'circulatingHEX',
  stakedSupplyChange: 'stakedHEX',
  stakedHEXGAChange: 'stakedHEXGA',
  totalTsharesChange: 'totalTshares',
  currentHoldersChange: 'currentHolders',
  holderIndexMaximumChange: 'holderIndexMaximum',
  unendedUnaccountedStakerAddressesChange: 'unendedUnaccountedStakerAddresses',
  historicalStakerAddressesChange: 'historicalStakerAddresses',
  tshareRateChangeHEX: 'tshareRateHEX',
  stakedHEXPercentChange: 'stakedHEXPercent',
  netTotalSupplyChangeHEX: 'totalHEX',
};
export const methods = [
  'Daily recorded snapshots use their original UTC record date and latest whole observation on that date; not verified closing or measurement time. No carry-forward.',
  'Calendar changes use consecutive selected dates only. Holder-index and missing-end/GA counts retain their proxy definitions.',
  'Daily payouts use independently pinned contract-day totals; snapshot T-shares are not the payout denominator. Rates are exact rational calculation displayed half-up to 18 places; zero shares mean null.',
  'HEX reference price: admitted early V3, otherwise eligible V2; admitted PulseChain in its separate domain. Explicitly conflicted/excluded primary quotes never fall back. No close/spot/ATH/ROI or cross-era returns.',
  'Ethereum-origin prices stop at the conservative 2022 cap; this is not a fork date. The unqualified 2023 gap remains. Live markets, liquidity and gas are separate meanings.',
];
function index<T>(rows: T[], key: (r: T) => string) {
  const map = new Map<string, T[]>();
  for (const row of rows) {
    const k = key(row);
    const group = map.get(k) ?? [];
    group.push(row);
    map.set(k, group);
  }
  return map;
}
function latest<T extends { recordedAtUtc: string | null }>(rows: T[]) {
  const times = rows.map((r) => r.recordedAtUtc).filter((t): t is string => t !== null);
  if (!times.length) return [];
  const time = Math.max(...times.map(Date.parse));
  return rows.filter((r) => r.recordedAtUtc !== null && Date.parse(r.recordedAtUtc) === time);
}
export function validateReadings(input: unknown[], now = Date.now()): ProductReading[] {
  const readings = input.map((r) => ReadingSchema.parse(r));
  const keys = new Set<string>();
  for (const r of readings) {
    const key = readingKey(r);
    if (keys.has(key) || Date.parse(r.observedAtUtc) > now)
      throw Error('READING_DUPLICATE_OR_FUTURE');
    keys.add(key);
    if (
      r.kind === 'market' &&
      (['HEX', 'PLS'].includes(r.asset) ? r.chainId !== 369 : r.chainId !== undefined)
    )
      throw Error('MARKET_CHAIN_IDENTITY');
    if (r.kind === 'tracked-liquidity') {
      const addresses = r.set.pools.map((p) => p.address);
      if (
        new Set(addresses).size !== addresses.length ||
        r.set.pools.some((p) => compare(p.valueUsd, '0') < 0)
      )
        throw Error('TRACKED_SET_IDENTITY_OR_VALUE');
      const sum = r.set.pools.reduce((total, p) => add(total, p.valueUsd), '0');
      if (compare(sum, r.value) !== 0) throw Error('TRACKED_SET_TOTAL');
      const identity = [...r.set.pools]
        .sort((a, b) => a.address.localeCompare(b.address))
        .map((p) => ({ address: p.address, venue: p.version === 'V1' ? 0 : 1 }));
      const reserveBased = r.set.measure === 'reserve-based source-derived USD estimate';
      if (reserveBased) {
        if (
          r.set.methodRevision !== marketMethodRevision ||
          JSON.stringify(identity) !== JSON.stringify(reserveBasedPools)
        )
          throw Error('TRACKED_SET_METHOD_COHORT');
      } else if (r.set.methodRevision !== undefined) throw Error('TRACKED_SET_METHOD_COHORT');
      const binding = reserveBased ? { method: r.set.methodRevision, pools: identity } : identity;
      if (hash(JSON.stringify(binding)) !== r.set.id) throw Error('TRACKED_SET_DIGEST');
    }
    if (r.kind === 'protocol') {
      ProtocolReadingSchema.parse(r);
      continue;
    }
    const values = r.kind === 'gas' ? [r.gasPriceWei, r.baseFeeWei, r.priorityFeeWei] : [r.value];
    for (const value of values)
      if (
        value !== null &&
        (compare(value, '0') < 0 ||
          ((r.kind === 'market' || r.kind === 'reference') && compare(value, '0') === 0) ||
          (r.kind === 'gas' && !/^\d+$/.test(value)))
      )
        throw Error('READING_UNITS_OR_VALUE');
  }
  return readings;
}
export function readingKey(r: ProductReading) {
  return r.kind === 'market' || r.kind === 'reference'
    ? 'market:' + r.asset
    : r.kind === 'tracked-liquidity'
      ? 'liquidity'
      : r.kind;
}
export function projectDaily(input: {
  daily: Daily[];
  prices: Price[];
  exceptions: Exception[];
  ledger: unknown;
  pair: ProductPair;
  inputHashes: Record<string, string>;
  credits: string;
  readings?: unknown[];
  now?: number;
}) {
  const ledger = ledgerDatasetSchema.parse(input.ledger),
    exceptions: Record<string, unknown>[] = [];
  const readings = validateReadings(input.readings ?? [], input.now);
  const valid = input.daily.filter((r) => r.recordedAtUtc !== null);
  const snapshots = index(valid, (r) => dateOf(r.recordedAtUtc!));
  const prices = index(input.prices, (r) => dateOf(r.recordedAtUtc));
  const payouts = new Map(ledger.items.map((r) => [r.nominalDateUtc, r]));
  const dates = [
    ...snapshots.keys(),
    ...prices.keys(),
    ...payouts.keys(),
    ...readings.map((r) => dateOf(r.observedAtUtc)),
  ].sort();
  if (!dates.length) throw Error('EMPTY_PRODUCT');
  const start = contractDayAt(BigInt(Date.parse(dates[0]!) / 1000));
  const end = contractDayAt(BigInt(Date.parse(dates.at(-1)!) / 1000));
  if (end - start > 10000) throw Error('PRODUCT_DATE_BOUND');
  const excluded = new Set<string>();
  for (const e of input.exceptions) {
    if (['zero_price', 'skeleton'].includes(e.reason)) continue;
    for (const field of e.fields)
      if (['pricePulseX', 'priceUV2', 'priceUV3'].includes(field))
        excluded.add(`${e.body}:${e.day}:${field}`);
  }
  const rows: ProductRow[] = [];
  for (let day = start; day <= end; day++) {
    const dateUtc = new Date(Number(dayStartSeconds(day)) * 1000).toISOString().slice(0, 10);
    const row = {
      contractDay: day,
      dateUtc,
      snapshotRecordedAtUtc: null,
      priceRecordedAtUtc: null,
      priceEra: null,
      btcRecordedAtUtc: null,
      ethRecordedAtUtc: null,
      plsRecordedAtUtc: null,
      gasRecordedAtUtc: null,
      liquidityRecordedAtUtc: null,
      ...Object.fromEntries(metricKeys.map((k) => [k, null])),
    } as ProductRow;
    const candidates = snapshots.get(dateUtc) ?? [],
      selected = latest(candidates);
    if (selected.length) {
      row.snapshotRecordedAtUtc = selected[0]!.recordedAtUtc;
      for (const key of metricKeys.filter((k) => productMetrics[k][2] === 'snapshot')) {
        const tokens = selected.map((r) => r[key] ?? null);
        if (tokens.every((t) => t === tokens[0])) row[key] = tokens[0] as string | null;
        else
          exceptions.push({
            dateUtc,
            field: key,
            reason: 'same_time_conflict',
            legacyDays: selected.map((r) => r.day),
          });
      }
      if (candidates.length > 1 || selected.some((r) => r.day !== day))
        exceptions.push({
          dateUtc,
          reason: 'calendar_snapshot_selection',
          selectedLegacyDays: selected.map((r) => r.day),
          candidateLegacyDays: candidates.map((r) => r.day),
          recordedAtUtc: row.snapshotRecordedAtUtc,
        });
    }
    const previous = rows.at(-1);
    for (const [key, base] of Object.entries(changes) as [ProductMetric, ProductMetric][])
      row[key] =
        previous &&
        previous.contractDay === day - 1 &&
        previous[base] !== null &&
        row[base] !== null
          ? add(row[base]!, previous[base]!, true)
          : null;
    const payout = payouts.get(dateUtc);
    if (payout) {
      row.payoutHearts = payout.payoutHearts;
      row.payoutStakeShares = payout.stakeShares;
      row.dailyPayoutHEX = exact(BigInt(payout.payoutHearts), 8);
      row.payoutPerTshareHEX = payout.rate.displayHalfUp18;
    }
    const dayPrices = prices.get(dateUtc) ?? [];
    const choose = (series: string, field: string, body: string) => {
      const group = latest(dayPrices.filter((p) => p.series === series));
      if (!group.length) return { row: null, blocked: false };
      const blocked =
        group.some((p) => excluded.has(`${body}:${p.day}:${field}`)) ||
        group.some((p) => p.quoteUsd !== group[0]!.quoteUsd);
      if (blocked)
        exceptions.push({
          dateUtc,
          field: 'hexPriceUsd',
          reason: 'excluded_or_conflicted_primary',
          series,
          legacyDays: group.map((p) => p.day),
        });
      return { row: group[0]!, blocked };
    };
    const pulse = choose('pulsechain-hex-reference-usd', 'pricePulseX', 'pulse');
    const v3 = choose('ethereum-origin-v3-reference-usd', 'priceUV3', 'ethereum');
    const v2 = choose('ethereum-origin-v2-reference-usd', 'priceUV2', 'ethereum');
    if (pulse.row && (v3.row || v2.row)) throw Error('OVERLAPPING_PRICE_ERAS');
    const chosen = pulse.row ? pulse : v3.row && (v3.blocked || v3.row.quoteUsd !== null) ? v3 : v2;
    if (chosen.row) {
      row.priceEra = pulse.row ? 'pulsechain' : 'ethereum-origin';
      row.priceRecordedAtUtc = chosen.row.recordedAtUtc;
      row.hexPriceUsd = chosen.blocked ? null : chosen.row.quoteUsd;
      if (v3.row && v2.row)
        exceptions.push({
          dateUtc,
          field: 'hexPriceUsd',
          reason: 'primary_price_priority',
          chosen: chosen.row.series,
          v3: v3.row.quoteUsd,
          v2: v2.row.quoteUsd,
          blocked: chosen.blocked,
        });
    }
    for (const reading of readings.filter((r) => dateOf(r.observedAtUtc) === dateUtc)) {
      if (reading.kind === 'market' || reading.kind === 'reference') {
        // A live HEX spot quote is never a historical reference quote.
        if (reading.asset === 'HEX') continue;
        const field = (
          {
            HEX: 'hexPriceUsd',
            BTC: 'btcPriceUsd',
            ETH: 'ethPriceUsd',
            PLS: 'plsPriceUsd',
          } as const
        )[reading.asset];
        const time = (
          {
            HEX: 'priceRecordedAtUtc',
            BTC: 'btcRecordedAtUtc',
            ETH: 'ethRecordedAtUtc',
            PLS: 'plsRecordedAtUtc',
          } as const
        )[reading.asset];
        row[field] = reading.value;
        row[time] = reading.observedAtUtc;
      } else if (reading.kind === 'gas') {
        row.gasPriceWei = reading.gasPriceWei;
        row.baseFeeWei = reading.baseFeeWei;
        row.priorityFeeWei = reading.priorityFeeWei;
        row.gasRecordedAtUtc = reading.observedAtUtc;
      } else if (reading.kind !== 'protocol') {
        row.trackedLiquidityUsd = reading.value;
        row.liquidityRecordedAtUtc = reading.observedAtUtc;
      }
    }
    rows.push(ProductRowSchema.parse(row));
  }
  const effectiveAtUtc = new Date(
    Math.max(
      Date.parse(input.pair.observedAtUtc),
      Date.parse(ledger.metadata.observationPin.blockTimestamp),
      ...rows.flatMap((r) =>
        [r.snapshotRecordedAtUtc, r.priceRecordedAtUtc].map((t) => (t ? Date.parse(t) : 0)),
      ),
      ...readings.map((r) => Date.parse(r.observedAtUtc)),
    ),
  ).toISOString();
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
  const priceSegments = (['ethereum-origin', 'pulsechain'] as const).flatMap((era) => {
    const found = rows.filter((r) => r.priceEra === era && r.hexPriceUsd !== null);
    return found.length ? [{ era, from: found[0]!.dateUtc, to: found.at(-1)!.dateUtc }] : [];
  });
  const metadata = ProductMetadataSchema.parse({
    schemaVersion: productSchemaVersion,
    methodRevision: 'utc-recorded-snapshot-primary-price-1',
    inputHashes: input.inputHashes,
    pair: input.pair,
    ledgerObservedAtUtc: ledger.metadata.observationPin.blockTimestamp,
    from: rows[0]!.dateUtc,
    through: rows.at(-1)!.dateUtc,
    rows: rows.length,
    effectiveAtUtc,
    readings,
    coverage: {
      snapshotDates: rows.filter((r) => r.snapshotRecordedAtUtc !== null).length,
      ledgerDates: payouts.size,
      priceDates: rows.filter((r) => r.hexPriceUsd !== null).length,
      structuralDates: rows.filter((r) => r.snapshotRecordedAtUtc === null).length,
      gaps,
    },
    priceSegments,
    methods,
    credits: input.credits,
  });
  return { rows, metadata, exceptions };
}
export function productFiles(
  product: Omit<ReturnType<typeof projectDaily>, 'rows'> & { rows: readonly ProductRow[] },
) {
  const files: Record<string, Buffer> = {
    'daily.ndjson': Buffer.from(product.rows.map(stable).join('')),
    'daily.csv': Buffer.from(csv([...product.rows], columns)),
    'metadata.json': Buffer.from(stable(product.metadata)),
    'exceptions.ndjson': Buffer.from(product.exceptions.map(stable).join('')),
  };
  const members = Object.fromEntries(
    Object.entries(files).map(([k, b]) => [k, { bytes: b.length, sha256: hash(b) }]),
  );
  const version = hash(stable({ schemaVersion: productSchemaVersion, files: members }));
  files['MANIFEST.json'] = Buffer.from(
    stable({ schemaVersion: productSchemaVersion, version, files: members }),
  );
  return { version, files, manifestSha256: hash(files['MANIFEST.json']) };
}
