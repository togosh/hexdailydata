// Compiled loopback witness. All API responses are controlled; no database or provider needed.
import assert from 'node:assert/strict';
import { chromium } from 'playwright';
import { createApp } from '../../dist/api/app.js';
import { mkdirSync, readFileSync, writeFileSync, readdirSync, statSync } from 'node:fs';
import { resolve } from 'node:path';
import { concepts } from '../../src/web/education.ts';
import { primaryResources, deeperResources } from '../../src/web/learnResources.ts';
import { readingCopy } from './education-reading.mjs';

const [
  output = 'artifacts/task-07/learn-refinement-20260921/current',
  webRoot = 'dist/web',
  mode = 'current',
] = process.argv.slice(2);
assert.match(output.replaceAll('\\', '/'), /^artifacts\/task-(07|09)\/[a-z0-9_/-]+$/);
const folder = resolve(output);
mkdirSync(resolve(folder, 'screenshots'), { recursive: true });
const fixture = JSON.parse(readFileSync('tests/browser/education-fixture.json', 'utf8'));
const app = createApp({ webRoot: resolve(webRoot) });
const base = await app.listen({ host: '127.0.0.1', port: 0 });
const browser = await chromium.launch({ channel: process.env.HDD_V2_BROWSER_CHANNEL ?? 'chrome' });
const checks = [],
  errors = [],
  externalAttempts = [],
  interceptedLinks = [],
  measurements = [],
  reading = [];
// A compact editorial capture set; all journeys still run their layout assertions.
const captures = new Set([
  'home-mobile-initial',
  'home-desktop-initial',
  'home-desktop-faq-default',
  'home-mobile-faq-default',
  'learn-desktop-initial',
  'learn-mobile-initial',
  'learn-desktop-full',
  'learn-mobile-full',
  'learn-mobile-lifecycle',
  'learn-mobile-example',
  'resources-mobile-primary',
  'learn-mobile-math-open',
  'learn-mobile-methodology-open',
  'learn-desktop-math-open',
  'learn-320-light',
]);
let context,
  page,
  requests,
  assets,
  apiMode = 'fixture';
