// Candidate-only exact arithmetic and saved-response analysis; no product writes or HTTP.
import { parse, isLosslessNumber } from 'lossless-json';
import { compare, add, exact, hash } from './normalize.ts';
import { decimal } from '../worker/history/input.ts';
import {
  CloseBenchmarkHistorySchema,
  benchmarkCloseBinding,
  benchmarkCloseMethod,
} from '../contracts/product-daily.ts';
import { stable } from './normalize.ts';

// Fixed saved evidence only. No collector invocation or provider fallback.
export const closeBodies = [
  {
    attempt: 1,
    asset: 'BTC',
    page: 1,
    bytes: 135206,
    sha256: '4e6bab95b900f42dadcce309a1574755d1a15ed938c27be93ba0bd36fb7299c4',
  },
  {
    attempt: 2,
    asset: 'BTC',
    page: 2,
    bytes: 136004,
    sha256: '310176d72fb3233ad29fc4500000171b94c8dedab991900d7818e2a612fb492b',
  },
  {
    attempt: 3,
    asset: 'BTC',
    page: 3,
    bytes: 69413,
    sha256: '5e3961a079841480166912f07312058ecadb2921cb295ab716dfa0d8486be664',
  },
  {
    attempt: 5,
    asset: 'ETH',
    page: 1,
    bytes: 131290,
    sha256: 'f9ff858a476f8e5847cd3d35e62691b7527cb033764f342ddf13f3cca0929a2a',
  },
  {
    attempt: 6,
    asset: 'ETH',
    page: 2,
    bytes: 132230,
    sha256: '13588019524df52dc0ddfa3a27287fb462ca80f4563f34d7d28cae20b67107f0',
  },
  {
    attempt: 7,
    asset: 'ETH',
    page: 3,
    bytes: 66388,
    sha256: '8c9da47ad5e32af5eb6bd7c9c1a82006ff69ffe8c1d8b81c164945c7e6c11950',
  },
] as const;
export function selectSavedCloses(normalized: Buffer, bodies: readonly Buffer[]) {
  if (
    normalized.length !== 3698181 ||
    hash(normalized) !== benchmarkCloseBinding.candlesSha256 ||
    bodies.length !== closeBodies.length
  )
    throw Error('CLOSE_INPUT_IDENTITY');
  const rows = closeBodies.flatMap((binding, i) => {
    const raw = bodies[i]!;
    if (raw.length !== binding.bytes || hash(raw) !== binding.sha256)
      throw Error('CLOSE_BODY_IDENTITY');
    const query = {
      step: 86400,
      limit: binding.page === 3 ? 506 : 1000,
      start: [1575331200, 1661558400, 1747785600][binding.page - 1]!,
    };
    const market = binding.asset.toLowerCase() + 'usd';
    const request: Request = {
      id: binding.asset.toLowerCase() + '-daily-' + binding.page,
      asset: binding.asset,
      expectedMarket: binding.asset + '/USD',
      query,
      url: `https://www.bitstamp.net/api/v2/ohlc/${market}/?step=86400&limit=${query.limit}&start=${query.start}&exclude_current_candle=true`,
    };
    return validatePage(raw, request, binding.attempt).candles;
  });
  const candles = mergeCandles(rows);
  if (stable(candles) !== stable(JSON.parse(normalized.toString('utf8'))))
    throw Error('CLOSE_NORMALIZATION_MISMATCH');
  const buckets = candles
    .map((c) => ({ dateUtc: c.labelUtc.slice(0, 10), asset: c.asset, value: c.close }))
    .sort((a, b) => lexical(a.dateUtc, b.dateUtc) || lexical(a.asset, b.asset));
  if (
    Buffer.byteLength(stable(buckets)) !== 287321 ||
    hash(stable(buckets)) !== benchmarkCloseBinding.selectionSha256
  )
    throw Error('CLOSE_BUCKET_IDENTITY');
  const history = CloseBenchmarkHistorySchema.parse({
    methodRevision: benchmarkCloseMethod,
    sourceField: 'close',
    dateMapping: 'unchanged-source-labelled-UTC-date',
    candlesSha256: benchmarkCloseBinding.candlesSha256,
    predecessorHistorySha256: benchmarkCloseBinding.predecessorHistory,
    selectionSha256: benchmarkCloseBinding.selectionSha256,
    buckets,
  });
  return {
    history,
    update: {
      readings: [],
      liquidityHistory: [],
      receiptSha256: hash(stable(history)),
      benchmarkHistory: history,
    },
    reconciliation: candles.map((c) => ({
      dateUtc: c.labelUtc.slice(0, 10),
      asset: c.asset,
      sourceField: 'close',
      value: c.close,
      quoteTimeUtc: null,
      contributors: c.contributors.map((s) => ({
        attempt: s.attempt,
        row: s.row,
        bodySha256: s.bodySha256,
        timestamp: s.values.timestamp,
        close: s.values.close,
      })),
    })),
  };
}

