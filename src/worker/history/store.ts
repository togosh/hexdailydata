import type pg from 'pg';
import { randomUUID } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import {
  historyMetadataSchema,
  historyRowSchema,
  metricDefinitions,
  metricNames,
  reportedHistoryResponseSchema,
  type HistoryRow,
} from '../../contracts/history.ts';
import { inspectInput, summarize, contentDigest, normalize } from './input.ts';
import { type ReadDatabase } from '../../services/queries/database.ts';
import { ApiFailure, unavailable } from '../../api/errors.ts';

export async function importHistory(
  client: pg.Client,
  input: ReturnType<typeof inspectInput>,
  signal: AbortSignal,
  replaceRevision?: string,
  hooks: { beforeCommit?: () => Promise<void> } = {},
) {
  if (!input.rows || !input.metadata) throw new Error('Inspected explicit selection required.');
  const metadata = historyMetadataSchema.parse(input.metadata),
    rows = input.rows.map((r) => historyRowSchema.parse(r));
  if (
    contentDigest(rows) !== metadata.contentSha256 ||
    !isDeepStrictEqual(summarize(rows), metadata.summary)
  )
    throw new Error('Inspected content mismatch.');
  const started = performance.now();
  signal.throwIfAborted();
  await client.query('BEGIN');
  try {
    await client.query(
      'SELECT pg_advisory_xact_lock_shared(4243,0),pg_advisory_xact_lock(4251,369)',
    );
    if ((await client.query('SELECT current_user AS role')).rows[0].role !== 'hdd_v2_worker')
      throw new Error('History import requires worker authority.');
    const old = (
      await client.query("SELECT * FROM hdd.history_source WHERE source='hexdailystats' FOR UPDATE")
    ).rows[0];
    if (old && isDeepStrictEqual(old.metadata, metadata)) {
      signal.throwIfAborted();
      await client.query('COMMIT');
      return {
        revision: old.revision,
        changed: false,
        rows: rows.length,
        ms: performance.now() - started,
      };
    }
    if (old ? replaceRevision !== old.revision : replaceRevision !== undefined)
      throw new Error('History conflict; explicit current replacement revision required.');
    const revision = randomUUID();
    await client.query(
      `INSERT INTO hdd.history_source VALUES('hexdailystats',369,$1,$2::jsonb)
      ON CONFLICT(source) DO UPDATE SET revision=excluded.revision,metadata=excluded.metadata`,
      [revision, JSON.stringify(metadata)],
    );
    let changedRows = 0;
    for (let offset = 0; offset < rows.length; offset += 128) {
      signal.throwIfAborted();
      const result = await client.query(
        `INSERT INTO hdd.history_daily(source,source_day,record_date,payload)
        SELECT 'hexdailystats',(p->>'sourceDay')::int,(p->>'sourceRecordDateUtc')::date,p FROM jsonb_array_elements($1::jsonb) p
        ON CONFLICT(source,source_day) DO UPDATE SET record_date=excluded.record_date,payload=excluded.payload
        WHERE hdd.history_daily.payload IS DISTINCT FROM excluded.payload`,
        [JSON.stringify(rows.slice(offset, offset + 128))],
      );
      changedRows += result.rowCount ?? 0;
    }
    const removed = await client.query(
      "DELETE FROM hdd.history_daily WHERE source='hexdailystats' AND NOT(source_day=ANY($1::int[]))",
      [rows.map((r) => r.sourceDay)],
    );
    await hooks.beforeCommit?.();
    signal.throwIfAborted();
    await client.query('COMMIT');
    return {
      revision,
      changed: true,
      changedRows,
      removedRows: removed.rowCount,
      rows: rows.length,
      ms: performance.now() - started,
    };
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {});
    throw error;
  }
}

