import './deny-network.mjs';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { fork } from 'node:child_process';
import { once } from 'node:events';
import { setTimeout as delay } from 'node:timers/promises';
import { createHash } from 'node:crypto';
import { initialize, now, address } from './fixture.mjs';
import { checkCalculator } from './calculator.mjs';
import { openDependencies } from '../../dist/api/dependencies.js';
import { ProductHomeResponseSchema } from '../../dist/contracts/product-daily.js';
import { CalculatorResponseSchema } from '../../dist/contracts/reads.js';
const T = resolve(process.env.HDD_TASK_ROOT ?? '');
assert(T.endsWith('mainline-consolidation-r1'));
const W = resolve('.');
await fs.mkdir(join(T, 'fixtures'), { recursive: true });
const root = await fs.mkdtemp(join(T, 'fixtures/entry-'));
const receipt = {
  synthetic: true,
  root,
  startedAt: new Date().toISOString(),
  externalRequests: 0,
  genuineBaseAdmissions: 0,
  baseline: null,
  checks: [],
  requests: 0,
  chargedBytes: 0,
  listenersSeconds: 0,
  seam: 'actual compiled ordinary-entry composition with synthetic immutable-admission seam',
  children: [],
};
const check = (name) => receipt.checks.push(name);
const hash = (b) => createHash('sha256').update(b).digest('hex');
let active;
async function child(extra = {}, seam = true, positive = false, source = false) {
  const env = {
    ...process.env,
    HDD_V2_PRODUCT_PROFILE: join(root, 'profile.json'),
    HDD_V2_HTTP_PORT: '0',
    HDD_V2_HTTP_HOST: '127.0.0.1',
    HDD_SYNTHETIC_ROOT: root,
    ...extra,
  };
  const entry = source ? 'src/api/main.ts' : 'dist/api/main.js';
  const p = fork(entry, [], {
    cwd: W,
    env,
    silent: true,
    execArgv: seam
      ? ['--import', pathToFileURL(join(W, 'tests/mainline/admission.mjs')).href]
      : [],
  });
  let stdout = '',
    stderr = '';
  p.stdout.on('data', (b) => (stdout += b));
  p.stderr.on('data', (b) => (stderr += b));
  const start = performance.now();
  let ended = false;
  const finished = once(p, 'exit').then(([code, signal]) => {
    ended = true;
    return { code, signal };
  });
  async function stop() {
    if (!ended) {
      if (p.connected) p.send('mainline-test-close');
      else p.kill();
    }
    const result = await Promise.race([finished, delay(6000).then(() => null)]);
    if (!result) {
      p.kill();
      await finished;
      throw Error('OWNED_CHILD_CLOSE_TIMEOUT');
    }
    receipt.listenersSeconds += (performance.now() - start) / 1000;
    receipt.children.push({ entry, seam, stdout, stderr, ...result });
    return result;
  }
  if (!positive) {
    const outcome = await Promise.race([finished, delay(6000).then(() => null)]);
    if (!outcome) {
      await stop();
      throw Error('EXPECTED_STARTUP_REFUSAL');
    }
    await stop();
    assert.equal(outcome.code, 1);
    assert(!stdout.includes('listening'));
    assert(stderr.includes('startup_failed'));
    assert(stderr.length < 256);
    return;
  }
  for (let i = 0; i < 120 && !ended; i++) {
    const line = stdout.split('\n').find((l) => l.includes('"event":"listening"'));
    if (line) {
      return {
        p,
        stop,
        url: 'http://127.0.0.1:' + JSON.parse(line).port,
        stdout: () => stdout,
      };
    }
    await delay(50);
  }
  await stop();
  throw Error('ENTRY_NOT_LISTENING:' + stderr);
}
async function req(path, options = {}) {
  assert(receipt.requests++ < 6000);
  const response = await fetch(active.url + path, {
    ...options,
    signal: AbortSignal.timeout(8000),
  });
  const bytes = Buffer.from(await response.arrayBuffer());
  receipt.chargedBytes += bytes.length + 8192;
  assert(receipt.chargedBytes < 4 * 1024 ** 3);
  return {
    status: response.status,
    headers: Object.fromEntries(response.headers),
    text: bytes.toString(),
    json: () => JSON.parse(bytes.toString()),
  };
}
try {
  receipt.baseline = await checkCalculator(root);
  check('baseline mismatch; exact calculator and price guards; explicit dormant legacy mode');
  const profile = await initialize(root);
  for (const [label, env] of [
    ['missing', { HDD_V2_PRODUCT_PROFILE: '' }],
    ['incidental SQL', { HDD_V2_DB_HOST: 'db' }],
    ['RPC fallback', { HDD_V2_ALLOW_LIVE_RPC: 'true' }],
    ['unknown mode', { HDD_V2_API_MODE: 'unknown' }],
    ['legacy without config', { HDD_V2_API_MODE: 'legacy-sql', HDD_V2_PRODUCT_PROFILE: '' }],
  ]) {
    await child(env, false);
    check(label + ' refused before dependencies');
  }
  await child({ HDD_V2_PRODUCT_PROFILE: '' }, false, false, true);
  check('source entry matches compiled missing-profile refusal');
  for (const [label, value] of [
    ['malformed', '{'],
    ['unknown', JSON.stringify({ ...profile, extra: true })],
    [
      'foreign',
      JSON.stringify({ ...profile, pair: { ...profile.pair, generation: 'f'.repeat(64) } }),
    ],
    ['UNC', JSON.stringify({ ...profile, holdersRoot: '\\\\foreign\\private' })],
    ['oversized', ' '.repeat(16385)],
  ]) {
    const path = join(root, label + '.json');
    await fs.writeFile(path, value);
    await child({ HDD_V2_PRODUCT_PROFILE: path }, false);
    check(label + ' refused');
  }
  await child({}, false);
  check('no preload cannot bypass immutable base admission');
  for (const [label, patch] of [
    ['counts', { pair: { ...profile.pair, holderRecordCount: 1 } }],
    ['product', { productRoot: join(root, 'absent-product') }],
  ]) {
    const path = join(root, label + '.json');
    await fs.writeFile(path, JSON.stringify({ ...profile, ...patch }));
    await child({ HDD_V2_PRODUCT_PROFILE: path });
    check(label + ' failure closes admitted readers');
  }
  active = await child({}, true, true);
  for (const path of [
    '/health/ready',
    '/api/v2/home',
    '/api/v2/live',
    '/api/v2/downloads',
    '/api/v2/daily?from=2026-10-01&to=2026-10-11',
    '/api/v2/markets/daily?from=2026-10-01&to=2026-10-11',
    '/api/v2/holders?limit=2',
    '/api/v2/stakes?limit=2',
    '/api/v2/stakes/1',
    '/api/v2/addresses/' + address(0),
    '/api/v2/addresses/' + address(0) + '/stakes',
  ]) {
    const r = await req(path);
    assert.equal(r.status, 200, path + ':' + r.text);
    check(path);
  }
  const home = (await req('/api/v2/home')).json();
  ProductHomeResponseSchema.parse(home);
  const calc = await req('/api/v2/calculator/inputs');
  CalculatorResponseSchema.parse(calc.json());
  assert.equal(calc.json().datasetVersion, home.datasetVersion);
  assert.equal(calc.json().shareRate.value.rawShareRate, '123456');
  for (const method of ['GET', 'HEAD']) {
    const r = await req('/api/v2/calculator/inputs', { method });
    assert.equal(r.status, 200);
    assert.equal(r.headers.etag, calc.headers.etag);
    if (method === 'HEAD') assert.equal(r.text, '');
    const cached = await req('/api/v2/calculator/inputs', {
      method,
      headers: { 'If-None-Match': calc.headers.etag },
    });
    assert.equal(cached.status, 304);
    assert.equal(cached.text, '');
  }
  check('calculator schema and GET/HEAD/304');
  for (const [path, status] of [
    ['/api/v2/charts/maturities', 503],
    ['/api/v2/stake-events', 403],
    ['/api/v2/stakes?minPrincipalHearts=1', 400],
    ['/api/v2/calculator/inputs?chain=ethereum', 400],
    ['/api/v2/home?source=subgraph', 400],
    ['/api/v2/holders?limit=51', 403],
  ]) {
    const r = await req(path);
    assert.equal(r.status, status, r.text);
    check(path + '=' + status);
  }
  for (const method of ['GET', 'HEAD'])
    for (const key of [null, 'bogus', 'Bearer lab_' + 'x'.repeat(43)]) {
      const headers = {
        'If-None-Match': calc.headers.etag,
        ...(key ? { Authorization: key } : {}),
      };
      const r = await req('/api/v2/downloads/11111111-1111-4111-8111-111111111111/daily', {
        method,
        headers,
      });
      assert([401, 403, 503].includes(r.status), r.text);
      assert.notEqual(r.status, 304);
    }
  const bad = await req('/api/v2/home', { headers: { Authorization: 'bogus' } });
  assert.equal(bad.status, 401);
  const key = await req('/api/v2/home', {
    headers: { Authorization: 'Bearer lab_' + 'x'.repeat(43) },
  });
  assert.equal(key.status, 503);
  check(
    'normal missing/invalid/default inactive paid access; CSV authorization before HEAD/304',
  );
  for (const name of ['daily', 'stakes', 'holders', 'maturities', 'markets']) {
    const r = await req('/samples/' + name + '.csv');
    assert.equal(r.status, 200);
    assert(r.text.length <= 16384);
    assert(r.headers['x-data-label'].includes('SYNTHETIC SAMPLE'));
    assert(r.headers['content-disposition'].includes('SYNTHETIC-SAMPLE'));
    assert.equal((await req('/samples/' + name + '.csv', { method: 'HEAD' })).text, '');
    assert.equal(
      (
        await req('/samples/' + name + '.csv', {
          headers: { 'If-None-Match': r.headers.etag },
        })
      ).status,
      304,
    );
  }
  assert.equal((await req('/samples/daily.csv?limit=1000')).status, 400);
  for (const path of [
    '/samples/CURRENT.json',
    '/product/CURRENT.json',
    '/.env',
    '/src/api/main.ts',
    '/%2e%2e%2fproduct%2fCURRENT.json',
  ]) {
    const r = await req(path);
    assert([400, 404, 503].includes(r.status), path + ':' + r.status);
  }
  check('five bounded labelled samples; query/static traversal refusal');
  await fs.writeFile(join(root, 'clock.txt'), String(now + 301000));
  const aged = (await req('/api/v2/home')).json();
  assert.equal(aged.live.freshness.HEX.status, 'stale');
  assert.equal(aged.live.hexPriceUsd, home.live.hexPriceUsd);
  assert.equal(aged.live.freshness.HEX.observedAtUtc, home.live.freshness.HEX.observedAtUtc);
  check('same running API ages source time without refreshing quote');
  await fs.writeFile(join(root, 'clock.txt'), String(now));
  const first = active;
  const other = await child({ HDD_V2_HTTP_PORT: new URL(first.url).port });
  check('partial listen failure closes readers');
  await active.stop();
  active = null;
  const events = (await fs.readFile(join(root, 'admissions.ndjson'), 'utf8'))
    .trim()
    .split('\n')
    .map(JSON.parse);
  assert.equal(events.filter((x) => x.action === 'open').length, 4);
  assert(events.filter((x) => x.action === 'close').length >= 4);
  check('all admitted synthetic handles closed');
  receipt.status = 'PASS';
  receipt.profile = join(root, 'profile.json');
  receipt.artifacts = {};
  for (const p of [
    'dist/api/main.js',
    'dist/api/entry.js',
    'dist/api/app.js',
    'dist/services/product-daily/calculator.js',
    'dist/services/product-daily/open.js',
    'dist/web/index.html',
  ])
    receipt.artifacts[p] = hash(await fs.readFile(p));
} catch (e) {
  receipt.status = 'FAIL';
  receipt.error = e.stack;
  process.exitCode = 1;
} finally {
  if (active) await active.stop();
  receipt.completedAt = new Date().toISOString();
  await fs.writeFile(join(root, 'RESULT.json'), JSON.stringify(receipt, null, 2));
  console.log(JSON.stringify(receipt, null, 2));
}
