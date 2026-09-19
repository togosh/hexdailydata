import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdir } from 'node:fs/promises';
import { chromium } from 'playwright';

test('built React shell renders honest unavailable states on desktop and mobile', async () => {
  const server = spawn(process.execPath, ['dist/api/main.js'], {
    env: {
      ...process.env,
      HDD_V2_MODE: 'development',
      HDD_V2_ALLOW_LIVE_RPC: 'false',
      HDD_V2_HTTP_HOST: '127.0.0.1',
      HDD_V2_HTTP_PORT: '0',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let browser;
  let stderr = '';
  server.stderr.on('data', (chunk) => {
    stderr += chunk;
  });
  try {
    const base = await new Promise((resolve, reject) => {
      const timeout = setTimeout(
        () => reject(new Error(`API startup timed out: ${stderr}`)),
        10_000,
      );
      let stdout = '';
      server.stdout.on('data', (chunk) => {
        stdout += chunk;
        if (stdout.includes('\n')) {
          clearTimeout(timeout);
          resolve(`http://127.0.0.1:${JSON.parse(stdout.split('\n')[0]).port}`);
        }
      });
      server.once('error', (error) => {
        clearTimeout(timeout);
        reject(error);
      });
      server.once('exit', (code) => {
        clearTimeout(timeout);
        reject(new Error(`API exit ${code}: ${stderr}`));
      });
    });
    const channel = process.env.HDD_V2_BROWSER_CHANNEL ?? 'chrome';
    browser = await chromium.launch(channel === 'chromium' ? {} : { channel });
    const page = await browser.newPage();
    const errors = [];
    page.on('pageerror', (error) => errors.push(error.message));
    await page.route('**/*', (route) =>
      route
        .request()
        .url()
        .startsWith(base + '/')
        ? route.continue()
        : route.abort(),
    );
    await mkdir('artifacts/task-01', { recursive: true });
    for (const [name, width, height] of [
      ['desktop', 1280, 800],
      ['mobile', 390, 844],
    ]) {
      await page.setViewportSize({ width, height });
      await page.goto(base);
      await page.getByRole('status').filter({ hasText: 'Development API connected.' }).waitFor();
      assert.equal(
        await page.getByRole('heading', { name: 'HEXDailyData', exact: true }).count(),
        1,
      );
      assert.equal(
        await page
          .locator('dd')
          .allTextContents()
          .then((values) => values.filter((v) => v === 'Unavailable').length),
        4,
      );
      assert.equal(
        await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth),
        true,
      );
      await page.screenshot({ path: `artifacts/task-01/shell-${name}.png`, fullPage: true });
    }
    await page.route('**/api/v2/status', (route) => route.fulfill({ status: 503, body: '{}' }));
    await page.reload();
    await page.getByRole('status').filter({ hasText: 'Development API unavailable.' }).waitFor();
    assert.equal(await page.locator('dd').first().textContent(), 'Unavailable');
    assert.deepEqual(errors, []);
    console.log(`Browser: ${browser.version()}; desktop/mobile and API failure states passed.`);
  } finally {
    await browser?.close();
    server.kill('SIGTERM');
    if (server.exitCode === null && server.signalCode === null) await once(server, 'exit');
  }
});
