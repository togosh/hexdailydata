import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { createHash } from 'node:crypto';
import { createApp } from '../../dist/api/app.js';
const hash = (b) => createHash('sha256').update(b).digest('hex');
test('actual compiled SPA GET/HEAD /api; negative routes, methods and no-dependency data behavior remain JSON', async () => {
  const app = createApp({ webRoot: resolve('dist/web'), dependencies: {}, mode: 'production' });
  try {
    for (const url of ['/api', '/api/reference'])
      for (const method of ['GET', 'HEAD']) {
        const r = await app.inject({ method, url });
        assert.equal(r.statusCode, 200);
        assert.match(r.headers['content-type'], /html/);
        if (method === 'HEAD') assert.equal(r.body, '');
        else assert.equal(r.body, readFileSync('dist/web/index.html', 'utf8'));
      }
    for (const url of [
      '/api/v2/not-real',
      '/api/v2/openapi.json',
      '/health/not-real',
      '/assets/missing.js',
      '/api/nope',
      '/api/reference/not-real',
      '/address/invalid',
      '/stake/99999999999999999',
      '/not-a-page',
    ]) {
      const r = await app.inject(url);
      assert.equal(r.statusCode, 404);
      assert.match(r.headers['content-type'], /json/);
      assert.equal(r.json().error.code, 'not_found');
    }
    for (const [url, status] of [
      ['/health/live', 200],
      ['/health/ready', 503],
      ['/api/v2/status?chain=pulsechain', 200],
      ['/api/v2/home?chain=pulsechain', 503],
      ['/api/v2/downloads?chain=pulsechain', 200],
      ['/api/v2/stakes?limit=101', 400],
    ]) {
      const r = await app.inject(url);
      assert.equal(r.statusCode, status, url);
      assert.match(r.headers['content-type'], /json/);
    }
    for (const url of ['/api', '/api/reference', '/openapi.json', '/api/v2/home', '/health/live']) {
      const r = await app.inject({ method: 'POST', url });
      assert.equal(r.statusCode, 405);
      assert.equal(r.json().error.code, 'read_only');
      assert.equal(r.headers.allow, 'GET, HEAD');
    }
  } finally {
    await app.close();
  }
});
test('compiled schema static asset is byte-identical; HEAD is empty and no SQL dependency is touched', async () => {
  let touched = 0;
  const app = createApp({
    webRoot: resolve('dist/web'),
    dependencies: {
      db: {
        read: () => {
          touched++;
          throw new Error('No database permitted');
        },
      },
    },
  });
  try {
    const asset = '/openapi.json';
    const r = await app.inject(asset);
    assert.equal(r.statusCode, 200);
    assert.match(r.headers['content-type'], /json/);
    const source = readFileSync('docs/openapi.json');
    assert.deepEqual(r.rawPayload, source);
    assert.equal(Number(r.headers['content-length']), source.length);
    const cached = await app.inject({ url: asset, headers: { 'if-none-match': r.headers.etag } });
    assert.equal(cached.statusCode, 304);
    assert.equal(cached.body, '');
    const head = await app.inject({ method: 'HEAD', url: asset });
    assert.equal(head.statusCode, 200);
    assert.equal(head.body, '');
    assert.equal(touched, 0);
    console.log(
      JSON.stringify({
        schemaAsset: asset,
        bytes: source.length,
        sha256: hash(source),
        compiledGETHEAD: 'PASS',
        databaseCalls: touched,
      }),
    );
  } finally {
    await app.close();
  }
});
