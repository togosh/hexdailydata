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

export async function finalize({
  R,
  real,
  base,
  fixture,
  origin,
  save,
  seed,
  skipUnchanged = false,
  previewSeconds = 600,
}) {
  const held = real.capture(),
    product = held.product;
  try {
    preserveMarketHistory(seed, product);
    const quiet = {
      status: 'PASS',
      rows: product.rows.length,
      rowsSha256: sha(canonical(product.rows)),
      seedRowsSha256: sha(canonical(seed.rows)),
      liquidityBuckets: product.metadata.liquidityHistory.length,
      ledger: product.metadata.ledgerSegments,
      pair: product.metadata.pair,
      readingsSha256: sha(canonical(product.metadata.readings)),
      sourceCoverage: 'accepted_base_plus_observed_updates',
      fullTargetInventoryProven: false,
    };
    await save('QUIET_DATA_COMPARISON', quiet);
    const h = await base.read(
      'holders',
      { source: 'subgraph', chain: 'pulsechain', limit: 1 },
      {},
      new AbortController().signal,
      new (await import('../../dist/services/queries/cursor.js')).PageCursors(),
      Date.now(),
    );
    const s = await base.read(
      'stakes',
      { source: 'subgraph', chain: 'pulsechain', limit: 1 },
      {},
      new AbortController().signal,
      new (await import('../../dist/services/queries/cursor.js')).PageCursors(),
      Date.now(),
    );
    let holder = h.items[0].reported,
      stake = s.items[0].reported;
    const changes = [];
    for (let n = 1; n <= 1; n++) {
      const path = join(R, 'session', 'participants-1', `WINDOW_${n}_UPDATE.json`);
      if (!existsSync(join(R, 'session', 'participants-1', 'ADOPTION.json'))) break;
      const u = JSON.parse(await readFile(path));
      changes.push({
        window: n,
        base: u.base,
        target: u.target,
        counts: u.sourceCounts,
        categories: Object.fromEntries(
          Object.entries(u.changes).map(([f, es]) => [
            f,
            Object.fromEntries(
              ['new', 'replacement', 'unchanged_overlap'].map((k) => [
                k,
                es.filter((e) => e.kind === k).length,
              ]),
            ),
          ]),
        ),
        ends: u.changes.stakeStarts.filter((e) => e.changedFields.includes('stakeEnd')).length,
        goodAccounting: u.changes.stakeStarts.filter((e) =>
          e.changedFields.includes('stakeGoodAccounting'),
        ).length,
      });
      holder = u.changes.tokenHolders.find((e) => e.kind === 'replacement')?.after ?? holder;
      stake =
        u.changes.stakeStarts.find(
          (e) =>
            e.changedFields.includes('stakeEnd') || e.changedFields.includes('stakeGoodAccounting'),
        )?.after ?? stake;
    }
    const partialPage = join(R, 'session/participants-1/window-01/tokenHolders/00001.ndjson');
    if (existsSync(partialPage) && changes.length === 0) {
      const records = (await readFile(partialPage, 'utf8'))
        .trim()
        .split('\n')
        .filter(Boolean)
        .map(JSON.parse);
      const differences = [];
      for (const after of records) {
        const before = await held.sourceGenerations.bySourceId(
          'tokenHolders',
          after.id,
          new AbortController().signal,
        );
        const fields = before
          ? Object.keys(after).filter((k) => canonical(before.reported[k]) !== canonical(after[k]))
          : Object.keys(after);
        differences.push({
          id: after.id,
          before: before?.reported ?? null,
          after,
          kind: before ? (fields.length ? 'replacement' : 'unchanged_overlap') : 'new',
          changedFields: fields,
        });
      }
      await save('UNQUALIFIED_PARTIAL_DIFF', {
        qualified: false,
        published: false,
        coverageCredit: 0,
        reason: 'Incomplete first changed family; window controls were not completed',
        rows: differences.length,
        differences,
      });
    }
    const paths = [
      '/api/v2/live',
      '/api/v2/home',
      '/api/v2/daily?from=' +
        product.metadata.through +
        '&to=' +
        product.metadata.through +
        '&limit=2',
      '/api/v2/holders?limit=2',
      '/api/v2/stakes?limit=2',
      '/api/v2/addresses/' + holder.holderAddress,
      '/api/v2/stakes/' + stake.stakeId,
    ];
    const bodies = {};
    for (const path of paths) {
      const r = await fixture.inject(path);
      assert.equal(r.statusCode, 200, r.body);
      bodies[path] = r.json();
    }
    const csv = await wire(fixture.app, '/api/v2/downloads/' + product.bundleId + '/daily', [
      ['Authorization', auth().authorization],
    ]);
    assert.equal(csv.statusCode, 200);
    await writeFile(join(R, 'evidence/final-daily.csv'), csv.body);
    await save('FINAL_NORMAL_API', {
      bodies,
      changes,
      selected: real.status(),
      csv: { bytes: Buffer.byteLength(csv.body), sha256: sha(csv.body) },
      observation: product.metadata.pair.observedAtUtc,
    });
    let backup;
    const productSize = await guardStorage(real.productDaily.root, 0),
      participantSize = await guardStorage(real.root, 0);
    const finalReservation = 4 * (productSize.bytes + participantSize.bytes) + 64 * 1024 ** 2;
    await save('FINAL_STORAGE_RESERVATION', {
      productSize,
      participantSize,
      finalReservation,
      purpose: 'backup, genuine restore, separate synthetic derivative and packaging allowance',
    });
    await guardStorage(R, finalReservation);
    if (existsSync(join(R, 'participant-product-backup'))) {
      backup = JSON.parse(await readFile(join(R, 'evidence/BACKUP_IDENTITY.json')));
      const raw = await readFile(join(backup.destination, 'BACKUP.json'));
      assert.equal(sha(raw), backup.sha256);
      assert.equal(JSON.parse(raw).selected.generation, real.status().generation);
      assert.equal(JSON.parse(raw).selected.product.version, real.status().productVersion);
    } else {
      backup = await backupParticipants(real, join(R, 'participant-product-backup'));
      await save('BACKUP_IDENTITY', backup);
    }
    // During this one restore, all old writable runtime roots are denied; immutable bases remain allowed.
    const denied = [real.root, real.productDaily.root].map((p) => resolve(p)),
      originals = [];
    const blocked = (path) => {
      if (typeof path !== 'string' && !Buffer.isBuffer(path) && !(path instanceof URL)) return;
      const p = resolve(path instanceof URL ? fileURLToPath(path) : String(path));
      if (denied.some((d) => p === d || p.startsWith(d + sep)))
        throw Error('RESTORE_OLD_WRITABLE_ROOT_DENIED');
    };
    for (const object of [fs, fsp])
      for (const name of [
        'readFile',
        'readFileSync',
        'open',
        'openSync',
        'stat',
        'statSync',
        'lstat',
        'lstatSync',
        'realpath',
        'realpathSync',
        'readdir',
        'readdirSync',
        'access',
        'accessSync',
        'writeFile',
        'writeFileSync',
        'mkdir',
        'mkdirSync',
        'rename',
        'renameSync',
        'unlink',
        'unlinkSync',
      ]) {
        if (typeof object[name] !== 'function') continue;
        const original = object[name];
        originals.push([object, name, original]);
        object[name] = function (path, ...rest) {
          blocked(path);
          if (name.startsWith('rename')) blocked(rest[0]);
          return original.call(this, path, ...rest);
        };
      }
    syncBuiltinESMExports();
    let restored, rf, synthetic;
    try {
      restored = await restoreParticipants(
        backup.destination,
        join(R, 'restored-candidate'),
        backup.sha256,
        base,
      );
      rf = await makeFixture({
        participants: restored.registry,
        productDaily: restored.registry.productDaily,
        sourceGenerations: base,
      });
      rf.controls.now = fixture.controls.now;
      const comparable = (v) =>
        JSON.parse(
          JSON.stringify(v, (k, value) =>
            k === 'nextCursor' && value !== null ? 'cursor-present' : value,
          ),
        );
      for (const path of paths) {
        const r = await rf.inject(path);
        assert.equal(r.statusCode, 200, r.body);
        assert.deepEqual(comparable(r.json()), comparable(bodies[path]));
      }
      const restoredProduct = restored.registry.productDaily.capture();
      assert.equal(sha(restoredProduct.csv), sha(csv.body));
      await save('GENUINE_RESTORE_RESULT', {
        ...restored.receipt,
        deniedOldWritableRoots: denied,
        normalRoutesCompared: paths,
        csvSha256: sha(csv.body),
        selected: restored.registry.status(),
        externalBaseReadinessReused: true,
      });
      const syntheticRoot = join(R, 'temp', 'restore-synthetic');
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
      await save('RESTORE_RESULT', {
        ...restored.receipt,
        deniedOldWritableRoots: denied,
        normalRoutesCompared: paths,
        syntheticNextPublication: next.selected,
        syntheticNextNeverSelectedInActualRoot: true,
        externalBaseReadinessReused: true,
      });
    } finally {
      for (const [object, name, original] of originals) object[name] = original;
      syncBuiltinESMExports();
      if (rf) await rf.close();
      if (synthetic) await synthetic.close();
      if (restored) await restored.registry.close();
    }
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
  } finally {
    held.release();
  }
}
