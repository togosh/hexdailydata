// Run against `npm run dev` in a disposable source-only copy. No provider/DB input.
import assert from 'node:assert/strict';
import { mkdir, readFile, writeFile, realpath } from 'node:fs/promises';
import { resolve } from 'node:path';
import { setTimeout as pause } from 'node:timers/promises';
import { chromium } from 'playwright';

const [scratch, output] = process.argv.slice(2);
assert.ok(scratch && output, 'Pass the disposable source copy and a new evidence directory.');
assert.notEqual(await realpath(scratch), await realpath('.'));
assert.match(scratch, /HEXDailyData-v2-Task09-/);
assert.match(output.replaceAll('\\', '/'), /^artifacts\/task-09\/[a-z0-9_/-]+$/);
await mkdir(output, { recursive: true });
const base = 'http://127.0.0.1:4321';
const responses = [];
for (const [path, status, type] of [
  ['/', 200, /text\/html/],
  ['/api.ts', 200, /javascript/],
  ['/health/live', 200, /json/],
  ['/api/v2/home?chain=pulsechain', 503, /json/],
  ['/api/v2/status', 200, /json/],
]) {
  const response = await fetch(base + path);
  const body = await response.text();
  const contentType = response.headers.get('content-type');
  assert.equal(response.status, status, path);
  assert.match(contentType, type, path);
  if (path === '/api.ts') {
    assert.match(body, /export/);
    assert.doesNotMatch(body, /<!doctype|Route .* not found/i);
  }
  responses.push({ path, status: response.status, contentType, bytes: Buffer.byteLength(body) });
}
const browser = await chromium.launch({ channel: process.env.HDD_V2_BROWSER_CHANNEL ?? 'chrome' });
const page = await browser.newPage({ viewport: { width: 390, height: 844 } });
const errors = [],
  external = [];
page.on('pageerror', (error) => errors.push(error.message));
await page.route('**/*', (route) => {
  if (
    route
      .request()
      .url()
      .startsWith(base + '/')
  )
    return route.continue();
  external.push(route.request().url());
  return route.abort();
});
const homePath = resolve(scratch, 'src/web/Home.tsx');
const original = await readFile(homePath, 'utf8');
try {
  await page.goto(base);
  await page.getByRole('heading', { name: 'Your daily view', exact: true }).waitFor();
  await page.getByText('Current native data is unavailable.', { exact: false }).waitFor();
  await page.screenshot({ path: resolve(output, 'dev-home-mobile.png') });
  await page.evaluate(() => (window.__hmrWitness = 'same-document'));
  assert.ok(original.includes('Your daily view'));
  await writeFile(homePath, original.replace('Your daily view', 'Task09 HMR witness'));
  await page.getByRole('heading', { name: 'Task09 HMR witness', exact: true }).waitFor();
  assert.equal(await page.evaluate(() => window.__hmrWitness), 'same-document');
  // Separate the two writes across the filesystem watcher's change coalescing window.
  await pause(500);
  await writeFile(homePath, original);
  await page.getByRole('heading', { name: 'Your daily view', exact: true }).waitFor();
  await page.goto(base + '/learn');
  await page.getByRole('heading', { name: 'Learn HEX', exact: true }).waitFor();
  await page.screenshot({ path: resolve(output, 'dev-learn-mobile.png') });
  await page.reload();
  await page.getByRole('heading', { name: 'Learn HEX', exact: true }).waitFor();
  assert.deepEqual(errors, []);
  assert.deepEqual(external, []);
  await writeFile(
    resolve(output, 'results.json'),
    JSON.stringify(
      {
        status: 'PASS',
        browser: browser.version(),
        responses,
        hmr: 'same document; scratch edit restored',
        home: 'actual no-DB 503; static UI usable',
        learn: 'direct URL and refresh',
        errors,
        external,
      },
      null,
      2,
    ),
  );
  console.log('PASS actual Vite JavaScript/proxy, no-DB Home, direct Learn and reversible HMR');
} finally {
  await writeFile(homePath, original);
  await browser.close();
}
