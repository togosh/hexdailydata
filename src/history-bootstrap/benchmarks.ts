/** Bounded offline selection from saved legacy bodies; no provider/source execution. */
import { createHash } from 'node:crypto';
import { parseScalarRows, compare, hash, stable, type RawRow } from './normalize.ts';
import { BenchmarkHistorySchema, benchmarkHistoryMethod } from '../contracts/product-daily.ts';

export const benchmarkInputs = {
  pulse: 'd687ab4b4af94366a2e3e5ce2d6c6d5329ed67d34453a80152b53308598b5d15',
  ethereum: '49bfa6eb956ffb7162af7b04c2121be2654ef310c6991e2f8b1e7673190b582b',
  caller: '7262f7f8c07c7de8af8a35b48cba595cbcf9c30ce4d78a16a4b132776ecec5fd',
  helperGitBlob: '2e0c6268c0bd2b0de3582e23511639991b1443f8',
} as const;
const fields = { BTC: 'priceBTC', ETH: 'priceETH' } as const;
type Asset = keyof typeof fields;
const assets = Object.keys(fields) as Asset[];
const from = '2019-12-03',
  through = '2026-10-07';
const dayMs = 86400000;
export const benchmarkDisclosure =
  'Legacy recorded-date BTC/ETH USD references: exact sample time unavailable; not daily closes or timestamp-aligned returns. Explicit conflicts and missing dates remain gaps.';
const positive = (s: string | null | undefined) => {
  try {
    return typeof s === 'string' && compare(s, '0') > 0;
  } catch {
    return false;
  }
};
const equal = (a: string | null | undefined, b: string | null | undefined) => {
  if (a === b) return true;
  try {
    return typeof a === 'string' && typeof b === 'string' && compare(a, b) === 0;
  } catch {
    return false;
  }
};
function timestamp(s: string | null | undefined) {
  if (typeof s !== 'string' || !/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d{3})?Z$/.test(s))
    return null;
  const t = Date.parse(s);
  return Number.isFinite(t) && new Date(t).toISOString() === s.replace(/(?<!\.\d{3})Z$/, '.000Z')
    ? t
    : null;
}
const ordered = (r: RawRow) =>
  Object.fromEntries(
    Object.keys(r)
      .sort()
      .map((k) => [k, r[k]]),
  );
function records(rows: RawRow[], body: string) {
  return rows.map((r, index) => {
    const time = timestamp(r.date),
      day =
        /^(0|[1-9]\d{0,4})$/.test(r.currentDay ?? '') && Number(r.currentDay) <= 65535
          ? Number(r.currentDay)
          : null;
    const contentSha256 = hash(stable(ordered(r)));
    return {
      index,
      id: r._id ?? null,
      contentSha256,
      stableId: (r._id ?? '') + ':' + contentSha256,
      sourceDay: r.currentDay ?? null,
      sourceDate: r.date ?? null,
      day,
      time,
      dateUtc: time === null ? null : new Date(time).toISOString().slice(0, 10),
      BTC: r.priceBTC,
      ETH: r.priceETH,
      body,
    };
  });
}
type RecordView = ReturnType<typeof records>[number];
type Exception = { reason: string; assets: Asset[]; dates: string[]; records: string[] };
function group<T>(rows: T[], key: (r: T) => string) {
  const out = new Map<string, T[]>();
  for (const r of rows) {
    const k = key(r);
    out.set(k, [...(out.get(k) ?? []), r]);
  }
  return out;
}
function gapRanges(selected: Set<string>) {
  const out: { from: string; to: string }[] = [];
  let gap: (typeof out)[number] | undefined;
  for (let t = Date.parse(from); t <= Date.parse(through); t += dayMs) {
    const d = new Date(t).toISOString().slice(0, 10);
    if (!selected.has(d)) {
      if (gap) gap.to = d;
      else gap = { from: d, to: d };
    } else if (gap) {
      out.push(gap);
      gap = undefined;
    }
  }
  if (gap) out.push(gap);
  return out;
}

