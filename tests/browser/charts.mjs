import assert from 'node:assert/strict';
import { chromium } from 'playwright';
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { setTimeout as pause } from 'node:timers/promises';
const [base, mode, evidence] = process.argv.slice(2);
assert.match(base, /^http:\/\/127\.0\.0\.1:\d+$/);
const fixture = JSON.parse(readFileSync(resolve(evidence, 'charts-fixture.json')));
const folder = resolve(evidence, 'screenshots');
mkdirSync(folder, { recursive: true });
const browser = await chromium.launch({ channel: process.env.HDD_V2_BROWSER_CHANNEL ?? 'chrome' });
const checks = [],
  errors = [],
  timings = [];
let context,
  page,
  requests = [];
async function open(width = 390, height = 844) {
  await context?.close();
  requests = [];
  context = await browser.newContext({
    viewport: { width, height },
    deviceScaleFactor: 1,
    reducedMotion: 'reduce',
    timezoneId: 'America/Chicago',
  });
  await context.addInitScript((at) => {
    const Original = Date;
    window.Date = class extends Original {
      constructor(...args) {
        super(...(args.length ? args : [at]));
      }
      static now() {
        return at;
      }
    };
    window.__paint = {};
    new MutationObserver(() => {
      for (const [name, selector] of [
        ['headlines', '[data-chart="price"][data-ready="true"] .chart-value'],
        ['chart', '[data-chart="price"][data-ready="true"] svg'],
      ]) {
        if (!window.__paint[name + 'Pending'] && document.querySelector(selector)) {
          window.__paint[name + 'Pending'] = true;
          requestAnimationFrame(() =>
            requestAnimationFrame(() => (window.__paint[name] = performance.now())),
          );
        }
      }
    }).observe(document, { subtree: true, attributes: true, childList: true });
  }, fixture.at);
  page = await context.newPage();
  page.on('pageerror', (e) => errors.push(e.message));
  await page.route('**/*', (route) => {
    const url = route.request().url();
    if (!url.startsWith(base + '/')) {
      errors.push('External request ' + url);
      return route.abort();
    }
    if (url.includes('/api/v2/')) requests.push(url);
    return route.continue();
  });
}
async function test(name, action) {
  await action();
  checks.push(name);
  console.log('PASS', name);
}
async function dashboard() {
  await page.goto(base + '/charts');
  await page.getByRole('heading', { name: 'Charts', exact: true }).waitFor();
  await page.waitForFunction(
    () => !document.querySelector('.charts-dashboard')?.textContent.includes('Loading…'),
  );
}
async function loadAll() {
  for (const section of await page.locator('.chart-section').all()) {
    await section.scrollIntoViewIfNeeded();
    const lazy = section.locator('[data-lazy-ready]');
    if (await lazy.count()) await lazy.locator('..').locator('[data-lazy-ready="true"]').waitFor();
  }
  await page.locator('[data-chart="holders"]').waitFor();
  await page.waitForFunction(
    () => !document.querySelector('.charts-dashboard')?.textContent.includes('Loading…'),
  );
}
async function shot(name, fullPage = false) {
  assert.ok(
    await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth),
    name + ' overflow',
  );
  await page.screenshot({ path: resolve(folder, `${mode}-${name}.png`), fullPage });
}
try {
  for (let i = 0; i < 60; i++) {
    try {
      if ((await fetch(base + '/health/live')).ok) break;
    } catch {}
    await pause(250);
  }
  await open();
  await test(`${mode}: compiled dashboard and honest source state`, async () => {
    await dashboard();
    if (mode === 'archive' || mode === 'both')
      assert.equal(await page.locator('[data-chart="price"]').getAttribute('data-ready'), 'true');
    else assert.match(await page.locator('[data-chart="price"]').innerText(), /Unavailable/);
    assert.equal(
      await page
        .locator('.chart-categories button')
        .allTextContents()
        .then((a) => a.join(',')),
      'All,Price,Staking,Supply,Activity,Adoption',
    );
    assert.equal(await page.locator('.charts-data-details').getAttribute('open'), null);
    assert.equal(await page.locator('.charts-dashboard table').count(), 0);
    assert.ok(
      (await page.locator('[data-lazy-ready="false"]').count()) > 0,
      'lower charts are not initially rendered',
    );
    await shot('mobile-390x844');
    await loadAll();
    assert.equal(await page.locator('[data-chart]').count(), 13);
    const cards = await page
      .locator('[data-chart]')
      .evaluateAll((es) => es.map((e) => e.getBoundingClientRect().toJSON()));
    assert.ok(cards.every((r) => r.width > 300));
    if (mode === 'archive') {
      assert.match(
        await page.locator('[data-chart="duration"] .chart-provenance').innerText(),
        /2026-09-17/,
      );
      assert.match(await page.locator('[data-chart="maturities"]').innerText(), /Unavailable/);
      assert.match(await page.locator('[data-chart="activity"]').innerText(), /Unavailable/);
      assert.equal(await page.locator('[data-chart="payout"]').getAttribute('data-source'), 'hds');
    } else {
      assert.equal(
        await page.locator('[data-chart="payout"]').getAttribute('data-source'),
        'native',
      );
      assert.equal(
        await page.locator('[data-chart="maturities"]').getAttribute('data-ready'),
        'true',
      );
    }
    if (mode === 'later') {
      assert.match(
        await page.locator('[data-chart="maturities"]').innerText(),
        /Later maturities are indexed/,
      );
      await page
        .locator('[data-chart="maturities"]')
        .getByRole('button', { name: 'ALL', exact: true })
        .click();
      assert.equal(await page.locator('[data-chart="maturities"] svg.dashboard-graph').count(), 1);
    }
    if (mode === 'none')
      assert.match(
        await page.locator('[data-chart="maturities"]').innerText(),
        /No upcoming maturities/,
      );
    await page.evaluate(() => scrollTo(0, 0));
    await shot('mobile-full', true);
    await page.locator('[data-chart="maturities"]').scrollIntoViewIfNeeded();
    await shot('maturity-mobile');
    if (mode === 'both')
      await page
        .locator('[data-chart="maturities"]')
        .screenshot({ path: resolve(folder, 'both-maturity-card.png') });
    assert.equal(requests.filter((u) => u.includes('/charts/archive')).length, 1);
    assert.equal(requests.filter((u) => u.includes('/charts/native')).length, 1);
    assert.equal(requests.filter((u) => u.includes('/charts/maturities')).length, 1);
    assert.ok(
      !requests.some((u) => /\/home|\/daily|\/markets/.test(u)),
      'No redundant HDS or live-price dependency',
    );
  });
  if (mode === 'both' || mode === 'archive') {
    await test('desktop hierarchy, full page, category keyboard and 320px overflow', async () => {
      await open(1440, 1000);
      await dashboard();
      await shot('desktop-1440x1000');
      await loadAll();
      await page.evaluate(() => scrollTo(0, 0));
      await shot('desktop-full', true);
      await page.locator('[data-chart="maturities"]').scrollIntoViewIfNeeded();
      await shot('desktop-scrolled');
      await page.getByRole('button', { name: 'Adoption', exact: true }).focus();
      await page.keyboard.press('Enter');
      assert.equal(await page.locator('[data-chart]').count(), 2);
      await page.getByRole('button', { name: 'Price', exact: true }).focus();
      await page.keyboard.press('Space');
      assert.equal(await page.locator('[data-chart]').count(), 2);
      assert.ok(
        await page
          .getByRole('button', { name: 'Price', exact: true })
          .evaluate((e) => e === document.activeElement),
      );
      await page.getByRole('button', { name: 'All', exact: true }).click();
      await page.setViewportSize({ width: 320, height: 844 });
      await loadAll();
      await page.evaluate(() => scrollTo(0, 0));
      await shot('mobile-320', true);
      await page.setViewportSize({ width: 390, height: 844 });
      await page.evaluate(() => (document.documentElement.style.fontSize = '200%'));
      assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
    });
    await test('card tap opens focused source/metric/date explorer and exact expandable records', async () => {
      await open(1440, 1000);
      await dashboard();
      const card = page.locator('[data-chart="price"]');
      await card.getByRole('button', { name: '30D', exact: true }).click();
      await card.getByRole('link', { name: 'Explore HEX Price', exact: true }).click();
      await page.locator('[data-testid="history-chart"]').waitFor();
      assert.equal(
        await page.getByRole('combobox', { name: 'Source', exact: true }).inputValue(),
        'hds',
      );
      assert.equal(
        await page.getByRole('combobox', { name: 'Metric', exact: true }).inputValue(),
        'price',
      );
      assert.ok((await page.locator('tbody tr').count()) >= 29);
      assert.match(await page.locator('tbody').innerText(), /Unavailable/);
      await shot('detail-desktop');
      await page.setViewportSize({ width: 390, height: 844 });
      await shot('detail-mobile');
      await page.getByRole('combobox', { name: 'Metric', exact: true }).selectOption('cost');
      await page
        .getByRole('heading', { name: 'T-Share Cost USD · derived HDS', exact: true })
        .waitFor();
      await shot('cost-detail-mobile');
      await page.getByRole('link', { name: '← All charts' }).click();
      await page.getByRole('heading', { name: 'Charts', exact: true }).waitFor();
    });
  }
  if (mode === 'both') {
    await test('expired current price does not replace history; failed refresh is recoverable and missing metric stays unavailable', async () => {
      const home = await (await fetch(base + '/api/v2/home')).json();
      assert.equal(home.live.price.status, 'unavailable');
      await open();
      await dashboard();
      const original = await page.locator('[data-chart="price"] .chart-value').innerText();
      assert.notEqual(original, '$0.99');
      await page.route('**/api/v2/charts/archive?*', (r) =>
        r.fulfill({ status: 503, contentType: 'application/json', body: '{}' }),
      );
      await page.locator('.charts-data-details summary').click();
      await page.getByRole('button', { name: 'Refresh chart history', exact: true }).click();
      await page.getByText('Archive request unavailable.', { exact: false }).waitFor();
      assert.equal(await page.locator('[data-chart="price"] .chart-value').innerText(), original);
      await page.unroute('**/api/v2/charts/archive?*');
      await page.route('**/api/v2/charts/archive?*', async (r) => {
        const response = await r.fetch(),
          body = await response.json();
        body.items.forEach((row) => (row.values[3] = null));
        await r.fulfill({ response, json: body });
      });
      await page.getByRole('button', { name: 'Refresh chart history', exact: true }).click();
      await page.getByRole('button', { name: 'Staking', exact: true }).click();
      await page.waitForFunction(
        () =>
          document.querySelector('[data-chart="shares"] .chart-value')?.textContent ===
          'Unavailable',
      );
      assert.equal(await page.locator('[data-chart="rate"]').getAttribute('data-ready'), 'true');
      await shot('missing-metric-mobile', true);
    });
    await test('maturity unit controls and exact indexed drill-down', async () => {
      await open();
      await dashboard();
      await loadAll();
      const card = page.locator('[data-chart="maturities"]');
      await card.getByRole('button', { name: 'T-Shares', exact: true }).click();
      await card.getByRole('button', { name: '3Y', exact: true }).click();
      await card.getByRole('link', { name: 'Explore Upcoming Maturities', exact: true }).click();
      await page.locator('[data-testid="history-chart"]').waitFor();
      assert.equal(
        await page.getByRole('combobox', { name: 'Source', exact: true }).inputValue(),
        'Native indexed stakes',
      );
      assert.equal(
        await page.getByRole('combobox', { name: 'Metric', exact: true }).inputValue(),
        'T-Shares',
      );
      await shot('maturity-detail-mobile');
    });
    await test('native ALL drill-down retains the entire date interval through bounded exact windows', async () => {
      await open();
      await dashboard();
      await page
        .locator('[data-chart="payout"]')
        .getByRole('link', { name: 'Explore Payout per T-Share', exact: true })
        .click();
      await page.getByText(/Complete selection:.*1228 records/).waitFor();
      assert.equal(await page.locator('tbody tr').count(), 100);
      assert.equal(
        await page.getByRole('combobox', { name: 'Source', exact: true }).inputValue(),
        'native',
      );
      assert.equal(requests.filter((r) => r.includes('/daily?')).length, 4);
    });
    await test('11 independent cold mobile loads under Task07 profile; initial request counts and payload sizes', async () => {
      for (let i = 0; i < 11; i++) {
        await open();
        const cdp = await context.newCDPSession(page);
        await cdp.send('Network.enable');
        await cdp.send('Network.setCacheDisabled', { cacheDisabled: true });
        await cdp.send('Network.emulateNetworkConditions', {
          offline: false,
          latency: 150,
          downloadThroughput: 10e6 / 8,
          uploadThroughput: 1.5e6 / 8,
        });
        await cdp.send('Emulation.setCPUThrottlingRate', { rate: 4 });
        await dashboard();
        await page.waitForFunction(() => window.__paint.headlines && window.__paint.chart);
        timings.push(
          await page.evaluate(() => ({
            ...window.__paint,
            resources: performance.getEntriesByType('resource').map((r) => ({
              name: r.name.split(location.origin)[1],
              bytes: r.encodedBodySize,
              decoded: r.decodedBodySize,
              startTime: r.startTime,
              responseEnd: r.responseEnd,
            })),
          })),
        );
        assert.equal(requests.filter((u) => u.includes('/charts/archive')).length, 1);
        assert.equal(requests.filter((u) => u.includes('/charts/native')).length, 1);
        assert.ok(
          timings.at(-1).resources.find((r) => r.name.includes('/charts/archive')).responseEnd -
            timings.at(-1).resources.find((r) => r.name.includes('/charts/archive')).startTime >=
            130,
        );
      }
    });
  }
  assert.deepEqual(errors, []);
} catch (e) {
  await page?.screenshot({ path: resolve(folder, `${mode}-failure.png`) }).catch(() => {});
  throw e;
} finally {
  const p95 = (key) =>
    timings.length >= 11
      ? timings.map((v) => v[key]).sort((a, b) => a - b)[Math.ceil(timings.length * 0.95) - 1]
      : null;
  writeFileSync(
    resolve(evidence, `browser-${mode}.json`),
    JSON.stringify(
      {
        checks,
        errors,
        timings,
        p95: { headlines: p95('headlines'), chart: p95('chart') },
        profile:
          '150ms RTT / 10Mbps down / 1.5Mbps up / 4x CPU; new context, cache disabled; 1227 HDS rows / 1228 native days / 120 stake rows; not Task09 or production scale',
        requests,
        liveRequests: 0,
      },
      null,
      2,
    ),
  );
  await context?.close();
  await browser.close();
}
