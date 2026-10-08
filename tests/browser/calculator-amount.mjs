// Synthetic loopback calculator checks and reusable LAB-ONLY static fixture server.
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { resolve, extname, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { HomeResponseSchema } from '../../src/contracts/api.ts';
import { CalculatorResponseSchema } from '../../src/contracts/reads.ts';

export const fixture = JSON.parse(
  readFileSync(new URL('./calculator-amount-fixture.json', import.meta.url)),
);
HomeResponseSchema.parse(fixture.home);
CalculatorResponseSchema.parse(fixture.calculator);
export const previewMarker = 'Synthetic preview data — not live HEX prices.';
export function fixtureResponses(selection = 'fresh', at = fixture.at) {
  const home = structuredClone(fixture.home),
    calculator = structuredClone(fixture.calculator);
  const current = new Date(at).toISOString();
  for (const obs of Object.values(home.live)) {
    obs.observedAt = current;
    obs.asOf.blockTimestamp = current;
  }
  calculator.shareRate.observedAt = current;
  calculator.shareRate.asOf.blockTimestamp = current;
  if (selection === 'stale') {
    home.live.price.status = 'stale';
    home.live.price.observedAt = home.live.price.asOf.blockTimestamp = new Date(
      at - 121000,
    ).toISOString();
  }
  HomeResponseSchema.parse(home);
  CalculatorResponseSchema.parse(calculator);
  return { home, calculator };
}
export async function startFixtureServer({
  webRoot,
  selection = 'fresh',
  port = 0,
  liveClock = false,
}) {
  assert.ok(['fresh', 'stale', 'unavailable'].includes(selection));
  const web = resolve(webRoot),
    apiRequests = [],
    rejected = [];
  const server = createServer((req, res) => {
    const fail = (status, message) => {
      res.writeHead(status, { 'Content-Type': 'application/json' });
      res.end(
        req.method === 'HEAD'
          ? ''
          : JSON.stringify({ error: { code: 'synthetic_unavailable', message } }),
      );
    };
    if (!['127.0.0.1', '::ffff:127.0.0.1'].includes(req.socket.remoteAddress))
      return fail(403, 'Loopback only');
    const host = `127.0.0.1:${server.address().port}`;
    if (req.headers.host !== host) return fail(403, 'Local host required');
    if (!['GET', 'HEAD'].includes(req.method)) return fail(405, 'GET/HEAD only');
    let path;
    try {
      const raw = decodeURIComponent(req.url.split('?')[0]);
      if (raw.includes('..') || raw.includes('\\') || raw.includes('\0'))
        return fail(403, 'Unsafe path');
      path = new URL(req.url, `http://${host}`).pathname;
    } catch {
      return fail(400, 'Invalid path');
    }
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader(
      'Content-Security-Policy',
      "default-src 'self'; connect-src 'self'; img-src 'self' data:; style-src 'self' 'unsafe-inline'; script-src 'self'; object-src 'none'; base-uri 'none'",
    );
    if (path.startsWith('/api/')) {
      apiRequests.push(req.url);
      const data = fixtureResponses(selection, liveClock ? Date.now() : fixture.at);
      const body =
        path === '/api/v2/calculator/inputs'
          ? data.calculator
          : path === '/api/v2/home' && selection !== 'unavailable'
            ? data.home
            : null;
      if (!body) return fail(503, 'Synthetic preview endpoint unavailable; no upstream exists');
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(req.method === 'HEAD' ? '' : JSON.stringify(body));
      return;
    }
    const file = resolve(web, ['/', '/calculator'].includes(path) ? 'index.html' : '.' + path);
    if (!file.startsWith(web + sep)) {
      rejected.push(path);
      return fail(403, 'Unsafe path');
    }
    const mime = {
      '.html': 'text/html',
      '.js': 'text/javascript',
      '.css': 'text/css',
      '.svg': 'image/svg+xml',
      '.png': 'image/png',
      '.webp': 'image/webp',
      '.ico': 'image/x-icon',
    }[extname(file)];
    if (!mime) return fail(404, 'Synthetic preview path not found');
    try {
      let bytes = readFileSync(file);
      if (extname(file) === '.html')
        bytes = Buffer.from(
          bytes
            .toString()
            .replace(
              '<body>',
              `<body><div role="note" style="background:#fff0ad;color:#362300;padding:10px 14px;font:600 16px/1.4 system-ui;overflow-wrap:anywhere">${previewMarker}</div>`,
            ),
        );
      res.writeHead(200, { 'Content-Type': mime });
      res.end(req.method === 'HEAD' ? '' : bytes);
    } catch {
      fail(404, 'Synthetic preview file not found');
    }
  });
  await new Promise((done, fail) => {
    server.once('error', fail);
    server.listen(port, '127.0.0.1', done);
  });
  return {
    url: `http://127.0.0.1:${server.address().port}`,
    apiRequests,
    rejected,
    close: async () => {
      server.closeAllConnections();
      await new Promise((done) => server.close(done));
    },
  };
}

async function runBrowser() {
  const [output, webRoot = 'dist/web', mode = 'candidate', selection = 'full'] =
    process.argv.slice(2);
  assert.ok(output);
  assert.equal(mode, 'candidate');
  assert.ok(['full', 'review'].includes(selection));
  const folder = resolve(output);
  assert.ok(!existsSync(resolve(folder, 'results.json')), 'Preserve prior evidence');
  mkdirSync(resolve(folder, 'screenshots'), { recursive: true });
  const { chromium } = await import('playwright');
  const server = await startFixtureServer({ webRoot });
  let browser,
    context,
    page,
    failure,
    requests,
    pending,
    held = [],
    marketMode = 'fresh',
    price = '0.01',
    sourceTime = fixture.at;
  const checks = [],
    errors = [],
    offOrigin = [],
    journeys = [],
    cleanup = {};
  const until = async (predicate, label) => {
    for (let i = 0; i < 180; i++) {
      if (await predicate()) return;
      await new Promise((r) => setTimeout(r, 40));
    }
    throw new Error('Timed out: ' + label);
  };
  const share = () => page.locator('.share-result .value');
  const amount = () => page.getByLabel('USD amount', { exact: true });
  const future = () => page.getByLabel('Hypothetical future USD per HEX');
  async function quote(title = '1.200006666666') {
    await until(
      async () =>
        (await share()
          .getAttribute('title')
          .catch(() => null)) === title,
      'automatic exact shares ' + title,
    );
  }
  async function noQuote() {
    assert.equal(await share().count(), 0, 'no stale shares');
    assert.equal(await page.locator('.usd-result .value').count(), 0, 'no stale future value');
  }
  async function settle() {
    await until(() => Promise.resolve(pending.size <= held.length), 'API completed');
    await page.evaluate(
      () => new Promise((done) => requestAnimationFrame(() => requestAnimationFrame(done))),
    );
  }
  async function refresh() {
    await settle();
    const before = requests.length,
      expected = 2 - pending.size;
    await page.evaluate(() => document.dispatchEvent(new Event('visibilitychange')));
    await until(
      () => Promise.resolve(requests.length === before + expected),
      'existing refresh slots',
    );
    await settle();
  }
  async function open({
    width = 390,
    height = 844,
    theme = 'dark',
    storage,
    blockedStorage = false,
    market = 'fresh',
  } = {}) {
    for (const r of held) await r.abort().catch(() => {});
    held = [];
    await context?.close();
    requests = [];
    pending = new Set();
    marketMode = market;
    price = '0.01';
    sourceTime = fixture.at;
    journeys.push({ width, height, theme, market, requests });
    context = await browser.newContext({
      viewport: { width, height },
      deviceScaleFactor: 1,
      reducedMotion: 'reduce',
      serviceWorkers: 'block',
    });
    context.setDefaultTimeout(6000);
    await context.addInitScript(
      ({ theme, storage, blockedStorage }) => {
        localStorage.setItem('hdd-v2-theme', theme);
        if (storage) sessionStorage.setItem('calculator-amount-v1', storage);
        if (blockedStorage)
          Object.defineProperty(window, 'sessionStorage', {
            get() {
              throw new Error('Synthetic blocked storage');
            },
          });
      },
      { theme, storage, blockedStorage },
    );
    await context.route('**/*', async (route) => {
      const u = new URL(route.request().url());
      if (u.origin !== server.url) {
        offOrigin.push(u.href);
        return route.abort();
      }
      if (!u.pathname.startsWith('/api/')) return route.continue();
      requests.push(u.pathname + u.search);
      if (!['/api/v2/home', '/api/v2/calculator/inputs'].includes(u.pathname)) {
        errors.push('Unexpected API ' + u.pathname);
        return route.fulfill({ status: 503, json: { error: { code: 'synthetic_unavailable' } } });
      }
      const isMarket = u.pathname === '/api/v2/home';
      if (isMarket && marketMode === 'hold') {
        held.push(route);
        return;
      }
      if (isMarket && marketMode === 'error')
        return route.fulfill({ status: 503, json: { error: { code: 'synthetic_unavailable' } } });
      const data = fixtureResponses('fresh', sourceTime);
      data.home.live.price.value.usdPerHex = price;
      await route.fulfill({
        json: isMarket
          ? HomeResponseSchema.parse(data.home)
          : CalculatorResponseSchema.parse(data.calculator),
      });
    });
    page = await context.newPage();
    page.on('pageerror', (e) => errors.push(e.message));
    page.on('request', (r) => {
      if (new URL(r.url()).pathname.startsWith('/api/')) pending.add(r);
    });
    page.on('requestfinished', (r) => pending.delete(r));
    page.on('requestfailed', (r) => pending.delete(r));
    await page.clock.install({ time: new Date(fixture.at) });
    await page.goto(server.url + '/calculator');
    await page.locator('.calculator-page').waitFor();
    await until(() => Promise.resolve(requests.length === 2), 'startup pair');
    await settle();
  }
  async function check(name, fn) {
    await fn();
    checks.push(name);
    console.log('PASS', name);
  }
  async function details(open = true) {
    await page.locator('#calculator-assumptions').evaluate((el, open) => {
      el.open = open;
    }, open);
  }
  async function layout() {
    assert.ok(
      await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth),
      'no horizontal reading scroll',
    );
    assert.deepEqual(
      await page
        .locator('.calculator-amount-help,.calculator-amount-error,.amount-unit-toggle')
        .evaluateAll((els) =>
          els
            .filter((el) => {
              if (!el.checkVisibility()) return false;
              const b = el.getBoundingClientRect();
              return b.left < -1 || b.right > innerWidth + 1 || el.scrollWidth > el.clientWidth + 1;
            })
            .map((el) => el.textContent),
        ),
      [],
    );
  }
  async function shot(name) {
    await layout();
    if (selection === 'full')
      await page.screenshot({ path: resolve(folder, 'screenshots', name + '.png') });
  }
  try {
    browser = await chromium.launch({
      channel: process.env.HDD_V2_BROWSER_CHANNEL ?? 'chrome',
      timeout: 15000,
    });
    await check(
      'Automatic initial calculation, stacked panels and compact first view',
      async () => {
        for (const [device, width, height] of [
          ['desktop', 1440, 900],
          ['mobile', 390, 844],
        ]) {
          await open({ width, height });
          await quote();
          assert.equal(await page.getByRole('button', { name: /Calculate/ }).count(), 0);
          const b = await page.locator('.calculator-grid > .panel').evaluateAll((els) =>
            els.map((el) => {
              const b = el.getBoundingClientRect();
              return { x: b.x, y: b.y, width: b.width, bottom: b.bottom };
            }),
          );
          assert.equal(b[0].x, b[1].x);
          assert.equal(b[0].width, b[1].width);
          assert.ok(b[1].y >= b[0].bottom);
          if (device === 'desktop') {
            assert.equal(b[0].width, 896);
            assert.equal(b[0].x, (width - b[0].width) / 2);
          }
          assert.match(
            await page.getByTestId('amount-equivalent').innerText(),
            /Estimated HEX: 10,000\.00/,
          );
          assert.equal(await page.locator('#calculator-assumptions').getAttribute('open'), null);
          const visible = await page.locator('.calculator-page').innerText();
          assert.ok(!visible.includes('Using $'));
          assert.ok(!visible.includes('spot estimate'));
          assert.ok(!visible.includes('fees and slippage'));
          journeys.at(-1).panelBounds = b;
          await page.evaluate(() => scrollTo(0, 0));
          await shot('auto-' + device + '-initial');
        }
      },
    );
    await check(
      'Exact formatted display, grouped edits, canonical drafts and whole-day grouping',
      async () => {
        await open({ width: 1440, height: 900 });
        await quote();
        const days = () => page.getByLabel('Whole days', { exact: true });
        const blur = async () => {
          await page.getByRole('heading', { name: 'Your stake', exact: true }).click();
        };
        assert.equal(await amount().inputValue(), '100.00');
        await amount().focus();
        assert.equal(await amount().inputValue(), '100');
        await blur();
        await quote();
        await amount().fill('1,234.50');
        await blur();
        assert.equal(await amount().inputValue(), '1,234.50');
        await until(
          () =>
            share()
              .count()
              .then((n) => n === 1),
          'formatted amount auto result',
        );
        assert.equal(
          await page.getByTestId('amount-equivalent').innerText(),
          'Estimated HEX: 123,450.00',
        );
        await details();
        assert.equal(
          await page.getByTestId('exact-principal-hearts').innerText(),
          '12345000000000',
        );
        const beforeFocus = await share().getAttribute('title');
        await amount().focus();
        assert.equal(await amount().inputValue(), '1234.50');
        await amount().press('End');
        await amount().press('Backspace');
        await amount().pressSequentially('6');
        await blur();
        assert.equal(await amount().inputValue(), '1,234.56');
        await until(
          () =>
            share()
              .count()
              .then((n) => n === 1),
          'decimal edit auto result',
        );
        assert.equal(
          await page.getByTestId('exact-principal-hearts').innerText(),
          '12345600000000',
        );
        assert.notEqual(await share().getAttribute('title'), beforeFocus);
        await days().fill('5,555');
        await blur();
        assert.equal(await days().inputValue(), '5,555');
        await until(
          () =>
            share()
              .count()
              .then((n) => n === 1),
          'grouped days auto result',
        );
        let record = await page.evaluate(() =>
          JSON.parse(sessionStorage.getItem('calculator-amount-v1')),
        );
        assert.equal(record.days, '5555');
        assert.equal(record.usd, '1234.56');
        await page.reload();
        await until(
          () =>
            share()
              .count()
              .then((n) => n === 1),
          'restored formatted draft quote',
        );
        assert.equal(await amount().inputValue(), '1,234.56');
        assert.equal(await days().inputValue(), '5,555');
        await page.getByRole('button', { name: '1Y', exact: true }).click();
        await amount().fill('100');
        await quote();
        for (const bad of ['1,00', '01,000', '1,234,56', '1.2,3', '1,234.001', '1.']) {
          await amount().fill(bad);
          await blur();
          await noQuote();
          assert.ok(await page.locator('#calculator-error').isVisible());
        }
        await amount().fill('9'.repeat(101));
        await blur();
        await noQuote();
        assert.match(await page.locator('#calculator-error').innerText(), /100 characters/);
        const canonical = '1'.repeat(100),
          grouped = canonical.replace(/\B(?=(\d{3})+(?!\d))/g, ',');
        await amount().fill(grouped);
        assert.equal(await amount().inputValue(), canonical, 'grouped paste is not truncated');
        await noQuote();
        await amount().fill('100');
        await blur();
        await quote();
        await page.getByRole('button', { name: 'HEX', exact: true }).click();
        await quote();
        const hex = () => page.getByLabel('HEX amount', { exact: true });
        assert.equal(await hex().inputValue(), '10,000.00');
        await hex().fill('10,000.12345678');
        await blur();
        await until(
          () =>
            share()
              .count()
              .then((n) => n === 1),
          'exact fractional HEX quote',
        );
        assert.equal(await hex().inputValue(), '10,000.12345678');
        await details();
        assert.equal(await page.getByTestId('exact-principal-hearts').innerText(), '1000012345678');
        await hex().focus();
        await blur();
        assert.equal(await page.getByTestId('exact-principal-hearts').innerText(), '1000012345678');
        record = await page.evaluate(() =>
          JSON.parse(sessionStorage.getItem('calculator-amount-v1')),
        );
        assert.equal(record.hex, '10000.12345678');
        assert.equal(record.usd, '100');
        await page.getByRole('button', { name: 'USD', exact: true }).click();
        await quote();
        assert.equal(await amount().inputValue(), '100.00');
        assert.equal(requests.length, 4, 'only initial and reload request pairs');
      },
    );
    await check(
      '300ms debounce cancels intermediate edits and never publishes invalid or stale results',
      async () => {
        await open({ width: 1440, height: 900 });
        await quote();
        await page.clock.pauseAt(new Date(fixture.at + 10000));
        for (const name of ['USD', '1Y']) {
          await page.getByRole('button', { name, exact: true }).click();
          await quote();
          await page.clock.runFor(350);
          await quote();
        }
        await amount().fill('200');
        await noQuote();
        await page.clock.runFor(100);
        await amount().fill('150');
        await page.clock.runFor(200);
        await noQuote();
        await page.clock.runFor(150);
        await quote('1.800015');
        await amount().fill('200');
        await page.clock.runFor(100);
        await amount().fill('0.001');
        await noQuote();
        await page.clock.runFor(500);
        await noQuote();
        assert.ok(await page.locator('#calculator-error').isVisible());
        await amount().fill('200');
        await page.clock.runFor(350);
        await quote('2.400026666666');
        await future().fill('0');
        await noQuote();
        await page.clock.runFor(350);
        await quote('2.400026666666');
        assert.equal(await page.locator('.usd-result .value').getAttribute('title'), '$0');
        await future().fill('2');
        await page.clock.runFor(350);
        await quote('2.400026666666');
        assert.equal(
          await page.locator('.usd-result .value').getAttribute('title'),
          '$50512.11679999',
        );
        await future().fill('1e2');
        await page.clock.runFor(350);
        await noQuote();
        assert.ok(await page.locator('#calculator-error').isVisible());
        for (const name of ['USD', '1Y']) {
          await page.getByRole('button', { name, exact: true }).click();
          assert.ok(await page.locator('#calculator-error').isVisible());
          await page.clock.runFor(350);
          await noQuote();
          assert.ok(await page.locator('#calculator-error').isVisible());
        }
        await future().fill('2');
        await page.clock.runFor(350);
        await quote('2.400026666666');
        assert.equal(await page.locator('#calculator-error').count(), 0);
        await page.getByLabel('Whole days', { exact: true }).fill('0');
        await page.clock.runFor(350);
        await noQuote();
        assert.ok(await page.locator('#calculator-error').isVisible());
        await page.getByLabel('Whole days', { exact: true }).fill('365');
        await page.clock.runFor(350);
        await quote('2.400026666666');
        assert.equal(requests.length, 2, 'debounce only performs local arithmetic');
        await page.clock.resume();
      },
    );
    await check(
      'Every scenario input and unit updates automatically; exact principal, drafts and persistence stay separate',
      async () => {
        await open();
        await quote();
        await future().fill('2');
        await quote();
        await page.getByRole('button', { name: 'HEX', exact: true }).click();
        await quote();
        assert.equal(
          await page.getByLabel('HEX amount', { exact: true }).inputValue(),
          '10,000.00',
        );
        await page.getByLabel('HEX amount', { exact: true }).fill('20000');
        await quote('2.400026666666');
        await page.getByRole('button', { name: 'USD', exact: true }).focus();
        await page.keyboard.press('Enter');
        await quote();
        assert.equal(await amount().inputValue(), '100.00');
        await details();
        assert.equal(await page.getByTestId('exact-principal-hearts').innerText(), '1000000000000');
        assert.match(
          await page.locator('.calculator-notes-body').innerText(),
          /Spot estimate; fees and slippage excluded. USD peg assumed/,
        );
        await page.getByLabel('Constant daily payout assumption').selectOption('');
        await future().fill('');
        await quote();
        assert.equal(await page.locator('.scenario-values .value').count(), 0);
        await page.getByLabel('Constant daily payout assumption').selectOption('30');
        await future().fill('2');
        await quote();
        assert.equal(
          await page.locator('.usd-result .value').getAttribute('title'),
          '$25256.02919999',
        );
        await page.getByRole('button', { name: 'MAX', exact: true }).click();
        await quote('3.000006666666');
        await page.getByLabel('Whole days', { exact: true }).fill('1');
        await quote('1.000006666666');
        await page.getByLabel('Whole days', { exact: true }).fill('365');
        await quote();
        await page.reload();
        await quote();
        await details();
        assert.equal(await future().inputValue(), '2');
        const record = await page.evaluate(() =>
          JSON.parse(sessionStorage.getItem('calculator-amount-v1')),
        );
        assert.equal(record.hex, '20000');
        assert.equal(record.usd, '100');
        await page.getByRole('button', { name: 'HEX', exact: true }).click();
        await quote('2.400026666666');
        if (selection === 'full') {
          await details(false);
          await page.evaluate(() => scrollTo(0, 0));
          await shot('auto-hex-mobile');
        }
        await open({ blockedStorage: true });
        await quote();
      },
    );
    await check(
      'Current-price changes, errors, retry, expiry and UTC boundary re-evaluate safely without new polling',
      async () => {
        await open();
        await quote();
        await future().fill('2');
        await quote();
        price = '0.02';
        await refresh();
        await quote('0.600001666666');
        assert.match(await page.getByTestId('amount-equivalent').innerText(), /5,000\.00/);
        price = '0.01';
        await refresh();
        await quote();
        marketMode = 'error';
        await refresh();
        await until(
          () =>
            page
              .getByText('Current HEX price unavailable — enter HEX instead.', { exact: true })
              .isVisible(),
          'retained-price error',
        );
        await noQuote();
        marketMode = 'hold';
        await refresh();
        await noQuote();
        await new Promise((r) => setTimeout(r, 400));
        await noQuote();
        for (const route of held) await route.fulfill({ json: fixtureResponses().home });
        held = [];
        marketMode = 'fresh';
        await quote();
        await page.clock.setSystemTime(new Date(fixture.at + 121000));
        await refresh();
        await noQuote();
        assert.ok(
          await page
            .getByText('Current HEX price unavailable — enter HEX instead.', { exact: true })
            .isVisible(),
        );
        await page.getByRole('button', { name: 'HEX', exact: true }).click();
        await quote();
        sourceTime = fixture.at + 121000;
        await refresh();
        await quote();
        await page.getByRole('button', { name: 'USD', exact: true }).click();
        await quote();
        sourceTime = Date.parse('2026-09-19T23:59:59Z');
        await page.clock.setSystemTime(new Date(sourceTime));
        await refresh();
        await quote();
        const previous = await page
          .locator('.stake-inputs .calculator-quote > div')
          .nth(1)
          .locator('dd')
          .innerText();
        sourceTime = Date.parse('2026-09-20T00:00:00Z');
        await page.clock.setSystemTime(new Date(sourceTime));
        await refresh();
        await quote();
        assert.notEqual(
          await page
            .locator('.stake-inputs .calculator-quote > div')
            .nth(1)
            .locator('dd')
            .innerText(),
          previous,
        );
        await open();
        await quote();
        await amount().fill('150');
        await quote('1.800015');
        await future().fill('0');
        await quote('1.800015');
        assert.equal(requests.length, 2);
        await page.clock.fastForward(60000);
        await until(() => Promise.resolve(requests.length === 4), 'unchanged 60s API cadence');
        await refresh();
        assert.equal(requests.length, 6);
        journeys.at(-1).cadence = {
          startup: 2,
          afterEdits: 2,
          after60Seconds: 4,
          afterVisibility: 6,
        };
      },
    );
    if (selection === 'full')
      await check(
        'Narrow/light and enlarged text, visible blocking errors and optional details',
        async () => {
          await open({ market: 'error' });
          await until(() => page.locator('#calculator-error').isVisible(), 'unavailable visible');
          await shot('auto-unavailable-mobile');
          await open({ width: 320, theme: 'light' });
          await amount().fill('0.001');
          await noQuote();
          await shot('auto-narrow-light-error');
          await open({ width: 1440, height: 900 });
          await quote();
          await details();
          await page
            .locator('.calculator-notes-body')
            .evaluate((el) => el.scrollIntoView({ block: 'start' }));
          await shot('auto-details-desktop');
          for (const [width, height, theme, scale] of [
            [390, 844, 'light', 100],
            [1440, 900, 'light', 100],
            [320, 844, 'dark', 100],
            [390, 844, 'light', 200],
            [1440, 900, 'dark', 200],
          ]) {
            await open({ width, height, theme });
            if (scale === 200)
              await page.addStyleTag({ content: 'html {font-size:200% !important;}' });
            await quote();
            await layout();
            await details();
            await layout();
            const last = page.getByRole('button', { name: 'Copy principal hearts', exact: true });
            await last.focus();
            await last.evaluate((el) => el.scrollIntoView({ block: 'center' }));
            assert.ok(
              await last.evaluate((el) => {
                const b = el.getBoundingClientRect(),
                  nav = document.querySelector('.bottom-nav');
                return (
                  b.top >= -1 &&
                  b.bottom <=
                    (getComputedStyle(nav).display === 'none'
                      ? innerHeight
                      : nav.getBoundingClientRect().top) +
                      1
                );
              }),
            );
            journeys.at(-1).textEnlargement = scale;
          }
        },
      );
    assert.deepEqual(errors, []);
    assert.deepEqual(offOrigin, []);
    assert.deepEqual(server.apiRequests, []);
  } catch (e) {
    failure = e.stack;
    throw e;
  } finally {
    const version = browser?.version();
    for (const route of held) await route.abort().catch(() => {});
    await context?.close();
    cleanup.context = 'closed';
    await browser?.close();
    cleanup.browser = browser ? 'closed' : 'not started';
    await server.close();
    cleanup.server = 'closed';
    writeFileSync(
      resolve(folder, 'results.json'),
      JSON.stringify(
        {
          revision: 3,
          mode,
          selection,
          browser: version,
          fixture: fixture.description,
          fixtureTime: new Date(fixture.at).toISOString(),
          checks,
          failure: failure ?? null,
          errors,
          offOrigin,
          serverAPIRequests: server.apiRequests,
          journeys,
          cleanup,
          debounceMs: 300,
          textEnlargement: 'CSS html font-size 200%, not native zoom',
        },
        null,
        2,
      ) + '\n',
    );
  }
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url))
  await runBrowser();
