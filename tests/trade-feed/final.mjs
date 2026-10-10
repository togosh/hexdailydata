import assert from 'node:assert/strict';
import fs from 'node:fs';
import fsp, { readFile, writeFile, mkdir } from 'node:fs/promises';
import { join, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { syncBuiltinESMExports } from 'node:module';
import { chromium } from 'playwright';
import { sha, SavedSourceGenerations } from '../../dist/services/source-update/generation.js';
import { ACCEPTED } from '../../dist/contracts/saved-generation.js';
import { preserveMarketHistory, marketEvidence } from '../../dist/services/product-daily/market.js';
import {
  backupParticipants,
  restoreParticipants,
} from '../../scripts/participant-refresh-backup.mjs';
import { fixture, auth } from '../market-feed/access-fixture.mjs';
import * as defaultBudget from './budget.mjs';

export async function finalEvidence({
  R,
  real,
  seed,
  f,
  origin,
  heldExport,
  save,
  budget = defaultBudget,
}) {
  const p = real.productDaily.capture();
  preserveMarketHistory(seed, p);
  assert.deepEqual(p.rows.slice(0, seed.rows.length), seed.rows);
  for (const k of [
    'pair',
    'ledgerSegments',
    'liquidityHistory',
    'benchmarkHistory',
    'ledgerObservedAtUtc',
    'priceSegments',
  ])
    assert.deepEqual(p.metadata[k], seed.metadata[k]);
  assert.deepEqual(
    p.metadata.readings.filter((r) => r.kind !== 'trade' && r.kind !== 'reference'),
    seed.metadata.readings.filter((r) => r.kind !== 'reference'),
  );
  for (const r of seed.metadata.readings.filter((r) => r.kind === 'reference'))
    assert(marketEvidence(p.metadata).some((n) => JSON.stringify(n) === JSON.stringify(r)));
  const trades = marketEvidence(p.metadata).filter((r) => r.kind === 'trade'),
    changed = [];
  for (const row of p.rows.slice(seed.rows.length)) {
    const expected = Object.fromEntries(Object.keys(row).map((k) => [k, null]));
    expected.contractDay = row.contractDay;
    expected.dateUtc = row.dateUtc;
    for (const r of trades.filter((r) => r.observedAtUtc.slice(0, 10) === row.dateUtc)) {
      expected[r.asset === 'BTC' ? 'btcPriceUsd' : 'ethPriceUsd'] = r.value;
      expected[r.asset === 'BTC' ? 'btcRecordedAtUtc' : 'ethRecordedAtUtc'] = r.observedAtUtc;
    }
    assert.deepEqual(row, expected);
    changed.push(row);
  }
  const chunks = [];
  for await (const b of heldExport.stream) chunks.push(b);
  await heldExport.released;
  assert.equal(sha(Buffer.concat(chunks)), sha(seed.csv));
  const routes = [
    '/api/v2/live',
    '/api/v2/home',
    '/api/v2/daily?from=2026-10-01&to=' + p.metadata.through + '&metric=btcPriceUsd',
    '/api/v2/holders?limit=1',
    '/api/v2/stakes?limit=1',
  ];
  f.controls.now = Date.now();
  // Preview requests advance controls.now; restore must use the API comparison clock.
  const comparisonNow = f.controls.now;
  const responses = {};
  for (const url of routes) {
    const r = await f.inject(url);
    assert.equal(r.statusCode, 200, r.body);
    responses[url] = r.json();
  }
  const download = '/api/v2/downloads/' + p.bundleId + '/daily';
  assert([401, 403].includes((await f.inject(download)).statusCode));
  const csv = await f.inject({ url: download, headers: auth() });
  assert.equal(csv.statusCode, 200, csv.body);
  assert.equal(sha(csv.body), sha(p.csv));
  for (const method of ['HEAD', 'GET']) {
    const r = await f.inject({
      url: download,
      method,
      headers: { ...auth(), 'if-none-match': csv.headers.etag },
    });
    assert.equal(r.statusCode, 304);
  }
  await save('FINAL_NORMAL_API', responses);
  await save('GENUINE_PRESERVATION', {
    status: 'PASS',
    existingRows: seed.rows.length,
    exactExistingCells: seed.rows.reduce((n, r) => n + Object.keys(r).length, 0),
    selectedRows: p.rows.length,
    newRows: changed,
    fixedCloseCells: p.metadata.benchmarkHistory.buckets.length,
    fixedBucketSha256: p.metadata.benchmarkHistory.selectionSha256,
    originalOracleReadings: seed.metadata.readings.filter((r) => r.kind === 'reference'),
    pair: p.metadata.pair,
    ledgerPeriods: p.metadata.coverage.ledgerDates,
    liquidityDates: p.metadata.liquidityHistory.length,
    selected: { version: p.version, manifestSha256: p.manifestSha256, csvSha256: sha(p.csv) },
    protectedCsv: 'PASS',
    unauthenticatedRefusal: 'PASS',
    head304: 'PASS',
    heldOriginalCsvSha256: sha(seed.csv),
  });
  let backup;
  if (p.version !== seed.version) {
    backup = await backupParticipants(real, join(R, 'real-backup'));
    await save('GENUINE_BACKUP', backup);
  }
  if (p.version !== seed.version) await previews({ R, origin, save, f, budget });
  return {
    backup,
    expected: {
      version: p.version,
      manifestSha256: p.manifestSha256,
      csvSha256: sha(p.csv),
      rows: p.rows,
      readings: p.metadata.readings,
      pair: p.metadata.pair,
    },
    routes,
    responses,
    now: comparisonNow,
  };
}
export async function previews({ R, origin, save, f, budget = defaultBudget }) {
  const dir = join(R, 'evidence/preview');
  await mkdir(dir, { recursive: true });
  const result = { screenshots: [], blocked: [], errors: [] };
  let browser;
  const pending = [],
    reservations = new WeakMap();
  try {
    const executablePath = [
      chromium.executablePath(),
      'C:/Program Files/Google/Chrome/Application/chrome.exe',
      'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
    ].find(fs.existsSync);
    assert(executablePath);
    browser = await chromium.launch({
      headless: true,
      executablePath,
      proxy: { server: origin, bypass: '127.0.0.1' },
      env: { SystemRoot: process.env.SystemRoot, TEMP: join(R, 'temp'), TMP: join(R, 'temp') },
      args: [
        '--disable-background-networking',
        '--disable-component-update',
        '--disable-domain-reliability',
        '--disable-sync',
        '--no-first-run',
        '--no-default-browser-check',
        '--host-resolver-rules=MAP * ~NOTFOUND, EXCLUDE 127.0.0.1',
        '--disable-features=MediaRouter,OptimizationHints,AutofillServerCommunication',
        '--disable-quic',
        '--force-webrtc-ip-handling-policy=disable_non_proxied_udp',
      ],
    });
    const context = await browser.newContext({ serviceWorkers: 'block' });
    await context.route('**/*', async (route) => {
      const u = new URL(route.request().url());
      if (u.origin !== origin || u.protocol !== 'http:') {
        result.blocked.push(u.origin);
        return route.abort();
      }
      f.controls.now = Date.now();
      reservations.set(
        route.request(),
        budget.reserve(u.pathname + u.search, 2 * 1024 ** 2 + 65536),
      );
      await route.continue();
    });
    await context.routeWebSocket('**/*', (ws) => {
      result.blocked.push('websocket');
      ws.close();
    });
    const page = await context.newPage();
    page.on('pageerror', (e) => result.errors.push(e.message));
    page.on('response', (r) =>
      pending.push(
        r
          .body()
          .then((body) =>
            budget.complete(reservations.get(r.request()), body.length + 65536, r.status()),
          ),
      ),
    );
    for (const [name, path, width] of [
      ['01-live-desktop.png', '/live', 1440],
      ['02-home-mobile.png', '/', 390],
    ]) {
      await page.setViewportSize({ width, height: 1000 });
      await page.goto(origin + path);
      await page.waitForLoadState('networkidle');
      await page.getByTestId('live-product').waitFor({ timeout: 30000 });
      const text = await page.locator('body').innerText();
      assert(text.includes('Bitstamp readings sample a reported trade'));
      assert(text.includes('Freshness is per observation'));
      assert(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1));
      await writeFile(join(dir, name + '.txt'), text);
      await page.screenshot({ path: join(dir, name), fullPage: true });
      result.screenshots.push({ name, path, width });
    }
    await Promise.all(pending);
    assert.deepEqual(result.errors, []);
    result.status = 'PASS';
    await context.close();
  } finally {
    if (browser) await browser.close();
    result.browserClosed = true;
    await save('PREVIEW', result);
  }
}

