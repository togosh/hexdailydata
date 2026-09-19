import assert from 'node:assert/strict';
import { readFile, writeFile, symlink, unlink } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { connect, databaseConfig } from '../../dist/db/connect.js';
import { ReadDatabase } from '../../dist/services/queries/database.js';
import { createApp } from '../../dist/api/app.js';
import { inspectInput } from '../../dist/worker/history/input.js';
import { importHistory, validateHistory } from '../../dist/worker/history/store.js';
import { exportHistory } from '../../dist/worker/history/export.js';
import { exportSeed, emptyTarget } from '../../dist/worker/bootstrap/seed.js';
import { tables } from '../../dist/worker/bootstrap/manifest.js';
import { sample, selection, rawRow } from './fixture.mjs';
import { parse, stringify } from 'lossless-json';

const signal = new AbortController().signal,
  action = process.argv[2] ?? 'archive',
  evidence = process.argv[3] ?? action;
const c = await connect(databaseConfig('worker')),
  api = await connect(databaseConfig('api'));
const db = new ReadDatabase(databaseConfig('api'));
const app = createApp({ dependencies: { db }, admission: { capacity: 10000, concurrent: 64 } });
await app.listen({ host: '127.0.0.1', port: 0 });
const url = `http://127.0.0.1:${app.server.address().port}`;
const request = async (path, options) => {
  const r = await fetch(url + path, options);
  const text = await r.text();
  return { status: r.status, headers: r.headers, text, json: text ? JSON.parse(text) : null };
};
const q = '/api/v2/daily?chain=pulsechain&source=hexdailystats&from=2023-05-11&to=2023-06-25';
const bytes = sample(),
  inspected = inspectInput(bytes, selection(bytes));
