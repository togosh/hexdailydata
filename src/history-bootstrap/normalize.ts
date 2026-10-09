// Internal, offline ingestion only. No API DTO/default or canonical projection changes.
import { parse, isLosslessNumber } from 'lossless-json';
import { createHash } from 'node:crypto';
import { decimal } from '../worker/history/input.ts';

export type RawRow = Record<string, string | null>;
export type Field = {
  input: string;
  target: string;
  unit: string;
  meaning: string;
  kind: 'observation' | 'derived' | 'held';
  signed: boolean;
  integer: boolean;
  maximum: string | null;
  formula: string | null;
};
export type PriceSeries = {
  input: string;
  series: string;
  era: string;
  unit: string;
  kind: 'reference' | 'held';
  body: 'pulse' | 'ethereum';
  fromDate?: string;
  toDate?: string | null;
};
export type Mapping = {
  format: string;
  version: number;
  fields: Field[];
  priceSeries: PriceSeries[];
  inputHashes: { pulse: string; ethereum: string; ledger: string };
  capturedAtUtc: string;
  timeConvention: string;
  credits: string;
  limitations: string[];
};
export type Daily = {
  day: number;
  recordedAtUtc: string | null;
  [key: string]: string | number | null;
};
export type Price = { series: string; day: number; recordedAtUtc: string; quoteUsd: string | null };
export type Exception = {
  body: string;
  day: number;
  records: number[];
  fields: string[];
  reason: string;
};
export const hash = (b: Buffer | string) => createHash('sha256').update(b).digest('hex');
export const stable = (v: unknown) => JSON.stringify(v) + '\n';
const epoch = Date.parse('2019-12-03T00:00:00Z');
const dayMs = 86400000;
export const nominal = (day: number) => new Date(epoch + day * dayMs).toISOString().slice(0, 10);
const validDate = (v: unknown): v is string =>
  typeof v === 'string' &&
  /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/.test(v) &&
  Number.isFinite(Date.parse(v)) &&
  new Date(v).toISOString().replace('.000Z', 'Z') === v.replace('.000Z', 'Z');

