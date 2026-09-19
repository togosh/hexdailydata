import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { setTimeout as pause } from 'node:timers/promises';
import http from 'node:http';
import { PageCursors } from '../../src/services/queries/cursor.ts';
import { RangeQuery } from '../../src/contracts/reads.ts';
import { ApiErrorSchema } from '../../src/contracts/api.ts';
import { routes } from '../../src/api/routes.ts';
import { createApp } from '../../src/api/app.ts';
import { AddressService } from '../../src/services/live/address.ts';
import { fixture, ManualClock, CODE_HASH, A, emptyBaseline } from '../live/fixture.mjs';

test('actual HTTP malformed paths and stake IDs are sanitized400 before dependency work', async () => {
  let calls = 0;
  const app = createApp({
    dependencies: {
      db: {
        read() {
          calls++;
          throw new Error('must not query');
        },
      },
    },
  });
  await app.listen({ host: '127.0.0.1', port: 0 });
  try {
    for (const path of [
      '/api/v2/stakes/PRIVATE_MARKER%ZZ',
      '/api/v2/addresses/PRIVATE_MARKER%C0%AF',
      '/api/v2/stakes/' + 'a'.repeat(2050),
      ...['nope', '1.5', '1e3', '-1', '0x10', '1099511627776'].map((id) => '/api/v2/stakes/' + id),
    ]) {
      const response = await new Promise((resolve, reject) => {
        http
          .get({ host: '127.0.0.1', port: app.server.address().port, path }, async (r) => {
            try {
              const chunks = [];
              for await (const chunk of r) chunks.push(chunk);
              resolve({
                status: r.statusCode,
                headers: r.headers,
                text: Buffer.concat(chunks).toString(),
              });
            } catch (error) {
              reject(error);
            }
          })
          .on('error', reject);
      });
      assert.equal(response.status, 400, path);
      const body = ApiErrorSchema.parse(JSON.parse(response.text));
      assert.equal(body.error.code, 'invalid_request');
      assert.equal(body.error.retryable, false);
      assert.equal(response.headers['cache-control'], 'no-store');
      assert.ok(!response.text.includes(path) && !response.text.includes('PRIVATE_MARKER'));
    }
    assert.equal(calls, 0);
  } finally {
    await app.close();
  }
});

test('page cursors reject tampering, filter/chain binding, expiry and another process', () => {
  const c = new PageCursors(),
    token = c.encode('stakes/pulsechain/50', 'observed-block', '100', 1000);
  assert.equal(c.decode(token, 'stakes/pulsechain/50', 1001).key, '100');
  for (const [text, binding, time] of [
    [token, 'stakes/ethereum/50', 1001],
    [token, 'stakes/pulsechain/100', 1001],
    [token, 'stakes/pulsechain/50', 61000],
    [token.slice(0, -3) + 'abc', 'stakes/pulsechain/50', 1001],
  ])
    assert.throws(
      () => c.decode(text, binding, time),
      (e) => e.status === 409,
    );
  assert.throws(() => new PageCursors().decode(token, 'stakes/pulsechain/50', 1001));
});
test('real calendar ranges and deterministic OpenAPI inventory share runtime definitions', () => {
  for (const q of [
    { from: '2023-02-29', to: '2023-03-01' },
    { from: '2024-02-30', to: '2024-03-01' },
    { from: '2024-03-01', to: '2024-02-29' },
    { from: '2018-01-01', to: '2018-01-02' },
  ])
    assert.equal(RangeQuery.safeParse(q).success, false);
  assert.equal(RangeQuery.safeParse({ from: '2024-02-29', to: '2024-03-01' }).success, true);
  const r = spawnSync(process.execPath, ['scripts/openapi.mjs', '--check'], { encoding: 'utf8' });
  assert.equal(r.status, 0, r.stderr);
  const document = JSON.parse(readFileSync('docs/openapi.json', 'utf8'));
  assert.equal(Object.keys(document.paths).length, routes.length);
  for (const route of routes)
    assert.ok(document.paths[route.path.replace(/:([a-z]+)/g, '{$1}')].get);
});
test('actual HTTP disconnect cancels last synthetic provider caller; one coalesced caller survives', async () => {
  const clock = new ManualClock(),
    f = fixture({ clock });
  clock.time = Math.ceil((clock.time + 60000) / 10500) * 10500;
  let entered = 0,
    aborted = 0,
    release;
  f.state.delay = (signal) =>
    new Promise((resolve, reject) => {
      entered++;
      release = resolve;
      signal.addEventListener(
        'abort',
        () => {
          aborted++;
          reject(signal.reason);
        },
        { once: true },
      );
    });
  const service = new AddressService(f.rpc('api', f.api), CODE_HASH, emptyBaseline);
  const app = createApp({ dependencies: { addresses: service } });
  await app.listen({ host: '127.0.0.1', port: 0 });
  const url = 'http://127.0.0.1:' + app.server.address().port + '/api/v2/addresses/' + A;
  try {
    const one = new AbortController(),
      two = new AbortController();
    const a = fetch(url, { signal: one.signal }).catch(() => null),
      b = fetch(url, { signal: two.signal }).catch(() => null);
    for (let i = 0; i < 100 && service.counters.coalesced < 1; i++) await pause(5);
    assert.equal(service.counters.coalesced, 1);
    assert.equal(entered, 1);
    one.abort();
    await a;
    await pause(20);
    assert.equal(aborted, 0);
    two.abort();
    await b;
    for (let i = 0; i < 100 && !aborted; i++) await pause(5);
    assert.equal(aborted, 1);
    assert.equal(service.counters.cancelled, 1);
    assert.equal(service.inflight.size, 0);
    assert.ok(release);
  } finally {
    await app.close();
  }
});

test(
  'HTTP address lifetime permits a valid six-second response beyond the old shell timeout',
  { timeout: 15000 },
  async () => {
    const f = fixture();
    f.clock.time = Math.ceil((f.clock.time + 60000) / 10500) * 10500;
    let first = true;
    f.state.delay = async (signal) => {
      if (first) {
        first = false;
        await pause(6100, undefined, { signal });
      }
    };
    const service = new AddressService(f.rpc('api', f.api), CODE_HASH, emptyBaseline);
    const app = createApp({ dependencies: { addresses: service } });
    await app.listen({ host: '127.0.0.1', port: 0 });
    try {
      const start = performance.now();
      const response = await fetch(
        'http://127.0.0.1:' + app.server.address().port + '/api/v2/addresses/' + A,
      );
      assert.equal(response.status, 200);
      assert.ok((await response.json()).live);
      assert.ok(performance.now() - start >= 6000);
    } finally {
      await app.close();
    }
  },
);
