// ONE same-listener combined preview and finite trial. No alternate provider or automatic restart.
import assert from 'node:assert/strict';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { chromium } from 'playwright';
import { createApp } from '../../dist/api/app.js';
import { ProductDailyStore } from '../../dist/services/product-daily/store.js';
import { ProductLiveResponseSchema } from '../../dist/contracts/product-daily.js';
import { protocolValues } from '../../dist/contracts/protocol-daily.js';
import { durableJson } from '../../scripts/market-refresh.mjs';
import { runProtocol as runRefresh } from '../../scripts/protocol-feed.mjs';
if (process.argv.length !== 3 || process.argv[2] !== 'trial') {
  console.log('Explicit trial required; no default requests.');
  process.exit(2);
}
import { charge } from '../market-feed/access-fixture.mjs';
const R = process.env.HDD_TASK_ROOT,
  profilePath = join(R, 'PROTOCOL_PROFILE.json'),
  preflightPath = join(R, 'PREFLIGHT.json'),
  output = join(R, 'session');
const previewRoot = join(R, 'evidence/preview');
assert(R?.endsWith('hex-protocol-daily-refresh-r1'));
await mkdir(previewRoot, { recursive: true });
assert(
  !existsSync(join(previewRoot, 'ADMISSION.json')) && !existsSync(output),
  'Existing preview/trial is a stop',
);
const result = {
  status: 'RUNNING',
  baseReaderAdmissions: 0,
  requests: 0,
  refusedBackgroundRequests: 0,
  refusedPageRequests: 0,
  screenshots: [],
  apiCalls: [],
  browserErrors: [],
  apiClosed: false,
  browserClosed: true,
  readersClosed: false,
};
let deps,
  app,
  browser,
  timer,
  origin,
  start,
  deadline,
  expired = false;
