// Host browser/load generation only. SQL/ranking/decoding/export work stays in containers.
import assert from 'node:assert/strict';
import http from 'node:http';
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { setTimeout as pause } from 'node:timers/promises';
import { chromium, firefox, webkit } from 'playwright';
const [base, evidence] = process.argv.slice(2);
assert.match(base, /^http:\/\/127\.0\.0\.1:\d+$/);
const control = JSON.parse(
  readFileSync(join(evidence, 'source environment/input/control.json'), 'utf8'),
);
const start = Date.now(),
  duration = 600000,
  rows = [],
  browsers = [],
  errors = [],
  agents = [];
const visitorPacingMs = 4000;
const connections = [];
const connectionTimer = setInterval(
  () =>
    connections.push({
      at: Date.now(),
      sockets: agents
        .slice(0, 50)
        .reduce(
          (n, a) =>
            n +
            [...Object.values(a.sockets), ...Object.values(a.freeSockets)].reduce(
              (sum, s) => sum + s.length,
              0,
            ),
          0,
        ),
    }),
  5000,
);
const bulkAddress = (i) => '0x' + (1000000n + BigInt(i)).toString(16).padStart(40, '0');
const clock = () => control.epoch + Date.now() - control.started;
const p95 = (values) => [...values].sort((a, b) => a - b)[Math.ceil(values.length * 0.95) - 1];
async function request(path, agent, kind, timeout = 15000) {
  const at = performance.now(),
    startedAt = Date.now();
  return new Promise((resolve) => {
    const req = http.get(base + path, { agent }, (res) => {
      const parts = [];
      let bytes = 0;
      res.on('data', (part) => {
        bytes += part.length;
        if (bytes <= 2 * 1024 * 1024) parts.push(part);
      });
      res.on('end', () => {
        let body;
        try {
          body = JSON.parse(Buffer.concat(parts));
        } catch {}
        const row = {
          kind,
          startedAt,
          path: path.split('?')[0],
          at: Date.now(),
          ms: performance.now() - at,
          status: res.statusCode,
          bytes,
        };
        if (path === '/api/v2/home')
          row.freshness = {
            native: body?.current?.asOf,
            sync: body?.sync,
            metrics: Object.fromEntries(
              Object.entries(body?.live ?? {}).map(([key, value]) => [
                key,
                {
                  status: value.status,
                  asOf: value.asOf,
                  observedAt: value.observedAt,
                  value: value.value,
                },
              ]),
            ),
          };
        if (kind.startsWith('address'))
          Object.assign(row, {
            outcome: body?.outcome,
            indexed: !!body?.indexed,
            current: !!body?.live && Date.parse(body.live.expiresAt) > clock(),
            items: body?.live?.page.items.length ?? 0,
            complete: body?.live?.page.enumerationComplete ?? false,
          });
        rows.push(row);
        resolve(body);
      });
    });
    req.setTimeout(timeout, () => req.destroy(new Error('load timeout')));
    req.on('error', (e) => {
      rows.push({ kind, startedAt, at: Date.now(), ms: performance.now() - at, error: e.message });
      resolve(null);
    });
  });
}
const routes = [
  '/api/v2/home',
  '/api/v2/charts/native',
  '/api/v2/holders?limit=50',
  '/api/v2/stakes?limit=50',
  '/api/v2/status',
  '/api/v2/downloads',
];
const visitors = Array.from({ length: 50 }, (_, i) =>
  (async () => {
    const agent = new http.Agent({ keepAlive: true, maxSockets: 1 });
    agents.push(agent);
    await pause(i * 100);
    for (let turn = 0; Date.now() - start < duration; turn++) {
      const began = Date.now();
      await request(routes[(i + turn) % routes.length], agent, 'visitor-' + i);
      await pause(Math.max(0, visitorPacingMs - (Date.now() - began)));
    }
  })(),
);
const addresses = (async () => {
  // These six-second cold lookups exceed the server's five-second keepalive.
  // Use fresh connections; only the fifty visitor sessions stay connected.
  const agent = new http.Agent({ keepAlive: false, maxSockets: 2 });
  agents.push(agent);
  const pending = [];
  for (let i = 0; i < duration / 6000; i++) {
    await pause(Math.max(0, start + i * 6000 - Date.now()));
    // Distinct ordinary 0/1/2-stake accounts; deadline overlaps are counted, never hidden.
    pending.push(
      request('/api/v2/addresses/' + bulkAddress(12000 + i) + '?limit=100', agent, 'address-cold'),
    );
  }
  await Promise.all(pending);
})();
const slowReader = (async () => {
  await pause(Math.max(0, start + 110000 - Date.now()));
  const catalog = await request('/api/v2/downloads', undefined, 'reader-catalog');
  const bundle = catalog?.bundles.find((b) => b.slot === 'current');
  assert.ok(bundle, 'Published file required for overlapping reader');
  const path = '/api/v2/downloads/' + bundle.id + '/stakes';
  const response = await new Promise((resolve, reject) =>
    http.get(base + path, resolve).on('error', reject),
  );
  response.on('error', () => {});
  assert.equal(response.statusCode, 200);
  response.pause();
  const began = Date.now();
  await pause(70000);
  const bufferedBytes = response.readableLength;
  response.destroy();
  const head = await fetch(base + path, { method: 'HEAD' });
  const cached = await fetch(base + path, {
    headers: { 'if-none-match': head.headers.get('etag') },
  });
  assert.equal(head.status, 200);
  assert.equal(cached.status, 304);
  writeFileSync(
    join(evidence, 'slow-reader.json'),
    JSON.stringify(
      {
        began,
        ended: Date.now(),
        bundle: bundle.id,
        status: response.statusCode,
        bufferedBytes,
        disconnected: true,
        head: head.status,
        cached: cached.status,
      },
      null,
      2,
    ),
  );
})();
const browserRun = (async () => {
  const browser = await chromium.launch({
    channel: process.env.HDD_V2_BROWSER_CHANNEL ?? 'chrome',
  });
  const samples = [];
  mkdirSync(join(evidence, 'screenshots'), { recursive: true });
  try {
    // Readiness wait is disclosed, outside individual fresh-document navigation timing.
    let ready = false;
    for (let i = 0; i < 150; i++) {
      const h = await request('/api/v2/home', undefined, 'browser-readiness');
      if (
        h?.live?.price.status === 'fresh' &&
        h.live.shareRate.status === 'fresh' &&
        h.live.latestCompletedPayout.status === 'fresh'
      ) {
        ready = true;
        break;
      }
      await pause(1000);
    }
    const readinessWaitMs = Date.now() - start;
    for (let i = 0; i < 11; i++) {
      const context = await browser.newContext({
        viewport: { width: 390, height: 844 },
        deviceScaleFactor: 1,
        reducedMotion: 'reduce',
      });
      const page = await context.newPage();
      page.on('pageerror', (e) => errors.push(e.message));
      await page.route('**/*', (route) =>
        route
          .request()
          .url()
          .startsWith(base + '/')
          ? route.continue()
          : route.abort(),
      );
      await page.addInitScript(({ epoch, started }) => {
        const Original = Date;
        window.Date = class extends Original {
          constructor(...args) {
            super(...(args.length ? args : [epoch + Original.now() - started]));
          }
          static now() {
            return epoch + Original.now() - started;
          }
        };
        window.__paint = {};
        const observe = () => {
          for (const [name, selector] of [
            ['headlines', '[data-testid="headlines"][data-ready="true"]'],
            ['chart', '[data-testid="history-chart"][data-ready="true"] svg circle'],
          ]) {
            if (!window.__paint[name + 'Pending'] && document.querySelector(selector)) {
              window.__paint[name + 'Pending'] = true;
              requestAnimationFrame(() =>
                requestAnimationFrame(() => (window.__paint[name] = performance.now())),
              );
            }
          }
        };
        new MutationObserver(observe).observe(document, {
          subtree: true,
          attributes: true,
          childList: true,
        });
      }, control);
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
      await page.goto(base);
      try {
        await page.waitForFunction(
          () => window.__paint.headlines && window.__paint.chart,
          {},
          { timeout: 15000 },
        );
      } catch {}
      const sample = await page.evaluate(() => ({
        paint: window.__paint,
        navigation: performance.getEntriesByType('navigation')[0].toJSON(),
        waterfall: performance.getEntriesByType('resource').map((r) => r.toJSON()),
        values: [...document.querySelectorAll('[data-metric] dd')].map((e) => e.textContent),
        circles: document.querySelectorAll('[data-testid="history-chart"] svg circle').length,
      }));
      samples.push(sample);
      writeFileSync(join(evidence, `cold-${i + 1}.json`), JSON.stringify(sample, null, 2));
      if (i === 0) await page.screenshot({ path: join(evidence, 'screenshots/cold-home.png') });
      await context.close();
    }
    const context = await browser.newContext({
        viewport: { width: 390, height: 844 },
        reducedMotion: 'reduce',
      }),
      page = await context.newPage();
    let chartsMeasurement;
    await page.route('**/*', (r) =>
      r
        .request()
        .url()
        .startsWith(base + '/')
        ? r.continue()
        : r.abort(),
    );
    for (const route of [
      '/charts',
      '/address/' + bulkAddress(1),
      '/calculator',
      '/downloads',
      '/learn',
      '/status',
    ]) {
      const at = performance.now();
      await page.goto(base + route);
      await page.locator('h1').waitFor();
      if (route === '/charts') {
        await page.locator('[data-chart="price"][data-ready="true"] svg').waitFor();
        await page.evaluate(
          () => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r))),
        );
        const landingMs = performance.now() - at;
        const deferredStart = performance.now();
        await page
          .getByRole('region', { name: 'Staking charts', exact: true })
          .scrollIntoViewIfNeeded();
        const card = page.locator('[data-chart="maturities"]');
        await card.waitFor();
        await page.waitForFunction(() => {
          const card = document.querySelector('[data-chart="maturities"]');
          return card && !card.textContent.includes('Loading');
        });
        chartsMeasurement = {
          landingMs,
          deferredMaturityMs: performance.now() - deferredStart,
          maturityAvailable: (await card.getAttribute('data-ready')) === 'true',
          maturityText: await card.innerText(),
          requests: await page.evaluate(() =>
            performance
              .getEntriesByType('resource')
              .filter((r) => r.name.includes('/api/v2/charts/'))
              .map((r) => r.toJSON()),
          ),
          profile:
            'One unthrottled mobile diagnostic after cold Home samples; representative SQL, mixed load. Not a p95.',
        };
      }
      await page.screenshot({
        path: join(evidence, 'screenshots/' + route.split('/')[1] + '.png'),
      });
      browsers.push({
        route,
        ms: performance.now() - at,
        heading: await page.locator('h1').textContent(),
        overflow: await page.evaluate(() => document.documentElement.scrollWidth > innerWidth),
      });
    }
    await context.close();
    writeFileSync(
      join(evidence, 'browser.json'),
      JSON.stringify(
        {
          browser: browser.version(),
          readinessWaitMs,
          ready,
          samples: samples.map((s) => ({
            headlines: s.paint.headlines ?? null,
            chart: s.paint.chart ?? null,
            circles: s.circles,
          })),
          headlineP95: samples.every((s) => s.paint.headlines)
            ? p95(samples.map((s) => s.paint.headlines))
            : null,
          chartP95: samples.every((s) => s.paint.chart)
            ? p95(samples.map((s) => s.paint.chart))
            : null,
          profile:
            '11 fresh 390x844 documents, disabled cache, 150ms RTT, 10/1.5 Mbps, 4x CPU; SQL warm; mixed load',
          browsers,
          chartsMeasurement,
          errors,
        },
        null,
        2,
      ),
    );
  } finally {
    await browser.close();
  }
})();
try {
  const outcomes = await Promise.allSettled([...visitors, addresses, browserRun, slowReader]);
  const failed = outcomes.find((r) => r.status === 'rejected');
  if (failed) throw failed.reason;
  await pause(12000);
  const agent = new http.Agent({ keepAlive: false, maxSockets: 1 });
  agents.push(agent);
  let cursor;
  for (let i = 0; i < 6; i++) {
    const result = await request(
      '/api/v2/addresses/' +
        bulkAddress(1) +
        '?limit=100' +
        (cursor ? '&cursor=' + encodeURIComponent(cursor) : ''),
      agent,
      'address-heavy',
    );
    cursor = result?.live?.page.nextCursor ?? cursor;
    await pause(10000);
  }
  const otherBrowsers = [];
  for (const [name, engine] of [
    ['firefox', firefox],
    ['webkit', webkit],
  ]) {
    let browser;
    try {
      browser = await engine.launch();
      const page = await browser.newPage();
      await page.route('**/*', (r) =>
        r
          .request()
          .url()
          .startsWith(base + '/')
          ? r.continue()
          : r.abort(),
      );
      await page.goto(base + '/learn');
      await page.getByRole('heading', { name: 'Learn HEX', exact: true }).waitFor();
      otherBrowsers.push({ name, status: 'PASS', version: browser.version() });
    } catch (e) {
      otherBrowsers.push({ name, status: 'NOT_RUN', reason: e.message.split('\n')[0] });
    } finally {
      await browser?.close();
    }
  }
  writeFileSync(
    join(evidence, 'load.json'),
    JSON.stringify(
      {
        startedAt: start,
        ordinaryDurationMs: duration,
        durationMs: Date.now() - start,
        visitors: 50,
        visitorPacingMs,
        connectedVisitorSockets: connections,
        newAddressesPerMinute: 10,
        distinctOrdinaryAddresses: duration / 6000,
        heavyPhase:
          'six 100-item continuation attempts, 10s pause; separate from 10-minute ordinary traffic',
        rows,
        otherBrowsers,
      },
      null,
      2,
    ),
  );
} finally {
  clearInterval(connectionTimer);
  for (const agent of agents) agent.destroy();
}