export type Asset = 'BTC' | 'ETH';
export type Request = {
  id: string;
  asset: Asset;
  expectedMarket: string;
  url: string;
  query: { step: number; limit: number; start?: number; end?: number };
};
export type Values = {
  timestamp: string;
  open: string;
  high: string;
  low: string;
  close: string;
  volume: string;
};
export type Contributor = {
  requestId: string;
  attempt: number;
  row: number;
  bodySha256: string;
  values: Values;
  numericJsonFields: string[];
};
export type Candle = Values & {
  asset: Asset;
  step: number;
  labelUtc: string;
  zeroVolume: boolean;
  contributors: Contributor[];
};
const fields = ['timestamp', 'open', 'high', 'low', 'close', 'volume'] as const;
const prices = ['open', 'high', 'low', 'close', 'volume'] as const;
export const domain = { from: '2019-12-03', through: '2026-10-08', dates: 2502 };
export const conventions = ['same-label-open', 'same-label-close', 'previous-label-close'] as const;
const lexical = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);
export const shift = (d: string, n: number) =>
  new Date(Date.parse(d) + n * 86400000).toISOString().slice(0, 10);
export const dates = (from = domain.from, through = domain.through) => {
  const result: string[] = [];
  for (let d = from; d <= through; d = shift(d, 1)) result.push(d);
  return result;
};
function object(v: unknown): Record<string, unknown> {
  if (!v || typeof v !== 'object' || Array.isArray(v) || isLosslessNumber(v))
    throw Error('OBJECT_SHAPE');
  return v as Record<string, unknown>;
}
function keys(v: Record<string, unknown>, allowed: readonly string[]) {
  if (Object.keys(v).some((k) => !allowed.includes(k))) throw Error('UNEXPECTED_SOURCE_FIELD');
}
function token(v: unknown) {
  const s = isLosslessNumber(v) ? v.value : v;
  if (
    typeof s !== 'string' ||
    s.length > 128 ||
    !/^[-]?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d{1,3})?$/.test(s)
  )
    throw Error('DECIMAL_TOKEN');
  const d = decimal(s);
  if (Math.abs(d.scale) > 128) throw Error('DECIMAL_SCALE');
  return s;
}
function strict(raw: Buffer) {
  if (raw.length > 1048576) throw Error('BODY_BOUND');
  const text = new TextDecoder('utf-8', { fatal: true }).decode(raw);
  let depth = 0,
    quote = false,
    escape = false,
    length = 0,
    start = 0;
  // The dependency allows identical duplicate keys. Reject every repeated key
  // lexically, including escaped spellings, before lossless value parsing.
  const keysAtDepth: (Set<string> | null)[] = [];
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (quote) {
      if (++length > 256) throw Error('TOKEN_BOUND');
      if (escape) escape = false;
      else if (c === '\\') escape = true;
      else if (c === '"') {
        quote = false;
        if (/^\s*:/.test(text.slice(i + 1))) {
          const key = JSON.parse(text.slice(start, i + 1)) as string;
          if (key === '__proto__') throw Error('UNEXPECTED_SOURCE_FIELD');
          const seen = keysAtDepth.at(-1);
          if (!seen || seen.has(key)) throw Error('DUPLICATE_JSON_KEY');
          seen.add(key);
        }
      }
    } else if (c === '"') {
      quote = true;
      length = 0;
      start = i;
    } else if (c === '[' || c === '{') {
      if (++depth > 5) throw Error('DEPTH_BOUND');
      keysAtDepth.push(c === '{' ? new Set() : null);
    } else if (c === ']' || c === '}') {
      depth--;
      keysAtDepth.pop();
    }
  }
  return parse(text, undefined, {
    onDuplicateKey: () => {
      throw Error('DUPLICATE_JSON_KEY');
    },
  });
}
export function validatePage(raw: Buffer, q: Request, attempt: number) {
  const u = new URL(q.url),
    market = q.asset.toLowerCase() + 'usd';
  if (
    u.origin !== 'https://www.bitstamp.net' ||
    u.pathname !== `/api/v2/ohlc/${market}/` ||
    u.username ||
    u.password ||
    u.hash ||
    q.expectedMarket !== q.asset + '/USD'
  )
    throw Error('ENDPOINT_IDENTITY');
  const expected = { ...q.query, exclude_current_candle: 'true' };
  if (
    [...u.searchParams].length !== Object.keys(expected).length ||
    Object.entries(expected).some(([k, v]) => u.searchParams.get(k) !== String(v)) ||
    ('start' in expected && 'end' in expected) ||
    ![3600, 86400].includes(q.query.step) ||
    q.query.limit < 1 ||
    q.query.limit > 1000
  )
    throw Error('FROZEN_QUERY');
  const root = object(strict(raw));
  keys(root, ['data', 'pair', 'market']);
  const data = object(root.data);
  keys(data, ['pair', 'market', 'ohlc']);
  const identities = [root.pair, root.market, data.pair, data.market].filter(
    (v) => v !== undefined,
  );
  if (
    !identities.length ||
    identities.some(
      (v) => typeof v !== 'string' || ![q.asset + '/USD', q.asset + 'USD', market].includes(v),
    )
  )
    throw Error('SPOT_USD_IDENTITY');
  if (!Array.isArray(data.ohlc) || data.ohlc.length > q.query.limit) throw Error('ROW_BOUND');
  const candles: Candle[] = data.ohlc.map((v, row) => {
    const r = object(v);
    keys(r, fields);
    if (Object.keys(r).length !== fields.length) throw Error('OHLC_FIELDS');
    const t = Object.fromEntries(fields.map((k) => [k, token(r[k])])) as Values;
    if (!/^[1-9]\d{8,9}$/.test(t.timestamp) || Number(t.timestamp) > 4102444800)
      throw Error('TIMESTAMP');
    for (const k of prices)
      if (compare(t[k], '0') < (k === 'volume' ? 0 : 1)) throw Error('OHLC_SIGN');
    if (
      compare(t.low, t.open) > 0 ||
      compare(t.low, t.close) > 0 ||
      compare(t.high, t.open) < 0 ||
      compare(t.high, t.close) < 0
    )
      throw Error('OHLC_RANGE');
    return {
      ...t,
      asset: q.asset,
      step: q.query.step,
      labelUtc: new Date(Number(t.timestamp) * 1000).toISOString(),
      zeroVolume: compare(t.volume, '0') === 0,
      contributors: [
        {
          requestId: q.id,
          attempt,
          row,
          bodySha256: hash(raw),
          values: t,
          numericJsonFields: fields.filter((k) => isLosslessNumber(r[k])),
        },
      ],
    };
  });
  const union = mergeCandles(candles),
    sorted = [...union].sort((a, b) => Number(a.timestamp) - Number(b.timestamp));
  const phases = [...new Set(sorted.map((c) => Number(c.timestamp) % q.query.step))];
  const first = sorted[0],
    last = sorted.at(-1);
  const cadenceGaps = sorted
    .slice(1)
    .filter((c, i) => Number(c.timestamp) - Number(sorted[i]!.timestamp) !== q.query.step)
    .map((c, i) => c.timestamp);
  const start = q.query.start ?? q.query.end! - (q.query.limit - 1) * q.query.step;
  // One-label edge difference may be inclusivity. Large shifts/empty/short pages
  // are retained coverage findings and stop dispatch; they never trigger a crawl.
  const compatible =
    !!first &&
    Number(first.timestamp) >= start - q.query.step &&
    Number(first.timestamp) <= start + q.query.step &&
    !!last &&
    Number(last.timestamp) <= start + q.query.limit * q.query.step &&
    phases.length === 1;
  const continueAcquisition = compatible && sorted.length === q.query.limit && !cadenceGaps.length;
  return {
    request: q,
    attempt,
    bodySha256: hash(raw),
    identities,
    rawOrder: candles.map((c) => c.timestamp),
    candles: union,
    coverage: {
      received: candles.length,
      unique: union.length,
      first: first?.timestamp ?? null,
      last: last?.timestamp ?? null,
      phases,
      cadenceGaps,
      continueAcquisition,
      reason: continueAcquisition
        ? 'bounded requested window observed'
        : 'empty, truncated, shifted or mixed-phase window; stop further acquisition',
    },
  };
}
export function mergeCandles(rows: Candle[]): Candle[] {
  const map = new Map<string, Candle>();
  for (const row of rows) {
    const key = `${row.asset}:${row.step}:${row.timestamp}`,
      old = map.get(key);
    if (old) {
      if (prices.some((k) => compare(old[k], row[k]) !== 0))
        throw Error('CONFLICTING_CANDLE_TIMESTAMP');
      old.contributors.push(...row.contributors);
    } else map.set(key, structuredClone(row));
  }
  for (const row of map.values()) {
    row.contributors.sort(
      (a, b) =>
        lexical(JSON.stringify(a.values), JSON.stringify(b.values)) ||
        lexical(a.requestId, b.requestId) ||
        a.attempt - b.attempt ||
        a.row - b.row,
    );
    Object.assign(row, row.contributors[0]!.values);
  }
  return [...map.values()].sort(
    (a, b) =>
      a.asset.localeCompare(b.asset) ||
      a.step - b.step ||
      Number(a.timestamp) - Number(b.timestamp),
  );
}
export function edgeRequest(
  asset: Asset,
  pages: ReturnType<typeof validatePage>[],
  alternatives: Request[],
) {
  const daily = pages.filter((p) => p.request.asset === asset && p.request.id.includes('-daily-'));
  if (
    daily.length !== 3 ||
    daily.some(
      (p) =>
        !p.coverage.continueAcquisition ||
        p.coverage.phases.length !== 1 ||
        p.coverage.phases[0] !== 0,
    )
  )
    return null;
  const union = mergeCandles(daily.flatMap((p) => p.candles)),
    present = new Set(union.map((c) => c.labelUtc.slice(0, 10)));
  const missing = dates().filter((d) => !present.has(d));
  if (!missing.length || missing.some((d) => d !== domain.from && d !== domain.through))
    return null;
  return (
    alternatives.find((q) => q.id.endsWith(missing.includes(domain.from) ? '-early' : '-late')) ??
    null
  );
}
type Fraction = { n: bigint; d: bigint };
const abs = (n: bigint) => (n < 0n ? -n : n);
function fraction(s: string): Fraction {
  const x = decimal(s);
  return x.scale >= 0
    ? { n: x.coefficient, d: 10n ** BigInt(x.scale) }
    : { n: x.coefficient * 10n ** BigInt(-x.scale), d: 1n };
}
function gcd(a: bigint, b: bigint): bigint {
  while (b) {
    const c = a % b;
    a = b;
    b = c;
  }
  return abs(a);
}
export function difference(reference: string, hds: string) {
  if (compare(hds, '0') <= 0) throw Error('HDS_DENOMINATOR');
  const r = fraction(reference),
    h = fraction(hds);
  let n = 100n * (r.n * h.d - h.n * r.d),
    d = r.d * h.n;
  const g = gcd(n, d);
  n /= g;
  d /= g;
  return { numerator: String(n), denominator: String(d), percent: rounded(n, d, 12) };
}
function units(n: bigint, d: bigint, places: number) {
  const u = abs(n) * 10n ** BigInt(places);
  return (n < 0n ? -1n : 1n) * (u / d + ((u % d) * 2n >= d ? 1n : 0n));
}
function rounded(n: bigint, d: bigint, places: number) {
  return exact(units(n, d, places), places);
}
export type Comparison = {
  asset: Asset;
  dateUtc: string;
  convention: string;
  hds: string;
  reference: string;
  referenceLabel: string;
  zeroVolume: boolean;
  numerator: string;
  denominator: string;
  percent: string;
  outsideSameLabelHighLow: boolean | null;
};
export function statistics(rows: Comparison[]) {
  const ordered = [...rows].sort((a, b) => {
    const d =
      abs(BigInt(a.numerator)) * BigInt(b.denominator) -
      abs(BigInt(b.numerator)) * BigInt(a.denominator);
    return d < 0n ? -1 : d > 0n ? 1 : a.dateUtc.localeCompare(b.dateUtc);
  });
  const percentile = (p: number) => {
    if (!rows.length) return null;
    const r = ordered[Math.ceil((rows.length * p) / 100) - 1]!;
    return rounded(abs(BigInt(r.numerator)), BigInt(r.denominator), 12);
  };
  const sum = rows.reduce((s, r) => s + units(BigInt(r.numerator), BigInt(r.denominator), 18), 0n);
  return {
    count: rows.length,
    signedMeanPercent: rows.length ? rounded(sum, BigInt(rows.length) * 10n ** 18n, 12) : null,
    meanNumerator18: String(sum),
    meanDenominator: rows.length,
    medianAbsolutePercent: percentile(50),
    p95AbsolutePercent: percentile(95),
    p99AbsolutePercent: percentile(99),
    maxAbsolutePercent: percentile(100),
    strictlyAbove: Object.fromEntries(
      [1, 5, 10].map((t) => [
        t,
        rows.filter((r) => abs(BigInt(r.numerator)) > BigInt(t) * BigInt(r.denominator)).length,
      ]),
    ),
    zeroVolumeReferences: rows.filter((r) => r.zeroVolume).length,
    top20: [...ordered]
      .sort((a, b) => {
        const delta =
          abs(BigInt(b.numerator)) * BigInt(a.denominator) -
          abs(BigInt(a.numerator)) * BigInt(b.denominator);
        return delta < 0n ? -1 : delta > 0n ? 1 : a.dateUtc.localeCompare(b.dateUtc);
      })
      .slice(0, 20),
  };
}
export function hourlyCheck(asset: Asset, candles: Candle[]) {
  const daily = candles.find(
    (c) => c.asset === asset && c.step === 86400 && c.labelUtc === '2020-01-15T00:00:00.000Z',
  );
  const groups = ['2020-01-15', '2020-01-14'].map((label) => {
    const start = Date.parse(label) / 1000,
      expected = Array.from({ length: 24 }, (_, i) => String(start + i * 3600));
    const hours = expected.map((t) =>
      candles.find((c) => c.asset === asset && c.step === 3600 && c.timestamp === t),
    );
    const missing = expected.filter((_, i) => !hours[i]);
    if (missing.length || !daily) return { label, missing, dailyAvailable: !!daily, matches: null };
    const h = hours as Candle[];
    const aggregate = {
      open: h[0]!.open,
      close: h.at(-1)!.close,
      high: h.reduce((s, c) => (compare(c.high, s) > 0 ? c.high : s), h[0]!.high),
      low: h.reduce((s, c) => (compare(c.low, s) < 0 ? c.low : s), h[0]!.low),
      volume: h.reduce((s, c) => add(s, c.volume), '0'),
    };
    const differences = Object.fromEntries(
      prices.map((k) => [k, add(aggregate[k], daily[k], true)]),
    );
    return {
      label,
      missing,
      aggregate,
      daily: daily.contributors[0]!.values,
      differences,
      matches: prices.every((k) => compare(aggregate[k], daily[k]) === 0),
      ohlcMatches: prices
        .filter((k) => k !== 'volume')
        .every((k) => compare(aggregate[k], daily[k]) === 0),
      zeroVolumeHours: h.filter((c) => c.zeroVolume).length,
    };
  });
  const matching = groups.filter((g) => g.matches);
  return {
    asset,
    dailyLabel: '2020-01-15',
    groups,
    inference:
      matching.length === 1
        ? `Exact relative aggregation supports daily grouping with hourly labels in ${matching[0]!.label} UTC calendar day`
        : 'Relative interval grouping remains partial/ambiguous',
    absoluteAnchor:
      'Unknown: matching hourly labels does not independently establish whether hourly timestamps anchor starts or ends.',
    exactLastTradeTime: null,
  };
}
export function analyze(
  candles: Candle[],
  hds: { buckets: { asset: Asset; dateUtc: string; value: string }[] },
  held: { asset: Asset; date: string }[],
) {
  const rows = mergeCandles(candles),
    comparisons: Comparison[] = [],
    assets: Record<string, unknown> = {};
  const gaps: unknown[] = [];
  for (const asset of ['BTC', 'ETH'] as const) {
    const daily = rows.filter((c) => c.asset === asset && c.step === 86400);
    const index = new Map<string, Candle>();
    for (const c of daily) {
      const d = c.labelUtc.slice(0, 10);
      if (index.has(d)) throw Error('MULTIPLE_DAILY_LABELS_IN_DATE');
      index.set(d, c);
    }
    const saved = new Map(
      hds.buckets.filter((b) => b.asset === asset).map((b) => [b.dateUtc, b.value]),
    );
    for (const [dateUtc, value] of saved) {
      const same = index.get(dateUtc);
      for (const convention of conventions) {
        const ref = index.get(convention === 'previous-label-close' ? shift(dateUtc, -1) : dateUtc);
        if (!ref) continue;
        const reference = convention === 'same-label-open' ? ref.open : ref.close;
        comparisons.push({
          asset,
          dateUtc,
          convention,
          hds: value,
          reference,
          referenceLabel: ref.labelUtc,
          zeroVolume: ref.zeroVolume,
          ...difference(reference, value),
          outsideSameLabelHighLow: same
            ? compare(value, same.low) < 0 || compare(value, same.high) > 0
            : null,
        });
      }
    }
    const common = new Set(
      [...saved.keys()].filter((d) => index.has(d) && index.has(shift(d, -1))),
    );
    const summary = Object.fromEntries(
      conventions.map((c) => {
        const all = comparisons.filter((r) => r.asset === asset && r.convention === c);
        return [
          c,
          {
            available: statistics(all),
            common: statistics(all.filter((r) => common.has(r.dateUtc))),
            excludedSavedDates: [...saved.keys()].filter((d) => !all.some((r) => r.dateUtc === d)),
            annual: Object.fromEntries(
              [...new Set(all.map((r) => r.dateUtc.slice(0, 4)))].sort().map((y) => [
                y,
                {
                  available: statistics(all.filter((r) => r.dateUtc.startsWith(y))),
                  common: statistics(
                    all.filter((r) => r.dateUtc.startsWith(y) && common.has(r.dateUtc)),
                  ),
                },
              ]),
            ),
          },
        ];
      }),
    );
    const missingHds = dates().filter((d) => !saved.has(d));
    for (const dateUtc of missingHds)
      gaps.push({
        asset,
        dateUtc,
        category:
          dateUtc === '2026-10-08'
            ? 'additional-endpoint'
            : held.some((h) => h.asset === asset && h.date === dateUtc)
              ? 'held-HDS-conflict'
              : 'original-HDS-gap',
        candidates: Object.fromEntries(
          conventions.map((c) => {
            const ref = index.get(c === 'previous-label-close' ? shift(dateUtc, -1) : dateUtc);
            return [
              c,
              ref
                ? {
                    value: c === 'same-label-open' ? ref.open : ref.close,
                    labelUtc: ref.labelUtc,
                    zeroVolume: ref.zeroVolume,
                    exactTradeTime: null,
                  }
                : null,
            ];
          }),
        ),
        publicationAuthorized: false,
      });
    assets[asset] = {
      targetDates: domain.dates,
      actualTargetCandles: dates().filter((d) => index.has(d)).length,
      missingTargetDates: dates().filter((d) => !index.has(d)),
      outOfTarget: daily
        .filter(
          (c) => c.labelUtc.slice(0, 10) < domain.from || c.labelUtc.slice(0, 10) > domain.through,
        )
        .map((c) => c.labelUtc),
      zeroVolume: daily.filter((c) => c.zeroVolume).map((c) => c.labelUtc),
      phaseSeconds: [...new Set(daily.map((c) => Number(c.timestamp) % 86400))],
      originalHdsGaps: missingHds.filter((d) => d <= '2026-10-07').length,
      additionalEndpointMissing: !saved.has('2026-10-08'),
      commonOverlap: common.size,
      comparison: summary,
      outsideSameLabelHighLow: comparisons
        .filter(
          (r) =>
            r.asset === asset && r.convention === 'same-label-close' && r.outsideSameLabelHighLow,
        )
        .map((r) => ({
          dateUtc: r.dateUtc,
          hds: r.hds,
          low: index.get(r.dateUtc)!.low,
          high: index.get(r.dateUtc)!.high,
        })),
      shared143DayWitness: dates('2024-03-27', '2024-08-16').map((d) => ({
        dateUtc: d,
        hdsAvailable: saved.has(d),
        candidateAvailable: index.has(d),
        zeroVolume: index.get(d)?.zeroVolume ?? null,
      })),
      hourly: hourlyCheck(asset, rows),
    };
  }
  return { domain, assets, comparisons, gaps, candles: rows };
}