export async function restoreProof({
  R,
  profile,
  final,
  save,
  admittedBase,
  budget = defaultBudget,
  baseAdmissionCount,
}) {
  if (!final.backup)
    return save('GENUINE_RESTORE', {
      status: 'UNCHANGED_SEED_REFERENCED',
      noSyntheticBackup: true,
    });
  const denied = [
    join(R, 'runtime'),
    join(R, 'reference/seed'),
    profile.productRoot,
    profile.participantRoot,
  ].map((p) => resolve(p));
  const originals = [];
  const check = (p) => {
    if (typeof p !== 'string' && !(p instanceof URL)) return;
    const path = resolve(p instanceof URL ? fileURLToPath(p) : p);
    if (denied.some((d) => path === d || path.startsWith(d + sep)))
      throw Error('PRIOR_WRITABLE_ROOT_UNAVAILABLE');
  };
  for (const object of [fs, fsp])
    for (const name of [
      'readFile',
      'readFileSync',
      'open',
      'openSync',
      'stat',
      'statSync',
      'lstat',
      'lstatSync',
      'readdir',
      'readdirSync',
      'writeFile',
      'writeFileSync',
      'rename',
      'renameSync',
      'unlink',
      'unlinkSync',
    ])
      if (typeof object[name] === 'function') {
        const original = object[name];
        originals.push([object, name, original]);
        object[name] = function (p, ...args) {
          check(p);
          if (name.startsWith('rename')) check(args[0]);
          return original.call(this, p, ...args);
        };
      }
  syncBuiltinESMExports();
  let base, restored, f;
  try {
    base =
      admittedBase ??
      (await SavedSourceGenerations.activate({
        root: profile.overlayRoot,
        holdersRoot: profile.holdersRoot,
        stakesRoot: profile.stakesRoot,
      }));
    if (!admittedBase) {
      await base.admit(join(base.root, ACCEPTED.generation), { readOnly: true });
      await base.loadSelection();
    }
    restored = await restoreParticipants(
      final.backup.destination,
      join(R, 'restored-candidate'),
      final.backup.sha256,
      base,
    );
    const p = restored.registry.productDaily.capture();
    assert.equal(p.version, final.expected.version);
    assert.equal(sha(p.csv), final.expected.csvSha256);
    assert.deepEqual(p.rows, final.expected.rows);
    assert.deepEqual(p.metadata.readings, final.expected.readings);
    f = budget.guard(
      await fixture(
        {
          participants: restored.registry,
          productDaily: restored.registry.productDaily,
          sourceGenerations: base,
        },
        { evidenceRoot: join(R, 'evidence') },
      ),
    );
    await verifyRestoredResponses({ f, final, product: p });
    await save('GENUINE_RESTORE', {
      status: 'PASS',
      receipt: restored.receipt,
      deniedPriorRoots: denied,
      exactBaseAdmissions: baseAdmissionCount ?? (admittedBase ? null : 1),
      admittedImmutableBaseHandlesReused: Boolean(admittedBase),
      selected: restored.registry.status(),
      csvSha256: sha(p.csv),
      externalBasesReadOnly: true,
    });
  } finally {
    if (f) await f.close();
    if (restored) await restored.registry.close();
    if (base && !admittedBase) await base.close();
    for (const [o, n, fn] of originals) o[n] = fn;
    syncBuiltinESMExports();
  }
}

// Reusable affected comparison, including a recheck of an already restored root.
// This neither creates a restore nor relaxes values, freshness or access assertions.
export async function verifyRestoredResponses({ f, final, product }) {
  assert.equal(
    new Date(Math.floor(final.now / 1000) * 1000).toISOString(),
    final.responses['/api/v2/live'].servedAtUtc,
    'RESTORE_COMPARISON_CLOCK_MISMATCH',
  );
  f.controls.now = final.now;
  const comparable = (v) =>
    JSON.parse(JSON.stringify(v, (k, v) => (k === 'nextCursor' && v !== null ? 'present' : v)));
  for (const url of final.routes) {
    const r = await f.inject(url);
    assert.equal(r.statusCode, 200);
    assert.deepEqual(comparable(r.json()), comparable(final.responses[url]));
  }
  const csv = await f.inject({
    url: '/api/v2/downloads/' + product.bundleId + '/daily',
    headers: auth(),
  });
  assert.equal(csv.statusCode, 200);
  assert.equal(sha(csv.body), final.expected.csvSha256);
}
