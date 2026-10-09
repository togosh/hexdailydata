// Genuine saved-result preservation, one compact restore and guarded actual UI preview.
import assert from 'node:assert/strict';
import fs, { existsSync } from 'node:fs';
import fsp, { readFile, writeFile, mkdir } from 'node:fs/promises';
import { join, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { syncBuiltinESMExports } from 'node:module';
import { chromium } from 'playwright';
import { sha, canonical } from '../../dist/services/source-update/generation.js';
import { preserveMarketHistory } from '../../dist/services/product-daily/market.js';
import {
  backupParticipants,
  restoreParticipants,
} from '../../scripts/participant-refresh-backup.mjs';
import { guardFixture, reserveResponse, checkResponse } from './close-budget.mjs';
import { fixture as makeFixture, auth, charge } from '../market-feed/access-fixture.mjs';
export async function finalize({ R, real, base, fixture, origin, seed, save, afterRestore }) {
  const held = real.capture();
  try {
    const product = held.product;
    preserveMarketHistory(seed, product);
    for (const k of ['pair', 'liquidityHistory', 'ledgerSegments'])
      assert.deepEqual(product.metadata[k], seed.metadata[k]);
    assert.deepEqual(product.metadata.readings, seed.metadata.readings);
    const permitted = new Set(['btcPriceUsd', 'ethPriceUsd']);
    let fields = 0;
    for (const row of seed.rows) {
      const next = product.rows.find((r) => r.dateUtc === row.dateUtc);
      assert(next);
      for (const [k, v] of Object.entries(row))
        if (!permitted.has(k) || row.dateUtc > '2026-10-08') {
          assert.deepEqual(next[k], v);
          fields++;
        }
    }
    const references = product.metadata.readings.filter((r) => r.kind === 'reference');
    for (const r of references) {
      const row = product.rows.find((x) => x.dateUtc === r.observedAtUtc.slice(0, 10));
      assert.equal(row[r.asset === 'BTC' ? 'btcPriceUsd' : 'ethPriceUsd'], r.value);
    }
    await save('PRESERVATION', {
      status: 'PASS',
      originalRows: seed.rows.length,
      selectedRows: product.rows.length,
      exactUnrelatedCells: fields,
      ledgerPeriods: product.metadata.coverage.ledgerDates,
      liquidityDates: product.metadata.liquidityHistory.length,
      pair: product.metadata.pair,
      unrelatedReadingsSha256: sha(canonical(seed.metadata.readings)),
      references,
      sourceCoverage: 'accepted_base_plus_observed_updates',
      csvSha256: sha(product.csv),
    });
    fixture.controls.now = Date.now();
    const holders = (await fixture.inject('/api/v2/holders?limit=1')).json(),
      holder = holders.items[0].reported;
    const paths = [
      '/api/v2/live',
      '/api/v2/home',
      '/api/v2/daily?from=2026-10-01&to=2026-10-10',
      '/api/v2/holders?limit=2',
      '/api/v2/stakes?limit=2',
      '/api/v2/addresses/' + holder.holderAddress,
    ];
    const responses = {};
    for (const path of paths) {
      const r = await fixture.inject(path);
      assert.equal(r.statusCode, 200, r.body);
      responses[path] = r.json();
    }
    await save('ACTUAL_NORMAL_API', responses);
    const download = '/api/v2/downloads/' + product.bundleId + '/daily';
    assert([401, 403].includes((await fixture.inject(download)).statusCode));
    const csv = await fixture.inject({ url: download, headers: auth() });
    assert.equal(csv.statusCode, 200);
    assert.equal(sha(csv.body), sha(product.csv));
    for (const method of ['HEAD', 'GET']) {
      const r = await fixture.inject({
        url: download,
        method,
        headers: { ...auth(), 'if-none-match': csv.headers.etag },
      });
      assert.equal(r.statusCode, 304);
    }
    const backup = await backupParticipants(real, join(R, 'real-backup'));
    await save('REAL_BACKUP', backup);
    const oldProfile = JSON.parse(await readFile(join(R, 'inputs/hds/SELECTED_PROFILE.json')));
    const denied = [
      real.root,
      real.productDaily.root,
      oldProfile.participantRoot,
      oldProfile.productRoot,
      join(R, 'seed-backup'),
    ].map((p) => resolve(p));
    const originals = [];
    function blocked(p) {
      if (typeof p !== 'string' && !(p instanceof URL)) return;
      const actual = resolve(p instanceof URL ? fileURLToPath(p) : p);
      if (denied.some((d) => actual === d || actual.startsWith(d + sep)))
        throw Error('RESTORE_OLD_ROOT_DENIED');
    }
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
      ]) {
        if (typeof object[name] !== 'function') continue;
        const original = object[name];
        originals.push([object, name, original]);
        object[name] = function (path, ...rest) {
          blocked(path);
          if (name.startsWith('rename')) blocked(rest[0]);
          return original.call(this, path, ...rest);
        };
      }
    syncBuiltinESMExports();
    let restored, rf;
    try {
      restored = await restoreParticipants(
        backup.destination,
        join(R, 'restored-candidate'),
        backup.sha256,
        base,
      );
      rf = await makeFixture({
        participants: restored.registry,
        productDaily: restored.registry.productDaily,
        sourceGenerations: base,
      });
      guardFixture(rf, 300);
      rf.controls.now = fixture.controls.now;
      const comparable = (v) =>
        JSON.parse(
          JSON.stringify(v, (k, v) => (k === 'nextCursor' && v !== null ? 'cursor-present' : v)),
        );
      for (const path of paths) {
        const r = await rf.inject(path);
        assert.equal(r.statusCode, 200, r.body);
        assert.deepEqual(comparable(r.json()), comparable(responses[path]));
      }
      const snapshot = restored.registry.productDaily.capture();
      assert.equal(sha(snapshot.csv), sha(product.csv));
      const restoredCsv = await rf.inject({ url: download, headers: auth() });
      assert.equal(restoredCsv.statusCode, 200);
      assert.equal(sha(restoredCsv.body), sha(product.csv));
      await save('GENUINE_RESTORE', {
        ...restored.receipt,
        deniedOldWritableRoots: denied,
        routes: paths,
        csvSha256: sha(snapshot.csv),
        selected: restored.registry.status(),
        externalBaseReadinessReused: true,
      });
      // Derived synthetic later update only; restored genuine pointer remains fixed.
      await afterRestore(restored.registry);
    } finally {
      for (const [object, name, original] of originals) object[name] = original;
      syncBuiltinESMExports();
      if (rf) await rf.close();
      if (restored) await restored.registry.close();
    }
    await previewOnly({ R, origin, save });
  } finally {
    held.release();
  }
}

