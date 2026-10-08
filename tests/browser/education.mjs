// Focused compiled loopback witness, adapted from the synthetic education harness.
// No backend starts: APIs are intercepted; static server rejects any missed API.
import assert from 'node:assert/strict';
import { chromium } from 'playwright';
import { createServer } from 'node:http';
import { mkdirSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { resolve, extname, sep } from 'node:path';
import { concepts } from '../../src/web/education.ts';
import { primaryResources, deeperResources } from '../../src/web/learnResources.ts';
import { readingCopy } from './education-reading.mjs';

const [output, webRoot = 'dist/web', mode = 'candidate', selection = 'full'] =
  process.argv.slice(2);
assert.ok(output, 'Explicit task-owned output directory required');
assert.ok(['baseline', 'candidate'].includes(mode));
assert.ok(['full', 'review', 'layout'].includes(selection));
const folder = resolve(output),
  web = resolve(webRoot);
assert.ok(!existsSync(resolve(folder, 'results.json')), 'Preserve prior evidence');
mkdirSync(resolve(folder, 'screenshots'), { recursive: true });
const fixture = JSON.parse(readFileSync('tests/browser/education-fixture.json', 'utf8'));
const checks = [],
  errors = [],
  externalAttempts = [],
  missedApi = [],
  journeys = [],
  reading = [],
  home = [];
const anchors = [
  'start',
  'hex',
  'pulsechain',
  'staking-basics',
  'staking',
  'tshares',
  'payout',
  'example-title',
  'data',
  'project-resources',
  'learn-depth-title',
  'longer-stakes',
  'maturity-questions',
  'good-accounting',
  'stake-states',
  'using-tools',
  'math',
  'methodology',
  'protocol-context',
  'share-mechanics',
  'site-pages',
  'resources',
];
const server = createServer((req, res) => {
  const path = new URL(req.url, 'http://127.0.0.1').pathname;
  if (path.startsWith('/api/')) {
    missedApi.push(path);
    res.writeHead(503).end();
    return;
  }
  const asset = resolve(web, '.' + decodeURIComponent(path));
  if (!asset.startsWith(web + sep) && asset !== web) {
    res.writeHead(403).end();
    return;
  }
  const file = extname(path) ? asset : resolve(web, 'index.html');
  try {
    res.setHeader(
      'Content-Type',
      {
        '.js': 'text/javascript',
        '.css': 'text/css',
        '.html': 'text/html',
        '.svg': 'image/svg+xml',
        '.png': 'image/png',
        '.ico': 'image/x-icon',
      }[extname(file)] ?? 'application/octet-stream',
    );
    res.end(readFileSync(file));
  } catch {
    res.writeHead(404).end();
  }
});
let browser,
  context,
  page,
  base,
  requests,
  assets,
  failure,
  cleanup = {};
async function open(width = 390, height = 844, apiMode = 'fixture', theme = 'dark') {
  await context?.close();
  requests = [];
  assets = [];
  journeys.push({ width, height, apiMode, theme, requests, assets });
  context = await browser.newContext({
    viewport: { width, height },
    deviceScaleFactor: 1,
    reducedMotion: 'reduce',
    serviceWorkers: 'block',
  });
  context.setDefaultTimeout(10000);
  await context.addInitScript(
    ({ at, theme }) => {
      localStorage.setItem('hdd-v2-theme', theme);
      const Original = Date;
      window.__testNow = at;
      window.Date = class extends Original {
        constructor(...args) {
          super(...(args.length ? args : [window.__testNow]));
        }
        static now() {
          return window.__testNow;
        }
      };
    },
    { at: fixture.at, theme },
  );
  await context.route('**/*', async (route) => {
    const url = new URL(route.request().url());
    if (url.origin !== base) {
      externalAttempts.push(url.href);
      return route.abort();
    }
    if (url.pathname.startsWith('/api/')) {
      requests.push(url.pathname + url.search);
      if (apiMode === 'loading') return; // Disposed with the context.
      if (
        ![
          '/api/v2/home',
          '/api/v2/calculator/inputs',
          '/api/v2/daily',
          '/api/v2/charts',
          '/api/v2/status',
          '/api/v2/stakes',
          '/api/v2/downloads',
        ].some((known) => url.pathname === known || url.pathname.startsWith(known + '/'))
      )
        errors.push('Unexpected API: ' + url.pathname);
      if (apiMode === 'fixture' && url.pathname === '/api/v2/home')
        return route.fulfill({ json: fixture.home });
      return route.fulfill({ status: 503, json: { error: { code: 'unavailable' } } });
    }
    if (url.pathname.startsWith('/assets/')) assets.push(url.pathname);
    return route.continue();
  });
  page = await context.newPage();
  page.on('pageerror', (error) => errors.push(error.message));
}
async function check(name, action) {
  if (selection === 'layout' && !name.startsWith('Dark/light')) return;
  await action();
  checks.push(name);
  console.log('PASS', name);
}
async function layout() {
  assert.ok(
    await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth),
    'No horizontal page scroll',
  );
  const clipped = await page
    .locator(
      '.learn-page p, .learn-page summary, .learn-page a, .learn-page dt, .learn-page dd, .home-learn-link',
    )
    .evaluateAll((els) =>
      els
        .filter((el) => {
          if (!el.checkVisibility()) return false;
          const b = el.getBoundingClientRect();
          return (
            b.left < -1 ||
            b.right > innerWidth + 1 ||
            (el.scrollWidth > el.clientWidth + 1 && getComputedStyle(el).display !== 'inline')
          );
        })
        .map((el) => el.textContent),
    );
  assert.deepEqual(clipped, [], 'No clipped reading copy');
}
async function shot(name) {
  await layout();
  if (selection === 'full')
    await page.screenshot({ path: resolve(folder, 'screenshots', name + '.png') });
}
async function anchor(id) {
  await page.waitForFunction((id) => {
    const target = document.getElementById(id);
    if (!target) return false;
    const focus = target.tagName === 'DETAILS' ? target.querySelector('summary') : target;
    let node = target;
    while (node) {
      if (node.tagName === 'DETAILS' && !node.open) return false;
      node = node.parentElement;
    }
    const box = focus.getBoundingClientRect(),
      nav = document.querySelector('.bottom-nav');
    const bottom =
      getComputedStyle(nav).display === 'none' ? innerHeight : nav.getBoundingClientRect().top;
    return (
      document.activeElement === focus &&
      box.top >= -1 &&
      box.top + Math.min(box.height, 44) <= bottom
    );
  }, id);
}
async function aboveBottom(selector) {
  const el = page.locator(selector);
  await el.scrollIntoViewIfNeeded();
  await el.focus();
  const bounds = await el.evaluate((el) => {
    const b = el.getBoundingClientRect(),
      nav = document.querySelector('.bottom-nav');
    const bottom =
      getComputedStyle(nav).display === 'none' ? innerHeight : nav.getBoundingClientRect().top;
    return {
      top: b.top,
      bottom: b.bottom,
      navTop: bottom,
      width: innerWidth,
      height: innerHeight,
      font: getComputedStyle(el).fontSize,
    };
  });
  // Native scroll positions round to CSS pixels; allow less than one pixel of padding rounding.
  if (!(bounds.top >= -1 && bounds.bottom <= bounds.navTop + 1))
    await page.screenshot({ path: resolve(folder, 'clearance-failure.png') });
  assert.ok(
    bounds.top >= -1 && bounds.bottom <= bounds.navTop + 1,
    selector + ' above bottom navigation: ' + JSON.stringify(bounds),
  );
}
async function readyHome() {
  await page.locator('[data-testid="headlines"][data-ready="true"]').waitFor();
  await page.waitForFunction(() =>
    document.querySelector('.home-chart-slot')?.textContent.includes('unavailable'),
  );
  await page.evaluate(() => document.fonts.ready);
}
try {
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  base = `http://127.0.0.1:${server.address().port}`;
  browser = await chromium.launch({
    channel: process.env.HDD_V2_BROWSER_CHANNEL ?? 'chrome',
    timeout: 15000,
  });
  if (selection === 'full') {
    for (const [device, width, height] of [
      ['mobile', 390, 844],
      ['desktop', 1440, 900],
    ]) {
      await check(device + ' deterministic Home fixture and initial bounds', async () => {
        await open(width, height);
        await page.goto(base);
        await readyHome();
        home.push({
          device,
          width,
          height,
          ...(await page.evaluate(() => {
            const rect = (el) => {
              const b = el.getBoundingClientRect();
              return { x: b.x, y: b.y + scrollY, width: b.width, height: b.height };
            };
            return {
              bounds: Object.fromEntries(
                ['.home-metrics', '.home-dashboard', '.home-shortcuts', '.home-chart-slot'].map(
                  (s) => [s, rect(document.querySelector(s))],
                ),
              ),
              metrics: [...document.querySelectorAll('.home-metrics > div')].map((el) => ({
                text: el.innerText,
                bounds: rect(el),
              })),
              dashboardText: document.querySelector('.home-dashboard').innerText,
              shortcuts: document.querySelector('.home-shortcuts').innerText,
              firstViewportText: document.querySelector('main').innerText.split('New to HEX?')[0],
            };
          })),
          requests: [...requests],
          assets: [...assets],
        });
        assert.ok(!assets.some((a) => /\/(Learn|Information)-/.test(a)), 'Learn prose stays lazy');
        await layout();
        if (device === 'mobile') {
          await page
            .locator(mode === 'baseline' ? '.home-faq' : '.home-learn-link')
            .evaluate((el) => el.scrollIntoView({ block: 'center' }));
          await shot('home-mobile-lower');
        }
      });
      await check(device + ' Learn initial copy/height and defaults without API', async () => {
        await open(width, height, 'unavailable');
        await page.goto(base + '/learn');
        await page.locator('.learn-page').waitFor();
        await page.evaluate(() => document.fonts.ready);
        reading.push({ device, width, height, ...(await readingCopy(page)) });
        assert.equal(reading.at(-1).bodyFontPx, '16px');
        assert.equal(requests.length, 0);
        assert.equal(await page.locator('.learn-page details[open]').count(), 0);
        if (mode === 'candidate') {
          assert.deepEqual(
            await page.locator('.learn-basics > details > summary').allTextContents(),
            concepts.map((c) => c.question),
          );
          assert.match(
            reading.at(-1).text,
            /HEXDailyData is read-only.*Maturity is not an automatic wallet payment/,
          );
          assert.ok(!reading.at(-1).text.includes('Starting a stake burns'));
          assert.ok(await page.locator('.learn-jumps a[href="/calculator"]').isVisible());
        }
        await shot('learn-' + device + '-initial');
      });
    }
  }
  if (mode === 'candidate') {
    await check('Home compact CTA mouse, keyboard, focus and history', async () => {
      for (const keyboard of [false, true]) {
        await open();
        await page.goto(base);
        await readyHome();
        const link = page.locator('.home-learn-link');
        assert.equal(await page.locator('.home-faq').count(), 0);
        assert.ok(
          await link.evaluate((el) => el.previousElementSibling.matches('.home-shortcuts')),
        );
        await aboveBottom('.home-learn-link');
        if (keyboard) {
          await page.keyboard.press('Tab');
          await page.keyboard.press('Shift+Tab');
          assert.ok(
            await link.evaluate(
              (el) =>
                document.activeElement === el &&
                el.matches(':focus-visible') &&
                getComputedStyle(el).outlineStyle !== 'none',
            ),
          );
          await page.keyboard.press('Enter');
        } else await link.click();
        await page.locator('.learn-page').waitFor();
        assert.equal(new URL(page.url()).pathname, '/learn');
        await page.goBack();
        await link.waitFor();
        await page.goForward();
        await page.locator('.learn-page').waitFor();
      }
    });
    await check(
      'Five closed questions and native keyboard disclosures preserve content',
      async () => {
        await open();
        await page.goto(base + '/learn');
        await page.locator('.learn-page').waitFor();
        assert.equal(await page.locator('.learn-page details[open]').count(), 0);
        assert.equal(await page.locator('.learn-basics > details').count(), 5);
        const ids = await page.locator('[id]').evaluateAll((els) => els.map((el) => el.id));
        assert.equal(new Set(ids).size, ids.length);
        for (const id of anchors) assert.ok(ids.includes(id), id);
        await page.keyboard.press('Tab');
        for (const c of concepts) {
          const summary = page.locator(`#${c.anchor} > summary`);
          await summary.focus();
          assert.ok(
            await summary.evaluate(
              (el) => el.matches(':focus-visible') && getComputedStyle(el).outlineStyle !== 'none',
            ),
          );
          await page.keyboard.press('Enter');
          assert.ok(await summary.evaluate((el) => el.parentElement.open));
          assert.ok((await page.locator('#' + c.anchor).innerText()).includes(c.answer));
          await layout();
          await page.keyboard.press('Space');
          assert.equal(await summary.evaluate((el) => el.parentElement.open), false);
        }
        await page.goto(base + '/learn#staking-basics');
        await anchor('staking-basics');
        assert.equal(await page.locator('.stake-lifecycle li').count(), 3);
        assert.match(
          await page.locator('#staking-basics').innerText(),
          /does not add extra earning days/,
        );
        await shot('learn-mobile-staking-expanded');
        await page.goto(base + '/learn#payout');
        await anchor('payout');
        assert.match(
          await page.locator('.learn-example').innerText(),
          /10 T-Shares × 6 HEX per T-Share ≈ 60 HEX.*before any end-of-stake penalties. Example only—not a forecast/s,
        );
        await shot('learn-mobile-example-expanded');
        await page.locator('.learn-example a').click();
        await anchor('math');
        assert.match(
          await page.locator('#math').innerText(),
          /bonuses share one floor; do not round them separately/,
        );
        await page.goto(base + '/learn#data');
        await anchor('data');
        assert.deepEqual(await page.locator('.learn-labels dt').allTextContents(), [
          'Live',
          'Indexed',
          'HDS reported',
          'Unavailable',
        ]);
        assert.match(
          await page.locator('#data').innerText(),
          /does not mean zero.*payout may still be waiting to be recorded/s,
        );
      },
    );
    await check(
      'Cold fragments open ancestors and history re-navigation restores focus',
      async () => {
        const selected =
          selection === 'review'
            ? [
                'tshares',
                'math',
                'methodology',
                'stake-states',
                'resources',
                'using-tools',
                'pulsechain',
              ]
            : anchors;
        for (const id of selected) {
          await open();
          await page.goto(base + '/learn#' + id);
          await anchor(id);
          await layout();
          assert.equal(requests.length, 0);
        }
        await open();
        await page.goto(base);
        await readyHome();
        await page.locator('.site-footer a[href="/learn#methodology"]').click();
        await anchor('methodology');
        await page.locator('.learn-jumps a[href="#data"]').click();
        await anchor('data');
        await page.goBack();
        await anchor('methodology');
        await page.goForward();
        await anchor('data');
        await page.locator('#data > summary').click();
        await page.locator('.learn-jumps a[href="#data"]').click();
        await anchor('data');
      },
    );
    await check(
      'Exact external labels, descriptions, hosts and classifications; no outbound navigation',
      async () => {
        await open();
        await page.goto(base + '/learn#project-resources');
        await anchor('project-resources');
        await page.locator('#resources > summary').click();
        const expected = [
          ...primaryResources,
          ...deeperResources.flatMap((r) => [r, ...(r.companion ? [r.companion] : [])]),
        ];
        assert.deepEqual(
          await page
            .locator('.learn-page a[href^="https:"]')
            .evaluateAll((els) => els.map((el) => el.href)),
          expected.map((r) => r.href),
        );
        for (const r of expected) {
          const link = page.locator(`.learn-page a[href="${r.href}"]`),
            text = await link.textContent();
          assert.ok(
            text.includes(r.label) &&
              text.includes(new URL(r.href).hostname) &&
              text.includes('↗') &&
              text.includes('(external)'),
          );
          if (r.description)
            assert.ok((await link.locator('..').textContent()).includes(r.description));
        }
        assert.match(await page.locator('#buy-stake').innerText(), /not a safety guarantee/);
        assert.match(
          await page.locator('#resources').innerText(),
          /historical, not current instructions or forecasts/,
        );
        await aboveBottom('#resources li:last-child a');
        assert.equal(requests.length, 0);
      },
    );
    if (selection !== 'review') {
      await check(
        'Home unavailable/loading errors stay honest; Learn useful without data',
        async () => {
          for (const apiMode of ['unavailable', 'loading']) {
            await open(390, 844, apiMode);
            await page.goto(base, { waitUntil: 'domcontentloaded' });
            await page.locator('.home-learn-link').waitFor();
            if (apiMode === 'unavailable')
              await page
                .getByText('Current native data is unavailable.', { exact: false })
                .waitFor();
            assert.equal(
              await page.locator('[data-testid="headlines"]').getAttribute('data-ready'),
              'false',
            );
            assert.ok(!(await page.locator('.home-metrics').innerText()).includes('$0.00'));
            const before = requests.length;
            await page.locator('.home-learn-link').click();
            await page.locator('.learn-page').waitFor();
            assert.equal(requests.length, before);
            assert.ok(await page.locator('.learn-aside').first().isVisible());
          }
        },
      );
      await check(
        'Dark/light 390x844 and 1440x900, 320px reflow and 200% root text enlargement',
        async () => {
          for (const [width, height, theme, textPercent] of [
            [390, 844, 'dark', 100],
            [390, 844, 'light', 100],
            [1440, 900, 'dark', 100],
            [1440, 900, 'light', 100],
            [320, 844, 'light', 100],
            [390, 844, 'light', 200],
            [1440, 900, 'dark', 200],
          ]) {
            await open(width, height, 'unavailable', theme);
            await page.goto(base + '/learn');
            await page.locator('.learn-page').waitFor();
            if (textPercent === 200)
              await page.addStyleTag({ content: 'html { font-size: 200% !important; }' });
            assert.equal(await page.evaluate(() => document.documentElement.dataset.theme), theme);
            assert.equal(
              await page.locator('.learn-page').evaluate((el) => getComputedStyle(el).fontSize),
              textPercent === 200 ? '32px' : '16px',
            );
            await layout();
            if (width === 320) await shot('learn-320-light');
            await page.locator('.learn-page details').evaluateAll((els) =>
              els.forEach((el) => {
                el.open = true;
              }),
            );
            await layout();
            await aboveBottom('#resources li:last-child a');
            await page.goto(base);
            await page.locator('.home-learn-link').waitFor();
            await page.getByText('Current native data is unavailable.', { exact: false }).waitFor();
            await page.waitForFunction(() =>
              document.querySelector('.home-chart-slot')?.textContent.includes('unavailable'),
            );
            if (textPercent === 200)
              await page.addStyleTag({ content: 'html { font-size: 200% !important; }' });
            await layout();
            await aboveBottom('.home-learn-link');
          }
        },
      );
      await check(
        'Visible calculator/data links retain destination behavior with synthetic failures',
        async () => {
          for (const [selector, heading] of [
            ['.learn-jumps a[href="/calculator"]', 'Stake Calculator'],
            ['.learn-page-links a[href="/charts"]', 'Charts'],
            ['.learn-page-links a[href="/search"]', 'Address Lookup'],
            ['.learn-page-links a[href="/downloads"]', 'Downloads'],
          ]) {
            await open(1440, 900, 'unavailable');
            await page.goto(base + '/learn');
            await page.locator(selector).click();
            await page.getByRole('heading', { name: heading, exact: true }).waitFor();
          }
        },
      );
    }
  }
  assert.deepEqual(errors, []);
  assert.deepEqual(externalAttempts, []);
  assert.deepEqual(missedApi, []);
} catch (error) {
  failure = error.stack;
  throw error;
} finally {
  const version = browser?.version() ?? null;
  try {
    await context?.close();
    cleanup.context = 'closed';
  } catch (e) {
    cleanup.context = String(e);
  }
  try {
    await browser?.close();
    cleanup.browser = browser ? 'closed' : 'not started';
  } catch (e) {
    cleanup.browser = String(e);
  }
  server.closeAllConnections();
  await new Promise((resolve) => server.close(resolve));
  cleanup.server = 'closed';
  writeFileSync(
    resolve(folder, 'results.json'),
    JSON.stringify(
      {
        mode,
        selection,
        browser: version,
        fixture: fixture.description,
        fixtureTime: new Date(fixture.at).toISOString(),
        base,
        checks,
        failure: failure ?? null,
        errors,
        externalAttempts,
        missedApi,
        journeys,
        home,
        reading,
        cleanup,
        textEnlargement:
          '200% root font using injected CSS (32px article); not native browser zoom',
        requestsPolicy:
          'Every API intercepted; all off-origin requests aborted; external links inspected without following',
      },
      null,
      2,
    ) + '\n',
  );
}
