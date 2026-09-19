import { parse, isLosslessNumber } from 'lossless-json';
import { createHash } from 'node:crypto';
import { open } from 'node:fs/promises';
import { constants } from 'node:fs';
import { z } from 'zod';
import {
  historyBytes,
  historyLimit,
  historyRowSchema,
  historyMetadataSchema,
  selectionSchema,
  metricNames,
  tokenSchema,
  type HistoryRow,
  type HistorySelection,
  type HistoryMetadata,
} from '../../contracts/history.ts';

export const sha256 = (bytes: string | Buffer) => createHash('sha256').update(bytes).digest('hex');
// Admission scan only: no rewriting JSON/numeric tokens. Parsing and duplicate-key
// rejection are delegated to lossless-json after these cheap memory/stack bounds.
function admit(text: string) {
  let depth = 0,
    quoted = false,
    escaped = false,
    length = 0,
    rows = 1;
  for (const c of text) {
    if (quoted) {
      if (++length > 4096) throw new Error('Input string exceeds bound.');
      if (escaped) escaped = false;
      else if (c === '\\') escaped = true;
      else if (c === '"') quoted = false;
    } else if (c === '"') {
      quoted = true;
      length = 0;
    } else if (c === '{' || c === '[') {
      if (++depth > 4) throw new Error('Input nesting exceeds bound.');
    } else if (c === '}' || c === ']') depth--;
    else if (c === ',' && depth === 1 && ++rows > historyLimit)
      throw new Error('Input record limit exceeded.');
  }
}
export async function readBounded(path: string, signal: AbortSignal, max = historyBytes) {
  const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const stat = await file.stat();
    if (!stat.isFile() || stat.nlink !== 1 || stat.size > max)
      throw new Error('Input must be a bounded ordinary file.');
    const parts: Buffer[] = [];
    let size = 0;
    for await (const chunk of file.createReadStream({ autoClose: false, signal })) {
      signal.throwIfAborted();
      size += chunk.length;
      if (size > max) throw new Error('Input file grew beyond byte bound.');
      parts.push(chunk);
    }
    return Buffer.concat(parts);
  } finally {
    await file.close();
  }
}
type RawRow = Record<string, string | null>;
export function parseInput(bytes: Buffer) {
  if (bytes.length > historyBytes) throw new Error('Input file exceeds byte bound.');
  const text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  admit(text);
  const raw: unknown = parse(text, undefined, {
    onDuplicateKey: () => {
      throw new Error('Duplicate JSON key.');
    },
  });
  if (!Array.isArray(raw) || raw.length < 1 || raw.length > historyLimit)
    throw new Error('Expected 1..10000 source-day records.');
  const rows = raw.map((r): RawRow => {
    if (!r || Array.isArray(r) || typeof r !== 'object' || Object.keys(r).length > 128)
      throw new Error('Invalid source row.');
    const out: RawRow = Object.create(null);
    for (const [key, value] of Object.entries(r)) {
      if (key.length > 80) throw new Error('Source key exceeds bound.');
      if (isLosslessNumber(value)) out[key] = tokenSchema.parse(value.value);
      else if (value === null || (typeof value === 'string' && value.length <= 1024))
        out[key] = value;
      else throw new Error('Only scalar source fields are supported.');
    }
    if (!/^(0|[1-9]\d{0,4})$/.test(out.currentDay ?? '') || Number(out.currentDay) > 65535)
      throw new Error('Invalid source day.');
    z.iso.datetime({ precision: 3 }).parse(out.date);
    if (!Object.hasOwn(out, 'circulatingHEX') || !Object.hasOwn(out, 'stakedHEX'))
      throw new Error('Not an HDS statistics row.');
    if (
      (out.chainId != null && out.chainId !== '369') ||
      (out.chain != null && !['369', 'pulsechain'].includes(out.chain)) ||
      (out.network != null && out.network !== 'pulsechain')
    )
      throw new Error('Conflicting source chain.');
    return out;
  });
  if (!rows.some((r) => Object.hasOwn(r, 'pricePulseX')))
    throw new Error('No PulseChain source fields; chain label alone is insufficient.');
  return rows;
}
// Exact decimal comparison, bounded to the admitted 160-character coefficient and
// three-digit exponent. Never use Number for published magnitudes or comparisons.
export function decimal(value: string) {
  tokenSchema.parse(value);
  const [mantissa, exponent = '0'] = value.toLowerCase().split('e');
  const [whole, fraction = ''] = mantissa!.split('.');
  return { coefficient: BigInt(whole! + fraction), scale: fraction.length - Number(exponent) };
}
function equal(a: string, b: string) {
  const x = decimal(a),
    y = decimal(b),
    scale = Math.max(x.scale, y.scale);
  return (
    x.coefficient * 10n ** BigInt(scale - x.scale) ===
    y.coefficient * 10n ** BigInt(scale - y.scale)
  );
}
function value(token: string | null | undefined, signed = false): HistoryRow['referencePriceUsd'] {
  if (token === undefined) return { published: null, value: null, availability: 'missing' };
  if (token === null) return { published: null, value: null, availability: 'null' };
  const n = decimal(token);
  const availability =
    !signed && n.coefficient < 0n ? (equal(token, '-1') ? 'sentinel' : 'negative') : 'available';
  return { published: token, value: availability === 'available' ? token : null, availability };
}
const signedFields = new Set([
  'totalTsharesChange',
  'currentHoldersChange',
  'stakedSupplyChange',
  'circulatingSupplyChange',
]);
export function normalize(r: RawRow, acquiredAt: string, excludePrice = false): HistoryRow {
  const sourceDay = Number(r.currentDay),
    sourceDate = r.date!,
    date = sourceDate.slice(0, 10);
  const nominal = 1575331200000 + sourceDay * 86400000;
  const offset = (Date.parse(date) - nominal) / 86400000;
  const metrics = Object.fromEntries(
    metricNames.map((k) => [k, value(r[k], signedFields.has(k))]),
  ) as HistoryRow['metrics'];
  for (const key of [
    'currentHolders',
    'numberOfHolders',
    'currentStakerCount',
    'totalStakerCount',
    'currentHoldersChange',
  ] as const) {
    const v = metrics[key];
    if (v.value !== null) {
      const n = decimal(v.value);
      if (n.scale > 0 && n.coefficient % 10n ** BigInt(n.scale) !== 0n) {
        v.value = null;
        v.availability = 'invalid_value';
      }
    }
  }
  const percent = metrics.stakedHEXPercent;
  if (percent.value !== null) {
    const n = decimal(percent.value);
    if (
      n.scale >= 0
        ? n.coefficient > 100n * 10n ** BigInt(n.scale)
        : n.coefficient * 10n ** BigInt(-n.scale) > 100n
    ) {
      percent.value = null;
      percent.availability = 'invalid_value';
    }
  }
  const core = ['circulatingHEX', 'stakedHEX', 'tshareRateHEX', 'totalTshares'] as const;
  const skeleton = core.every(
    (k) => metrics[k].value !== null && decimal(metrics[k].value!).coefficient === 0n,
  );
  if (skeleton)
    for (const v of Object.values(metrics))
      if (v.availability === 'available') {
        v.value = null;
        v.availability = 'skeleton';
      }
  const price = value(r.pricePulseX);
  let reason: HistoryRow['referencePriceUsd']['availability'] | undefined;
  // Conservative post-launch boundary, not a claim of fork block or first trade time.
  if (date < '2023-05-14' || nominal < Date.parse('2023-05-14')) reason = 'era_unproved';
  else if (offset < -1 || offset > 2) reason = 'date_mismatch';
  else if (Date.parse(sourceDate) > Date.parse(acquiredAt) || date >= acquiredAt.slice(0, 10))
    reason = 'future_period';
  else if (skeleton) reason = 'skeleton';
  else if (price.value !== null && decimal(price.value).coefficient === 0n) reason = 'zero_price';
  else if (
    price.value !== null &&
    ['priceUV2', 'priceUV3', 'priceUV2UV3'].some(
      (k) => r[k] != null && equal(price.value!, tokenSchema.parse(r[k])),
    )
  )
    reason = 'copied_price';
  if (excludePrice) reason = 'selected_exclusion';
  if (reason) {
    price.value = null;
    price.availability = reason;
  }
  const row = historyRowSchema.parse({
    sourceDay,
    sourceDayToken: r.currentDay,
    sourceDate,
    sourceRecordDateUtc: date,
    marketPeriodUtc: null,
    dateRelationship:
      offset === 0
        ? 'same_nominal_day'
        : offset === -1
          ? 'previous_nominal_day'
          : offset > 0 && offset <= 2
            ? 'delayed'
            : 'unproved',
    quality: skeleton ? 'skeleton' : 'reported',
    metrics,
    referencePriceUsd: price,
  });
  if (Buffer.byteLength(JSON.stringify(row)) > 16384)
    throw new Error('Normalized source row exceeds 16KiB.');
  return row;
}
export function summarize(rows: HistoryRow[]) {
  const dated = [...rows].sort(
    (a, b) => a.sourceDate.localeCompare(b.sourceDate) || a.sourceDay - b.sourceDay,
  );
  const first = dated.find((r) => r.referencePriceUsd.availability === 'available');
  return {
    records: rows.length,
    prices: rows.filter((r) => r.referencePriceUsd.availability === 'available').length,
    firstRecordDateUtc: dated[0]!.sourceRecordDateUtc,
    lastRecordDateUtc: dated.at(-1)!.sourceRecordDateUtc,
    firstAvailablePrice: first
      ? {
          sourceDay: first.sourceDay,
          sourceRecordDateUtc: first.sourceRecordDateUtc,
          sourceDate: first.sourceDate,
        }
      : null,
  };
}
export function contentDigest(rows: HistoryRow[]) {
  return sha256(JSON.stringify(rows));
}
export function inspectInput(bytes: Buffer, selection?: HistorySelection) {
  const raw = parseInput(bytes),
    digest = sha256(bytes);
  const keys = [...new Set(raw.flatMap(Object.keys))].sort();
  const counts = new Map<number, RawRow[]>();
  for (const r of raw) {
    const d = Number(r.currentDay);
    const group = counts.get(d);
    if (group) group.push(r);
    else counts.set(d, [r]);
  }
  const duplicates = [...counts]
    .filter(([, rs]) => rs.length > 1)
    .map(([sourceDay, rs]) => ({ sourceDay, count: rs.length }));
  const inventory = {
    sha256: digest,
    bytes: bytes.length,
    sourceRecords: raw.length,
    sourceDays: counts.size,
    firstSourceDay: Math.min(...counts.keys()),
    lastSourceDay: Math.max(...counts.keys()),
    keys: keys.slice(0, 256),
    keyCount: keys.length,
    duplicates: duplicates.slice(0, 100),
    duplicateDayCount: duplicates.length,
    inventoryTruncated: keys.length > 256 || duplicates.length > 100,
    unmappedFields: keys
      .slice(0, 256)
      .filter(
        (k) =>
          !metricNames.includes(k as never) && !['currentDay', 'date', 'pricePulseX'].includes(k),
      ),
  };
  if (!selection) return { inventory };
  const s = selectionSchema.parse(selection);
  if (s.sha256 !== digest) throw new Error('Expected source-file digest mismatch.');
  if (Date.parse(s.provenance.acquiredAt) > Date.now()) throw new Error('Future acquisition time.');
  const excluded = new Set(s.excludeSourceDays.map((e) => e.sourceDay));
  const byDay = new Map<number, HistoryRow>();
  let identicalDuplicates = 0;
  for (const r of raw) {
    const d = Number(r.currentDay),
      date = r.date!.slice(0, 10);
    if (
      d < s.fromSourceDay ||
      d > s.toSourceDay ||
      date < s.fromDate ||
      date > s.toDate ||
      excluded.has(d)
    )
      continue;
    const row = normalize(
        r,
        s.provenance.acquiredAt,
        s.excludePriceSourceDays.some((e) => e.sourceDay === d),
      ),
      previous = byDay.get(d);
    if (previous && JSON.stringify(previous) !== JSON.stringify(row))
      throw new Error(
        `Conflicting duplicate source day ${d}; explicitly exclude or supply a corrected snapshot.`,
      );
    if (previous) identicalDuplicates++;
    else byDay.set(d, row);
  }
  const rows = [...byDay.values()].sort((a, b) => a.sourceDay - b.sourceDay);
  if (!rows.length) throw new Error('Selection contains no source records.');
  if (rows.some((r, i) => i && r.sourceRecordDateUtc < rows[i - 1]!.sourceRecordDateUtc))
    throw new Error('Selected source days have conflicting date order.');
  const metadata: HistoryMetadata = historyMetadataSchema.parse({
    selection: s,
    summary: summarize(rows),
    dateBasis: 'sourceRecordDateUtc',
    priceKind: 'source_reported_daily_reference',
    marketPeriod: 'unproved',
    contentSha256: contentDigest(rows),
  });
  if (Buffer.byteLength(JSON.stringify(metadata)) > 16384)
    throw new Error('History metadata exceeds bound.');
  return { inventory, rows, metadata, identicalDuplicates };
}
