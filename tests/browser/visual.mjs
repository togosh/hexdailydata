import assert from 'node:assert/strict';
import { chromium } from 'playwright';
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { execFileSync } from 'node:child_process';
import { setTimeout as pause } from 'node:timers/promises';
const [base, scenario, evidence] = process.argv.slice(2);
assert.match(base, /^http:\/\/127\.0\.0\.1:\d+$/);
assert.equal(scenario, 'visual');
const fixture = JSON.parse(readFileSync(resolve(evidence, 'visual-fixture.json')));
const folder = resolve(evidence, 'screenshots');
mkdirSync(folder, { recursive: true });
const checks = [],
  errors = [],
  traffic = [],
  timings = [];
const browser = await chromium.launch({ channel: process.env.HDD_V2_BROWSER_CHANNEL ?? 'chrome' });
let context, page;
async function open(viewport = { width: 390, height: 844 }, deviceScaleFactor = 1) {
  await context?.close();
  context = await browser.newContext({ viewport, deviceScaleFactor, reducedMotion: 'reduce' });
  await context.addInitScript((at) => {
    window.__testNow = at;
    const Original = Date;
    window.Date = class extends Original {
      constructor(...args) {
        super(...(args.length ? args : [window.__testNow]));
      }
      static now() {
        return window.__testNow;
      }
    };
    window.__paint = {};
    new MutationObserver(() => {
      for (const [key, selector] of [
        ['headlines', '[data-testid="headlines"][data-ready="true"]'],
        ['chart', '[data-testid="history-chart"][data-ready="true"]'],
      ]) {
        if (!window.__paint[key + 'Pending'] && document.querySelector(selector)) {
          window.__paint[key + 'Pending'] = true;
          requestAnimationFrame(() =>
            requestAnimationFrame(() => (window.__paint[key] = performance.now())),
          );
        }
      }
    }).observe(document, { subtree: true, childList: true, attributes: true });
  }, fixture.at);
  page = await context.newPage();
  page.on('pageerror', (error) => errors.push(error.message));
  await page.route('**/*', (route) => {
    const url = route.request().url();
    traffic.push(url);
    if (!url.startsWith(base + '/')) {
      errors.push('External request: ' + url);
      return route.abort();
    }
    return route.continue();
  });
}
async function test(name, fn) {
  await fn();
  checks.push(name);
  console.log('PASS', name);
}
async function home() {
  await page.goto(base);
  await page.locator('[data-testid="headlines"][data-ready="true"]').waitFor();
  await page.locator('[data-testid="history-chart"][data-ready="true"]').waitFor();
}
async function capture(name) {
  assert.equal(
    await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth),
    true,
    name + ' no horizontal page overflow',
  );
  await page.screenshot({ path: resolve(folder, 'visual-' + name + '.png') });
}
try {
  for (let i = 0; i < 60; i++) {
    try {
      if ((await fetch(base + '/health/live')).ok) break;
    } catch {}
    await pause(250);
  }
  await open();
  await test('SYNTHETIC compiled API values, four priority metrics in 390x844, high supply, chart and exact details', async () => {
    await home();
    assert.deepEqual(await (await fetch(base + '/api/v2/home')).json(), fixture.expected);
    assert.match(await page.locator('[data-metric="price"] dd').innerText(), /\$0\.003876/);
    assert.match(await page.locator('[data-metric="duration"] dd').innerText(), /9\.75/);
    for (const name of ['price', 'completed', 'staked', 'duration']) {
      const box = await page.locator('[data-metric="' + name + '"]').boundingBox();
      assert.ok(
        box.y > 0 && box.y + box.height < 770,
        name + ' fully visible above bottom navigation',
      );
    }
    const supply = await page.getByRole('heading', { name: 'Supply & staking' }).boundingBox();
    assert.ok(supply.y < 700, 'supply context high on mobile');
    await capture('home-390');
    await page.screenshot({ path: resolve(folder, 'visual-home-390-full.png'), fullPage: true });
    await page.setViewportSize({ width: 1440, height: 1000 });
    await capture('home-1440');
    const chart = await page.locator('.home-chart').boundingBox(),
      facts = await page.locator('.home-facts').boundingBox();
    assert.equal(chart.y, facts.y);
    assert.ok(chart.y + chart.height < 850 && chart.x < facts.x);
    const before = traffic.filter((url) => url.includes('/api/')).length;
    const button = page.getByRole('button', { name: 'Details', exact: true });
    await button.click();
    const dialog = page.getByRole('dialog');
    await dialog.waitFor();
    await capture('details-1440');
    await page.setViewportSize({ width: 390, height: 844 });
    await capture('details-390');
    await page.setViewportSize({ width: 1440, height: 1000 });
    assert.match(await dialog.innerText(), new RegExp(fixture.expected.live.price.value.usdPerHex));
    assert.ok((await dialog.innerText()).includes(fixture.expected.daily.circulatingHex));
    await context.grantPermissions(['clipboard-read', 'clipboard-write']);
    await dialog.getByRole('button', { name: 'Copy price', exact: true }).click();
    await dialog.getByText('Copied', { exact: true }).waitFor();
    assert.equal(await page.evaluate(() => navigator.clipboard.readText()), '0.003876 USD/HEX');
    assert.equal(
      traffic.filter((url) => url.includes('/api/')).length,
      before,
      'Details does no provider or API fanout',
    );
    await page.keyboard.press('Escape');
    assert.equal(await button.evaluate((e) => e === document.activeElement), true);
    await page.getByRole('button', { name: '7D', exact: true }).click();
    await page.getByText('Data table · 7 records', { exact: true }).waitFor();
    await page.getByText('Data table · 7 records', { exact: true }).click();
    assert.equal(await page.locator('tbody tr').count(), 7);
    await page.getByRole('button', { name: '30D', exact: true }).click();
    await page.getByText('Data table · 30 records', { exact: true }).waitFor();
  });
  await test('header search, mobile menu, Escape/focus, bottom destinations, browser back and final-row clearance', async () => {
    await page.getByLabel('Header address or stake ID', { exact: true }).fill('1');
    await page.getByRole('button', { name: 'Search from header' }).click();
    await page.getByRole('heading', { name: 'Stake 1', exact: true }).waitFor();
    assert.equal(await page.locator('.desktop-nav [aria-current="page"]').innerText(), 'Search');
    await page.goBack();
    await page.setViewportSize({ width: 390, height: 844 });
    const toggle = page.getByRole('button', { name: 'Open navigation menu' });
    await toggle.click();
    await page.getByRole('dialog').waitFor();
    await page.keyboard.press('Tab');
    assert.equal(await page.evaluate(() => !!document.activeElement.closest('dialog')), true);
    await page.keyboard.press('Shift+Tab');
    assert.equal(await page.evaluate(() => !!document.activeElement.closest('dialog')), true);
    await capture('menu-390');
    await page.keyboard.press('Escape');
    assert.equal(await toggle.evaluate((e) => e === document.activeElement), true);
    await toggle.click();
    await page
      .getByRole('navigation', { name: 'All destinations' })
      .getByRole('link', { name: 'Data status' })
      .click();
    await page.getByRole('heading', { level: 1 }).waitFor();
    assert.equal(await page.getByRole('dialog').count(), 0);
    await page.waitForFunction(() => document.activeElement?.tagName === 'MAIN');
    for (const [label, path] of [
      ['Home', '/'],
      ['Charts', '/charts'],
      ['Calculator', '/calculator'],
      ['Data', '/downloads'],
      ['Search', '/search'],
    ]) {
      await page
        .getByRole('navigation', { name: 'Mobile destinations' })
        .getByRole('link', { name: label, exact: true })
        .click();
      await page.waitForURL(base + path);
      assert.equal(await page.locator('.bottom-nav [aria-current="page"]').innerText(), label);
    }
    await page.locator('tbody tr').first().waitFor();
    await page.waitForFunction(() => document.activeElement?.tagName === 'MAIN');
    await page.evaluate(
      () =>
        new Promise((resolve) =>
          requestAnimationFrame(() => {
            window.scrollTo(0, document.body.scrollHeight);
            requestAnimationFrame(resolve);
          }),
        ),
    );
    const last = await page.locator('.site-footer p').boundingBox(),
      bottom = await page.locator('.bottom-nav').boundingBox();
    assert.ok(last.y + last.height < bottom.y, 'last footer row clears fixed controls');
  });
  await test('all main routes at 320px and desktop; reduced motion and 200% text/reflow', async () => {
    for (const [name, path] of [
      ['home', '/'],
      ['charts', '/charts'],
      ['calculator', '/calculator'],
      ['downloads', '/downloads'],
      ['address', '/address/0x' + '1'.padStart(40, '0')],
      ['search', '/search'],
      ['learn', '/learn'],
      ['status', '/status'],
    ]) {
      await page.goto(base + path);
      await page.locator('h1').waitFor({ state: 'attached' });
      await page.waitForTimeout(250);
      for (const width of [320, 390, 1440]) {
        await page.setViewportSize({ width, height: width === 1440 ? 1000 : 844 });
        await page.evaluate(() => scrollTo(0, 0));
        await capture(name + '-' + width + '-smoke');
      }
      await page.setViewportSize({ width: 320, height: 844 });
      await page.evaluate(() => (document.documentElement.style.fontSize = '200%'));
      assert.equal(
        await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth),
        true,
        name + ' 200% text',
      );
      await page.evaluate(() => (document.documentElement.style.fontSize = ''));
    }
    await open({ width: 720, height: 500 }, 2);
    await home();
    await capture('home-200-percent-reflow');
    assert.equal(
      await page.evaluate(() => matchMedia('(prefers-reduced-motion: reduce)').matches),
      true,
    );
  });
  await test('age progression after unchanged and failed refresh; missing, zero and extreme data remain separate', async () => {
    await open();
    await home();
    const response = fixture.expected;
    await page.evaluate((at) => (window.__testNow = at + 121000), fixture.at);
    await page.locator('[data-metric="price"]').getByText(/Stale/).waitFor();
    await page.getByRole('button', { name: 'Refresh', exact: true }).click();
    await page.locator('[data-metric="price"]').getByText(/Stale/).waitFor();
    await page.route('**/api/v2/home?*', (r) =>
      r.fulfill({ status: 503, contentType: 'application/json', body: '{}' }),
    );
    await page.getByRole('button', { name: 'Refresh', exact: true }).click();
    await page
      .getByRole('status')
      .getByText(/Data is unavailable/)
      .waitFor();
    await capture('home-stale-failed-refresh');
    await page.evaluate((at) => (window.__testNow = at + 1801000), fixture.at);
    await page.waitForFunction(
      () => document.querySelector('[data-metric="price"] dd').textContent === 'Unavailable',
    );
    await capture('home-expired-failed-refresh');
    await page.unroute('**/api/v2/home?*');
    await page.evaluate((at) => (window.__testNow = at), fixture.at);
    const boundary = structuredClone(response);
    boundary.daily.stakedPercent = '0';
    boundary.daily.weightedStakeLengthDays = null;
    boundary.daily.circulatingHex = '90071992547409931234567890.00000001';
    boundary.live.price.value.usdPerHex = '0.000000000000000000000000000000000001';
    await page.route('**/api/v2/home?*', (r) =>
      r.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(boundary) }),
    );
    await page.reload();
    await page.locator('[data-metric="duration"] dd').getByText('Unavailable').waitFor();
    assert.match(await page.locator('[data-metric="staked"] dd').innerText(), /^0/);
    await page.setViewportSize({ width: 320, height: 844 });
    await capture('home-extreme-320');
    await page.getByRole('button', { name: 'Details', exact: true }).click();
    assert.ok((await page.getByRole('dialog').innerText()).includes(boundary.daily.circulatingHex));
    await page.keyboard.press('Escape');
    await page.unroute('**/api/v2/home?*');
    await page.route('**/api/v2/daily?*', (r) => r.abort());
    await page.reload();
    await page.locator('[data-testid="headlines"][data-ready="true"]').waitFor();
    await capture('home-chart-failure');
  });
  await test('11 fresh useful-headline/chart timings on small realistic fixture, existing mobile network profile', async () => {
    for (let i = 0; i < 11; i++) {
      await open();
      const cdp = await context.newCDPSession(page);
      await cdp.send('Network.enable');
      await cdp.send('Network.setCacheDisabled', { cacheDisabled: true });
      await cdp.send('Network.emulateNetworkConditions', {
        offline: false,
        latency: 150,
        downloadThroughput: (10 * 1000000) / 8,
        uploadThroughput: (1.5 * 1000000) / 8,
      });
      await cdp.send('Emulation.setCPUThrottlingRate', { rate: 4 });
      await home();
      await page.waitForFunction(() => window.__paint.headlines && window.__paint.chart);
      timings.push(
        await page.evaluate(() => ({
          ...window.__paint,
          resources: performance.getEntriesByType('resource').map((r) => r.toJSON()),
        })),
      );
      const last = timings.at(-1);
      const api = last.resources.find((r) => r.name.includes('/api/v2/home?'));
      assert.ok(api.responseEnd - api.startTime >= 130, 'observed throttled Home latency');
    }
  });
  assert.deepEqual(errors, []);
} catch (e) {
  errors.push(e.stack);
  await page?.screenshot({ path: resolve(folder, 'visual-failure.png') }).catch(() => {});
  throw e;
} finally {
  const p95 = (key) =>
    timings.map((r) => r[key]).sort((a, b) => a - b)[Math.ceil(timings.length * 0.95) - 1];
  writeFileSync(
    resolve(evidence, 'visual-browser.json'),
    JSON.stringify(
      {
        scenario: fixture.scenario,
        sourceCommit: execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim(),
        workingTreeAtRun: execFileSync('git', ['diff', '--stat'], { encoding: 'utf8' }),
        browser: browser.version(),
        viewport: '390x844 and 1440x1000 CSS; DPR 1',
        zoomCheck:
          '200% text plus full zoom-equivalent 720x500 CSS / DPR2 for a 1440x1000 display; not browser chrome keyboard zoom',
        checks,
        errors,
        traffic,
        timings,
        performance: {
          fixture: '120 stakes / 60 accounts; warm SQL; NOT million-row qualification',
          network: '150ms RTT / 10Mbps down / 1.5Mbps up',
          cpu: '4x browser slowdown; API .25CPU/512MiB; DB1.5CPU/3GiB; browser outside envelope',
          cache: 'disabled; new context and document each sample',
          homeBytes: fixture.homeBytes,
          headlinesP95: p95('headlines'),
          chartP95: p95('chart'),
        },
      },
      null,
      2,
    ),
  );
  await context?.close();
  await browser.close();
}
