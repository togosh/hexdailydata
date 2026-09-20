import type { z } from 'zod';
import {
  reportedHistoryResponseSchema,
  historyLimit,
  type HistoryRow,
} from '../contracts/history.ts';
import { endpoint, request, RequestError } from './api.ts';
import { dateShift, decimal } from './format.ts';

export type Archive = z.infer<typeof reportedHistoryResponseSchema>;
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
