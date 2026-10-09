import { deriveFixture } from './fixture-state.mjs';
import { guardStorage } from '../../scripts/refresh-data.mjs';
import assert from 'node:assert/strict';
import { readFile, writeFile, mkdir, lstat, cp } from 'node:fs/promises';
import fsp from 'node:fs/promises';
import fs, { existsSync } from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import { fileURLToPath } from 'node:url';
import { join, resolve, sep } from 'node:path';
import { chromium } from 'playwright';
import { canonical, sha } from '../../dist/services/source-update/generation.js';
import { preserveMarketHistory } from '../../dist/services/product-daily/market.js';
import { ParticipantRegistry } from '../../dist/services/source-update/refresh.js';
import {
  backupParticipants,
  restoreParticipants,
} from '../../scripts/participant-refresh-backup.mjs';
import { prepareWindow } from '../../scripts/participant-refresh.mjs';
import { fixture as makeFixture, auth, charge, wire } from '../market-feed/access-fixture.mjs';

// Post-closure local correction only. Never calls a collector or repeats the genuine restore.
import { openProductDependencies } from '../../dist/services/product-daily/open.js';
const R = process.env.HDD_TASK_ROOT;
const save = (name, v) =>
  writeFile(join(R, 'evidence', name + '_CORRECTED.json'), JSON.stringify(v, null, 2) + '\n', {
    flag: 'wx',
  });
