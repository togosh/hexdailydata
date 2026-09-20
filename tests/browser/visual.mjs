import assert from 'node:assert/strict';
import { chromium } from 'playwright';
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { execFileSync } from 'node:child_process';
import { stakeApy } from '../../src/domain/calculator.ts';
import { displayRatio } from '../../src/domain/units.ts';
import { compactNumber } from '../../src/web/format.ts';
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
  context = await browser.newContext({
    viewport,
    deviceScaleFactor,
    reducedMotion: 'reduce',
    colorScheme: 'light',
    timezoneId: 'America/Chicago',
  });
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
        ['apy', '[data-testid="stake-apy"][data-ready="true"]'],
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
  await page.locator('[data-testid="stake-apy"][data-ready="true"]').waitFor();
}
async function capture(name) {
  assert.equal(
    await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth),
    true,
    name + ' no horizontal page overflow',
  );
  await page.screenshot({ path: resolve(folder, 'visual-' + name + '.png') });
}
async function refreshHome() {
  const response = page.waitForResponse((r) => r.url().includes('/api/v2/home?'));
  await page.evaluate(() => document.dispatchEvent(new Event('visibilitychange')));
  await response;
}
try {
  for (let i = 0; i < 60; i++) {
    try {
      if ((await fetch(base + '/health/live')).ok) break;
    } catch {}
    await pause(250);
  }
  await open();
  await test('SYNTHETIC compiled API values, requested six-metric order, Supply then Today, chart controls and APY estimates', async () => {
    await home();
    assert.deepEqual(await (await fetch(base + '/api/v2/home')).json(), fixture.expected);
    assert.equal(await page.locator('.home-context').count(), 0);
    assert.equal(await page.locator('.home-metrics .meta').count(), 0);
    assert.doesNotMatch(await page.locator('.home-page').innerText(), /≈/);
    assert.equal(await page.locator('.home-facts .panel-context').count(), 0);
    assert.equal(await page.getByRole('button', { name: 'Refresh', exact: true }).count(), 0);
    assert.deepEqual(await page.locator('.home-today dt').allTextContents(), [
      'New Stakes',
      'Ended Stakes',
      'New Holders (net)',
      'New Stakers (net)',
      'NET HEX Locked',
      'Payouts (est.)',
      'Penalties',
    ]);
    assert.match(await page.locator('[data-metric="tvl"] dd').innerText(), /\$.*2\.41B/);
    assert.match(await page.locator('[data-metric="price"] dd').innerText(), /\$0\.003876/);
    assert.match(await page.locator('[data-metric="duration"] dd').innerText(), /9\.75/);
    assert.deepEqual(
      await page
        .locator('.home-metrics > [data-metric]')
        .evaluateAll((nodes) => nodes.map((n) => n.dataset.metric)),
      ['price', 'completed', 'rate', 'staked', 'holders', 'stakers'],
    );
    assert.equal(
      await page.locator('[data-metric="holders"] dd').innerText(),
      fixture.expected.current.holderCount,
    );
    assert.equal(
      await page.locator('[data-metric="stakers"] dd').innerText(),
      fixture.expected.current.stakerCount,
    );
    for (const name of ['price', 'completed', 'rate', 'staked', 'holders', 'stakers']) {
      const box = await page.locator('[data-metric="' + name + '"]').boundingBox();
      assert.ok(
        box.y > 0 && box.y + box.height < 770,
        name + ' fully visible above bottom navigation',
      );
    }
    const supply = await page.locator('.home-facts').boundingBox();
    const today = await page.locator('.home-today').boundingBox();
    const mobileChart = await page.locator('.home-chart').boundingBox();
    assert.ok(supply.y < 740, 'supply context directly after metrics on mobile');
    assert.ok(
      today.y >= supply.y + supply.height && mobileChart.y >= today.y + today.height,
      'Supply, Today, then chart',
    );
    for (const viewport of [
      { width: 390, height: 844 },
      { width: 390, height: 780 },
      { width: 375, height: 812 },
    ]) {
      await page.setViewportSize(viewport);
      const nav = await page.locator('.bottom-nav').boundingBox();
      for (const selector of ['.home-metrics', '.home-facts', '.home-today']) {
        const box = await page.locator(selector).boundingBox();
        assert.ok(box.y >= 0 && box.y + box.height < nav.y, selector + ' fits initial mobile view');
      }
      assert.equal(await page.evaluate(() => scrollY), 0);
      await capture('home-' + viewport.width + 'x' + viewport.height);
    }
    await page.setViewportSize({ width: 390, height: 844 });
    await capture('home-390');
    await page.screenshot({ path: resolve(folder, 'visual-home-390-full.png'), fullPage: true });
    await page.setViewportSize({ width: 1440, height: 1000 });
    await capture('home-1440');
    await page.screenshot({ path: resolve(folder, 'visual-home-1440-full.png'), fullPage: true });
    const chart = await page.locator('.home-chart').boundingBox(),
      facts = await page.locator('.home-facts').boundingBox();
    assert.equal(chart.y, facts.y);
    assert.ok(chart.y + chart.height < 850 && chart.x < facts.x);
    const desktopToday = await page.locator('.home-today').boundingBox();
    assert.equal(desktopToday.y, facts.y);
    assert.ok(desktopToday.x > facts.x, 'desktop panels sit side by side');
    for (const viewport of [
      { width: 1440, height: 900 },
      { width: 1366, height: 768 },
    ]) {
      await page.setViewportSize(viewport);
      const shortcuts = await page.locator('.home-shortcuts').boundingBox();
      assert.ok(shortcuts.y + shortcuts.height < viewport.height, 'desktop quick actions fit');
      await capture('home-' + viewport.width + 'x' + viewport.height);
    }
    await page.setViewportSize({ width: 1440, height: 1000 });
    assert.equal(
      await page.getByRole('button', { name: 'Exact values & methodology', exact: true }).count(),
      0,
    );
    assert.equal(await page.locator('.home-chart details').count(), 0);
    assert.equal(await page.locator('.home-chart a').count(), 0);
    assert.doesNotMatch(
      await page.locator('.home-chart').innerText(),
      /Native daily history|Data table/,
    );
    assert.deepEqual(await page.locator('.home-facts dt').allTextContents(), [
      'Circulating supply',
      'Locked principal (incl. GA)',
      'TVL Staked',
      'Avg Stake Length',
    ]);
    assert.deepEqual(await page.locator('.home-apy dt').allTextContents(), ['1Y', '5Y', '10Y']);
    for (const value of await page.locator('.home-apy dd').allTextContents())
      assert.match(value, /^\d[\d,.]*%$/);
    await page.getByRole('button', { name: '7D', exact: true }).click();
    await page.waitForFunction(
      () => document.querySelectorAll('.home-chart svg circle').length === 7,
    );
    await page.getByRole('button', { name: '30D', exact: true }).click();
    await page.waitForFunction(
      () => document.querySelectorAll('.home-chart svg circle').length === 30,
    );
  });
  await test('dark default, adjacent theme/menu controls, persistent light mode, device UTC/day rollover and estimate expiry', async () => {
    await open();
    await home();
    assert.equal(
      await page.evaluate(() => document.documentElement.dataset.theme),
      'dark',
      'default stays dark even with light OS preference',
    );
    for (const width of [390, 1440]) {
      await page.setViewportSize({ width, height: width === 1440 ? 1000 : 844 });
      const theme = await page.locator('.theme-toggle').boundingBox();
      const menu = await page.locator('.menu-toggle').boundingBox();
      const day = await page.getByTestId('hex-day').boundingBox();
      const utc = await page.getByTestId('utc-clock').boundingBox();
      assert.ok(theme.y < 90 && theme.x + theme.width <= menu.x && Math.abs(theme.y - menu.y) < 1);
      assert.ok(day.x < utc.x && Math.abs(day.y - utc.y) < 1);
      await page.getByRole('button', { name: 'Use light mode' }).click();
      await page.waitForFunction(() => document.documentElement.dataset.theme === 'light');
      assert.equal(
        await page.evaluate(() => getComputedStyle(document.documentElement).colorScheme),
        'light',
      );
      await capture('home-' + width + '-light');
      if (width === 390)
        await page.screenshot({
          path: resolve(folder, 'visual-home-390-light-full.png'),
          fullPage: true,
        });
      await page.reload();
      await page.getByRole('button', { name: 'Use dark mode' }).waitFor();
      assert.equal(await page.evaluate(() => document.documentElement.dataset.theme), 'light');
      await page.getByRole('button', { name: 'Use dark mode' }).click();
    }
    const beforeMidnight = Date.parse('2026-09-19T23:59:59Z');
    await page.evaluate((at) => (window.__testNow = at), beforeMidnight);
    await page.getByTestId('utc-clock').getByText('23:59:59 UTC', { exact: true }).waitFor();
    assert.equal(await page.getByTestId('hex-day').innerText(), 'HEX Day 2483');
    await page.evaluate((at) => (window.__testNow = at + 1000), beforeMidnight);
    await page.getByTestId('utc-clock').getByText('00:00:00 UTC', { exact: true }).waitFor();
    assert.equal(await page.getByTestId('hex-day').innerText(), 'HEX Day 2484');
    assert.equal(
      await page.locator('[data-metric="total-estimate"] dd').innerText(),
      'Unavailable',
    );
    assert.deepEqual(
      await page.locator('.home-apy dd').allTextContents(),
      Array(3).fill('Unavailable'),
    );
    await open({ width: 1440, height: 1000 });
    await home();
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
      await page.getByRole('button', { name: 'Use light mode' }).click();
      await page.waitForFunction(() => document.documentElement.dataset.theme === 'light');
      await capture(name + '-1440-light-smoke');
      await page.getByRole('button', { name: 'Use dark mode' }).click();
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
    assert.match(await page.locator('[data-metric="price"] dd').innerText(), /0\.003876/);
    await refreshHome();
    assert.match(await page.locator('[data-metric="price"] dd').innerText(), /0\.003876/);
    await page.route('**/api/v2/home?*', (r) =>
      r.fulfill({ status: 503, contentType: 'application/json', body: '{}' }),
    );
    await refreshHome();
    await page
      .getByRole('status')
      .getByText(/Data is unavailable/)
      .waitFor();
    await capture('home-stale-failed-refresh');
    await page.evaluate((at) => (window.__testNow = at + 1801000), fixture.at);
    await page.waitForFunction(
      () => document.querySelector('[data-metric="price"] dd').textContent === 'Unavailable',
    );
    assert.equal(await page.locator('[data-metric="tvl"] dd').innerText(), 'Unavailable');
    assert.deepEqual(
      await page.locator('.home-apy dd').allTextContents(),
      Array(3).fill('Unavailable'),
    );
    await capture('home-expired-failed-refresh');
    await page.unroute('**/api/v2/home?*');
    await page.evaluate((at) => (window.__testNow = at), fixture.at);
    const boundary = structuredClone(response);
    boundary.current.stakedPercent = '0';
    boundary.current.weightedStakeLengthDays = null;
    boundary.current.circulatingHex = '90071992547409931234567890.00000001';
    boundary.live.price.value.usdPerHex = '0.000000000000000000000000000000000001';
    await page.route('**/api/v2/home?*', (r) =>
      r.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(boundary) }),
    );
    await page.reload();
    await page.locator('[data-metric="duration"] dd').getByText('Unavailable').waitFor();
    assert.match(await page.locator('[data-metric="staked"] dd').innerText(), /^0/);
    await page.setViewportSize({ width: 320, height: 844 });
    await capture('home-extreme-320');
    await page.unroute('**/api/v2/home?*');
    await page.route('**/api/v2/daily?*', (r) => r.abort());
    await page.reload();
    await page.locator('[data-testid="headlines"][data-ready="true"]').waitFor();
    await capture('home-chart-failure');
  });
  await test('APY uses the completed30-day exact mean and current rate, independent of today; gaps and failed history stay unavailable', async () => {
    await open();
    const boundary = structuredClone(fixture.expected);
    const inputs = await (await fetch(base + '/api/v2/calculator/inputs')).json();
    const mean = inputs.presets.find((p) => p.window === 30);
    const original = structuredClone(mean);
    await page.route('**/api/v2/home?*', (r) =>
      r.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(boundary) }),
    );
    await page.route('**/api/v2/calculator/inputs?*', (r) =>
      r.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(inputs) }),
    );
    const expected = () =>
      [1, 5, 10].map(
        (years) =>
          compactNumber(
            displayRatio(
              stakeApy(
                1000000000000n,
                years,
                BigInt(boundary.live.shareRate.value.rawShareRate),
                {
                  numerator: BigInt(mean.value.numerator),
                  denominator: BigInt(mean.value.denominator),
                },
                BigInt(fixture.at / 1000),
              ),
            ),
            2,
            false,
          ) + '%',
      );
    await home();
    assert.deepEqual(await page.locator('.home-apy dd').allTextContents(), expected());
    const baseline = await page.locator('.home-apy dd').allTextContents();
    boundary.live.todayPayoutEstimate = {
      ...boundary.live.todayPayoutEstimate,
      status: 'unavailable',
      value: null,
      reason: 'not_observed',
    };
    await home();
    assert.deepEqual(await page.locator('.home-apy dd').allTextContents(), baseline);
    boundary.live.shareRate.value.rawShareRate = (
      BigInt(boundary.live.shareRate.value.rawShareRate) * 2n
    ).toString();
    await home();
    assert.deepEqual(await page.locator('.home-apy dd').allTextContents(), expected());
    assert.notDeepEqual(await page.locator('.home-apy dd').allTextContents(), baseline);
    mean.value.numerator = '0';
    await home();
    assert.deepEqual(await page.locator('.home-apy dd').allTextContents(), Array(3).fill('0%'));
    mean.value = {
      numerator: '1',
      denominator: '1000000000000000000000000000000',
      hexPerTShare: '0',
    };
    await home();
    assert.deepEqual(await page.locator('.home-apy dd').allTextContents(), Array(3).fill('<0.01%'));
    mean.status = 'unavailable';
    mean.reason = 'missing_days';
    mean.count = 29;
    mean.value = null;
    await page.reload();
    await page.locator('[data-testid="headlines"][data-ready="true"]').waitFor();
    assert.deepEqual(
      await page.locator('.home-apy dd').allTextContents(),
      Array(3).fill('Unavailable'),
    );
    Object.assign(mean, original);
    await home();
    await page.unroute('**/api/v2/calculator/inputs?*');
    await page.route('**/api/v2/calculator/inputs?*', (r) =>
      r.fulfill({ status: 503, body: '{}' }),
    );
    const failed = page.waitForResponse((r) => r.url().includes('/calculator/inputs?'));
    await page.evaluate(() => document.dispatchEvent(new Event('visibilitychange')));
    await failed;
    await page.waitForFunction(() => document.querySelector('.home-apy').dataset.ready === 'false');
    assert.deepEqual(
      await page.locator('.home-apy dd').allTextContents(),
      Array(3).fill('Unavailable'),
    );
    assert.equal(
      await page.locator('[data-testid="headlines"]').getAttribute('data-ready'),
      'true',
    );
    await capture('home-apy-history-unavailable');
    await page.unroute('**/api/v2/calculator/inputs?*');
    let release;
    const wait = new Promise((resolve) => (release = resolve));
    await page.route('**/api/v2/calculator/inputs?*', async (r) => {
      await wait;
      await r.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify(inputs),
      });
    });
    await page.reload();
    await page.locator('[data-testid="headlines"][data-ready="true"]').waitFor();
    await page.locator('[data-testid="history-chart"][data-ready="true"]').waitFor();
    assert.equal(await page.locator('.home-apy').getAttribute('data-ready'), 'false');
    release();
    await page.locator('[data-testid="stake-apy"][data-ready="true"]').waitFor();
    await open();
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
      await page.waitForFunction(
        () => window.__paint.headlines && window.__paint.chart && window.__paint.apy,
      );
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
          apyP95: p95('apy'),
        },
      },
      null,
      2,
    ),
  );
  await context?.close();
  await browser.close();
}
