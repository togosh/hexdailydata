// A text-only correction within the original 15-minute preview campaign.
import assert from 'node:assert/strict';
import { readFile, writeFile, mkdir, copyFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { chromium } from 'playwright';
import { openProductDependencies } from '../../dist/services/product-daily/open.js';
import { fixture, charge } from '../market-feed/access-fixture.mjs';
const R = process.env.HDD_TASK_ROOT,
  folder = join(R, 'evidence/preview');
const old = JSON.parse(await readFile(join(R, 'evidence/FINAL_PREVIEW.json'))),
  deadline = Date.parse(old.startedAt) + 900000;
assert(Date.now() < deadline);
assert.equal(JSON.parse(await readFile(join(R, 'session/ACCOUNTING.json'))).status, 'CLOSED');
let deps, f, browser;
const receipt = {
  priorPreview: old,
  externalRequests: 0,
  finalScreenshots: 4,
  supersededTextOnlyImages: 2,
  originalDeadline: new Date(deadline).toISOString(),
};
try {
  deps = await openProductDependencies(
    JSON.parse(await readFile(join(R, 'PARTICIPANT_PROFILE.json'))),
  );
  f = await fixture(
    { ...deps, close: undefined },
    {
      webRoot: resolve('dist/web'),
      account: { webRoot: resolve('account/dist/ui'), register: async () => {} },
    },
  );
  f.controls.now = Date.now();
  f.app.server.on('connect', (_req, socket) => {
    charge();
    socket.destroy();
  });
  const origin = await f.app.listen({ host: '127.0.0.1', port: 0 });
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
  const context = await browser.newContext({
    viewport: { width: 1440, height: 1000 },
    serviceWorkers: 'block',
  });
  let blocked = 0;
  await context.route('**/*', async (route) => {
    charge();
    const u = new URL(route.request().url());
    if (u.origin !== origin || u.protocol !== 'http:') {
      blocked++;
      await route.abort();
    } else await route.continue();
  });
  await context.routeWebSocket('**/*', (ws) => {
    charge();
    blocked++;
    ws.close();
  });
  const page = await context.newPage(),
    errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await mkdir(join(R, 'evidence/preview-superseded'));
  for (const { name, path } of old.screenshots.slice(0, 2)) {
    assert(Date.now() < deadline);
    await page.goto(origin + path);
    await page.waitForLoadState('networkidle');
    assert(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1));
    if (path.startsWith('/address'))
      assert.match(
        await page.getByTestId('source-holder-balance').innerText(),
        /Saved source record \/ 6 Oct 2026/i,
      );
    await copyFile(join(folder, name), join(R, 'evidence/preview-superseded', name));
    await page.screenshot({ path: join(folder, name) });
  }
  assert.equal(blocked, 0);
  assert.deepEqual(errors, []);
  receipt.status = 'PASS';
  receipt.finishedAt = new Date().toISOString();
  receipt.campaignWallSeconds = (Date.now() - Date.parse(old.startedAt)) / 1000;
  await context.close();
} catch (e) {
  receipt.status = 'FAIL';
  receipt.error = String(e.stack ?? e);
  console.error(e);
  process.exitCode = 1;
} finally {
  if (browser) await browser.close();
  if (f) await f.close();
  if (deps) await deps.close();
  receipt.closed = true;
  await writeFile(
    join(R, 'evidence/PREVIEW_TEXT_CORRECTION.json'),
    JSON.stringify(receipt, null, 2) + '\n',
  );
}
console.log(
  JSON.stringify({
    status: receipt.status,
    campaignWallSeconds: receipt.campaignWallSeconds,
    closed: receipt.closed,
  }),
);
