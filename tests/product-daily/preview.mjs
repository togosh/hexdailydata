// One bounded preview of the actual composed candidate. Literal loopback only.
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { mkdir, writeFile, readFile } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { createHash } from 'node:crypto';
import { chromium } from 'playwright';
import { createApp } from '../../dist/api/app.js';
import { sourceUnits } from '../../dist/contracts/source-stakes.js';
import { charge, root } from './access-fixture.mjs';
export async function preview(deps, bundle) {
  const out = join(root, 'evidence/preview');
  await mkdir(out, { recursive: true });
  assert(!existsSync(join(out, 'ADMISSION.json')), 'One preview only');
  const start = Date.now(),
    deadline = start + 900000;
  await writeFile(
    join(out, 'ADMISSION.json'),
    JSON.stringify({
      startedAt: new Date(start).toISOString(),
      maximumSeconds: 900,
      externalRequests: 0,
    }) + '\n',
    { flag: 'wx' },
  );
  const result = {
    status: 'RUNNING',
    requests: 0,
    refusedBackgroundRequests: 0,
    refusedPageRequests: 0,
    apiCalls: [],
    browserErrors: [],
    screenshots: [],
    appClosed: false,
    browserClosed: false,
  };
  const holder = bundle.changes.tokenHolders.find(
      (e) => e.before && e.after.holderAddress !== '0x' + '0'.repeat(40),
    ),
    stake = bundle.changes.stakeStarts.find(
      (e) => e.before && !e.before.stakeEnd && e.after.stakeEnd,
    ),
    newStake = bundle.changes.stakeStarts.find((e) => !e.before);
  let app, browser, timer;
  const count = () => {
    charge();
    result.requests++;
    assert(Date.now() < deadline);
  };
  try {
    app = createApp({
      webRoot: resolve('dist/web'),
      account: { webRoot: resolve('account/dist/ui'), register: async () => {} },
      dependencies: { ...deps, close: undefined },
    });
    app.addHook('onRequest', async (req) => {
      count();
      if (req.url.startsWith('/api/')) result.apiCalls.push(req.url);
    });
    const address = await app.listen({ host: '127.0.0.1', port: 0 }),
      origin = new URL(address).origin;
    app.server.on('connect', (_req, socket) => {
      count();
      result.refusedBackgroundRequests++;
      socket.destroy();
    });
    const executable = [
      chromium.executablePath(),
      'C:/Program Files/Google/Chrome/Application/chrome.exe',
      'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
    ].find(existsSync);
    assert(executable);
    result.browser = executable;
    browser = await chromium.launch({
      headless: true,
      executablePath: executable,
      proxy: { server: origin, bypass: '127.0.0.1' },
      env: { SystemRoot: process.env.SystemRoot, TEMP: process.env.TEMP, TMP: process.env.TMP },
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
    timer = setTimeout(
      () => {
        void browser?.close();
        void app?.close();
      },
      Math.max(1, deadline - Date.now()),
    );
    const context = await browser.newContext({
      viewport: { width: 1440, height: 1000 },
      serviceWorkers: 'block',
    });
    await context.route('**/*', async (route) => {
      const u = new URL(route.request().url());
      if (u.origin !== origin || u.protocol !== 'http:') {
        count();
        result.refusedPageRequests++;
        await route.abort();
      } else await route.continue();
    });
    await context.routeWebSocket('**/*', (ws) => {
      count();
      result.refusedPageRequests++;
      ws.close();
    });
    const page = await context.newPage();
    page.on('pageerror', (e) => result.browserErrors.push(e.message));
    const main = page.locator('main');
    const goto = async (path) => page.goto(origin + path, { waitUntil: 'domcontentloaded' });
    const dailyReady = () =>
      page.locator('[data-testid="daily-product"][data-ready="true"]').waitFor({ timeout: 30000 });
    const listReady = () =>
      page
        .locator('[data-testid="source-stake-list"][data-ready="true"]')
        .waitFor({ timeout: 15000 });
    const noOverflow = async () =>
      assert(
        await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1),
        'Horizontal overflow',
      );
    const shoot = async (name) => {
      assert(result.screenshots.length < 6);
      await noOverflow();
      await page.screenshot({ path: join(out, name) });
      result.screenshots.push(name);
    };
    const noPickers = async () => {
      assert.equal(
        await page
          .locator(
            'select[aria-label="Stake source"],option[value="base"],option[value="hds-archive"],option[value="contract-ledger"]',
          )
          .count(),
        0,
      );
    };
    await goto('/');
    await page.getByTestId('live-product').waitFor();
    assert((await main.innerText()).includes('stale'));
    assert((await main.innerText()).includes('Unavailable'));
    await shoot('01-home-stale-desktop.png');
    await goto('/daily?from=2020-01-01&to=2020-12-31&metric=circulatingHEX');
    await dailyReady();
    await noPickers();
    const cell = page.locator('[data-exact]').first(),
      expected = deps.productDaily
        .capture()
        .rows.find((r) => r.dateUtc === '2020-01-01').circulatingHEX;
    assert.equal(await cell.getAttribute('data-exact'), expected);
    assert.equal(await cell.getAttribute('title'), expected);
    const titles = await page.locator('.dashboard-graph title').allTextContents();
    assert(titles.some((t) => t.includes(expected)));
    await shoot('02-daily-statistics-desktop.png');
    await goto('/daily?from=2019-12-03&to=2026-10-07&metric=payoutPerTshareHEX');
    await dailyReady();
    assert((await main.innerText()).includes('Unavailable'));
    await shoot('03-ledger-payout-desktop.png');
    await goto('/daily?from=2019-12-03&to=2026-10-07&metric=hexPriceUsd');
    await dailyReady();
    assert((await main.innerText()).includes('Ethereum-origin'));
    assert((await main.innerText()).includes('2023'));
    await shoot('04-primary-price-desktop.png');
    await page.setViewportSize({ width: 390, height: 844 });
    await goto('/daily?from=2024-01-01&to=2024-12-31&metric=totalTshares');
    await dailyReady();
    await noPickers();
    await shoot('05-daily-controls-mobile.png');
    await goto('/search?view=holders&source=subgraph&generation=base');
    await page
      .locator('[data-testid="source-holder-list"][data-ready="true"]')
      .waitFor({ timeout: 15000 });
    await noPickers();
    assert(!new URL(page.url()).searchParams.has('generation'));
    assert(!new URL(page.url()).searchParams.has('source'));
    assert.equal(new URL(page.url()).searchParams.get('kind'), 'holders');
    await goto('/address/' + holder.after.holderAddress);
    await listReady();
    const balance = page.getByTestId('source-holder-balance').locator('.holder-balance');
    assert.equal(await balance.getAttribute('title'), sourceUnits(holder.after.tokenBalance, 8));
    await shoot('06-saved-address-mobile.png');
    await goto('/stake/' + stake.after.stakeId);
    await page.getByTestId('source-stake-detail').waitFor();
    assert((await main.innerText()).includes('End link: present'));
    await noOverflow();
    await goto('/stake/' + newStake.after.stakeId);
    await page.getByTestId('source-stake-detail').waitFor();
    await noPickers();
    await goto('/live');
    await page.getByTestId('live-product').waitFor();
    await main.getByRole('button', { name: 'Refresh local view' }).click();
    await page.getByTestId('live-product').waitFor();
    assert((await main.innerText()).includes('stale'));
    assert(
      result.apiCalls.every(
        (path) =>
          !/[?&](?:source|view|series|generation|datasetVersion|holderDatasetVersion)=/.test(path),
      ),
    );
    assert.deepEqual(result.browserErrors, []);
    assert.equal(result.refusedPageRequests, 0);
    result.status = 'PASS';
    await context.close();
  } catch (e) {
    result.status = 'FAIL';
    result.error = e.stack;
    throw e;
  } finally {
    clearTimeout(timer);
    if (browser) {
      await browser.close();
      result.browserClosed = true;
    }
    if (app) {
      await app.close();
      result.appClosed = true;
    }
    result.seconds = (Date.now() - start) / 1000;
    result.completedAt = new Date().toISOString();
    result.identities = {};
    for (const name of result.screenshots) {
      const b = await readFile(join(out, name));
      result.identities[name] = {
        bytes: b.length,
        sha256: createHash('sha256').update(b).digest('hex'),
      };
    }
    await writeFile(join(out, 'RESULT.json'), JSON.stringify(result, null, 2) + '\n', {
      flag: 'wx',
    });
  }
  return result;
}