try {
  const profile = JSON.parse(await readFile(profilePath));
  const reader = new ProductDailyStore(profile.productRoot, profile.pair);
  await reader.load();
  deps = { productDaily: reader, close: async () => {} };
  result.baseReaderAdmissions++;
  app = createApp({
    webRoot: resolve('dist/web'),
    account: { webRoot: resolve('account/dist/ui'), register: async () => {} },
    dependencies: { ...deps, close: undefined },
  });
  const count = () => {
    charge();
    result.requests++;
    assert(Date.now() < deadline, 'Preview 900-second deadline');
  };
  app.addHook('onRequest', async (req) => {
    count();
    if (req.url.startsWith('/api/')) result.apiCalls.push(req.url);
  });
  app.server.on('connect', (_req, socket) => {
    charge();
    result.requests++;
    result.refusedBackgroundRequests++;
    socket.destroy();
  });
  start = Date.now();
  deadline = start + 900000;
  origin = await app.listen({ host: '127.0.0.1', port: 0 });
  await durableJson(join(previewRoot, 'ADMISSION.json'), {
    startedAt: new Date(start).toISOString(),
    deadline: new Date(deadline).toISOString(),
    maximumSeconds: 900,
    origin,
    processId: process.pid,
    baseReaderAdmissions: 1,
  });
  timer = setTimeout(
    () => {
      expired = true;
      void browser?.close();
      void app.close();
    },
    Math.max(1, deadline - Date.now()),
  );
  const get = async (path) => {
    assert(!expired);
    const r = await fetch(origin + path, { signal: AbortSignal.timeout(5000) });
    assert.equal(r.status, 200);
    return { body: await r.json(), etag: r.headers.get('etag'), at: new Date().toISOString() };
  };
  const baseline = await get('/api/v2/live');
  await durableJson(join(previewRoot, 'BASELINE.json'), baseline);
  const held = deps.productDaily.capture();
  result.trial = await runRefresh(
    { mode: 'trial', profilePath, output, preflightPath },
    {
      onBegin: async () => {
        if (expired)
          throw Error('Same-listener preview deadline reached; no further cycle admission');
      },
      onPublished: async (receipt) => {
        if (expired)
          return {
            status: 'UNAVAILABLE',
            reason: 'Preview 900-second limit reached',
            observedAtUtc: receipt.observedAtUtc,
          };
        let response;
        for (let n = 0; n < 3; n++) {
          response = await get('/api/v2/live');
          if (response.body.datasetVersion === receipt.selected.version) break;
          await delay(1050);
        }
        const live = ProductLiveResponseSchema.parse(response.body);
        assert.equal(
          live.datasetVersion,
          receipt.selected.version,
          'Running API did not adopt selected version',
        );
        const update = JSON.parse(
          await readFile(join(output, `ROUND_${receipt.cycle}_UPDATE.json`)),
        );
        for (const [k, v] of Object.entries(protocolValues(update.readings[0])))
          assert.equal(live[k], v);
        for (const [k, v] of Object.entries(baseline.body.freshness))
          if (!['protocol', 'payout'].includes(k))
            assert.equal(live.freshness[k].observedAtUtc, v.observedAtUtc);
        assert.equal(live.hexPriceUsd, baseline.body.hexPriceUsd);
        assert.equal(live.trackedLiquidityUsd, baseline.body.trackedLiquidityUsd);
        assert.equal(
          Date.parse(live.freshness.protocol.observedAtUtc),
          Date.parse(receipt.observedAtUtc),
        );
        assert.equal(live.freshness.savedState.status, 'stale');
        assert.equal(
          held.version,
          baseline.body.datasetVersion,
          'Old held generation remains stable',
        );
        const at = new Date().toISOString(),
          age = (Date.parse(at) - Date.parse(receipt.observedAtUtc)) / 1000;
        const adoption = {
          status: 'ADOPTED',
          adoptedAt: at,
          ageSeconds: age,
          fresh: age <= 300,
          processId: process.pid,
          origin,
          api: response,
          heldGeneration: held.version,
        };
        console.log(
          JSON.stringify({
            cycle: receipt.cycle,
            publication: receipt.selected.version,
            adoptionAgeSeconds: age,
            fresh: age <= 300,
          }),
        );
        return adoption;
      },
    },
  );
  if (!expired) {
    const live = await get('/api/v2/live'),
      home = await get('/api/v2/home');
    assert.equal(home.body.datasetVersion, live.body.datasetVersion);
    const end = deps.productDaily.capture().metadata.through,
      begin = new Date(Date.parse(end) - 89 * 86400000).toISOString().slice(0, 10);
    const daily = await get(
      '/api/v2/daily?from=' + begin + '&to=' + end + '&metric=dailyPayoutHEX',
    );
    assert.equal(home.body.live.tshareRateHEX, live.body.tshareRateHEX);
    await durableJson(join(previewRoot, 'FINAL_API.json'), { live, home, daily });
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
    result.browserClosed = false;
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
    async function shoot(name) {
      assert(Date.now() < deadline);
      assert(result.screenshots.length < 4);
      assert(
        await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1),
        'Horizontal overflow',
      );
      await page.screenshot({ path: join(previewRoot, name) });
      result.screenshots.push(name);
    }
    await page.goto(origin + '/');
    await page.getByTestId('protocol-availability').waitFor();
    await page
      .getByTestId('protocol-availability')
      .evaluate((el) => el.scrollIntoView({ block: 'start' }));
    await shoot('01-protocol-desktop.png');
    await page.goto(origin + '/daily?from=' + begin + '&to=' + end + '&metric=dailyPayoutHEX');
    await page.locator('[data-testid="daily-product"][data-ready="true"]').waitFor();
    await shoot('02-daily-payout-desktop.png');
    await page.goto(origin + '/daily?from=' + begin + '&to=' + end + '&metric=trackedLiquidityUsd');
    await page.locator('[data-testid="daily-product"][data-ready="true"]').waitFor();
    await shoot('03-unchanged-liquidity-desktop.png');
    await page.setViewportSize({ width: 390, height: 1000 });
    await page.goto(origin + '/');
    await page.getByTestId('protocol-availability').waitFor();
    await page
      .getByTestId('protocol-availability')
      .evaluate((el) => el.scrollIntoView({ block: 'start' }));
    await shoot('04-protocol-mobile.png');
    assert.deepEqual(result.browserErrors, []);
    assert.equal(result.refusedPageRequests, 0);
    assert(
      result.apiCalls.every((p) => !/[?&](source|view|series|generation|datasetVersion)=/.test(p)),
    );
    await context.close();
  }
  const adopted = result.trial.publications.filter((p) => p.adoption?.status === 'ADOPTED');
  result.repeatableRefreshPass = new Set(adopted.map((p) => p.selected.version)).size >= 2;
  result.freshDeliveryPass = adopted.some((p) => p.adoption.fresh);
  result.status =
    result.trial.status === 'COMPLETE_FINITE_TRIAL' && result.repeatableRefreshPass
      ? 'PASS'
      : 'PARTIAL';
} catch (e) {
  result.status = 'PARTIAL';
  result.error = e.stack;
  console.error(e.stack);
} finally {
  clearTimeout(timer);
  if (browser) {
    await browser.close();
    result.browserClosed = true;
  }
  if (app) {
    await app.close();
    result.apiClosed = true;
  }
  if (deps) {
    await deps.close();
    result.readersClosed = true;
  }
  result.completedAt = new Date().toISOString();
  result.previewSeconds = start ? (Date.now() - start) / 1000 : null;
  result.previewExpired = expired;
  await durableJson(join(previewRoot, 'RESULT.json'), result);
}
console.log(
  JSON.stringify({
    status: result.status,
    repeatableRefreshPass: result.repeatableRefreshPass,
    freshDeliveryPass: result.freshDeliveryPass,
    apiClosed: result.apiClosed,
    readersClosed: result.readersClosed,
  }),
);
process.exitCode = result.status === 'PASS' ? 0 : 2;
