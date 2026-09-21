import assert from 'node:assert/strict';
import { writeFileSync } from 'node:fs';
import { ReadDatabase } from '../../dist/services/queries/database.js';
import { databaseConfig } from '../../dist/db/connect.js';
import { createApp } from '../../dist/api/app.js';
import { maturitiesSql } from '../../dist/services/queries/charts.js';
const mode = process.argv[2],
  at = Date.parse('2026-09-19T12:00:00Z');
const db = new ReadDatabase(databaseConfig('api'));
const app = createApp({
  dependencies: { db },
  now: () => at,
  admission: { capacity: 10000, concurrent: 64 },
});
const checks = [],
  requests = [];
async function get(path) {
  const start = performance.now(),
    r = await app.inject('/api/v2/' + path);
  requests.push({
    path,
    status: r.statusCode,
    bytes: Buffer.byteLength(r.body),
    ms: performance.now() - start,
  });
  return r;
}
async function test(name, action) {
  await action();
  checks.push(name);
  console.log('PASS', name);
}
try {
  await test('chart queries reject unsupported chains/parameters and sanitize unavailable states', async () => {
    for (const route of ['charts/archive', 'charts/native', 'charts/maturities']) {
      assert.equal((await get(route + '?chain=ethereum')).statusCode, 400);
      assert.equal((await get(route + '?limit=99999')).statusCode, 400);
    }
  });
  if (mode === 'archive' || mode === 'both')
    await test('one compact multi-field archive read matches exact daily values, null price and source dates; ETag revalidation', async () => {
      const r = await get('charts/archive');
      assert.equal(r.statusCode, 200, r.body);
      const a = r.json();
      assert.equal(a.items.length, 1227);
      assert.equal(a.source, 'hexdailystats');
      assert.equal(a.metadata.selection.provenance.kind, 'synthetic-fixture');
      assert.ok(a.items.some((row) => row.values[0] === null));
      const last = a.items.at(-1),
        exact = (await get(`daily?source=hexdailystats&from=${last.date}&to=${last.date}`)).json()
          .items[0];
      assert.equal(last.values[0], exact.referencePriceUsd.value);
      assert.equal(last.values[2], exact.metrics.tshareRateHEX.value);
      assert.equal(last.values[7], exact.metrics.currentStakerCount.value);
      assert.equal(last.values[10], exact.metrics.currentHolders.value);
      assert.equal(
        (
          await app.inject({
            url: '/api/v2/charts/archive',
            headers: { 'if-none-match': r.headers.etag },
          })
        ).statusCode,
        304,
      );
      assert.ok(Buffer.byteLength(r.body) < 600000);
    });
  if (mode === 'archive')
    await test('archive-only cannot manufacture native activity or maturities', async () => {
      assert.equal((await get('charts/native')).statusCode, 503);
      assert.equal((await get('charts/maturities')).statusCode, 503);
    });
  if (mode !== 'archive')
    await test('expired current price remains unavailable independently of retained chart history', async () => {
      const r = await get('home');
      assert.equal(r.statusCode, 200, r.body);
      assert.equal(r.json().live.price.status, 'unavailable');
      assert.equal(r.json().live.price.value, null);
    });
  if (mode !== 'archive')
    await test('native completed-day series equals exact read and current cutoff is excluded', async () => {
      const r = await get('charts/native');
      assert.equal(r.statusCode, 200, r.body);
      const n = r.json(),
        last = n.items.at(-1);
      assert.ok(last.day < n.cutoff.contractDay);
      assert.equal(n.truncated, false);
      assert.equal(n.items.length, 1228);
      const exact = (await get(`daily?from=${last.date}&to=${last.date}`)).json().items[0];
      assert.equal(last.values[0], exact.payout.hexPerTShare);
      assert.equal(last.values[8], exact.activity.newStakes);
      assert.equal(last.values[9], exact.activity.endedStakes);
      assert.equal(last.values[10], exact.activity.penaltiesHex);
      assert.equal(last.values[7], exact.holderCount);
    });
  if (mode !== 'archive')
    await test('bounded future maturity aggregate agrees with independent lifecycle selection and exact integer totals', async () => {
      const r = await get('charts/maturities');
      assert.equal(r.statusCode, 200, r.body);
      const m = r.json();
      const truth = await db.read(
        new AbortController().signal,
        async (c) =>
          (
            await c.query(
              'SELECT principal_hearts,stake_shares,locked_day,staked_days,lifecycle FROM hdd.stakes WHERE chain_id=369',
            )
          ).rows,
      );
      const selected = truth.filter(
        (s) => s.lifecycle === 'unsettled' && s.locked_day + s.staked_days > m.cutoff.contractDay,
      );
      assert.equal(
        m.items.reduce((n, v) => n + BigInt(v.count), 0n),
        BigInt(selected.length),
      );
      assert.equal(
        m.items.reduce((n, v) => n + BigInt(v.principalHearts), 0n),
        selected.reduce((n, s) => n + BigInt(s.principal_hearts), 0n),
      );
      assert.equal(
        m.items.reduce((n, v) => n + BigInt(v.stakeShares), 0n),
        selected.reduce((n, s) => n + BigInt(s.stake_shares), 0n),
      );
      assert.ok(m.items.length <= 5556);
      if (mode === 'none') assert.deepEqual(m.items, []);
      if (mode === 'later') assert.ok(m.items.every((r) => r.day > m.cutoff.contractDay + 90));
      const plan = await db.read(
        new AbortController().signal,
        async (c) =>
          (
            await c.query('EXPLAIN (ANALYZE,BUFFERS,FORMAT JSON) ' + maturitiesSql, [
              m.cutoff.contractDay,
            ])
          ).rows,
      );
      writeFileSync(`/evidence/maturity-plan-${mode}.json`, JSON.stringify(plan, null, 2));
    });
  if (['native', 'later', 'none'].includes(mode))
    await test('native-only has no price/share-cost/reported-T-share archive substitute', async () => {
      assert.equal((await get('charts/archive')).statusCode, 503);
    });
} finally {
  writeFileSync(
    `/evidence/api-${mode}.json`,
    JSON.stringify({ mode, checks, requests, liveRequests: 0 }, null, 2),
  );
  await app.close();
  await db.close();
}