async function open(width = 390, height = 844) {
  await context?.close();
  requests = [];
  assets = [];
  context = await browser.newContext({
    viewport: { width, height },
    deviceScaleFactor: 1,
    reducedMotion: 'reduce',
  });
  await context.addInitScript((at) => {
    window.__focusEvents = [];
    document.addEventListener('focusin', (event) =>
      window.__focusEvents.push(
        event.target.id || event.target.parentElement?.id || event.target.tagName,
      ),
    );
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
    window.__headlines = null;
    new MutationObserver(() => {
      if (
        !window.__headlines &&
        document.querySelector('[data-testid="headlines"][data-ready="true"]')
      ) {
        window.__headlines = 'pending';
        requestAnimationFrame(() =>
          requestAnimationFrame(() => (window.__headlines = performance.now())),
        );
      }
    }).observe(document, { subtree: true, childList: true, attributes: true });
  }, fixture.at);
  page = await context.newPage();
  page.on('pageerror', (error) => errors.push(error.message));
  await context.route('**/*', async (route) => {
    const url = new URL(route.request().url());
    if (url.origin !== base) {
      externalAttempts.push(url.href);
      errors.push('Unexpected external request: ' + url.href);
      return route.abort();
    }
    if (url.pathname.startsWith('/api/')) {
      requests.push(url.pathname + url.search);
      if (apiMode === 'loading') return; // Kept pending until this context is disposed.
      if (apiMode === 'fixture' && url.pathname === '/api/v2/home') {
        return route.fulfill({ json: fixture.home });
      }
      return route.fulfill({ status: 503, json: { error: { code: 'unavailable' } } });
    }
    if (url.pathname.startsWith('/assets/')) assets.push(url.pathname);
    return route.continue();
  });
}
async function check(name, action) {
  await action();
  checks.push(name);
  console.log('PASS', name);
}
async function shot(name, fullPage = false) {
  assert.ok(
    await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth),
    name + ' page overflow',
  );
  if (captures.has(name))
    await page.screenshot({ path: resolve(folder, 'screenshots', name + '.png'), fullPage });
}
async function anchor(id) {
  await page.waitForFunction((id) => {
    const target = document.getElementById(id);
    if (!target) return false;
    const focus = target.tagName === 'DETAILS' ? target.querySelector('summary') : target;
    const box = target.getBoundingClientRect();
    const nav = document.querySelector('.bottom-nav');
    const bottom =
      getComputedStyle(nav).display === 'none' ? innerHeight : nav.getBoundingClientRect().top;
    const atPageEnd = Math.abs(scrollY + innerHeight - document.documentElement.scrollHeight) <= 2;
    return (
      document.activeElement === focus &&
      box.top >= 0 &&
      (box.top < 100 || atPageEnd) &&
      box.top + Math.min(box.height, 44) <= bottom &&
      (target.tagName !== 'DETAILS' || target.open)
    );
  }, id);
}
async function aboveBottom(selector) {
  const locator = page.locator(selector);
  await locator.scrollIntoViewIfNeeded();
  await locator.focus();
  assert.ok(
    await locator.evaluate((el) => {
      const box = el.getBoundingClientRect();
      const nav = document.querySelector('.bottom-nav');
      const bottom =
        getComputedStyle(nav).display === 'none' ? innerHeight : nav.getBoundingClientRect().top;
      return box.top >= 0 && box.bottom <= bottom;
    }),
    selector + ' must be wholly above mobile navigation',
  );
}
try {
  await check(
    'three cold local Home loads; headline positions, requests and loaded assets recorded',
    async () => {
      for (let run = 0; run < 3; run++) {
        await open();
        await page.goto(base);
        await page.waitForFunction(() => typeof window.__headlines === 'number');
        await page.waitForFunction(() =>
          document.querySelector('.home-chart-slot')?.textContent.includes('unavailable'),
        );
        measurements.push(
          await page.evaluate(() => {
            const rect = (selector) => {
              const b = document.querySelector(selector)?.getBoundingClientRect();
              return b ? { x: b.x, y: b.y + scrollY, width: b.width, height: b.height } : null;
            };
            return {
              headlinesMs: window.__headlines,
              headlines: rect('.home-metrics'),
              dashboard: rect('.home-dashboard'),
              shortcuts: rect('.home-shortcuts'),
              faq: rect('.home-faq'),
            };
          }),
        );
        measurements.at(-1).requests = [...requests];
        measurements.at(-1).assets = [...assets];
        if (run === 0) await shot('home-mobile-initial');
        if (mode !== 'baseline')
          assert.ok(
            !assets.some((a) => /\/(Learn|Information)-/.test(a)),
            'Home must not load Learn or Information',
          );
      }
      await open(1440, 1000);
      await page.goto(base);
      await page.waitForFunction(() => typeof window.__headlines === 'number');
      await page.waitForFunction(() =>
        document.querySelector('.home-chart-slot')?.textContent.includes('unavailable'),
      );
      await shot('home-desktop-initial');
      if (mode === 'baseline') return;
    },
  );
  if (mode !== 'baseline') {
    for (const [device, width, height] of [
      ['desktop', 1440, 1000],
      ['mobile', 390, 844],
    ]) {
      await check(
        device + ' FAQ defaults, shared answers, keyboard toggles and refresh focus',
        async () => {
          await open(width, height);
          await page.goto(base);
          const faq = page.locator('.home-faq');
          await faq.waitFor();
          await page.waitForFunction(() =>
            document.querySelector('.home-chart-slot')?.textContent.includes('unavailable'),
          );
          assert.deepEqual(
            await faq.locator('details').evaluateAll((els) => els.map((e) => e.open)),
            [true, false, false, false, false],
          );
          assert.deepEqual(
            await faq.locator('details p').allTextContents(),
            concepts.map((c) => c.answer),
          );
          assert.ok(
            await faq.evaluate((el) => el.previousElementSibling.matches('.home-shortcuts')),
          );
          await faq.scrollIntoViewIfNeeded();
          await shot('home-' + device + '-faq-default');
          for (const [index, summary] of (await faq.locator('summary').all()).entries()) {
            await summary.focus();
            assert.ok(
              await summary.evaluate(
                (el) =>
                  el.matches(':focus-visible') && getComputedStyle(el).outlineStyle !== 'none',
              ),
            );
            await page.keyboard.press('Enter');
            assert.equal(await summary.evaluate((el) => el.parentElement.open), index !== 0);
            await page.keyboard.press('Space');
            assert.equal(await summary.evaluate((el) => el.parentElement.open), index === 0);
          }
          for (const summary of (await faq.locator('summary').all()).slice(1)) {
            await summary.focus();
            await page.keyboard.press('Enter');
          }
          const response = page.waitForResponse((r) => r.url().includes('/api/v2/home?'));
          await page.evaluate(() => {
            window.__testNow += 1000;
            document.dispatchEvent(new Event('visibilitychange'));
          });
          await response;
          assert.ok(
            await faq
              .locator('summary')
              .last()
              .evaluate((el) => document.activeElement === el),
          );
          assert.deepEqual(
            await faq.locator('details').evaluateAll((els) => els.map((e) => e.open)),
            [true, true, true, true, true],
          );
          await faq.scrollIntoViewIfNeeded();
          await shot('home-' + device + '-faq-expanded');
          await aboveBottom('#home-faq-pulsechain p');
          await shot('home-' + device + '-faq-last-answer');
          if (device === 'mobile') await shot('home-mobile-faq-expanded-full', true);
          await aboveBottom('.home-faq a');
          await faq.getByRole('link', { name: 'Learn HEX →' }).click();
          await page.getByRole('heading', { name: 'Learn HEX', exact: true }).waitFor();
          assert.equal(new URL(page.url()).pathname, '/learn');
          await page.goBack();
          await faq.waitFor();
          await page.goForward();
          await page.locator('.learn-page').waitFor();
        },
      );
      await check(
        device + ' Learn direct offline, semantic anchors, readable lifecycle and resources',
        async () => {
          apiMode = 'unavailable';
          await open(width, height);
          await page.goto(base + '/learn');
          await page.getByRole('heading', { name: 'Learn HEX', exact: true }).waitFor();
          assert.equal(requests.length, 0, 'Static Learn needs no data API');
          assert.equal(await page.locator('.learn-page h1').count(), 1);
          assert.equal(await page.locator('.learn-jumps a').count(), 3);
          assert.equal(await page.locator('.learn-page details[open]').count(), 0);
          assert.equal(await page.locator('.learn-page details').count(), 8);
          for (const c of concepts.filter((concept) => concept.id !== 'staking')) {
            assert.equal(
              await page
                .locator('#' + c.anchor + ' > p')
                .first()
                .textContent(),
              c.answer,
            );
            assert.ok(await page.locator('#' + c.anchor).isVisible());
            assert.equal(
              await page.locator('#' + c.anchor).evaluate((el) => el.closest('details')),
              null,
            );
          }
          const ids = await page.locator('[id]').evaluateAll((els) => els.map((e) => e.id));
          assert.equal(new Set(ids).size, ids.length, 'unique DOM anchors');
          for (const id of [
            'start',
            'staking',
            'data',
            'math',
            'methodology',
            'resources',
            'project-resources',
            'stake-states',
            'using-tools',
            ...concepts.map((c) => c.anchor),
          ])
            assert.ok(ids.includes(id));
          assert.equal(await page.locator('.stake-lifecycle li').count(), 3);
          assert.deepEqual(await page.locator('.stake-lifecycle strong').allTextContents(), [
            'Choose & start',
            'While it runs',
            'End your stake',
          ]);
          const lifecycle = await page.locator('#staking-basics').innerText();
          assert.match(lifecycle, /Payment isn't automatic/);
          assert.match(
            lifecycle,
            /Ending early or too late can reduce your payout and starting HEX/,
          );
          assert.match(lifecycle, /does not add extra earning days/);
          assert.match(
            await page.locator('#staking').innerText(),
            /higher rate means fewer T-Shares\. It is not an interest rate/,
          );
          assert.match(
            await page.locator('.example-equation').innerText(),
            /10 T-Shares × 6 HEX per T-Share ≈ 60 HEX/,
          );
          assert.match(
            await page.locator('.learn-example').innerText(),
            /before any end-of-stake penalties\. Example only—not a forecast/,
          );
          assert.equal(await page.locator('.learn-example a').getAttribute('href'), '#math');
          assert.deepEqual(await page.locator('.learn-labels dt').allTextContents(), [
            'Live',
            'Indexed',
            'HDS reported',
            'Unavailable',
          ]);
          assert.match(
            await page.locator('.learn-labels').innerText(),
            /originally published by HEXDailyStats/,
          );
          assert.match(await page.locator('.learn-labels').innerText(), /does not mean zero/);
          assert.match(
            await page.locator('#data').innerText(),
            /payout may still be waiting to be recorded/,
          );
          reading.push({ device, ...(await readingCopy(page)) });
          assert.equal(reading.at(-1).bodyFontPx, '16px');
          assert.ok(
            await page
              .locator('.learn-page p, .learn-labels dt')
              .evaluateAll((elements) =>
                elements.every((el) => parseFloat(getComputedStyle(el).fontSize) >= 16),
              ),
            'normal article copy and data labels remain at least 16px',
          );
          assert.ok(
            !reading.at(-1).text.includes('Starting a stake burns'),
            'technical mechanics remain optional',
          );
          await shot('learn-' + device + '-initial');
          await shot('learn-' + device + '-full', true);
          await page.locator('.stake-lifecycle').scrollIntoViewIfNeeded();
          await shot('learn-' + device + '-lifecycle');
          await page.locator('.learn-example').scrollIntoViewIfNeeded();
          await shot('learn-' + device + '-example');
          await page
            .locator('#project-resources')
            .evaluate((el) => el.scrollIntoView({ block: 'start' }));
          await shot('resources-' + device + '-primary');
          await page.locator('#resources summary').click();
          await page.locator('#resources').scrollIntoViewIfNeeded();
          await shot('resources-' + device + '-reading');
          const expected = [
            ...primaryResources,
            ...deeperResources.flatMap((r) => [r, ...(r.companion ? [r.companion] : [])]),
          ];
          assert.deepEqual(
            await page
              .locator('.learn-page a[href^="https:"]')
              .evaluateAll((els) => els.map((e) => e.href)),
            expected.map((r) => r.href),
          );
          await page.evaluate(() => {
            window.__externalClicks = [];
            document.addEventListener(
              'click',
              (event) => {
                const link = event.target.closest('a[href^="https:"]');
                if (link) {
                  event.preventDefault();
                  window.__externalClicks.push(link.href);
                }
              },
              { capture: true },
            );
          });
          await page.keyboard.press('Tab');
          for (const r of expected) {
            const link = page.locator(`.learn-page a[href="${r.href}"]`);
            assert.ok((await link.innerText()).includes(new URL(r.href).hostname));
            assert.ok((await link.innerText()).includes('↗'));
            await link.focus();
            assert.ok(await link.evaluate((el) => el.matches(':focus-visible')));
            await page.keyboard.press('Enter');
            assert.equal(await page.evaluate(() => window.__externalClicks.at(-1)), r.href);
            interceptedLinks.push(r.href);
          }
          await aboveBottom('#resources li:last-child a');
          await shot('resources-' + device + '-last-link');
          assert.equal(requests.length, 0);
        },
      );
    }
    await check(
      'optional questions and visible next steps preserve their meanings and keyboard access',
      async () => {
        await open();
        await page.goto(base + '/learn');
        await page.locator('.learn-page').waitFor();
        await page.keyboard.press('Tab');
        for (const [id, meaning] of [
          ['longer-stakes', /More shares do not guarantee a better dollar result/],
          ['maturity-questions', /does not end itself or gain extra payout days/],
          ['good-accounting', /does not remove penalties already incurred/],
          ['stake-states', /Current.*means unended, not.*currently earning/s],
          ['using-tools', /slippage and any spending allowance or stake duration/],
          ['math', /bonuses share one floor; do not round them separately/],
          ['methodology', /30-consecutive-completed-day mean/],
          ['resources', /historical, not current instructions or forecasts/],
        ]) {
          const details = page.locator('#' + id);
          const summary = details.locator(':scope > summary');
          assert.equal(await details.evaluate((el) => el.open), false);
          await summary.focus();
          await page.keyboard.press('Enter');
          assert.equal(await details.evaluate((el) => el.open), true);
          assert.match(await details.innerText(), meaning);
          await page.keyboard.press('Space');
          assert.equal(await details.evaluate((el) => el.open), false);
        }
        for (const [selector, heading] of [
          ['.learn-source-link', 'Stake Calculator'],
          ['.learn-page-links a[href="/charts"]', 'Charts'],
          ['.learn-page-links a[href="/search"]', 'Address Lookup'],
          ['.learn-page-links a[href="/downloads"]', 'Downloads'],
        ]) {
          await page.goto(base + '/learn');
          await page.locator(selector).click();
          await page.getByRole('heading', { name: heading, exact: true }).waitFor();
        }
      },
    );
    await check(
      'cold lazy anchors, Home methodology link, same-route history and focus only on navigation',
      async () => {
        for (const id of [
          'math',
          'methodology',
          'tshares',
          'staking-basics',
          'resources',
          'protocol-context',
          'share-mechanics',
          'site-pages',
        ]) {
          await open();
          await page.goto(base + '/learn#' + id);
          await anchor(id);
          assert.equal(
            await page.evaluate(
              (id) => window.__focusEvents.filter((entry) => entry === id).length,
              id,
            ),
            1,
            'cold target focused once',
          );
          if (['math', 'methodology', 'resources'].includes(id))
            assert.equal(
              await page.locator('#' + id + ' summary').evaluate((el) => el.tabIndex),
              0,
              'native summary stays in tab order',
            );
          if (['math', 'methodology'].includes(id)) await shot('learn-mobile-' + id + '-open');
          if (['protocol-context', 'share-mechanics', 'site-pages'].includes(id))
            assert.equal(
              await page.locator('#methodology').evaluate((el) => el.open),
              true,
              'nested target opens its enclosing disclosure',
            );
          assert.equal(requests.length, 0);
        }
        await open(1440, 1000);
        await page.goto(base + '/learn#math');
        await anchor('math');
        await shot('learn-desktop-math-open');
        await page.goto(base);
        await page.locator('.site-footer a[href="/learn#methodology"]').click();
        await anchor('methodology');
        await shot('learn-desktop-methodology-open');
        await page.locator('.learn-jumps a[href="#staking"]').click();
        await anchor('staking');
        await page.goBack();
        await anchor('methodology');
        await page.goBack();
        await page.locator('.home-faq').waitFor();
        await page.goForward();
        await anchor('methodology');
        await aboveBottom('#methodology a[href="/status"]');
        await page.locator('#methodology a[href="/status"]').click();
        await page.getByRole('heading', { name: 'Data status', exact: true }).waitFor();
      },
    );
    await check(
      'Home education survives unavailable and indefinitely loading APIs without adding requests',
      async () => {
        for (apiMode of ['unavailable', 'loading']) {
          await open();
          await page.goto(base, { waitUntil: 'domcontentloaded' });
          await page.locator('.home-faq').waitFor();
          assert.equal(await page.locator('#home-faq-hex').getAttribute('open'), '');
          if (apiMode === 'unavailable')
            await page.getByText('Current native data is unavailable.', { exact: false }).waitFor();
          assert.ok(!requests.some((r) => /learn|education|resources/.test(r)));
          await page.locator('.home-faq a').click();
          await page.locator('.learn-page').waitFor();
          assert.ok(await page.locator('#hex').isVisible());
        }
        apiMode = 'unavailable';
      },
    );
    await check(
      '320px, 720 CSS-pixel reflow, light mode and bottom navigation clearance',
      async () => {
        for (const width of [320, 720]) {
          await open(width, 844);
          await page.goto(base + '/learn#math');
          await anchor('math');
          await shot(`learn-${width}-math`);
          await page.getByRole('button', { name: 'Use light mode' }).click();
          assert.equal(await page.evaluate(() => document.documentElement.dataset.theme), 'light');
          await shot(`learn-${width}-light`);
          await page.goto(base + '/learn#resources');
          await anchor('resources');
          await aboveBottom('#resources li:last-child a');
          await page.goto(base + '/learn#methodology');
          await anchor('methodology');
          await aboveBottom('#methodology a[href="/status"]');
          await page.goto(base);
          for (const s of (await page.locator('.home-faq summary').all()).slice(1)) {
            await s.focus();
            await page.keyboard.press('Enter');
          }
          await aboveBottom('#home-faq-pulsechain p');
          await shot(`home-${width}-faq-light`);
          assert.ok(
            await page.evaluate(() => matchMedia('(prefers-reduced-motion: reduce)').matches),
          );
        }
      },
    );
    await check(
      'internal page destinations and Downloads/Status smoke with API failures',
      async () => {
        await open(1440, 1000);
        for (const [href, heading] of [
          ['/', 'Your daily view'],
          ['/charts', 'Charts'],
          ['/calculator', 'Stake Calculator'],
          ['/search', 'Address Lookup'],
          ['/downloads', 'Downloads'],
        ]) {
          await page.goto(base + '/learn#site-pages');
          await anchor('site-pages');
          await page.locator(`.learn-destinations a[href="${href}"]`).click();
          await page.getByRole('heading', { name: heading, exact: true }).waitFor();
          assert.equal(new URL(page.url()).pathname, href);
          if (href === '/downloads') {
            await page.getByRole('link', { name: 'Read the methodology ↗' }).click();
            await anchor('methodology');
          }
        }
      },
    );
    assert.deepEqual(errors, []);
  }
} finally {
  const inventory = readdirSync(resolve(webRoot, 'assets'))
    .filter((f) => /\.(js|css)$/.test(f))
    .map((name) => ({ name, bytes: statSync(resolve(webRoot, 'assets', name)).size }));
  writeFileSync(
    resolve(folder, 'results.json'),
    JSON.stringify(
      {
        mode,
        browser: browser.version(),
        fixture: fixture.description,
        profile:
          'Unthrottled local cold browser contexts, 390x844 CSS px; no p95 or backend qualification',
        checks,
        errors,
        externalAttempts,
        interceptedLinks,
        measurements,
        reading,
        inventory,
        cleanup: 'Browser contexts, browser and task-owned loopback server closed in finally',
      },
      null,
      2,
    ) + '\n',
  );
  await context?.close();
  await browser.close();
  await app.close();
}
