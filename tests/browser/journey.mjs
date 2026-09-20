import assert from 'node:assert/strict';
import { chromium, firefox, webkit } from 'playwright';
import { mkdirSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { setTimeout as pause } from 'node:timers/promises';
import { compactNumber, yearsFromDays } from '../../src/web/format.ts';

const [base, scenario, evidence] = process.argv.slice(2);
assert.match(base, /^http:\/\/127\.0\.0\.1:\d+$/);
const at = Date.parse('2026-09-19T12:00:00.000Z');
const folder = resolve(evidence, 'screenshots');
mkdirSync(folder, { recursive: true });
const traffic = [],
  errors = [],
  checks = [],
  measurements = [];
let pinnedFirst;
const channel = process.env.HDD_V2_BROWSER_CHANNEL ?? 'chrome';
const browser = await chromium.launch(channel === 'chromium' ? {} : { channel });
let context, page;
async function newPage(viewport = { width: 390, height: 844 }) {
  const c = await browser.newContext({ viewport, deviceScaleFactor: 1, reducedMotion: 'reduce' });
  await c.addInitScript((time) => {
    window.__testNow = time;
    const Original = Date;
    window.Date = class extends Original {
      constructor(...args) {
        super(...(args.length ? args : [window.__testNow]));
      }
      static now() {
        return window.__testNow;
      }
    };
  }, at);
  const p = await c.newPage();
  p.on('pageerror', (e) => errors.push(e.message));
  p.on('request', (r) => {
    traffic.push({ scenario, url: r.url(), resource: r.resourceType(), method: r.method() });
    if (!r.url().startsWith(base + '/')) errors.push('Unexpected public network: ' + r.url());
  });
  return [c, p];
}
async function test(name, fn) {
  await fn();
  checks.push(name);
  console.log('PASS', name);
}
async function capture(name, width = 390, height = 844) {
  await page.setViewportSize({ width, height });
  await page.evaluate(() => window.scrollTo(0, 0));
  await page.screenshot({ path: resolve(folder, `${scenario}-${name}-${width}.png`) });
  assert.equal(
    await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth),
    true,
    `${name} page overflow at ${width}`,
  );
}
async function go(path) {
  await page.goto(base + path);
  await page.locator('h1').waitFor();
}
async function range(from, to) {
  await page.getByLabel('From (UTC)', { exact: true }).fill(from);
  await page.getByLabel('To (UTC)', { exact: true }).fill(to);
  await page.getByRole('button', { name: 'Apply range' }).click();
  await page.getByText('Complete selection:', { exact: false }).waitFor();
}
const p95 = (values) => [...values].sort((a, b) => a - b)[Math.ceil(values.length * 0.95) - 1];
try {
  for (let i = 0; i < 60; i++) {
    try {
      if ((await fetch(base + '/health/live')).ok) break;
    } catch {}
    await pause(250);
  }
  [context, page] = await newPage();
  if (scenario === 'empty' || scenario === 'archive') {
    await test(`${scenario}: real empty native endpoints and usable Home navigation`, async () => {
      assert.equal((await fetch(base + '/api/v2/home')).status, 503);
      assert.equal((await fetch(base + '/api/v2/calculator/inputs')).status, 503);
      await go('/');
      await page.getByText('Current native data is unavailable.', { exact: false }).waitFor();
      assert.equal(await page.locator('[data-metric="price"] dd').innerText(), 'Unavailable');
      await capture('home');
      await go('/calculator');
      await page.getByText('Share rate unavailable or expired.', { exact: false }).waitFor();
      await page.getByLabel('HEX amount', { exact: true }).fill('123456.00000001');
      await page.reload();
      assert.equal(
        await page.getByLabel('HEX amount', { exact: true }).inputValue(),
        '123456.00000001',
      );
      assert.equal(
        await page.getByRole('button', { name: 'Calculate shares & timing' }).isDisabled(),
        true,
      );
      await go('/downloads');
      await page.getByRole('heading', { name: 'Standard downloads unavailable' }).waitFor();
      await capture('downloads-unavailable');
    });
    await test(`${scenario}: independent HDS archive browser-to-compiled-API/SQL`, async () => {
      await go('/charts');
      if (scenario === 'empty') {
        await page.getByText('Data is unavailable.', { exact: false }).waitFor();
        await capture('charts-empty');
      } else {
        await page.getByRole('heading', { name: 'HDS reference price' }).waitFor();
        await page.getByRole('button', { name: 'Load all available HDS records' }).click();
        await page.getByText(/Complete selection:.*1227 records/).waitFor({ timeout: 60000 });
        assert.equal(await page.locator('tbody tr').count(), 100);
        await capture('charts-all-real', 1440, 1000);
        await capture('charts-all-real');
        await range('2023-05-11', '2023-05-18');
        assert.match(await page.locator('tbody').innerText(), /0\.01958399/);
        const firstPoint = await page.locator('svg circle title').first().textContent();
        assert.match(firstPoint, /2023-05-17/);
        await capture('charts-real-first-price');
        await range('2024-09-01', '2024-09-02');
        assert.match(await page.locator('tbody').innerText(), /sourceDay 1734/);
        assert.match(await page.locator('tbody').innerText(), /sourceDay 1735/);
        await page.getByLabel('Metric', { exact: true }).selectOption('averageStakeLength');
        assert.match(await page.locator('tbody').innerText(), /1734/);
        await capture('charts-real-duplicates', 1440, 1000);
        await range('2024-10-03', '2024-10-05');
        assert.equal(await page.locator('svg path.series').getAttribute('d'), '');
        await go('/status');
        await page.getByText(/1227 records · 1218 admitted/).waitFor();
        await capture('status-archive');
      }
    });
  } else {
    const fixture = JSON.parse(readFileSync(resolve(evidence, 'fixture.json'), 'utf8'));
    const expected = fixture.expected;
    if (scenario === 'scale') {
      await context.close();
      await test('11 cold mobile documents: real million-row SQL, throttled network and CPU', async () => {
        assert.equal(fixture.shape.count, 1000000);
        assert.equal(fixture.shape.accounts, 500000);
        for (let i = 0; i < 11; i++) {
          [context, page] = await newPage();
          const cdp = await context.newCDPSession(page);
          await cdp.send('Network.enable');
          await cdp.send('Network.setCacheDisabled', { cacheDisabled: true });
          await cdp.send('Network.emulateNetworkConditions', {
            offline: false,
            latency: 150,
            downloadThroughput: 10000000 / 8,
            uploadThroughput: 1500000 / 8,
            connectionType: 'cellular4g',
          });
          await cdp.send('Emulation.setCPUThrottlingRate', { rate: 4 });
          await page.addInitScript(() => {
            window.__paintTimes = {};
            const observe = () => {
              const headlines = document.querySelector(
                '[data-testid="headlines"][data-ready="true"]',
              );
              const chart = document.querySelector(
                '[data-testid="history-chart"][data-ready="true"] svg circle',
              );
              for (const [name, ready] of [
                ['headlines', headlines],
                ['chart', chart],
              ]) {
                if (ready && !window.__paintTimes[name + 'Pending']) {
                  window.__paintTimes[name + 'Pending'] = true;
                  requestAnimationFrame(() =>
                    requestAnimationFrame(() => (window.__paintTimes[name] = performance.now())),
                  );
                }
              }
            };
            new MutationObserver(observe).observe(document, {
              childList: true,
              subtree: true,
              attributes: true,
            });
          });
          await go('/');
          await page.locator('[data-testid="headlines"][data-ready="true"]').waitFor();
          for (const [id, value] of [
            ['price', expected.live.price.value.usdPerHex],
            ['staked', expected.daily.stakedPercent],
            ['duration', expected.daily.weightedStakeLengthDays],
            ['completed', expected.live.latestCompletedPayout.value.hexPerTShare],
          ])
            assert.ok(
              (await page.locator(`[data-metric="${id}"] dd`).innerText()).includes(
                compactNumber(
                  id === 'duration' ? yearsFromDays(value) : value,
                  id === 'price' ? 7 : id === 'completed' ? 3 : 2,
                  id !== 'duration' && id !== 'staked',
                ),
              ),
              `${id} content equality`,
            );
          await page
            .locator('[data-testid="history-chart"][data-ready="true"] svg circle')
            .first()
            .waitFor();
          await page.waitForFunction(
            () => window.__paintTimes.headlines && window.__paintTimes.chart,
          );
          const sample = await page.evaluate(() => ({
            ...window.__paintTimes,
            navigation: performance.getEntriesByType('navigation')[0].toJSON(),
            waterfall: performance.getEntriesByType('resource').map((r) => r.toJSON()),
            userAgent: navigator.userAgent,
          }));
          sample.sample = i + 1;
          sample.contentAsserted = [
            'price',
            'stakedPercent',
            'weightedStakeLengthDays',
            'completedPayout',
          ];
          assert.equal(await page.locator('[data-testid="history-chart"] svg circle').count(), 30);
          const api = sample.waterfall.find((r) => r.name.includes('/api/v2/home?'));
          measurements.push(sample);
          writeFileSync(resolve(evidence, `sample-${i + 1}.json`), JSON.stringify(sample, null, 2));
          const mainScript = sample.waterfall.find((r) => /\/assets\/index-.*\.js$/.test(r.name));
          assert.ok(
            api.responseEnd - api.startTime >= 130 && sample.navigation.responseEnd >= 130,
            'Loopback document and Home response latency observed',
          );
          assert.ok(
            mainScript.encodedBodySize > 300000 && mainScript.duration >= 300,
            'Loopback script transfer is throttled',
          );
          if (i === 0) {
            await capture('home-throttled');
            await capture('home-throttled', 1440, 1000);
          }
          await context.close();
        }
        const values = measurements.map((m) => m.headlines),
          chart = measurements.map((m) => m.chart);
        const result = {
          browser: browser.version(),
          headless: true,
          deviceScaleFactor: 1,
          viewport: { width: 390, height: 844 },
          network: { rttMs: 150, downloadMbps: 10, uploadMbps: 1.5, loopbackVerified: true },
          cpuSlowdown: 4,
          backend: fixture.resources,
          cache: 'disabled; fresh context/document each sample; warm SQL',
          sourceClock: fixture.clock,
          timingClock:
            'real performance.now navigation-relative; two requestAnimationFrame callbacks after complete required DOM values',
          chartDefinition:
            '30 completed payout markers from the selected native daily range, complete response parsed',
          p50Method: 'nearest-rank ceil(n*p)-1',
          headlinesP50: [...values].sort((a, b) => a - b)[5],
          headlinesP95: p95(values),
          chartP95: p95(chart),
          homeBytes: fixture.homeBytes,
          homeQueryP95: p95(fixture.homeQueryMs),
          raw: measurements,
        };
        writeFileSync(resolve(evidence, 'performance.json'), JSON.stringify(result, null, 2));
        console.log(
          JSON.stringify({
            headlinesP95: result.headlinesP95,
            chartP95: result.chartP95,
            homeBytes: result.homeBytes,
            homeQueryP95: result.homeQueryP95,
          }),
        );
        assert.ok(result.headlinesP95 <= 2000, 'useful headline p95 <=2s');
        assert.ok(result.chartP95 <= 3500, 'chart p95 <=3.5s');
        assert.ok(result.homeBytes <= 25 * 1024);
        assert.ok(result.homeQueryP95 <= 250);
      });
    } else {
      await test('real populated Home, native chart and independent initial requests', async () => {
        await go('/');
        await page.locator('[data-testid="headlines"][data-ready="true"]').waitFor();
        await page.locator('[data-testid="history-chart"][data-ready="true"]').waitFor();
        for (const width of [390, 1440]) await capture('home', width, width === 390 ? 844 : 1000);
        const metrics = await page.locator('[data-testid="headlines"]').boundingBox();
        assert.ok(metrics.y + metrics.height < 844);
        const initial = traffic.filter((r) => r.url.includes('/api/')).map((r) => r.url);
        assert.ok(initial.some((r) => r.includes('/home?')));
        assert.ok(!initial.some((r) => /\/status|\/downloads|hexdailystats/.test(r)));
        await page.route('**/api/v2/daily?*', (r) => r.abort());
        await page.reload();
        await page.locator('[data-testid="headlines"][data-ready="true"]').waitFor();
        await page.unrouteAll();
      });
      await test('search validation, indexed/rank paging, pinned live pages, deep links and history', async () => {
        const address = '0x' + '1'.padStart(40, '0');
        await go('/address/' + address);
        pinnedFirst = await (
          await fetch(base + '/api/v2/addresses/' + address + '?chain=pulsechain&limit=20')
        ).json();
        await page.getByText('Showing 20 of 41 current stakes', { exact: false }).waitFor();
        for (const width of [390, 1440])
          await capture('address', width, width === 390 ? 844 : 1000);
        await page.getByRole('button', { name: 'Next pinned page' }).click();
        await page.getByText(/offset 20/).waitFor();
        await page.getByRole('button', { name: 'Next pinned page' }).click();
        await page.getByText('Showing 1 of 41 current stakes', { exact: false }).waitFor();
        await go('/search');
        await page.locator('tbody tr').first().waitFor();
        await page.getByLabel('Address or stake ID', { exact: true }).fill('9007199254740993');
        await page.getByRole('button', { name: 'Search', exact: true }).click();
        await page.getByRole('alert').waitFor();
        await page.getByLabel('Address or stake ID', { exact: true }).fill('1');
        await page.getByRole('button', { name: 'Search', exact: true }).click();
        await page.getByRole('heading', { name: 'Stake 1', exact: true }).waitFor();
        await page.getByText(/inherited Ethereum origin/).waitFor();
        await page.reload();
        await page.getByRole('heading', { name: 'Stake 1', exact: true }).waitFor();
        await page.goBack();
        await page.getByRole('heading', { name: 'Search & rankings' }).waitFor();
        await page.goForward();
        await page.getByRole('heading', { name: 'Stake 1', exact: true }).waitFor();
        await go('/search');
        await page.getByRole('button', { name: 'Next page', exact: true }).click();
        await page
          .locator('tbody tr')
          .first()
          .getByRole('link', { name: '21', exact: true })
          .waitFor();
        await page.getByLabel('Browse', { exact: true }).selectOption('liquid');
        await page.getByText('Rank at', { exact: false }).waitFor();
        await page.getByRole('button', { name: 'Next page', exact: true }).click();
        await page.locator('tbody tr').first().waitFor();
        assert.equal(await page.locator('tbody tr td').first().innerText(), '21');
      });
      await test('calculator real inputs, exact quote, scenario, input invalidation and outage preservation', async () => {
        await go('/calculator');
        await page.getByRole('button', { name: 'Calculate shares & timing' }).waitFor();
        await page.waitForFunction(() => !document.querySelector('button.primary:disabled'));
        await page.getByLabel('HEX amount', { exact: true }).fill('10000');
        await page.getByLabel('Whole days').fill('365');
        await page.getByRole('button', { name: 'Calculate shares & timing' }).click();
        await page.getByText('0.972011620873', { exact: true }).waitFor();
        await page.getByText('Optional payout & future USD scenario', { exact: true }).click();
        await page.getByLabel('Constant daily payout assumption').selectOption('30');
        await page.getByLabel('Hypothetical future USD per HEX').fill('0.01');
        await page.getByRole('button', { name: 'Calculate shares & timing' }).click();
        await page.getByRole('heading', { name: 'Hypothetical payout scenario' }).waitFor();
        for (const width of [390, 1440])
          await capture('calculator', width, width === 390 ? 844 : 1000);
        await page.getByLabel('HEX amount', { exact: true }).fill('20000');
        assert.equal(await page.getByText('0.972011620873', { exact: true }).count(), 0);
        await page.route('**/api/v2/calculator/inputs?*', (r) =>
          r.fulfill({ status: 503, contentType: 'application/json', body: '{}' }),
        );
        await page.getByRole('button', { name: 'Refresh', exact: true }).click();
        await page.getByText('Data is unavailable.', { exact: false }).waitFor();
        assert.equal(await page.getByLabel('HEX amount', { exact: true }).inputValue(), '20000');
        await capture('calculator-outage');
        await page.unrouteAll();
      });
      await test('source-selectable real native+HDS charts and streaming verified download', async () => {
        await go('/charts');
        await page.getByLabel('Source', { exact: true }).selectOption('native');
        await page.getByRole('heading', { name: 'Completed payout', exact: true }).waitFor();
        assert.ok((await page.locator('svg circle').count()) > 0);
        for (const width of [390, 1440])
          await capture('charts-native', width, width === 390 ? 844 : 1000);
        await go('/downloads');
        await page.getByRole('link', { name: 'Download daily CSV', exact: true }).waitFor();
        assert.equal(await page.locator('a[download]').count(), 5);
        for (const width of [390, 1440])
          await capture('downloads', width, width === 390 ? 844 : 1000);
        const downloaded = page.waitForEvent('download');
        await page.getByRole('link', { name: 'Download daily CSV', exact: true }).click();
        const file = await downloaded;
        const output = resolve(evidence, 'small-daily.csv');
        await file.saveAs(output);
        const bytes = readFileSync(output);
        assert.equal(
          bytes.length,
          Number(fixture.bundle.files.find((f) => f.dataset === 'daily').bytes),
        );
        assert.ok(bytes.toString().startsWith('date_utc,display_day,origin_chain_id,'));
        assert.ok(
          !traffic.some((t) => t.resource === 'fetch' && /\/downloads\/[^?]+\/daily/.test(t.url)),
        );
        const retired = await fetch(
          base + '/api/v2/downloads/aaaaaaaa-aaaa-4aaa-aaaa-aaaaaaaaaaaa/daily',
        );
        assert.equal(retired.status, 410);
        assert.match(retired.headers.get('content-type'), /json/);
        await go('/learn');
        await page.getByRole('heading', { name: 'Stake status glossary' }).waitFor();
        await go('/status');
        await page.getByText(/1227 records · 1218 admitted/).waitFor();
      });
      await test('partial, stale, source-stalled, expired and quota browser states', async () => {
        const home = await (await fetch(base + '/api/v2/home')).json();
        const change = structuredClone(home);
        change.live.price = {
          ...change.live.price,
          status: 'unavailable',
          value: null,
          reason: 'source_unavailable',
        };
        await page.route('**/api/v2/home?*', (r) =>
          r.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(change) }),
        );
        await go('/');
        await page.getByText('Unavailable', { exact: true }).first().waitFor();
        assert.match(await page.locator('[data-metric="rate"] dd').innerText(), /12,345.6/);
        await capture('home-price-missing');
        await page.unrouteAll();
        const stale = structuredClone(home);
        for (const o of Object.values(stale.live)) {
          o.status = 'stale';
          o.asOf.blockTimestamp = new Date(at - 121000).toISOString();
          o.observedAt = new Date(at - 121000).toISOString();
        }
        await page.route('**/api/v2/home?*', (r) =>
          r.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(stale) }),
        );
        await page.reload();
        await page
          .getByText(/Stale · 2m/)
          .first()
          .waitFor();
        await capture('home-stale');
        await page.getByRole('button', { name: 'Refresh', exact: true }).click();
        await page
          .getByText(/Stale · 2m/)
          .first()
          .waitFor();
        await page.evaluate((t) => (window.__testNow = t), at + 1801000);
        await page.waitForFunction(
          () => document.querySelector('[data-metric="price"] dd').textContent === 'Unavailable',
        );
        await capture('home-expired');
        await page.unrouteAll();
        await page.evaluate((t) => (window.__testNow = t), at);
        const address = '0x' + '1'.padStart(40, '0');
        const data = await (await fetch(base + '/api/v2/addresses/' + address)).json();
        data.outcome = 'quota';
        data.live = null;
        data.reason = 'quota';
        await page.route('**/api/v2/addresses/**', (r) =>
          r.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(data) }),
        );
        await go('/address/' + address);
        await page.getByText(/provider quota reached/).waitFor();
        await page.getByRole('heading', { name: 'Accepted indexed baseline' }).waitFor();
        await capture('address-quota');
        await page.unrouteAll();
        await page.route('**/api/v2/addresses/**', async (r) => {
          if (r.request().url().includes('cursor='))
            await r.fulfill({ status: 409, contentType: 'application/json', body: '{}' });
          else
            await r.fulfill({
              status: 200,
              contentType: 'application/json',
              body: JSON.stringify(pinnedFirst),
            });
        });
        await page.reload();
        await page.getByRole('button', { name: 'Next pinned page' }).click();
        await page
          .getByText('Observation changed or expired. Restart to read a new pinned page.', {
            exact: true,
          })
          .waitFor();
        await capture('address-expired');
        await page.unrouteAll();
      });
      await test('320px, 200% layout, keyboard, copy and same-origin runtime boundaries', async () => {
        for (const path of [
          '/',
          '/charts',
          '/calculator',
          '/downloads',
          '/address/0x' + '1'.padStart(40, '0'),
        ]) {
          await go(path);
          await page.waitForTimeout(100);
          await page.setViewportSize({ width: 320, height: 844 });
          assert.equal(
            await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth),
            true,
            path + ' 320px',
          );
          await page.evaluate(() => (document.documentElement.style.fontSize = '200%'));
          assert.equal(
            await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth),
            true,
            path + ' 200% text',
          );
          await page.evaluate(() => (document.documentElement.style.fontSize = ''));
        }
        await context.grantPermissions(['clipboard-read', 'clipboard-write']);
        await page.getByRole('button', { name: 'Copy address' }).click();
        await page.getByText('Copied', { exact: true }).waitFor();
        assert.equal(
          await page.evaluate(() => navigator.clipboard.readText()),
          '0x' + '1'.padStart(40, '0'),
        );
        await page.keyboard.press('Control+Home');
        await page.keyboard.press('Tab');
        assert.notEqual(await page.evaluate(() => document.activeElement.tagName), 'BODY');
        for (const path of ['/api/nope', '/health/nope', '/assets/missing.js']) {
          const r = await fetch(base + path);
          assert.equal(r.status, 404);
          assert.match(r.headers.get('content-type'), /json/);
        }
        for (const engine of [firefox, webkit]) {
          const entry = { browser: engine.name(), supported: false };
          if (existsSync(engine.executablePath())) {
            const b = await engine.launch();
            try {
              const p = await b.newPage();
              await p.goto(base + '/learn');
              await p.getByRole('heading', { name: 'Learn & methodology' }).waitFor();
              entry.supported = true;
              entry.version = b.version();
            } finally {
              await b.close();
            }
          }
          writeFileSync(resolve(evidence, `${engine.name()}-smoke.json`), JSON.stringify(entry));
        }
      });
      await test('revision restart, cancellation, delayed payout and inconclusive stake errors', async () => {
        await go('/charts');
        await page.getByLabel('Source', { exact: true }).selectOption('hds');
        await page.getByRole('button', { name: 'Load all available HDS records' }).waitFor();
        await page.route('**/api/v2/daily?*', async (r) => {
          if (r.request().url().includes('afterSourceDay='))
            await r.fulfill({ status: 409, contentType: 'application/json', body: '{}' });
          else await r.continue();
        });
        await page.getByRole('button', { name: 'Load all available HDS records' }).click();
        await page
          .getByText('The observation changed or expired. Restart this selection.', { exact: true })
          .waitFor();
        assert.equal(await page.locator('[data-testid="history-chart"]').count(), 0);
        await capture('archive-revision-restart');
        await page.unrouteAll();
        await page.route('**/api/v2/daily?*', async (r) => {
          await pause(500);
          await r.abort().catch(() => {});
        });
        await go('/charts');
        await page
          .getByRole('navigation', { name: 'Mobile destinations' })
          .getByRole('link', { name: 'Home', exact: true })
          .click();
        await page.locator('[data-testid="headlines"][data-ready="true"]').waitFor();
        await pause(600);
        assert.equal(await page.getByRole('heading', { name: 'Your daily view' }).count(), 1);
        await page.unrouteAll();
        const delayed = await (await fetch(base + '/api/v2/home')).json();
        delayed.live.latestCompletedPayout.value.contractDay -= 2;
        delayed.live.latestCompletedPayout.value.displayDay -= 2;
        await page.route('**/api/v2/home?*', (r) =>
          r.fulfill({
            status: 200,
            contentType: 'application/json',
            body: JSON.stringify(delayed),
          }),
        );
        await page.reload();
        await page
          .locator('[data-metric="completed"]')
          .getByText(/2026-09-16/)
          .waitFor();
        assert.match(await page.locator('[data-metric="estimate"]').innerText(), /2026-09-19/);
        await page.unrouteAll();
        await page.route('**/api/v2/stakes/1099511627775?*', (r) =>
          r.fulfill({
            status: 503,
            contentType: 'application/json',
            body: JSON.stringify({ error: { code: 'not_indexed' } }),
          }),
        );
        await go('/stake/1099511627775');
        await page
          .getByText('The index is catching up; this bounded lookup is inconclusive.', {
            exact: true,
          })
          .waitFor();
        await capture('stake-index-lag');
        await page.unrouteAll();
        const inputs = await (await fetch(base + '/api/v2/calculator/inputs')).json();
        inputs.shareRate.status = 'stale';
        inputs.shareRate.asOf.blockTimestamp = new Date(at - 121000).toISOString();
        inputs.shareRate.observedAt = new Date(at - 121000).toISOString();
        await page.route('**/api/v2/calculator/inputs?*', (r) =>
          r.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(inputs) }),
        );
        await go('/calculator');
        await page.getByText('Last-known-rate scenario.', { exact: false }).waitFor();
        await page.getByRole('button', { name: 'Calculate shares & timing' }).click();
        await page.getByRole('status').filter({ hasText: 'Calculated' }).waitFor();
        await page.evaluate((t) => (window.__testNow = t), at + 1801000);
        await page.getByText('Share rate unavailable or expired.', { exact: false }).waitFor();
        assert.equal(await page.getByRole('status').filter({ hasText: 'Calculated' }).count(), 0);
        await capture('calculator-expired');
        await page.evaluate((t) => (window.__testNow = t), at);
        for (const p of inputs.presets) {
          p.status = 'unavailable';
          p.value = null;
          p.reason = 'missing_days';
        }
        await page.getByRole('button', { name: 'Refresh', exact: true }).click();
        await page.getByText('Last-known-rate scenario.', { exact: false }).waitFor();
        await page.getByRole('button', { name: 'Calculate shares & timing' }).click();
        await page
          .getByText('Selected payout preset unavailable. Showing shares and maturity only.', {
            exact: true,
          })
          .waitFor();
        const beforeMidnight = Date.parse('2026-09-19T23:59:00.000Z');
        inputs.shareRate.status = 'fresh';
        inputs.shareRate.asOf.blockTimestamp = new Date(beforeMidnight).toISOString();
        inputs.shareRate.observedAt = new Date(beforeMidnight).toISOString();
        await page.evaluate((t) => (window.__testNow = t), beforeMidnight);
        await page.getByRole('button', { name: 'Refresh', exact: true }).click();
        await page.getByRole('button', { name: 'Calculate shares & timing' }).click();
        await page.getByRole('status').filter({ hasText: 'maturity 2027-09-20' }).waitFor();
        await page.evaluate((t) => (window.__testNow = t), beforeMidnight + 61000);
        await page.waitForFunction(
          () =>
            !Array.from(document.querySelectorAll('[role="status"]')).some((e) =>
              e.textContent.includes('Calculated'),
            ),
        );
        await page.getByRole('button', { name: 'Calculate shares & timing' }).click();
        await page.getByRole('status').filter({ hasText: 'maturity 2027-09-21' }).waitFor();
        await page.evaluate((t) => (window.__testNow = t), at);
        await page.unrouteAll();
      });
      await test('status ages real observations and streams without refreshing their source time', async () => {
        await go('/status');
        const table = page.getByRole('region', { name: 'Independent current observations' });
        await table.getByRole('cell', { name: 'fresh', exact: true }).first().waitFor();
        const times = await table
          .locator('tbody tr')
          .evaluateAll((rows) =>
            rows.map((row) => [...row.children].slice(2).map((c) => c.textContent)),
          );
        const states = (state) =>
          page.waitForFunction((wanted) => {
            const cells = [...document.querySelectorAll('tbody tr td:nth-child(2)')];
            return cells.length === 4 && cells.every((c) => c.textContent === wanted);
          }, state);
        const requestsBefore = traffic.filter((r) => r.url.includes('/api/v2/status?')).length;
        await page.evaluate((t) => (window.__testNow = t), at + 121000);
        await states('stale');
        await page.getByText(/pulsechain · block 100 · stale/).waitFor();
        await page.evaluate((t) => (window.__testNow = t), at + 1801000);
        await states('unavailable');
        await page.getByText(/pulsechain · block 100 · unavailable/).waitFor();
        assert.equal(
          traffic.filter((r) => r.url.includes('/api/v2/status?')).length,
          requestsBefore,
        );
        // A successful HTTP refresh with the same source must not revive expired observations.
        const refreshed = page.waitForResponse((r) => r.url().includes('/api/v2/status?'));
        await page.getByRole('button', { name: 'Refresh', exact: true }).first().click();
        await refreshed;
        await states('unavailable');
        assert.deepEqual(
          await table
            .locator('tbody tr')
            .evaluateAll((rows) =>
              rows.map((row) => [...row.children].slice(2).map((c) => c.textContent)),
            ),
          times,
        );
        await page.route('**/api/v2/status?*', (r) =>
          r.fulfill({ status: 503, contentType: 'application/json', body: '{}' }),
        );
        await page.getByRole('button', { name: 'Refresh', exact: true }).first().click();
        await page.getByText('Data is unavailable.', { exact: false }).waitFor();
        await states('unavailable');
        await capture('status-expired');
        const status = await (await fetch(base + '/api/v2/status')).json();
        status.state = 'current';
        status.streams.push({
          ...status.streams[0],
          chain: 'ethereum',
          asOf: { ...status.streams[0].asOf, chainId: 1 },
          freshness: 'unavailable',
        });
        status.observations[0].status = 'stale';
        status.observations[1].status = 'unavailable';
        await page.unrouteAll();
        await page.route('**/api/v2/status?*', (r) =>
          r.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(status) }),
        );
        await go('/status');
        await page.getByText('current', { exact: true }).waitFor();
        await table.getByRole('cell', { name: 'stale', exact: true }).waitFor();
        await table.getByRole('cell', { name: 'unavailable', exact: true }).waitFor();
        await page.evaluate((t) => (window.__testNow = t), at + 121000);
        await page.getByText('degraded', { exact: true }).waitFor();
        await page.evaluate((t) => (window.__testNow = t), at);
        await page.unrouteAll();
      });
    }
  }
  assert.deepEqual(errors, []);
  writeFileSync(
    resolve(evidence, `${scenario}-browser.json`),
    JSON.stringify(
      {
        scenario,
        browser: browser.version(),
        channel,
        headless: true,
        deviceScaleFactor: 1,
        virtualSourceClock: new Date(at).toISOString(),
        realNavigationTimings: true,
        checks,
        errors,
        traffic,
      },
      null,
      2,
    ),
  );
} catch (e) {
  if (page && !page.isClosed())
    await page.screenshot({ path: resolve(folder, scenario + '-failure.png') }).catch(() => {});
  writeFileSync(
    resolve(evidence, `${scenario}-failure.json`),
    JSON.stringify({ message: e.stack, checks, errors, traffic }, null, 2),
  );
  throw e;
} finally {
  await context?.close();
  await browser.close();
}
