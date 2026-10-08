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
export async function preview(deps, finishMobile = false, correctionOrdinal = 1) {
  const out = join(root, 'evidence/preview');
  await mkdir(out, { recursive: true });
  const admission = finishMobile ? JSON.parse(await readFile(join(out, 'ADMISSION.json'))) : null;
  const previous = finishMobile ? JSON.parse(await readFile(join(out, 'RESULT.json'))) : null;
  if (finishMobile) {
    assert(!existsSync(join(out, '04-home-mobile.png')), 'Final mobile view already captured');
    assert.equal(previous.status, 'FAIL');
    assert.equal(previous.screenshots.length, 3);
    assert.equal(previous.appClosed, true);
    assert.equal(previous.browserClosed, true);
    assert(previous.error.includes('Horizontal overflow'));
  } else assert(!existsSync(join(out, 'ADMISSION.json')), 'One preview only');
  const start = admission ? Date.parse(admission.startedAt) : Date.now(),
    deadline = start + 600000;
  assert(Date.now() < deadline, 'Original preview deadline');
  if (!finishMobile)
    await writeFile(
      join(out, 'ADMISSION.json'),
      JSON.stringify({
        startedAt: new Date(start).toISOString(),
        maximumSeconds: 600,
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
    screenshots: previous?.screenshots ?? [],
    appClosed: false,
    browserClosed: false,
  };
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
    const noOverflow = async () => {
      const geometry = await page.evaluate(() => ({
        width: innerWidth,
        scroll: document.documentElement.scrollWidth,
        outside: [...document.querySelectorAll('body *')]
          .map((e) => ({
            tag: e.tagName,
            cls: e.className,
            text: e.textContent?.slice(0, 90),
            right: e.getBoundingClientRect().right,
            width: e.getBoundingClientRect().width,
          }))
          .filter((e) => e.right > innerWidth + 1)
          .slice(0, 30),
      }));
      assert(
        geometry.scroll <= geometry.width + 1,
        'Horizontal overflow: ' + JSON.stringify(geometry),
      );
    };
    const shoot = async (name) => {
      assert(result.screenshots.length < 4);
      assert(!existsSync(join(out, name)), 'Preserve existing screenshot');
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
    if (!finishMobile) {
      await goto('/');
      await page.getByTestId('live-product').waitFor();
      await noPickers();
      assert((await main.innerText()).includes('stale'));
      assert((await main.innerText()).includes('Unavailable'));
      await shoot('01-home-desktop.png');
      await page
        .getByRole('heading', { name: 'Tracked HEX liquidity (USD estimate)', exact: true })
        .scrollIntoViewIfNeeded();
      await shoot('02-liquidity-history-desktop.png');
      const snapshot = deps.productDaily.capture();
      const end = snapshot.metadata.through;
      const begin = new Date(Date.parse(end) - 89 * 86400000).toISOString().slice(0, 10);
      await goto('/daily?from=' + begin + '&to=' + end + '&metric=trackedLiquidityUsd');
      await dailyReady();
      await noPickers();
      await shoot('03-daily-liquidity-desktop.png');
    }
    await page.setViewportSize({ width: 390, height: 844 });
    await goto('/');
    await page.getByTestId('live-product').waitFor();
    await noPickers();
    await page.getByTestId('live-product').scrollIntoViewIfNeeded();
    await shoot('04-home-mobile.png');
    await goto('/live');
    await page.getByTestId('live-product').waitFor();
    await main.getByRole('button', { name: 'Refresh local view' }).click();
    await page.getByTestId('live-product').waitFor();
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
    result.previousResult = finishMobile ? 'RESULT.json' : null;
    result.originalDeadlineRetained = finishMobile;
    await writeFile(
      join(out, finishMobile ? 'CORRECTION_' + correctionOrdinal + '_RESULT.json' : 'RESULT.json'),
      JSON.stringify(result, null, 2) + '\n',
      {
        flag: 'wx',
      },
    );
  }
  return result;
}
