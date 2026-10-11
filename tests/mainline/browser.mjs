import './deny-network.mjs';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { fork } from 'node:child_process';
import { once } from 'node:events';
import { setTimeout as delay } from 'node:timers/promises';
import { chromium } from 'playwright';
import { now, address } from './fixture.mjs';
const T = process.env.HDD_TASK_ROOT,
  W = resolve('.');
const root = JSON.parse(
  JSON.parse(
    await fs.readFile(
      join(T, 'evidence/CHECK-actual-entry-static-refusal-corrected.json'),
      'utf8',
    ),
  ).stdout,
).root;
await fs.writeFile(join(root, 'clock.txt'), String(now));
const receipt = {
  synthetic: true,
  requests: 0,
  chargedBytes: 0,
  blockedExternal: 0,
  checks: [],
  images: [],
  errors: [],
  listenerSeconds: 0,
};
const start = performance.now();
const child = fork('dist/api/main.js', [], {
  cwd: W,
  env: {
    ...process.env,
    HDD_SYNTHETIC_ROOT: root,
    HDD_V2_PRODUCT_PROFILE: join(root, 'profile.json'),
    HDD_V2_HTTP_HOST: '127.0.0.1',
    HDD_V2_HTTP_PORT: '0',
  },
  execArgv: ['--import', pathToFileURL(join(W, 'tests/mainline/admission.mjs')).href],
  silent: true,
});
let output = '',
  errors = '';
