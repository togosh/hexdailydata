import type pg from 'pg';
import { createHash } from 'node:crypto';
import { open } from 'node:fs/promises';
import { dirname } from 'node:path';
import {
  historyMetadataSchema,
  historyRowSchema,
  metricNames,
  metricDefinitions,
} from '../../contracts/history.ts';
import { csvLine } from '../exports/datasets.ts';
import { safePath, syncPath } from '../../operator/files.ts';

export async function exportHistory(client: pg.Client, path: string, signal: AbortSignal) {
  await safePath(dirname(path));
  const file = await open(path, 'wx', 0o640);
  const started = performance.now(),
    digest = createHash('sha256');
  let count = 0,
    bytes = 0,
    complete = false;
  const write = async (text: string) => {
    signal.throwIfAborted();
    bytes += Buffer.byteLength(text);
    digest.update(text);
    await file.write(text);
  };
  try {
    await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
    const source = (
      await client.query("SELECT * FROM hdd.history_source WHERE source='hexdailystats'")
    ).rows[0];
    if (!source) throw new Error('History archive unavailable.');
    const metadata = historyMetadataSchema.parse(source.metadata);
    const columns = [
      'source',
      'chain_id',
      'source_day',
      'source_date',
      'source_record_date_utc',
      'date_basis',
      'revision',
      'mapping_version',
      'price_kind',
      'price_availability',
      'reference_price_usd',
      'price_published_token',
    ];
    for (const k of metricNames)
      columns.push(
        `${k}_${metricDefinitions[k].unit}`,
        `${k}_published_token`,
        `${k}_availability`,
      );
    const numeric = new Set([
      1,
      2,
      10,
      11,
      ...metricNames.flatMap((_, i) => [12 + i * 3, 13 + i * 3]),
    ]);
    await write(csvLine(columns));
    await client.query(
      "DECLARE history_csv NO SCROLL CURSOR FOR SELECT payload FROM hdd.history_daily WHERE source='hexdailystats' ORDER BY source_day",
    );
    for (;;) {
      signal.throwIfAborted();
      const { rows } = await client.query('FETCH FORWARD 128 FROM history_csv');
      if (!rows.length) break;
      for (const r of rows) {
        if (++count > 10000) throw new Error('History record limit exceeded.');
        const row = historyRowSchema.parse(r.payload);
        await write(
          csvLine(
            [
              'hexdailystats',
              369,
              row.sourceDay,
              row.sourceDate,
              row.sourceRecordDateUtc,
              metadata.dateBasis,
              source.revision,
              metadata.selection.mappingVersion,
              metadata.priceKind,
              row.referencePriceUsd.availability,
              row.referencePriceUsd.value,
              row.referencePriceUsd.published,
              ...metricNames.flatMap((k) => [
                row.metrics[k].value,
                row.metrics[k].published,
                row.metrics[k].availability,
              ]),
            ],
            numeric,
          ),
        );
      }
    }
    await client.query('CLOSE history_csv');
    await client.query('COMMIT');
    await file.sync();
    complete = true;
    await file.close();
    await syncPath(dirname(path));
    return {
      rows: count,
      bytes,
      sha256: digest.digest('hex'),
      revision: source.revision,
      ms: performance.now() - started,
    };
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {});
    // A failed exclusive output is deliberately retained as incomplete; never replace
    // an existing operator file or let cleanup mask the initiating error.
    throw error;
  } finally {
    if (!complete) await file.close().catch(() => {});
  }
}