const completion = {
  externalRequests: 0,
  genuineRestoreRepeated: false,
  frozenRuntimeUnchanged: true,
};
let deps, restored, synthetic, fixture;
try {
  const profile = JSON.parse(await readFile(join(R, 'PROFILE.json')));
  deps = await openProductDependencies(profile);
  const base = deps.sourceGenerations;
  const old = JSON.parse(await readFile(join(R, 'evidence/GENUINE_RESTORE_RESULT.json')));
  assert.equal(old.status, 'PASS');
  restored = {
    registry: await ParticipantRegistry.open(
      join(R, 'restored-candidate/participants'),
      join(R, 'restored-candidate/product'),
      base,
    ),
  };
  const originalPointer = await readFile(join(R, 'runtime/participants/CURRENT.json'));
  const syntheticRoot = join(R, 'temp', 'restore-synthetic-corrected-2');
  synthetic = await deriveFixture(restored.registry, syntheticRoot, base);
  // A derived fresh storage seed migrates on its first product publication.
  // This is fixture setup only; the genuine restored compact store is unchanged.
  const warm = structuredClone(
    synthetic.productDaily.capture().metadata.readings.find((r) => r.kind === 'gas'),
  );
  warm.observedAtUtc = new Date(
    Date.parse(synthetic.productDaily.capture().metadata.effectiveAtUtc) + 1000,
  ).toISOString();
  warm.gasPriceWei = String(BigInt(warm.gasPriceWei) + 1n);
  await synthetic.publishProduct({
    readings: [warm],
    liquidityHistory: [],
    receiptSha256: sha('SYNTHETIC restore seed migration'),
  });
  await synthetic.refresh(undefined, true);
  const current = synthetic.capture();

  const snapshot = current.sourceGenerations.identity.snapshot;
  const b = { number: snapshot.number, hash: snapshot.hash, timestamp: snapshot.timestamp };
  current.release();
  const target = {
    number: b.number + 1,
    hash: '0x' + sha('SYNTHETIC restore next window'),
    timestamp: b.timestamp + 10,
  };
  const document = {
    base: b,
    target,
    after: { tokenHolders: [], stakeStarts: [] },
    provenance: { tokenHolders: {}, stakeStarts: {} },
    sourceCounts: {
      tokenHolders: 0,
      stakeStarts: 0,
      stakeEnds: 0,
      stakeGoodAccountings: 0,
      affectedParents: 0,
    },
  };
  const draft = await prepareWindow(synthetic, document);
  const proof = {
    format: 'participant-window-proof-1',
    complete: true,
    base: b,
    target,
    deployment: snapshot.deployment,
    captureLedgerSha256: sha('SYNTHETIC'),
    afterSha256: { tokenHolders: sha('[]'), stakeStarts: sha('[]') },
    families: ['tokenHolders', 'stakeStarts', 'stakeEnds', 'stakeGoodAccountings'],
    explicitEmptyAndRepeats: true,
    parentChecks: true,
    witnessChecks: true,
    closingHeadersAndMetadata: true,
    networkClosureKnown: true,
  };
  const next = await synthetic.publish({ ...draft, proofSha256: sha(canonical(proof)) }, proof);
  await synthetic.refresh(undefined, true);
  assert.equal(synthetic.status().generation, next.selected.generation);
  assert.equal(synthetic.status().error, null);
  const quote = structuredClone(
    synthetic.productDaily.capture().metadata.readings.find((r) => r.kind === 'gas'),
  );
  quote.observedAtUtc = new Date(Date.parse(quote.observedAtUtc) + 1).toISOString();
  quote.gasPriceWei = String(BigInt(quote.gasPriceWei) + 1n);
  await synthetic.publishProduct({
    readings: [quote],
    liquidityHistory: [],
    receiptSha256: sha('SYNTHETIC restore mixed'),
  });
  await synthetic.refresh(undefined, true);
  assert.equal(synthetic.status().error, null);

  assert((await readFile(join(R, 'runtime/participants/CURRENT.json'))).equals(originalPointer));
  await save('SYNTHETIC_RESTORE_CORRECTION', {
    status: 'PASS',
    synthetic: true,
    root: syntheticRoot,
    genuineRestoreRepeated: false,
    nextParticipant: next.selected,
    mixedProduct: synthetic.status(),
    originalPointerUnchanged: true,
    setup:
      'New derived seed product migration, then participant, then gas. Original failed fixture retained.',
  });
  await synthetic.close();
  synthetic = null;
  await restored.registry.close();
  restored = null;
  fixture = await makeFixture(deps, {
    now: () => Date.now(),
    webRoot: resolve('dist/web'),
    account: { webRoot: resolve('account/dist/ui'), register: async () => {} },
  });
  const origin = await fixture.app.listen({ host: '127.0.0.1', port: 0 });
  const actual = await fixture.inject('/api/v2/live');
  assert.equal(actual.statusCode, 200);
  await save('FINAL_ACTUAL_CLOCK_API', {
    status: 'PASS',
    sampledAt: new Date().toISOString(),
    origin,
    pid: process.pid,
    body: actual.json(),
    continuousClock: true,
  });
  const evidence = JSON.parse(await readFile(join(R, 'evidence/FINAL_NORMAL_API.json')));
  const addressPath = Object.keys(evidence.bodies).find((p) => p.startsWith('/api/v2/addresses/'));
  const holder = { holderAddress: addressPath.split('/').at(-1) };
  const previewSeconds = 600;
  const preview = join(R, 'evidence/preview');
  await mkdir(preview);
  const started = Date.now(),
    deadline = started + previewSeconds * 1000,
    result = {
      screenshots: [],
      browserErrors: [],
      blocked: 0,
      startedAt: new Date(started).toISOString(),
    };
  let browser;
  const executable = [
    chromium.executablePath(),
    'C:/Program Files/Google/Chrome/Application/chrome.exe',
    'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
  ].find(existsSync);
  assert(executable);
  const timer = setTimeout(() => void browser?.close(), previewSeconds * 1000);
  try {
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
    await context.route('**/*', async (route) => {
      charge();
      const u = new URL(route.request().url());
      if (u.origin !== origin || u.protocol !== 'http:') {
        charge();
        result.blocked++;
        await route.abort();
      } else await route.continue();
    });
    await context.routeWebSocket('**/*', (ws) => {
      charge();
      result.blocked++;
      ws.close();
    });
    const page = await context.newPage();
    page.on('pageerror', (e) => result.browserErrors.push(e.message));
    const views = [
      ['01-home-desktop.png', '/', 1440],
      ['02-charts-desktop.png', '/charts', 1440],
      ['03-address-mobile.png', '/address/' + holder.holderAddress, 390],
      ['04-home-mobile.png', '/', 390],
    ];
    for (const [name, path, width] of views) {
      assert(Date.now() < deadline);
      await page.setViewportSize({ width, height: 1000 });
      await page.goto(origin + path);
      await page.waitForLoadState('networkidle');
      assert(
        await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1),
        'Horizontal overflow',
      );
      await page.screenshot({ path: join(preview, name) });
      result.screenshots.push({ name, path });
    }
    assert.deepEqual(result.browserErrors, []);
    await context.close();
    result.status = 'PASS';
  } catch (e) {
    result.status = 'FAIL';
    result.error = String(e.stack ?? e);
    throw e;
  } finally {
    clearTimeout(timer);
    if (browser) await browser.close();
    result.browserClosed = true;
    result.seconds = (Date.now() - started) / 1000;
    await save('FINAL_PREVIEW', result);
  }
  completion.status = 'PASS';
} catch (e) {
  completion.status = 'FAIL';
  completion.error = String(e.stack ?? e);
  process.exitCode = 1;
} finally {
  if (fixture) await fixture.close();
  if (synthetic) await synthetic.close();
  if (restored) await restored.registry.close();
  if (deps) await deps.close();
  completion.closed = true;
  completion.completedAt = new Date().toISOString();
  await save('FINAL_LOCAL_COMPLETION', completion);
}
console.log(JSON.stringify(completion));