child.stdout.on('data', (b) => (output += b));
child.stderr.on('data', (b) => (errors += b));
const exit = once(child, 'exit');
let browser;
try {
  let listening;
  for (let i = 0; i < 100; i++) {
    listening = output.split('\n').find((l) => l.includes('"listening"'));
    if (listening) break;
    await delay(50);
  }
  assert(listening, errors);
  const origin = 'http://127.0.0.1:' + JSON.parse(listening).port;
  browser = await chromium.launch({
    executablePath: 'C:/Program Files/Google/Chrome/Application/chrome.exe',
    headless: true,
    args: [
      '--disable-background-networking',
      '--disable-component-update',
      '--disable-sync',
      '--no-proxy-server',
      '--host-resolver-rules=MAP * ~NOTFOUND, EXCLUDE 127.0.0.1',
    ],
  });
  const context = await browser.newContext({
    viewport: { width: 1440, height: 1080 },
    serviceWorkers: 'block',
  });
  let inFlight = 0;
  const queued = [],
    held = new Set();
  const settled = (request) => {
    if (held.delete(request)) {
      inFlight--;
      queued.shift()?.();
    }
  };
  context.on('requestfinished', settled);
  context.on('requestfailed', settled);
  await context.route('**/*', async (route) => {
    if (new URL(route.request().url()).origin !== origin) {
      receipt.blockedExternal++;
      await route.abort();
      return;
    }
    assert(++receipt.requests < 6000);
    receipt.chargedBytes += 4 * 1024 * 1024;
    assert(receipt.chargedBytes < 4 * 1024 ** 3);
    if (inFlight >= 4) await new Promise((resolve) => queued.push(resolve));
    inFlight++;
    held.add(route.request());
    await route.continue();
  });
  const page = await context.newPage();
  page.on('pageerror', (e) => receipt.errors.push(e.message));
  await page.clock.install({ time: now });
  await page.goto(origin + '/calculator');
  await page.locator('[data-testid="amount-equivalent"]').waitFor();
  await page.waitForFunction(
    () => document.querySelector('.share-result dd')?.textContent.trim() !== '—',
  );
  receipt.initialShares = await page.locator('.share-result dd').innerText();
  assert(receipt.initialShares.includes('0.972'));
  assert.equal(
    await page.locator('[data-testid=exact-principal-hearts]').textContent(),
    '1000000000000',
  );
  await page.getByLabel('USD amount', { exact: true }).fill('123.45');
  await page.getByLabel('Whole days', { exact: true }).focus();
  await page.getByRole('button', { name: 'HEX', exact: true }).click();
  await page.getByLabel('HEX amount', { exact: true }).fill('9876');
  await page.getByLabel('Whole days', { exact: true }).focus();
  await page.getByRole('button', { name: 'USD', exact: true }).click();
  assert.equal(await page.getByLabel('USD amount', { exact: true }).inputValue(), '123.45');
  await page.getByRole('button', { name: 'HEX', exact: true }).click();
  assert.equal(await page.getByLabel('HEX amount', { exact: true }).inputValue(), '9,876.00');
  await page.getByRole('button', { name: 'USD', exact: true }).click();
  await fs.writeFile(join(root, 'clock.txt'), String(now + 301000));
  await page.clock.fastForward(301000);
  await page
    .getByText('Current HEX price unavailable — enter HEX instead.', { exact: true })
    .waitFor();
  assert.equal(await page.locator('.share-result dd').innerText(), '—');
  assert.equal(await page.locator('[data-testid="amount-equivalent"]').count(), 0);
  await page.getByRole('button', { name: 'HEX', exact: true }).click();
  await page.clock.runFor(400);
  assert.notEqual(await page.locator('.share-result dd').innerText(), '—');
  await page.getByLabel('Hypothetical future USD per HEX', { exact: true }).fill('0.25');
  await page.clock.runFor(400);
  assert((await page.locator('.usd-result dd').innerText()).includes('$'));
  receipt.checks.push(
    'actual compiled Home/Calculator schemas',
    'independent persisted amount drafts',
    '300-second boundary hides cached USD results',
    'stale-rate HEX calculation survives absent USD',
    'hypothetical price stays separate',
  );
  await page.reload();
  await page.getByLabel('HEX amount', { exact: true }).waitFor();
  assert.equal(await page.getByLabel('HEX amount', { exact: true }).inputValue(), '9,876.00');
  for (const [path, selector] of [
    ['/search?kind=holders', '[data-testid="source-holder-list"][data-ready="true"]'],
    ['/address/' + address(0), '[data-testid="source-stake-list"][data-ready="true"]'],
    ['/stake/1', '[data-testid="source-stake-detail"]'],
    ['/daily', '[data-testid="daily-product"][data-ready="true"]'],
    ['/downloads', 'a[href="/samples/daily.csv"]'],
    ['/charts/maturities', 'text=Canonical maturity schedules are unavailable'],
  ]) {
    await page.goto(origin + path);
    await page.locator(selector).waitFor();
  }
  receipt.checks.push('normal Search, Daily, Downloads and unavailable Maturities UI loads');
  // Keep time monotonic in this running process; final images show the honest last-known state.
  await page.goto(origin + '/calculator');
  await page.getByRole('button', { name: 'HEX', exact: true }).click();
  await page.getByLabel('HEX amount', { exact: true }).fill('10000');
  await page.getByLabel('Whole days', { exact: true }).focus();
  await page.clock.runFor(450);
  await page.waitForFunction(
    () => document.querySelector('.share-result dd')?.textContent.trim() !== '—',
  );
  async function shot(name) {
    await page.evaluate(() => {
      document.querySelector('#synthetic-label')?.remove();
      const d = document.createElement('div');
      d.id = 'synthetic-label';
      d.textContent = 'SYNTHETIC TEST DATA · NOT LIVE · NO GENUINE BASE ADMISSION';
      d.style.cssText =
        'background:#fff0ad;color:#362300;padding:12px;font:700 14px system-ui;position:relative;z-index:99999';
      document.body.prepend(d);
    });
    await fs.mkdir(join(T, 'screenshots'), { recursive: true });
    await page.screenshot({ path: join(T, 'screenshots', name), fullPage: true });
    receipt.images.push(name);
  }
  assert.deepEqual(receipt.errors, []);
  assert.equal(receipt.blockedExternal, 0);
  await shot('calculator-desktop-synthetic.png');
  await page.setViewportSize({ width: 390, height: 844 });
  await shot('calculator-mobile-synthetic.png');
  await page.goto(origin + '/');
  await page
    .getByRole('link', { name: 'Learn how these observations and calculations work' })
    .waitFor();
  await shot('home-mobile-synthetic.png');
  await page.setViewportSize({ width: 1440, height: 1080 });
  await shot('home-desktop-synthetic.png');
  assert.deepEqual(receipt.errors, []);
  assert.equal(receipt.blockedExternal, 0);
  receipt.status = 'PASS';
} catch (e) {
  receipt.status = 'FAIL';
  receipt.error = e.stack;
  process.exitCode = 1;
} finally {
  if (browser) await browser.close();
  if (child.connected) child.send('mainline-test-close');
  const result = await Promise.race([exit, delay(6000).then(() => null)]);
  if (!result) {
    child.kill();
    await exit;
    receipt.closeFailure = true;
    process.exitCode = 1;
  }
  receipt.child = { output, errors, exit: result };
  receipt.listenerSeconds = (performance.now() - start) / 1000;
  await fs.writeFile(
    join(T, 'evidence', 'BROWSER-' + Math.floor(performance.timeOrigin) + '.json'),
    JSON.stringify(receipt, null, 2),
  );
  console.log(JSON.stringify(receipt, null, 2));
}
