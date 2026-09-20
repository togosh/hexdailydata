import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdir } from 'node:fs/promises';
import { chromium } from 'playwright';

test('built website renders honest native-unavailable states on desktop and mobile', async () => {
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
    const evidence = process.env.HDD_V2_BROWSER_EVIDENCE ?? 'artifacts/task-07/smoke-' + Date.now();
    if (!/^artifacts\/task-\d{2}(\/[a-z0-9_-]+)*$/.test(evidence))
      throw new Error('Task-owned browser evidence required.');
    await mkdir(evidence, { recursive: true });
    for (const [name, width, height] of [
      ['desktop', 1440, 1000],
      ['mobile', 390, 844],
    ]) {
      await page.setViewportSize({ width, height });
      await page.goto(base);
      await page.getByText('Current native data is unavailable.', { exact: false }).waitFor();
      assert.equal(
        await page.getByRole('heading', { name: 'Your daily view', exact: true }).count(),
        1,
      );
      assert.equal(
        await page
          .locator('[data-metric] dd')
          .allTextContents()
          .then((values) => values.filter((v) => v === 'Unavailable').length),
        6,
      );
      assert.equal(
        await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth),
        true,
      );
      await page.screenshot({ path: `${evidence}/shell-${name}.png`, fullPage: true });
    }
    // Dialog controls must remain inside their own scrollport, not merely the page.
    // Navigation lives outside main and does not inherit its enlarged-text wrapping.
    for (const width of [390, 320]) {
      await page.setViewportSize({ width, height: 844 });
      for (const scale of ['100%', '200%']) {
        await page.evaluate(
          (fontSize) => (document.documentElement.style.fontSize = fontSize),
          scale,
        );
        for (const opener of ['Details', 'Open navigation menu']) {
          const trigger = page.getByRole('button', { name: opener, exact: true });
          await trigger.click();
          const dialog = page.getByRole('dialog');
          const close = dialog.getByRole('button', { name: 'Close', exact: true });
          await close.waitFor();
          const geometry = await close.evaluate((button) => {
            const modal = button.closest('dialog');
            const control = button.getBoundingClientRect(),
              box = modal.getBoundingClientRect();
            return {
              fits: control.left >= box.left && control.right <= box.right,
              scrollsHorizontally: modal.scrollWidth > modal.clientWidth,
            };
          });
          assert.deepEqual(
            geometry,
            { fits: true, scrollsHorizontally: false },
            `${opener} ${width}px ${scale}`,
          );
          await page.screenshot({
            path: `${evidence}/dialog-${opener === 'Details' ? 'details' : 'navigation'}-${width}-${scale.slice(0, -1)}.png`,
          });
          await page.keyboard.press('Escape');
          assert.equal(await trigger.evaluate((button) => document.activeElement === button), true);
        }
      }
    }
    await page.evaluate(() => (document.documentElement.style.fontSize = ''));
    await page.route('**/api/v2/home?*', (route) => route.fulfill({ status: 503, body: '{}' }));
    await page.reload();
    await page.getByText('Current native data is unavailable.', { exact: false }).waitFor();
    assert.equal(await page.locator('dd').first().textContent(), 'Unavailable');
    assert.deepEqual(errors, []);
    console.log(`Browser: ${browser.version()}; desktop/mobile and API failure states passed.`);
  } finally {
    await browser?.close();
    server.kill('SIGTERM');
    if (server.exitCode === null && server.signalCode === null) await once(server, 'exit');
  }
});
