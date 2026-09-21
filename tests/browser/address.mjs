import assert from 'node:assert/strict';
import { chromium } from 'playwright';
import { mkdirSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
const [base, scenario, evidence] = process.argv.slice(2);
assert.match(base, /^http:\/\/127\.0\.0\.1:\d+$/);
assert.ok(['ordinary', 'extreme'].includes(scenario));
const address = '0x' + '1'.padStart(40, '0'),
  at = Date.parse('2026-09-19T12:00:00Z');
const folder = resolve(evidence, 'screenshots');
mkdirSync(folder, { recursive: true });
const browser = await chromium.launch({ channel: process.env.HDD_V2_BROWSER_CHANNEL ?? 'chrome' });
const context = await browser.newContext({
  viewport: { width: 1440, height: 1000 },
  deviceScaleFactor: 1,
  reducedMotion: 'reduce',
  permissions: ['clipboard-read', 'clipboard-write'],
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
}, at);
const page = await context.newPage(),
  errors = [],
  checks = [];
page.on('pageerror', (e) => errors.push(e.message));
await context.route('**/*', (r) => {
  if (
    !r
      .request()
      .url()
      .startsWith(base + '/')
  ) {
    errors.push('External request');
    return r.abort();
  }
  return r.continue();
});
async function test(name, fn) {
  await fn();
  checks.push(name);
  console.log('PASS', name);
}
async function go() {
  await page.goto(base + '/address/' + address);
  await page.getByRole('button', { name: 'Open 24', exact: true }).waitFor();
  await page.locator('.stake-desktop tbody tr').first().waitFor({ state: 'attached' });
}
async function capture(name) {
  assert.equal(
    await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth),
    true,
    name + ' overflow',
  );
  await page.screenshot({ path: resolve(folder, name + '.png') });
}
async function keyboardClick(locator) {
  await locator.focus();
  assert.equal(await locator.evaluate((e) => e === document.activeElement), true);
  await page.keyboard.press('Enter');
}
try {
  // Wait for the freshly started compiled test host.
  for (let n = 0; n < 120; n++) {
    try {
      if ((await fetch(base + '/health/live')).ok) break;
    } catch {}
    await new Promise((r) => setTimeout(r, 250));
  }
  if (scenario === 'ordinary') {
    await test('ordinary complete index vs partial live observation; desktop 1440x1000', async () => {
      await go();
      assert.equal(
        await page.evaluate(() => getComputedStyle(document.documentElement).backgroundColor),
        'rgb(5, 13, 24)',
      );
      assert.equal(
        await page.locator('[data-metric="address-staked"] .value').innerText(),
        '4.725M',
      );
      assert.equal(await page.locator('[data-metric="address-shares"] .value').innerText(), '1.2K');
      await page.getByText('20 / 27 live verified', { exact: true }).waitFor();
      assert.equal(await page.locator('.address-data-details').getAttribute('open'), null);
      const summary = await page.locator('.address-summary').boundingBox(),
        stakes = await page.locator('.address-stakes').boundingBox();
      assert.ok(summary.x > stakes.x);
      await capture('address-desktop-1440');
    });
    await test('keyboard lifecycle filters and pagination retain exact GA and cancelled states', async () => {
      await keyboardClick(page.getByRole('button', { name: 'Good Accounted 3', exact: true }));
      await page.locator('.stake-desktop tbody tr').first().waitFor();
      assert.equal(await page.locator('.stake-desktop tbody tr').count(), 3);
      await keyboardClick(page.getByRole('button', { name: 'Ended 5', exact: true }));
      await page.getByText('Cancelled', { exact: true }).first().waitFor();
      assert.equal(await page.locator('.stake-desktop tbody tr').count(), 5);
      await keyboardClick(page.getByRole('button', { name: 'Open 24', exact: true }));
      await page.getByRole('button', { name: 'Next page', exact: true }).click();
      await page.getByText('Page 2', { exact: true }).waitFor();
      assert.equal(await page.locator('.stake-desktop tbody tr').count(), 4);
      await page.getByRole('button', { name: 'Previous page', exact: true }).click();
      await page.getByText('Page 1', { exact: true }).waitFor();
    });
    await test('keyboard copy, disclosure and bounded live continuation; reset starts a new observation', async () => {
      await keyboardClick(page.getByRole('button', { name: 'Copy address', exact: true }));
      await page.getByText('Copied', { exact: true }).waitFor();
      assert.equal(await page.evaluate(() => navigator.clipboard.readText()), address);
      await keyboardClick(page.locator('.address-data-details > summary'));
      await page
        .getByText(/Partial page; whole-address stake totals and nearest maturity are not inferred/)
        .waitFor();
      await page.getByRole('button', { name: 'Next pinned page', exact: true }).click();
      await page.getByText(/Showing 7 of 27 current stakes/).waitFor();
      assert.equal(
        await page.locator('[data-metric="address-staked"] .value').innerText(),
        '4.725M',
      );
      await page.getByRole('button', { name: 'Restart current observation', exact: true }).click();
      await page.getByText(/Showing 20 of 27 current stakes/).waitFor();
      await keyboardClick(page.locator('.address-data-details > summary'));
    });
    await test('mobile 390x844 summary precedes compact stake cards; no table or page overflow', async () => {
      await page.setViewportSize({ width: 390, height: 844 });
      await page.evaluate(() => scrollTo(0, 0));
      await page.reload();
      await page.getByRole('button', { name: 'Open 24', exact: true }).waitFor();
      await page.locator('.stake-card').first().waitFor();
      assert.equal(await page.locator('.stake-card').count(), 4);
      assert.equal(await page.locator('.stake-desktop').isVisible(), false);
      assert.ok(
        (await page.locator('.address-summary').boundingBox()).y <
          (await page.locator('.address-stakes').boundingBox()).y,
      );
      await capture('address-mobile-390');
      await page.locator('.address-stakes').scrollIntoViewIfNeeded();
      await capture('address-mobile-stakes-390');
      await page.getByRole('button', { name: 'View all 20 on this page' }).click();
      assert.equal(await page.locator('.stake-card').count(), 20);
      await page.getByRole('button', { name: 'Show fewer' }).click();
      assert.equal(await page.locator('.stake-card').count(), 4);
      await page.setViewportSize({ width: 320, height: 844 });
      await capture('address-mobile-320');
      await page.setViewportSize({ width: 720, height: 500 });
      await capture('address-200-percent-equivalent');
    });
    await test('search # normalization, local persistence, deduplication, clearing and invalid input', async () => {
      await page.getByLabel('Address or stake ID', { exact: true }).fill('#1');
      await keyboardClick(page.getByRole('button', { name: 'Search', exact: true }));
      await page.getByRole('heading', { name: 'Stake 1', exact: true }).waitFor();
      assert.equal(new URL(page.url()).pathname, '/stake/1');
      await page.goto(base + '/search');
      await page
        .getByLabel('Address or stake ID', { exact: true })
        .fill(address.toUpperCase().replace('0X', '0x'));
      await page.getByRole('button', { name: 'Search', exact: true }).click();
      await page.getByRole('button', { name: 'Open 24', exact: true }).waitFor();
      await page.reload();
      await keyboardClick(page.locator('.recent-searches summary'));
      await capture('address-recent-searches');
      assert.deepEqual(
        await page.evaluate(() => JSON.parse(localStorage.getItem('hdd-recent-searches'))),
        [address, '1'],
      );
      await keyboardClick(page.getByRole('button', { name: 'Clear recent searches', exact: true }));
      assert.equal(await page.evaluate(() => localStorage.getItem('hdd-recent-searches')), null);
      await page.getByLabel('Address or stake ID', { exact: true }).fill('#1099511627776');
      await page.getByRole('button', { name: 'Search', exact: true }).click();
      await page.getByRole('alert').waitFor();
    });
    await test('incompatible live cursor hides old values and restarts from the initial endpoint', async () => {
      await go();
      await keyboardClick(page.locator('.address-data-details > summary'));
      await page.route('**/api/v2/addresses/**/stakes?**', (r) =>
        r.fulfill({ status: 409, json: { error: { code: 'cursor_incompatible' } } }),
      );
      await page.getByRole('button', { name: 'Next pinned page', exact: true }).click();
      await page
        .getByText(/Observation changed or expired. Restart to read a new pinned page/)
        .waitFor();
      assert.equal(
        await page.locator('[data-metric="address-liquid"] .value').innerText(),
        'Unavailable',
      );
      await page.unroute('**/api/v2/addresses/**/stakes?**');
      await page.getByRole('button', { name: 'Restart current observation', exact: true }).click();
      await page.getByText(/Showing 20 of 27 current stakes/).waitFor();
    });
    await test('expired live data hides amounts; indexed figures stay independently dated', async () => {
      await go();
      await page.evaluate(() => (window.__testNow += 61000));
      await page.waitForFunction(
        () =>
          document.querySelector('[data-metric="address-liquid"] .value').textContent ===
          'Unavailable',
      );
      assert.equal(
        await page.locator('[data-metric="address-staked"] .value').innerText(),
        '4.725M',
      );
      await keyboardClick(page.locator('.address-data-details > summary'));
      await page.getByText(/Observation changed or expired/).waitFor();
      await capture('address-expired');
      await page.evaluate((at) => (window.__testNow = at), at);
    });
    await test('quota, missing index and stale retry preserve explicit unavailable/dated states', async () => {
      const original = await (
        await fetch(base + '/api/v2/addresses/' + address + '?limit=20')
      ).json();
      await page.route('**/api/v2/addresses/**', (r) =>
        r.fulfill({
          json: { ...original, live: null, outcome: 'quota', reason: 'request_budget_or_deadline' },
        }),
      );
      await go();
      assert.equal(
        await page.locator('[data-metric="address-liquid"] .value').innerText(),
        'Unavailable',
      );
      await keyboardClick(page.locator('.address-data-details > summary'));
      await page.getByText(/provider quota reached/).waitFor();
      await capture('address-quota');
      await page.unroute('**/api/v2/addresses/**');
      await page.route('**/api/v2/addresses/**', (r) =>
        r.fulfill({ json: { ...original, indexed: null } }),
      );
      await page.reload();
      await page.getByText('INDEXED · unavailable', { exact: true }).first().waitFor();
      for (const metric of ['staked', 'shares', 'maturity'])
        assert.equal(
          await page.locator(`[data-metric="address-${metric}"] .value`).innerText(),
          'Unavailable',
        );
      await capture('address-missing-index');
      await page.unroute('**/api/v2/addresses/**');
      await go();
      await page.route('**/api/v2/addresses/**', (r) =>
        r.fulfill({ status: 503, json: { error: { code: 'source_unavailable' } } }),
      );
      await page.locator('.address-feedback button').click();
      await page.getByText(/Last received data remains dated below/).waitFor();
      assert.equal(
        await page.locator('[data-metric="address-liquid"] .value').innerText(),
        'Unavailable',
      );
      await capture('address-stale-retry');
      await page.route('**/api/v2/stakes?**', (r) =>
        r.fulfill({ status: 503, json: { error: { code: 'source_unavailable' } } }),
      );
      await page.reload();
      await page
        .getByText('Data is unavailable. Please try again.', { exact: true })
        .first()
        .waitFor();
      for (const metric of ['liquid', 'staked', 'shares', 'maturity'])
        assert.equal(
          await page.locator(`[data-metric="address-${metric}"] .value`).innerText(),
          'Unavailable',
        );
      assert.equal(await page.locator('.stake-card').count(), 0);
      await capture('address-unavailable');
    });
  } else {
    await test('separate extreme-number and long-ID wrapping journey', async () => {
      await page.route('**/api/v2/addresses/**', async (r) => {
        const response = await r.fetch(),
          body = await response.json();
        body.live.balanceHearts = '9'.repeat(70);
        body.indexed.staking.lockedHearts = '9'.repeat(70);
        body.indexed.staking.accountedShares = '1';
        await r.fulfill({ json: body });
      });
      await page.route('**/api/v2/stakes?**', async (r) => {
        const response = await r.fetch(),
          body = await response.json();
        body.items = body.items.map((s, i) => ({
          ...s,
          stakeId: String(1099511627775 - i),
          principalHearts: '9'.repeat(70),
          stakeShares: '1',
        }));
        await r.fulfill({ json: body });
      });
      await go();
      for (const width of [1440, 390, 320]) {
        await page.setViewportSize({ width, height: width === 1440 ? 1000 : 844 });
        await capture('address-extreme-' + width);
      }
      await keyboardClick(page.locator('.address-data-details > summary'));
      await capture('address-extreme-details');
    });
  }
  assert.deepEqual(errors, []);
  writeFileSync(
    resolve(evidence, 'address-' + scenario + '.json'),
    JSON.stringify(
      {
        status: 'PASS',
        checks,
        errors,
        compiled: true,
        source:
          'synthetic SQL plus raw fixture provider; fault/extreme cases intercepted explicitly',
        liveRequests: 0,
      },
      null,
      2,
    ),
  );
} catch (error) {
  await page.screenshot({ path: resolve(folder, scenario + '-failure.png') }).catch(() => {});
  writeFileSync(
    resolve(evidence, scenario + '-failure.txt'),
    await page.locator('body').innerText(),
  );
  throw error;
} finally {
  await browser.close();
}