export interface HistoryQuery {
  from: string;
  to: string;
  afterSourceDay?: number | undefined;
  revision?: string | undefined;
}
export async function reportedHistory(db: ReadDatabase, q: HistoryQuery, signal: AbortSignal) {
  return db.read(
    signal,
    async (c) => {
      const source = (
        await c.query(
          "SELECT revision,metadata FROM hdd.history_source WHERE source='hexdailystats'",
        )
      ).rows[0];
      if (!source) throw unavailable();
      if (q.revision && q.revision !== source.revision)
        throw new ApiFailure(409, 'expired_cursor', 'History revision changed; restart the range.');
      const metadata = historyMetadataSchema.parse(source.metadata);
      const { rows } = await c.query(
        `SELECT payload FROM hdd.history_daily WHERE source='hexdailystats'
      AND record_date BETWEEN $1::date AND $2::date AND source_day>$3::int ORDER BY source_day LIMIT 65`,
        [q.from, q.to, q.afterSourceDay ?? -1],
      );
      const dates = (
        await c.query(
          `SELECT to_char(record_date,'YYYY-MM-DD') AS date,count(*)::int AS records,
      count(*) FILTER(WHERE payload->'referencePriceUsd'->>'availability'='available')::int AS prices
      FROM hdd.history_daily WHERE source='hexdailystats' AND record_date BETWEEN $1::date AND $2::date
      GROUP BY record_date ORDER BY record_date LIMIT 366`,
          [q.from, q.to],
        )
      ).rows;
      const expected = Array.from(
        { length: (Date.parse(q.to) - Date.parse(q.from)) / 86400000 + 1 },
        (_, i) => new Date(Date.parse(q.from) + i * 86400000).toISOString().slice(0, 10),
      );
      const items = rows.slice(0, 64).map((r) => historyRowSchema.parse(r.payload));
      return reportedHistoryResponseSchema.parse({
        chain: 'pulsechain',
        chainId: 369,
        source: 'hexdailystats',
        sourceReported: true,
        revision: source.revision,
        metadata,
        fieldDefinitions: metricDefinitions,
        coverage: {
          from: q.from,
          to: q.to,
          records: dates.reduce((n, r) => n + r.records, 0),
          prices: dates.reduce((n, r) => n + r.prices, 0),
          missingRecordDates: expected.filter((d) => !dates.some((r) => r.date === d)),
          missingPriceDates: expected.filter(
            (d) => !dates.some((r) => r.date === d && r.prices > 0),
          ),
        },
        items,
        continuation:
          rows.length > 64
            ? { afterSourceDay: items.at(-1)!.sourceDay, revision: source.revision }
            : null,
      });
    },
    true,
  );
}

/** Portable/restore audit only. No request-time file hashing or native table scan. */
export async function validateHistory(client: pg.Client, signal: AbortSignal) {
  const sources = (await client.query('SELECT * FROM hdd.history_source')).rows;
  const stored = (
    await client.query(
      "SELECT source_day,to_char(record_date,'YYYY-MM-DD') AS date,payload FROM hdd.history_daily ORDER BY source_day LIMIT 10001",
    )
  ).rows;
  if (!sources.length && !stored.length) return;
  if (sources.length !== 1 || !stored.length || stored.length > 10000)
    throw new Error('Invalid portable history size.');
  const metadata = historyMetadataSchema.parse(sources[0].metadata),
    s = metadata.selection;
  const rows: HistoryRow[] = [];
  for (const r of stored) {
    signal.throwIfAborted();
    const row = historyRowSchema.parse(r.payload);
    if (
      row.sourceDay !== r.source_day ||
      row.sourceRecordDateUtc !== r.date ||
      row.sourceDayToken !== String(row.sourceDay) ||
      row.sourceRecordDateUtc !== row.sourceDate.slice(0, 10) ||
      row.sourceDay < s.fromSourceDay ||
      row.sourceDay > s.toSourceDay ||
      row.sourceRecordDateUtc < s.fromDate ||
      row.sourceRecordDateUtc > s.toDate ||
      s.excludeSourceDays.some((e) => e.sourceDay === row.sourceDay)
    )
      throw new Error('Invalid portable history selection.');
    const raw: Record<string, string | null> = {
      currentDay: row.sourceDayToken,
      date: row.sourceDate,
    };
    for (const key of metricNames)
      if (row.metrics[key].availability !== 'missing') raw[key] = row.metrics[key].published;
    if (row.referencePriceUsd.availability !== 'missing')
      raw.pricePulseX = row.referencePriceUsd.published;
    if (row.referencePriceUsd.availability === 'copied_price')
      raw.priceUV2 = row.referencePriceUsd.published;
    if (
      !isDeepStrictEqual(
        normalize(
          raw,
          s.provenance.acquiredAt,
          s.excludePriceSourceDays.some((e) => e.sourceDay === row.sourceDay),
        ),
        row,
      )
    )
      throw new Error('Invalid portable history normalization.');
    rows.push(row);
  }
  if (
    rows.some((r, i) => i && r.sourceRecordDateUtc < rows[i - 1]!.sourceRecordDateUtc) ||
    contentDigest(rows) !== metadata.contentSha256 ||
    !isDeepStrictEqual(summarize(rows), metadata.summary)
  )
    throw new Error('Invalid portable history metadata.');
}
