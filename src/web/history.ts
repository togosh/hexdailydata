import type { z } from 'zod';
import {
  reportedHistoryResponseSchema,
  historyLimit,
  type HistoryRow,
} from '../contracts/history.ts';
import { endpoint, request, RequestError } from './api.ts';
import { dateShift, decimal } from './format.ts';
import { DailyResponseSchema } from '../contracts/reads.ts';
import { DailyLedgerResponseSchema, type DailyLedgerResponse } from '../contracts/daily-ledger.ts';
import { displayRatio } from '../domain/units.ts';

/** One immutable saved dataset across bounded windows; never mix a replacement into a chart. */
export async function loadLedger(from: string, to: string, signal: AbortSignal, get = request) {
  if (!validRange(from, to, 10000)) throw new Error('Invalid ledger range.');
  let first: DailyLedgerResponse | undefined;
  const items: DailyLedgerResponse['items'] = [],
    missing: DailyLedgerResponse['coverage']['missing'] = [];
  let pages = 0;
  for (let start = from; start <= to; start = dateShift(start, 366)) {
    signal.throwIfAborted();
    const end = dateShift(start, 365) < to ? dateShift(start, 365) : to;
    const page = await get(
      endpoint('/daily', {
        source: 'contract-ledger',
        from: start,
        to: end,
        datasetVersion: first?.datasetVersion,
      }),
      DailyLedgerResponseSchema,
      signal,
    );
    if (
      first &&
      (page.datasetVersion !== first.datasetVersion ||
        page.manifestSha256 !== first.manifestSha256 ||
        JSON.stringify(page.metadata) !== JSON.stringify(first.metadata))
    )
      throw new RequestError(409);
    if (
      page.coverage.from !== start ||
      page.coverage.to !== end ||
      page.coverage.returned !== page.items.length ||
      page.items.length + page.coverage.missing.length !== page.coverage.requested
    )
      throw new RequestError(503);
    const days = [
      ...page.items.map((r) => [r.contractDay, r.nominalDateUtc] as const),
      ...page.coverage.missing.map((r) => [r.contractDay, r.nominalDateUtc] as const),
    ].sort((a, b) => a[0] - b[0]);
    if (
      new Set(days.map((d) => d[0])).size !== days.length ||
      days.some((d, i) => d[1] !== dateShift(start, i)) ||
      days.at(-1)?.[1] !== end
    )
      throw new RequestError(503);
    first ??= page;
    items.push(...page.items);
    missing.push(...page.coverage.missing);
    pages++;
  }
  signal.throwIfAborted();
  return { first: first!, items, missing, pages };
}
export function ledgerPoints(data: Awaited<ReturnType<typeof loadLedger>>): Point[] {
  return [
    ...data.items.map((r): Point => ({
      key: String(r.contractDay),
      date: r.nominalDateUtc,
      value: r.rate.rational
        ? displayRatio({
            numerator: BigInt(r.rate.rational.numerator),
            denominator: BigInt(r.rate.rational.denominator),
          })
        : null,
      status: r.rate.reason ?? 'saved contract storage',
      detail: `Contract day ${r.contractDay} · payout ${r.payoutHearts} hearts · ${r.stakeShares} raw shares · ${r.rate.rational ? `exact ratio ${r.rate.rational.numerator}/${r.rate.rational.denominator}` : 'undefined: zero shares'}`,
    })),
    ...data.missing.map((r): Point => ({
      key: String(r.contractDay),
      date: r.nominalDateUtc,
      value: null,
      status: r.reason,
      detail: `Contract day ${r.contractDay} · no captured ledger value`,
    })),
  ].sort((a, b) => a.date.localeCompare(b.date));
}

