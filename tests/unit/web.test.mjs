import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { decimal, numberText, observationState } from '../../src/web/format.ts';
import { loadArchive, plot } from '../../src/web/history.ts';
import { inspectInput } from '../../src/worker/history/input.ts';
import { rawRow, selection } from '../history/fixture.mjs';
import { createApp } from '../../src/api/app.ts';
import { resolve } from 'node:path';

test('exact browser presentation handles >2^53, signed exponents, null, zero and >24 decimals', () => {
  assert.equal(
    numberText('9007199254740993.12345678901234567890123456789'),
    '9,007,199,254,740,993.12345678901234567890123456789',
  );
  assert.equal(decimal('-1.2300e-40'), '-0.' + '0'.repeat(39) + '123');
  assert.equal(numberText('1e-40', 4), '0.' + '0'.repeat(39) + '1');
  assert.equal(numberText(null), 'Unavailable');
  assert.equal(numberText('0'), '0');
  assert.equal(decimal('1.23e3'), '1230');
  assert.equal(decimal('-0.0e-4'), '0');
});
test('browser ages old successful responses, preserves stale status and expires day estimates', () => {
  const time = Date.parse('2026-09-19T23:59:00Z');
  const row = {
    status: 'fresh',
    value: '1',
    asOf: { blockTimestamp: new Date(time).toISOString() },
    observedAt: new Date(time).toISOString(),
  };
  assert.equal(observationState(row, time + 120000), 'fresh');
  assert.equal(observationState(row, time + 121000), 'stale');
  assert.equal(
    observationState(
      { ...row, observedAt: new Date(time + 1700000).toISOString() },
      time + 1801000,
    ),
    'unavailable',
  );
  assert.equal(observationState({ ...row, status: 'stale' }, time), 'stale');
  const day = Math.floor((time / 1000 - 1575331200) / 86400);
  assert.equal(observationState(row, time + 61000, day), 'unavailable');
});
const bytes = Buffer.from(JSON.stringify(Array.from({ length: 400 }, (_, i) => rawRow(1255 + i))));
const inspected = inspectInput(
  bytes,
  selection(bytes, { toSourceDay: 1654, toDate: '2024-06-13' }),
);
const revision = randomUUID();
function server(overrides = {}) {
  const urls = [];
  return {
    urls,
    get: async (url, schema, signal) => {
      signal.throwIfAborted();
      urls.push(url);
      const q = new URL(url, 'http://local').searchParams;
      const all = inspected.rows.filter(
        (r) => r.sourceRecordDateUtc >= q.get('from') && r.sourceRecordDateUtc <= q.get('to'),
      );
      const remaining = all.filter((r) => r.sourceDay > Number(q.get('afterSourceDay') ?? -1));
      const items = remaining.slice(0, 64);
      const result = {
        chain: 'pulsechain',
        chainId: 369,
        source: 'hexdailystats',
        sourceReported: true,
        revision,
        metadata: inspected.metadata,
        fieldDefinitions: {},
        coverage: {
          from: q.get('from'),
          to: q.get('to'),
          records: all.length,
          prices: all.filter((r) => r.referencePriceUsd.value).length,
          missingRecordDates: [],
          missingPriceDates: [],
        },
        items,
        continuation:
          remaining.length > 64 ? { afterSourceDay: items.at(-1).sourceDay, revision } : null,
      };
      return schema.parse({
        ...result,
        ...overrides,
        ...(typeof overrides.change === 'function' ? overrides.change(result, urls.length) : {}),
      });
    },
  };
}
test('archive selection follows 64-row cursor plus revision across 366-date windows', async () => {
  const fake = server();
  const result = await loadArchive(
    '2023-05-11',
    '2024-06-13',
    new AbortController().signal,
    fake.get,
  );
  assert.equal(result.rows.length, 400);
  assert.equal(result.pages, 7);
  assert.match(fake.urls[1], /afterSourceDay=/);
  assert.match(fake.urls[1], /revision=/);
});
test('archive rejects revision changes, duplicate/nonadvancing pages and cancellation', async () => {
  const first = server();
  let calls = 0;
  const changed = async (...args) => {
    const page = await first.get(...args);
    if (++calls === 2) page.revision = randomUUID();
    return page;
  };
  await assert.rejects(
    loadArchive('2023-05-11', '2023-09-01', new AbortController().signal, changed),
    /changed or expired/,
  );
  const stuck = server();
  const bad = async (...args) => {
    const page = await stuck.get(...args);
    page.continuation.afterSourceDay = 0;
    return page;
  };
  await assert.rejects(
    loadArchive('2023-05-11', '2023-09-01', new AbortController().signal, bad),
    /did not advance/,
  );
  const controller = new AbortController();
  const stop = async (...args) => {
    const p = await server().get(...args);
    controller.abort();
    return p;
  };
  await assert.rejects(loadArchive('2023-05-11', '2023-09-01', controller.signal, stop));
});
test('graph separates missing prices, absent dates and both duplicate-date records', () => {
  const data = [
    ['2024-09-01', '1'],
    ['2024-09-01', '2'],
    ['2024-09-02', '3'],
    ['2024-09-03', null],
    ['2024-09-04', '4'],
    ['2024-09-06', '5'],
    ['2024-09-07', '6'],
  ].map(([date, value], i) => ({ key: String(i), date, value, status: '', detail: '' }));
  const p = plot(data);
  assert.equal(p.lines.length, 1);
  assert.equal(p.coordinates.length, 7);
  assert.equal(p.coordinates[0].x, p.coordinates[1].x);
  assert.notEqual(p.coordinates[0].y, p.coordinates[1].y);
});
test('chart coordinates normalize exact extremes before approximate pixel conversion', () => {
  for (const pair of [
    ['1e400', '2e400'],
    ['-2e-999', '-1e-999'],
  ]) {
    const p = plot(
      pair.map((value, i) => ({
        key: String(i),
        date: `2024-01-0${i + 1}`,
        value,
        status: 'available',
        detail: '',
      })),
    );
    assert.equal(p.coordinates[0].y, 220);
    assert.equal(p.coordinates[1].y, 35);
  }
});
test('compiled SPA fallback is allowlisted and never swallows API, health or missing assets', async () => {
  const app = createApp({ webRoot: resolve('src/web') });
  try {
    for (const url of [
      '/charts',
      '/calculator',
      '/downloads',
      '/learn',
      '/status',
      '/search',
      '/address/0x' + '1'.repeat(40),
      '/stake/1',
    ]) {
      const r = await app.inject(url);
      assert.equal(r.statusCode, 200);
      assert.match(r.headers['content-type'], /html/);
      const head = await app.inject({ method: 'HEAD', url });
      assert.equal(head.statusCode, 200);
      assert.equal(head.body, '');
    }
    for (const url of [
      '/api/nope',
      '/health/nope',
      '/assets/missing.js',
      '/missing',
      '/charts/nope',
      '/address/nope',
    ]) {
      const r = await app.inject(url);
      assert.equal(r.statusCode, 404);
      assert.match(r.headers['content-type'], /json/);
    }
  } finally {
    await app.close();
  }
});