export function parseScalarRows(bytes: Buffer): RawRow[] {
  if (bytes.length > 16 * 1024 * 1024) throw Error('SOURCE_BYTES');
  const text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  let depth = 0,
    quoted = false,
    escaped = false,
    length = 0;
  for (const c of text) {
    if (quoted) {
      if (++length > 4096) throw Error('SOURCE_STRING');
      if (escaped) escaped = false;
      else if (c === '\\') escaped = true;
      else if (c === '"') quoted = false;
    } else if (c === '"') {
      quoted = true;
      length = 0;
    } else if (c === '[' || c === '{') {
      if (++depth > 4) throw Error('SOURCE_DEPTH');
    } else if (c === ']' || c === '}') depth--;
  }
  const input: unknown = parse(text, undefined, {
    onDuplicateKey: () => {
      throw Error('DUPLICATE_KEY');
    },
  });
  if (!Array.isArray(input) || input.length < 1 || input.length > 10000) throw Error('SOURCE_ROWS');
  return input.map((value) => {
    if (
      !value ||
      Array.isArray(value) ||
      typeof value !== 'object' ||
      Object.keys(value).length > 128
    )
      throw Error('SOURCE_ROW');
    const row: RawRow = Object.create(null);
    for (const [key, raw] of Object.entries(value)) {
      if (key.length > 80) throw Error('SOURCE_KEY');
      if (isLosslessNumber(raw)) {
        decimal(raw.value);
        row[key] = raw.value;
      } else if (raw === null || (typeof raw === 'string' && raw.length <= 1024)) row[key] = raw;
      else throw Error('SOURCE_SCALAR');
    }
    return row;
  });
}
export function parseRows(bytes: Buffer): RawRow[] {
  return parseScalarRows(bytes).map((row) => {
    if (
      !/^(0|[1-9]\d{0,4})$/.test(row.currentDay ?? '') ||
      Number(row.currentDay) > 65535 ||
      !validDate(row.date)
    )
      throw Error('SOURCE_DAY_DATE');
    if (!Object.hasOwn(row, 'circulatingHEX') || !Object.hasOwn(row, 'stakedHEX'))
      throw Error('SOURCE_SHAPE');
    return row;
  });
}
export function loadMapping(bytes: Buffer): Mapping {
  if (bytes.length > 128 * 1024) throw Error('MAPPING_BYTES');
  const m = JSON.parse(bytes.toString()) as Mapping;
  if (
    m.format !== 'hdd-history-bootstrap-mapping-1' ||
    m.version !== 1 ||
    m.fields.length !== 27 ||
    new Set(m.fields.map((f) => f.input)).size !== 27 ||
    new Set(m.fields.map((f) => f.target)).size !== 27 ||
    !validDate(m.capturedAtUtc)
  )
    throw Error('MAPPING_SHAPE');
  for (const f of m.fields) {
    if (
      !/^[A-Za-z][A-Za-z0-9]+$/.test(f.target) ||
      ['day', 'recordedAtUtc', 'source', 'confidence', 'availability'].includes(f.target) ||
      !['observation', 'derived', 'held'].includes(f.kind)
    )
      throw Error('MAPPING_FIELD');
  }
  const target = (key: string) => m.fields.find((f) => f.input === key)?.target;
  if (
    target('numberOfHolders') !== 'holderIndexMaximum' ||
    target('numberOfHoldersChange') !== 'holderIndexMaximumChange' ||
    target('penaltiesHEX') !== 'estimatedPenaltiesHEX' ||
    target('dailyMintedInflationTotal') !== 'netTotalSupplyChangeHEX' ||
    target('actualAPYRate') !== 'simpleAnnualizedPayoutRatePercent'
  )
    throw Error('MISLEADING_MAPPING');
  if (
    ['dailyPayoutHEX', 'payoutPerTshareHEX', 'penaltiesHEX', 'actualAPYRate'].some(
      (k) => m.fields.find((f) => f.input === k)?.kind !== 'held',
    )
  )
    throw Error('UNQUALIFIED_PAYOUT_PERIOD');
  return m;
}
export function compare(a: string, b: string) {
  const x = decimal(a),
    y = decimal(b),
    scale = Math.max(x.scale, y.scale);
  const delta =
    x.coefficient * 10n ** BigInt(scale - x.scale) - y.coefficient * 10n ** BigInt(scale - y.scale);
  return delta < 0n ? -1 : delta > 0n ? 1 : 0;
}
export function exact(coefficient: bigint, scale: number) {
  if (scale < 0) return String(coefficient * 10n ** BigInt(-scale));
  const sign = coefficient < 0n ? '-' : '';
  const abs = coefficient < 0n ? -coefficient : coefficient;
  const text = String(abs).padStart(scale + 1, '0');
  const value = scale ? text.slice(0, -scale) + '.' + text.slice(-scale) : text;
  return sign + (value.includes('.') ? value.replace(/0+$/, '').replace(/\.$/, '') : value);
}
export function add(a: string, b: string, subtract = false) {
  const x = decimal(a),
    y = decimal(b),
    scale = Math.max(x.scale, y.scale);
  return exact(
    x.coefficient * 10n ** BigInt(scale - x.scale) +
      (subtract ? -1n : 1n) * y.coefficient * 10n ** BigInt(scale - y.scale),
    scale,
  );
}
export function ratio(a: string, b: string, places: number, multiplier = 1n) {
  const x = decimal(a),
    y = decimal(b);
  if (y.coefficient === 0n) return null;
  let n = x.coefficient * multiplier,
    d = y.coefficient;
  const shift = places + y.scale - x.scale;
  if (shift >= 0) n *= 10n ** BigInt(shift);
  else d *= 10n ** BigInt(-shift);
  const negative = n < 0n !== d < 0n;
  n = n < 0n ? -n : n;
  d = d < 0n ? -d : d;
  return exact((negative ? -1n : 1n) * (n / d + (2n * (n % d) >= d ? 1n : 0n)), places);
}
export function validScalar(
  token: string | null | undefined,
  f: Pick<Field, 'signed' | 'integer' | 'maximum'>,
): string | null {
  if (token == null) return null;
  try {
    const n = decimal(token);
    if (
      (!f.signed && n.coefficient < 0n) ||
      (f.integer && n.scale > 0 && n.coefficient % 10n ** BigInt(n.scale) !== 0n) ||
      (f.maximum !== null && compare(token, f.maximum) > 0)
    )
      return null;
    return token;
  } catch {
    return null;
  }
}
type Group = { day: number; rows: RawRow[]; indexes: number[] };
function groups(rows: RawRow[]) {
  const result = new Map<number, Group>();
  rows.forEach((row, index) => {
    const day = Number(row.currentDay);
    let g = result.get(day);
    if (!g) {
      g = { day, rows: [], indexes: [] };
      result.set(day, g);
    }
    g.rows.push(row);
    g.indexes.push(index);
  });
  return [...result.values()].sort((a, b) => a.day - b.day);
}
function skeleton(r: RawRow) {
  return (
    [1, 2].includes(Number(r.currentDay)) ||
    ['circulatingHEX', 'stakedHEX', 'tshareRateHEX', 'totalTshares'].every(
      (k) => r[k] != null && compare(r[k]!, '0') === 0,
    )
  );
}
// Original identical tokens collapse. Numerically equal but differently spelled tokens
// remain a conflict, avoiding an unexplained token winner.
function agreed(g: Group, key: string) {
  return g.rows.every((r) => r[key] === g.rows[0]![key]);
}
export function normalize(pulse: RawRow[], ethereum: RawRow[], mapping: Mapping) {
  const exceptions: Exception[] = [];
  const daily: Daily[] = [];
  const prices: Price[] = [];
  const exception = (body: string, g: Group, fields: string[], reason: string) =>
    exceptions.push({ body, day: g.day, records: g.indexes, fields, reason });
  for (const g of groups(pulse)) {
    const row: Daily = { day: g.day, recordedAtUtc: agreed(g, 'date') ? g.rows[0]!.date! : null };
    const skeletonDay = g.rows.some(skeleton),
      dateConflict = row.recordedAtUtc === null;
    const offset =
      row.recordedAtUtc === null
        ? NaN
        : (Date.parse(row.recordedAtUtc.slice(0, 10)) - Date.parse(nominal(g.day))) / dayMs;
    const badDate =
      dateConflict ||
      offset < -1 ||
      offset > 2 ||
      Date.parse(row.recordedAtUtc!) > Date.parse(mapping.capturedAtUtc) ||
      row.recordedAtUtc!.slice(0, 10) >= mapping.capturedAtUtc.slice(0, 10);
    if (skeletonDay || badDate)
      exception(
        'pulse',
        g,
        mapping.fields.map((f) => f.input),
        skeletonDay
          ? 'skeleton'
          : dateConflict
            ? 'conflicting_record_times'
            : 'unqualified_record_date',
      );
    for (const f of mapping.fields) {
      row[f.target] = null;
      if (skeletonDay || badDate || f.kind === 'held') continue;
      if (!agreed(g, f.input)) {
        exception('pulse', g, [f.input], 'conflicting_tokens');
        continue;
      }
      const raw = g.rows[0]![f.input];
      const value = validScalar(raw, f);
      if (value === null && raw != null)
        exception('pulse', g, [f.input], 'invalid_sign_integer_range_or_token');
      if (f.kind === 'observation') row[f.target] = value;
    }
    if (!skeletonDay && !badDate) {
      const previous = daily.at(-1);
      const consecutive = previous?.day === g.day - 1;
      const a = row.circulatingHEX,
        b = row.stakedHEX;
      const calculations: Record<string, string | null> = {
        totalHEX: typeof a === 'string' && typeof b === 'string' ? add(a, b) : null,
      };
      calculations.stakedHEXPercent =
        typeof b === 'string' && calculations.totalHEX !== null
          ? ratio(b, calculations.totalHEX!, 2, 100n)
          : null;
      calculations.netTotalSupplyChangeHEX =
        consecutive && typeof previous!.totalHEX === 'string' && calculations.totalHEX !== null
          ? add(calculations.totalHEX!, previous!.totalHEX, true)
          : null;
      calculations.stakedHEXPercentChange =
        consecutive &&
        typeof previous!.stakedHEXPercent === 'string' &&
        calculations.stakedHEXPercent !== null
          ? add(calculations.stakedHEXPercent!, previous!.stakedHEXPercent, true)
          : null;
      for (const f of mapping.fields.filter((f) => f.kind === 'derived')) {
        if (!agreed(g, f.input)) continue;
        const value = calculations[f.target] ?? null;
        row[f.target] = value;
        const raw = g.rows[0]![f.input];
        if (
          value !== null &&
          (raw == null ||
            validScalar(raw, { signed: true, integer: false, maximum: null }) === null ||
            compare(raw, value) !== 0)
        )
          exception('pulse', g, [f.input], 'recomputed_from_same_observations');
      }
    }
    daily.push(row);
  }
  for (const series of mapping.priceSeries.filter((p) => p.kind === 'reference')) {
    for (const g of groups(series.body === 'pulse' ? pulse : ethereum)) {
      const first = g.rows[0]!,
        date = first.date!;
      if (
        date.slice(0, 10) < series.fromDate! ||
        nominal(g.day) < series.fromDate! ||
        (series.toDate && (date.slice(0, 10) > series.toDate || nominal(g.day) > series.toDate))
      )
        continue;
      if (!agreed(g, 'date')) {
        exception(series.body, g, [series.input], 'conflicting_record_times');
        continue;
      }
      let quote: string | null = null,
        reason: string | null = null;
      const offset = (Date.parse(date.slice(0, 10)) - Date.parse(nominal(g.day))) / dayMs;
      if (!agreed(g, series.input)) reason = 'conflicting_price_tokens';
      else if (g.rows.some(skeleton)) reason = 'skeleton';
      else if (offset < -1 || offset > 2) reason = 'date_mismatch';
      else if (
        Date.parse(date) > Date.parse(mapping.capturedAtUtc) ||
        date.slice(0, 10) >= mapping.capturedAtUtc.slice(0, 10)
      )
        reason = 'future_record_date';
      else {
        quote = validScalar(first[series.input], { signed: false, integer: false, maximum: null });
        if (quote !== null && compare(quote, '0') <= 0) {
          quote = null;
          reason = 'zero_price';
        } else if (quote === null && first[series.input] != null) reason = 'invalid_price';
      }
      if (series.input === 'pricePulseX' && [1734, 1735, 1768].includes(g.day)) {
        quote = null;
        reason = 'selected_price_exclusion';
      }
      if (
        quote !== null &&
        series.input === 'pricePulseX' &&
        g.rows.some((r) =>
          ['priceUV2', 'priceUV3', 'priceUV2UV3'].some(
            (k) => r[k] != null && compare(quote!, r[k]!) === 0,
          ),
        )
      ) {
        quote = null;
        reason = 'copied_uv_price';
      }
      if (
        quote !== null &&
        series.input === 'priceUV2' &&
        g.rows.some(
          (r) =>
            r.priceUV3 != null && compare(r.priceUV3, '0') > 0 && compare(quote!, r.priceUV3) === 0,
        )
      ) {
        quote = null;
        reason = 'possible_copied_uv3_price';
      }
      if (reason) exception(series.body, g, [series.input], reason);
      prices.push({ series: series.series, day: g.day, recordedAtUtc: date, quoteUsd: quote });
    }
  }
  return { daily, prices, exceptions };
}
export function csv(rows: Record<string, unknown>[], columns: string[]) {
  const quote = (v: unknown) => {
    const s = v === null ? '' : String(v);
    return /[",\r\n]/.test(s) ? '"' + s.replaceAll('"', '""') + '"' : s;
  };
  return (
    columns.join(',') +
    '\n' +
    rows.map((row) => columns.map((k) => quote(row[k])).join(',') + '\n').join('')
  );
}