export type Archive = z.infer<typeof reportedHistoryResponseSchema>;
/** Exact native windows share a cutoff; discard a moving index instead of splicing revisions. */
export async function loadNative(from: string, to: string, signal: AbortSignal, get = request) {
  if (!validRange(from, to, historyLimit)) throw new Error('Invalid native range.');
  let result: z.infer<typeof DailyResponseSchema> | undefined;
  for (let start = from; start <= to; start = dateShift(start, 366)) {
    const end = dateShift(start, 365) < to ? dateShift(start, 365) : to;
    const page = await get(
      endpoint('/daily', { from: start, to: end }),
      DailyResponseSchema,
      signal,
    );
    if (!result) result = page;
    else {
      if (JSON.stringify(page.cutoff) !== JSON.stringify(result.cutoff))
        throw new RequestError(409);
      result = {
        ...result,
        items: [...result.items, ...page.items],
        coverage: {
          fromDay: result.coverage.fromDay,
          toDay: page.coverage.toDay,
          expected: result.coverage.expected + page.coverage.expected,
          count: result.coverage.count + page.coverage.count,
          missingDays: [...result.coverage.missingDays, ...page.coverage.missingDays],
        },
      };
    }
  }
  signal.throwIfAborted();
  return result!;
}
export function validRange(from: string, to: string, maximum = 366) {
  return (
    /^\d{4}-\d{2}-\d{2}$/.test(from) &&
    /^\d{4}-\d{2}-\d{2}$/.test(to) &&
    Number.isFinite(Date.parse(from)) &&
    Number.isFinite(Date.parse(to)) &&
    new Date(from).toISOString().slice(0, 10) === from &&
    new Date(to).toISOString().slice(0, 10) === to &&
    from >= '2019-12-03' &&
    to >= from &&
    Date.parse(to) - Date.parse(from) < maximum * 86400000 &&
    Date.parse(to) <= 1575331200000 + 65535 * 86400000
  );
}
/** One selection, one revision. A revision conflict discards the whole result; caller offers restart. */
export async function loadArchive(from: string, to: string, signal: AbortSignal, get = request) {
  if (!validRange(from, to, historyLimit)) throw new Error('Invalid archive range.');
  let pages = 0,
    first: Archive | undefined;
  const rows: HistoryRow[] = [],
    seen = new Set<number>();
  for (let start = from; start <= to; start = dateShift(start, 366)) {
    const end = dateShift(start, 365) < to ? dateShift(start, 365) : to;
    let cursor: Archive['continuation'] = null,
      windowCount = 0,
      expected: number | undefined;
    do {
      signal.throwIfAborted();
      if (++pages > 190) throw new Error('Archive page limit reached. Select a smaller range.');
      const page: Archive = await get(
        endpoint('/daily', {
          source: 'hexdailystats',
          from: start,
          to: end,
          afterSourceDay: cursor?.afterSourceDay,
          revision: cursor?.revision,
        }),
        reportedHistoryResponseSchema,
        signal,
      );
      if (
        first &&
        (page.revision !== first.revision ||
          page.metadata.contentSha256 !== first.metadata.contentSha256)
      )
        throw new RequestError(409);
      first ??= page;
      if (
        page.coverage.from !== start ||
        page.coverage.to !== end ||
        (expected !== undefined && page.coverage.records !== expected)
      )
        throw new Error('Archive coverage changed. Restart the selection.');
      expected = page.coverage.records;
      let prior = cursor?.afterSourceDay ?? -1;
      for (const row of page.items) {
        if (
          seen.has(row.sourceDay) ||
          row.sourceDay <= prior ||
          row.sourceRecordDateUtc < start ||
          row.sourceRecordDateUtc > end
        )
          throw new Error('Archive rows conflict. Restart the selection.');
        seen.add(row.sourceDay);
        prior = row.sourceDay;
        rows.push(row);
        windowCount++;
        if (rows.length > historyLimit) throw new Error('Archive row limit reached.');
      }
      if (
        page.continuation &&
        (!page.items.length ||
          page.continuation.revision !== page.revision ||
          page.continuation.afterSourceDay !== prior ||
          prior <= (cursor?.afterSourceDay ?? -1))
      )
        throw new Error('Archive cursor did not advance. Restart the selection.');
      cursor = page.continuation;
    } while (cursor);
    if (windowCount !== expected)
      throw new Error('Archive range is incomplete. Restart the selection.');
  }
  signal.throwIfAborted();
  return { first: first!, rows, pages };
}

export type Point = {
  key: string;
  date: string;
  value: string | null;
  detail: string;
  status: string;
};
/** Normalize exact decimal integers before reducing to bounded pixel coordinates. */
export function plot(points: Point[]) {
  const counts = new Map<string, number>();
  const expanded = points.map((p) => (p.value === null ? null : decimal(p.value)));
  const scale = Math.max(0, ...expanded.map((v) => v?.split('.')[1]?.length ?? 0));
  const values = expanded.map((v) => {
    if (v === null) return null;
    const [whole = '0', fraction = ''] = v.replace(/^-/, '').split('.');
    return BigInt(whole + fraction.padEnd(scale, '0')) * (v.startsWith('-') ? -1n : 1n);
  });
  let min: bigint | undefined, max: bigint | undefined;
  for (let i = 0; i < points.length; i++) {
    const p = points[i]!;
    counts.set(p.date, (counts.get(p.date) ?? 0) + 1);
    const value = values[i];
    if (value !== null && value !== undefined) {
      min = min === undefined || value < min ? value : min;
      max = max === undefined || value > max ? value : max;
    }
  }
  const dates = points.map((p) => Date.parse(p.date));
  const start = Math.min(...dates),
    end = Math.max(...dates);
  const low = min ?? 0n,
    span = (max ?? 0n) - low;
  const coordinates = points.map((p, i) => ({
    ...p,
    x: 70 + ((dates[i]! - start) / Math.max(86400000, end - start)) * 700,
    y:
      values[i] == null
        ? null
        : span === 0n
          ? 127
          : 220 - (Number(((values[i]! - low) * 1000000n) / span) / 1000000) * 185,
  }));
  const lines: string[] = [];
  for (let i = 1; i < coordinates.length; i++) {
    const a = coordinates[i - 1]!,
      b = coordinates[i]!;
    if (
      a.y !== null &&
      b.y !== null &&
      Date.parse(b.date) - Date.parse(a.date) === 86400000 &&
      counts.get(a.date) === 1 &&
      counts.get(b.date) === 1
    )
      lines.push(`M${a.x},${a.y} L${b.x},${b.y}`);
  }
  const label = (v: bigint) => {
    const index = values.findIndex((n) => n === v);
    const token = index < 0 ? '0' : expanded[index]!;
    const approximate = Number(token);
    return Number.isFinite(approximate) && (approximate !== 0 || v === 0n)
      ? approximate.toPrecision(4)
      : points[index]!.value!;
  };
  return { coordinates, lines, minLabel: label(low), maxLabel: label(max ?? 0n) };
}