/** Pure rule also used by synthetic fixtures; input order never chooses a winner. */
export function selectBenchmarkRows(primary: RawRow[], diagnostic: RawRow[] = []) {
  const p = records(primary, 'pulse'),
    e = records(diagnostic, 'ethereum');
  const exceptions: Exception[] = [],
    held = new Set<string>();
  const flag = (reason: string, rs: RecordView[], affected: Asset[]) => {
    const dates = [
      ...new Set(
        rs.filter((r) => r.body === 'pulse').flatMap((r) => (r.dateUtc ? [r.dateUtc] : [])),
      ),
    ].sort();
    exceptions.push({
      reason,
      assets: affected,
      dates,
      records: rs.map((r) => r.body + ':' + r.stableId).sort(),
    });
    for (const d of dates) for (const a of affected) held.add(d + ':' + a);
  };
  const days = group(
    p.filter((r) => r.day !== null),
    (r) => String(r.day),
  );
  let duplicateGroups = 0;
  for (const rs of days.values()) {
    if (rs.length > 1) duplicateGroups++;
    if (rs.some((r) => r.time === null) || new Set(rs.map((r) => r.dateUtc)).size > 1)
      flag('source-day chronology unresolved', rs, assets);
    for (const a of assets)
      if (rs.some((r) => !equal(r[a], rs[0]![a]))) flag('source-day benchmark conflict', rs, [a]);
  }
  for (const r of p)
    if (r.day === null || r.time === null) flag('invalid source day/timestamp', [r], assets);
  const orderedDays = [...days.values()].sort((a, b) => a[0]!.day! - b[0]!.day!);
  for (let i = 1; i < orderedDays.length; i++) {
    const a = orderedDays[i - 1]!.filter((r) => r.dateUtc),
      b = orderedDays[i]!.filter((r) => r.dateUtc);
    if (a.length && b.length && a.some((x) => b.some((y) => x.dateUtc! > y.dateUtc!)))
      flag('source-day calendar regression', [...a, ...b], assets);
  }
  const diagnosticByTime = group(
    e.filter((r) => r.day !== null && r.time !== null),
    (r) => r.day + ':' + r.time,
  );
  let matchedRecords = 0;
  for (const r of p)
    for (const other of diagnosticByTime.get(r.day + ':' + r.time) ?? []) {
      matchedRecords++;
      for (const a of assets)
        if (positive(r[a]) && positive(other[a]) && !equal(r[a], other[a]))
          flag(
            'cross-feed same-day/same-record-time positive conflict; exact quote times unknown',
            [r, other],
            [a],
          );
    }
  const dates = group(
    p.filter((r) => r.dateUtc !== null && r.day !== null),
    (r) => r.dateUtc!,
  );
  const buckets: { dateUtc: string; asset: Asset; value: string }[] = [];
  const selections: Record<string, unknown>[] = [];
  for (const [dateUtc, rs] of [...dates].sort(([a], [b]) => a.localeCompare(b))) {
    if (dateUtc < from || dateUtc > through) {
      flag('outside authorized historical domain', rs, assets);
      continue;
    }
    const latest = Math.max(...rs.map((r) => r.time!));
    const ties = rs
      .filter((r) => r.time === latest)
      .sort((a, b) => a.stableId.localeCompare(b.stableId));
    for (const asset of assets) {
      if (ties.some((r) => !equal(r[asset], ties[0]![asset])))
        flag('same-record-time benchmark conflict', ties, [asset]);
      const representative = ties[0]!;
      const available = !held.has(dateUtc + ':' + asset) && positive(representative[asset]);
      if (available) buckets.push({ dateUtc, asset, value: representative[asset]! });
      selections.push({
        dateUtc,
        asset,
        value: available ? representative[asset] : null,
        quoteTimestamp: null,
        representative: available ? representative.stableId : null,
        recordTimestamp: new Date(latest).toISOString(),
        contributors: rs.map((r) => r.stableId).sort(),
        reason: available
          ? 'latest whole record; stable equivalent representative'
          : held.has(dateUtc + ':' + asset)
            ? 'explicit conflict/chronology hold'
            : 'latest record value zero/negative/null/missing/invalid; no fallback',
      });
    }
  }
  const coverage = Object.fromEntries(
    assets.map((a) => {
      const selected = buckets.filter((b) => b.asset === a),
        set = new Set(selected.map((b) => b.dateUtc));
      return [
        a,
        {
          selectedDates: selected.length,
          firstDate: selected[0]?.dateUtc ?? null,
          lastDate: selected.at(-1)?.dateUtc ?? null,
          quoteTimeUnknown: selected.length,
          positiveSourceOccurrences: p.filter((r) => positive(r[a])).length,
          heldDates: [...held]
            .filter((k) => k.endsWith(':' + a))
            .map((k) => k.slice(0, 10))
            .sort(),
          gaps: gapRanges(set),
        },
      ];
    }),
  );
  const contributors = [...p, ...e].map(({ day, time, ...r }) => ({
    ...r,
    nominalTargetUtc:
      day === null ? null : new Date((1575417600 + (day - 1) * 86400) * 1000).toISOString(),
    originalTokenPresence: {
      BTC: r.BTC === undefined ? 'missing' : r.BTC === null ? 'null' : 'present',
      ETH: r.ETH === undefined ? 'missing' : r.ETH === null ? 'null' : 'present',
    },
  }));
  return {
    buckets,
    selections,
    contributors,
    exceptions,
    coverage,
    summary: {
      primaryRows: p.length,
      primarySourceDays: days.size,
      primaryRecordDates: dates.size,
      duplicateSourceDayGroups: duplicateGroups,
      diagnosticRows: e.length,
      matchedRecordTimes: matchedRecords,
      historicalFrom: from,
      historicalThrough: through,
    },
  };
}

export function qualifyBenchmarkHistory(
  pulse: Buffer,
  ethereum: Buffer,
  helper: Buffer,
  caller: Buffer,
) {
  if (
    hash(pulse) !== benchmarkInputs.pulse ||
    hash(ethereum) !== benchmarkInputs.ethereum ||
    hash(caller) !== benchmarkInputs.caller
  )
    throw Error('BENCHMARK_SOURCE_BINDING');
  const gitBlob = createHash('sha1')
    .update(Buffer.concat([Buffer.from('blob ' + helper.length + '\0'), helper]))
    .digest('hex');
  if (helper.length !== 3774 || gitBlob !== benchmarkInputs.helperGitBlob)
    throw Error('BENCHMARK_HELPER_BINDING');
  const result = selectBenchmarkRows(parseScalarRows(pulse), parseScalarRows(ethereum));
  const history = BenchmarkHistorySchema.parse({
    methodRevision: benchmarkHistoryMethod,
    sourceBodySha256: hash(pulse),
    diagnosticBodySha256: hash(ethereum),
    helperGitBlob: gitBlob,
    callerSha256: hash(caller),
    selectionSha256: hash(stable(result.buckets)),
    buckets: result.buckets,
  });
  return { history, ...result };
}