const tests = [];
async function test(name, fn) {
  const start = performance.now();
  await fn();
  tests.push({ name, status: 'PASS', ms: performance.now() - start });
  console.log('PASS', name);
}
async function archiveSnapshot() {
  return (
    await c.query(
      'SELECT to_jsonb(t)::text AS row FROM hdd.history_source t UNION ALL SELECT to_jsonb(t)::text FROM hdd.history_daily t ORDER BY row',
    )
  ).rows;
}
async function nativeSnapshot() {
  const out = {};
  for (const [name, keys] of Object.entries(tables).filter(([n]) => !n.startsWith('history_'))) {
    out[name] = (
      await c.query(`SELECT to_jsonb(t)::text AS row FROM hdd.${name} t ORDER BY ${keys.join(',')}`)
    ).rows;
  }
  return out;
}
async function checkExact() {
  const response = await request(q);
  assert.equal(response.status, 200, response.text);
  const row = response.json.items.find((r) => r.sourceDay === 1261);
  assert.equal(row.metrics.currentHolders.value, '9007199254740993');
  assert.equal(
    row.metrics.circulatingHEX.value,
    '900719925474099312345678.12345678901234567890123456789',
  );
  assert.equal(row.referencePriceUsd.value, '1.2300e-40');
  assert.equal(row.metrics.totalTsharesChange.value, '-1.00000000000000000000000001');
  return response;
}
try {
  if (action === 'archive') {
    await test('archive-only exact import, attributed HTTP, API role read-only; native routes remain uninitialized', async () => {
      const before = await nativeSnapshot();
      const result = await importHistory(c, inspected, signal);
      assert.equal(result.changed, true);
      assert.deepEqual(await nativeSnapshot(), before);
      await checkExact();
      for (const path of [
        '/api/v2/home',
        '/api/v2/calculator/inputs',
        '/api/v2/daily?from=2023-05-11&to=2023-05-20',
      ])
        assert.equal((await request(path)).status, 503, path);
      const status = await request('/api/v2/status');
      assert.equal(status.json.state, 'uninitialized');
      assert.equal(status.json.productionReady, false);
      assert.equal((await c.query('SELECT count(*)::int AS n FROM hdd.chains')).rows[0].n, 0);
      assert.equal(
        (await c.query('SELECT count(*)::int AS n FROM hdd.export_bundles')).rows[0].n,
        0,
      );
      await assert.rejects(
        api.query('UPDATE hdd.history_source SET revision=revision'),
        /permission|read-only/,
      );
      await assert.rejects(
        exportSeed(c, '/state/archive-only.seed.tar.gz', signal),
        /uninitialized/,
      );
      await assert.rejects(emptyTarget(c), /empty/);
    });
    await test('unchanged import does not rewrite rows; ETag 304, conflict, cancellation, SQL failure and atomic correction', async () => {
      const before = await archiveSnapshot(),
        old = await checkExact();
      const physical = (
        await c.query('SELECT xmin::text,ctid::text FROM hdd.history_daily ORDER BY source_day')
      ).rows;
      assert.equal((await importHistory(c, inspected, signal)).changed, false);
      assert.deepEqual(
        (await c.query('SELECT xmin::text,ctid::text FROM hdd.history_daily ORDER BY source_day'))
          .rows,
        physical,
      );
      assert.equal(
        (await request(q, { headers: { 'If-None-Match': old.headers.get('etag') } })).status,
        304,
      );
      const raw = parse(bytes.toString());
      raw.find((r) => r.currentDay === '1261').pricePulseX = '-1';
      const changed = Buffer.from(stringify(raw));
      const candidate = inspectInput(changed, selection(changed));
      await assert.rejects(importHistory(c, candidate, signal), /conflict/);
      const stop = new AbortController();
      await assert.rejects(
        importHistory(c, candidate, stop.signal, old.json.revision, {
          beforeCommit: async () => stop.abort(),
        }),
      );
      assert.deepEqual(await archiveSnapshot(), before);
      await assert.rejects(
        importHistory(c, candidate, signal, old.json.revision, {
          beforeCommit: async () => c.query('SELECT 1/0'),
        }),
        /division by zero/,
      );
      assert.deepEqual(await archiveSnapshot(), before);
      await importHistory(c, candidate, signal, old.json.revision, {
        beforeCommit: async () => {
          const during = await checkExact();
          assert.equal(during.json.revision, old.json.revision);
        },
      });
      const updated = await request(q, { headers: { 'If-None-Match': old.headers.get('etag') } });
      assert.equal(updated.status, 200);
      assert.equal(updated.json.metadata.summary.firstAvailablePrice.sourceDay, 1263);
      assert.notEqual(updated.headers.get('etag'), old.headers.get('etag'));
      assert.equal(
        (await request(q + '&afterSourceDay=1261&revision=' + old.json.revision)).status,
        409,
      );
      await importHistory(c, inspected, signal, updated.json.revision);
      const n = await nativeSnapshot();
      assert.ok(Object.values(n).every((rs) => rs.length === 0));
    });
    await test('strict source/chain/range errors and exact streamed CSV; paths never overwrite or follow symlinks', async () => {
      for (const query of [
        'source=unknown&chain=pulsechain',
        'source=hexdailystats&chain=ethereum',
        'source=hexdailystats&chain=unknown',
      ])
        assert.equal(
          (await request('/api/v2/daily?' + query + '&from=2023-05-11&to=2023-05-20')).status,
          400,
        );
      assert.equal(
        (await request('/api/v2/daily?source=hexdailystats&from=2023-05-11&to=2024-05-20')).status,
        400,
      );
      const out = await exportHistory(c, '/state/history-sample.csv', signal);
      const csv = await readFile('/state/history-sample.csv', 'utf8');
      assert.equal(out.bytes, Buffer.byteLength(csv));
      assert.ok(csv.includes('900719925474099312345678.12345678901234567890123456789'));
      assert.ok(csv.includes(',1.2300e-40,1.2300e-40,'));
      assert.ok(csv.includes(',-1.00000000000000000000000001,-1.00000000000000000000000001,'));
      assert.ok(!csv.includes("'-1.0000"));
      await assert.rejects(exportHistory(c, '/state/history-sample.csv', signal), /exist/);
      await symlink('/state', '/state/history-link');
      try {
        await assert.rejects(exportHistory(c, '/state/history-link/bad.csv', signal), /Symlink/);
      } finally {
        await unlink('/state/history-link');
      }
      await writeFile('/evidence/local-synthetic-example.csv', csv);
    });
    await test('10000-record bounded shape: import, 366-day paginated HTTP, streaming CSV and no repeat growth', async () => {
      const raw = Array.from({ length: 10000 }, (_, i) => rawRow(i + 1255));
      const data = Buffer.from(JSON.stringify(raw));
      const input = inspectInput(
        data,
        selection(data, {
          fromSourceDay: 1255,
          toSourceDay: 11254,
          fromDate: '2023-05-11',
          toDate: raw.at(-1).date.slice(0, 10),
        }),
      );
      const revision = (await request(q)).json.revision;
      const imported = await importHistory(c, input, signal, revision);
      const size = async () =>
        (
          await c.query(
            "SELECT c.relname,pg_relation_size(c.oid)::text AS heap,pg_indexes_size(c.oid)::text AS indexes,pg_total_relation_size(c.oid)::text AS total FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='hdd' AND c.relname IN('history_source','history_daily') ORDER BY c.relname",
          )
        ).rows;
      const before = await size();
      const start = performance.now();
      let next = '',
        items = [],
        maxResponse = 0;
      do {
        const r = await request(
          '/api/v2/daily?source=hexdailystats&from=2023-05-11&to=2024-05-10' + next,
        );
        assert.equal(r.status, 200);
        maxResponse = Math.max(maxResponse, Buffer.byteLength(r.text));
        assert.ok(Buffer.byteLength(r.text) <= 2 * 1024 * 1024);
        items.push(...r.json.items);
        next = r.json.continuation
          ? '&afterSourceDay=' +
            r.json.continuation.afterSourceDay +
            '&revision=' +
            r.json.continuation.revision
          : '';
      } while (next);
      assert.equal(items.length, 366);
      assert.equal(new Set(items.map((r) => r.sourceDay)).size, 366);
      const queryMs = performance.now() - start;
      const csv = await exportHistory(c, '/state/history-scale.csv', signal);
      assert.equal(csv.rows, 10000);
      const repeat = await importHistory(c, input, signal);
      assert.equal(repeat.changed, false);
      assert.deepEqual(await size(), before);
      await writeFile(
        '/evidence/history-scale.json',
        JSON.stringify(
          {
            synthetic: true,
            rows: 10000,
            inputBytes: data.length,
            imported,
            size: before,
            queryMs,
            maxResponse,
            csv,
            repeat,
          },
          null,
          2,
        ),
      );
      await importHistory(c, inspected, signal, imported.revision);
    });
  } else if (action === 'native') {
    await test('archive correction/query leaves every native SQL field and retained undo byte-identical', async () => {
      const before = await nativeSnapshot();
      assert.ok(before.stakes.length > 0);
      const first = await checkExact();
      const changed = Buffer.from(bytes.toString().replaceAll('1.2300e-40', '2.5000e-40'));
      await importHistory(
        c,
        inspectInput(changed, selection(changed)),
        signal,
        first.json.revision,
      );
      assert.deepEqual(await nativeSnapshot(), before);
      await importHistory(c, inspected, signal, (await request(q)).json.revision);
      await checkExact();
      assert.deepEqual(await nativeSnapshot(), before);
    });
  } else if (action === 'verify') {
    await test('restored SQL/API retains independent exact archive and portable validation', async () => {
      await checkExact();
      await c.query('BEGIN');
      try {
        await validateHistory(c, signal);
      } finally {
        await c.query('ROLLBACK');
      }
      await writeFile(
        '/evidence/' + evidence + '-archive.json',
        JSON.stringify(await archiveSnapshot(), null, 2),
      );
      await exportHistory(c, '/state/' + evidence + '.csv', signal);
      const csv = await readFile('/state/' + evidence + '.csv', 'utf8');
      assert.ok(csv.includes(',1.2300e-40,1.2300e-40,'));
      assert.ok(csv.includes('900719925474099312345678.12345678901234567890123456789'));
    });
  } else if (action === 'real') {
    await test('actual selected PulseChain archive serves bounded attributed HTTP with no native initialization', async () => {
      const response = await request(
        '/api/v2/daily?source=hexdailystats&chain=pulsechain&from=2023-05-11&to=2023-05-20',
      );
      assert.equal(response.status, 200, response.text);
      assert.equal(response.json.metadata.summary.records, 1227);
      assert.equal(response.json.metadata.summary.prices, 1218);
      assert.equal(
        response.json.metadata.summary.firstAvailablePrice.sourceRecordDateUtc,
        '2023-05-17',
      );
      assert.equal(
        response.json.items.find((r) => r.sourceDay === 1261).referencePriceUsd.value,
        '0.01958399',
      );
      assert.equal((await request('/api/v2/status')).json.state, 'uninitialized');
      assert.equal((await request('/api/v2/home')).status, 503);
      await writeFile('/evidence/real-api-example.json', JSON.stringify(response.json, null, 2));
      await c.query('BEGIN');
      try {
        await validateHistory(c, signal);
      } finally {
        await c.query('ROLLBACK');
      }
      const rows = (
        await c.query(
          'SELECT source_day,record_date::text,payload FROM hdd.history_daily ORDER BY source_day',
        )
      ).rows;
      const dates = new Set(rows.map((r) => r.record_date));
      const allDates = Array.from(
        {
          length: Math.round((Date.parse('2026-09-18') - Date.parse('2023-05-11')) / 86400000) + 1,
        },
        (_, i) => new Date(Date.parse('2023-05-11') + i * 86400000).toISOString().slice(0, 10),
      );
      await writeFile(
        '/evidence/real-coverage.json',
        JSON.stringify(
          {
            records: rows.length,
            uniqueDates: dates.size,
            missingRecordDates: allDates.filter((d) => !dates.has(d)),
            missingPriceDates: allDates.filter(
              (d) =>
                !rows.some(
                  (r) =>
                    r.record_date === d && r.payload.referencePriceUsd.availability === 'available',
                ),
            ),
            excludedPrices: rows
              .filter((r) => r.payload.referencePriceUsd.availability !== 'available')
              .map((r) => ({
                sourceDay: r.source_day,
                date: r.record_date,
                price: r.payload.referencePriceUsd,
              })),
            fieldCoverage: Object.fromEntries(
              Object.keys(rows[0].payload.metrics).map((k) => [
                k,
                rows.reduce((t, r) => {
                  const s = r.payload.metrics[k].availability;
                  t[s] = (t[s] ?? 0) + 1;
                  return t;
                }, {}),
              ]),
            ),
          },
          null,
          2,
        ),
      );
    });
  } else throw Error('Unknown test phase');
  await writeFile('/evidence/' + evidence + '-tests.json', JSON.stringify(tests, null, 2));
} finally {
  await app.close();
  await db.close();
  await c.end();
  await api.end();
}