export async function previewOnly({ R, origin, save }) {
  const preview = join(R, 'evidence/preview');
  await mkdir(preview, { recursive: true });
  const started = Date.now(),
    deadline = started + 600000,
    result = {
      screenshots: [],
      browserErrors: [],
      blocked: 0,
      startedAt: new Date(started).toISOString(),
    };
  let browser;
  const reservations = new WeakMap();
  const responseBodies = [];
  const timer = setTimeout(() => void browser?.close(), 600000);
  try {
    const executable = [
      chromium.executablePath(),
      'C:/Program Files/Google/Chrome/Application/chrome.exe',
      'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
    ].find(existsSync);
    assert(executable);
    browser = await chromium.launch({
      headless: true,
      executablePath: executable,
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
    const context = await browser.newContext({
      viewport: { width: 1440, height: 1000 },
      serviceWorkers: 'block',
    });
    await context.route('**/*', async (route) => {
      charge();
      const u = new URL(route.request().url());
      if (u.origin !== origin || u.protocol !== 'http:') {
        result.blocked++;
        await route.abort();
      } else {
        reservations.set(route.request(), reserveResponse(u.pathname));
        await route.continue();
      }
    });
    await context.routeWebSocket('**/*', (ws) => {
      charge();
      result.blocked++;
      ws.close();
    });
    const page = await context.newPage();
    page.on('response', (response) =>
      responseBodies.push(
        response
          .body()
          .then((body) => checkResponse(reservations.get(response.request()), body.length)),
      ),
    );
    page.on('pageerror', (e) => result.browserErrors.push(e.message));
    for (const [name, path, width] of [
      ['01-btc-desktop.png', '/charts?metric=btcPriceUsd&from=2019-12-03&to=2020-01-05', 1440],
      ['02-eth-mobile.png', '/charts?metric=ethPriceUsd&from=2024-03-27&to=2024-09-02', 390],
    ]) {
      assert(Date.now() < deadline);
      await page.setViewportSize({ width, height: 1000 });
      await page.goto(origin + path);
      await page.waitForLoadState('networkidle');
      if (path.startsWith('/charts')) {
        await page
          .locator('[data-testid="daily-product"][data-ready="true"]')
          .waitFor({ timeout: 60000 });
        assert((await page.locator('tbody tr').count()) > 0);
        assert((await page.locator('body').innerText()).includes('Bitstamp daily candle closes'));
        assert(
          (await page.locator('tbody').innerText()).includes(
            'Source-labelled daily candle close; exact trade time unknown',
          ),
        );
        await writeFile(join(preview, name + '.txt'), await page.locator('body').innerText(), {
          flag: 'wx',
        });
      }
      assert(
        await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1),
        'Horizontal overflow',
      );
      await page.screenshot({ path: join(preview, name), fullPage: true });
      result.screenshots.push({ name, path });
    }
    await Promise.all(responseBodies);
    assert.deepEqual(result.browserErrors, []);
    await context.close();
    result.status = 'PASS';
  } catch (e) {
    result.status = 'FAIL';
    result.failure = String(e.stack ?? e);
    throw e;
  } finally {
    clearTimeout(timer);
    if (browser) await browser.close();
    result.browserClosed = true;
    result.seconds = (Date.now() - started) / 1000;
    await save('FINAL_PREVIEW', result);
  }
}
