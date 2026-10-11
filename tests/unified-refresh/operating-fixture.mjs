// Real coordinator / native collectors / paired storage / API. No real bases or network.
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import { writeFileSync, readFileSync, existsSync } from 'node:fs';
import { resolve, join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import net from 'node:net';
import dns from 'node:dns';
import { syncBuiltinESMExports } from 'node:module';
import {
  SavedSourceGenerations,
  canonical,
  sha,
} from '../../dist/services/source-update/generation.js';
import { ParticipantRegistry, participantPair } from '../../dist/services/source-update/refresh.js';
import { ACCEPTED } from '../../dist/contracts/saved-generation.js';
import {
  createMarketStorage,
  auditJournal,
  verifyMarketCertificate,
} from '../../dist/services/product-daily/storage.js';
import { productFiles } from '../../dist/services/product-daily/project.js';
import { ProductDailyStore } from '../../dist/services/product-daily/store.js';
import { checkGuardCorrections } from './guard-checks.mjs';
import {
  RealOperatingClock,
  boundedOperatingConfig,
} from '../../scripts/unified-refresh/operating-authority.mjs';
const W = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const priorTask =
  'C:\\Code\\HEXDailyData-Subgraph-First-Launch-Proof-R2\\unified-refresh-integration-r2';
const read = async (p) => JSON.parse(await fs.readFile(p));
const put = async (p, v) => fs.writeFile(p, JSON.stringify(v, null, 2) + '\n', { flag: 'wx' });

export async function runFixture(taskRoot, mode = 'mixed', runUnified) {
  const T = resolve(taskRoot);
  assert(
    [
      priorTask,
      priorTask.replace('unified-refresh-integration-r2', 'repeatable-refresh-operations-r1'),
      priorTask.replace(
        'unified-refresh-integration-r2',
        'repeatable-refresh-public-qualification-r1',
      ),
      priorTask.replace(
        'unified-refresh-integration-r2',
        'unified-refresh-public-qualification-r4',
      ),
      priorTask.replace(
        'unified-refresh-integration-r2',
        'unified-refresh-public-qualification-r3',
      ),
      priorTask.replace(
        'unified-refresh-integration-r2',
        'unified-refresh-public-qualification-r2',
      ),
    ].includes(T),
  );
  assert(
    [
      'repeatable',
      'native-boundary',
      'operating-smoke',
      'operating-cancel-retry',
      'operating-cancel-physical',
      'operating-cancel-completion',
      'operating-parent-stop',
      'operating-receipt-failure',
      'operating-job-capacity',
      'operating-parent-death',
      'serial-blocked',
      'r4-all',
      'result-limit',
      'result-over',
      'legacy',
      'length',
      'malformed',
      'truncated',
      'r3-final',
      'mixed',
      'qualification',
      'no-body',
      'no-body-retry',
      'hash',
      'duplicate',
      'exit',
      'missing',
      'budget',
      'cancel',
      'cancel-active',
      'exhaust',
      'before-product',
      'after-product',
      'participant-stage',
      'acknowledgement',
      'unknown-product',
      'policy-clock',
      'policy-payout',
      'prepare-delay',
      'admission-delay',
      'cancel-prepared',
      'prepare-within',
      'prepare-reserve',
    ].includes(mode),
  );
  const root = await fs.mkdtemp(join(T, 'fixtures/operating-' + mode + '-'));
  const operatingSmall = mode.startsWith('operating-');
  const boundary = mode === 'native-boundary';
  await fs.mkdir(join(root, 'evidence'));
  process.env.HDD_TASK_ROOT = root;
  const NativeDate = Date,
    realNow = performance.now.bind(performance);
  let now = Date.parse('2026-10-10T23:53:00Z');
  globalThis.Date = class extends NativeDate {
    constructor(...a) {
      super(...(a.length ? a : [now]));
    }
    static now() {
      return now;
    }
  };
  Object.defineProperty(performance, 'now', { configurable: true, value: () => now });
  if (boundary) {
    globalThis.Date = NativeDate;
    Object.defineProperty(performance, 'now', { configurable: true, value: realNow });
    now = NativeDate.now();
  }
  const deny = () => {
    throw Error('DENIED_EXTERNAL_NETWORK');
  };
  const originals = {
    open: fs.open,
    connect: net.Socket.prototype.connect,
    lookup: dns.lookup,
    promiseLookup: dns.promises.lookup,
    fetch: globalThis.fetch,
  };
  dns.promises.lookup = deny;
  dns.lookup = (host, options, callback) => {
    if (host !== '127.0.0.1') return deny();
    const cb = typeof options === 'function' ? options : callback;
    queueMicrotask(() =>
      options?.all ? cb(null, [{ address: '127.0.0.1', family: 4 }]) : cb(null, '127.0.0.1', 4),
    );
  };
  globalThis.fetch = deny;
  net.Socket.prototype.connect = function (...args) {
    const o = args[0];
    if (typeof o !== 'object' || o.host !== '127.0.0.1') return deny();
    return originals.connect.apply(this, args);
  };
  const clock = boundary
    ? new RealOperatingClock()
    : {
        mode: 'SYNTHETIC',
        now: () => now / 1000,
        sleep: async (n) => {
          now += n * 1000;
        },
        synchronize: (t) => {
          // JSON source seconds can carry microseconds; Date.parse closes at ms.
          assert(t * 1000 >= now - 2);
          now = Math.max(now, t * 1000);
        },
      };
  const h = sha('tiny immutable synthetic bases; no production records');
  const empty = (name) => ({
    root: join(root, name),
    lowerBound: async () => 0,
    rowAt: async () => null,
    close: async () => {},
    byAddress: async () => null,
    byNumericId: async () => null,
  });
  const base = new SavedSourceGenerations(
    join(root, 'base-overlay'),
    empty('holders'),
    empty('stakes'),
  );
  for (const name of ['base-overlay', 'holders', 'stakes']) await fs.mkdir(join(root, name));
  base.selected = ACCEPTED.generation;
  base.overlay = {
    holders: new Map(),
    stakes: new Map(),
    addresses: new Map(),
    numeric: new Map(),
    owners: new Map(),
    newHolders: [],
    newStakes: [],
    index: '',
    files: {},
  };
  base.consecutive = {
    generation: ACCEPTED.generation,
    deployment: ACCEPTED.deployment,
    target: {
      number: ['r3-final', 'r4-all'].includes(mode) ? 27758521 : 27754425,
      hash: '0x' + sha('synthetic base pin'),
      timestamp: 1791560565,
    },
    // Required descriptor compatibility counters, not loaded/source-census rows.
    familyVersions: { tokenHolders: h, stakeStarts: h },
    holderRecordCount: 664435,
    stakeStartRecordCount: 954715,
    updateFileSha256: h,
    updateSha256: h,
  };
  let writer,
    reader,
    lagging,
    held,
    heldExport,
    app,
    children = new Set();
  const starts = [],
    facts = [];
  let operatingTradeJobs = 0;
  let listenerStart = null,
    localRequests = 0,
    observedLocalBytes = 0,
    chargedLocalBytes = 0;
  const receipt = {
    synthetic: true,
    root,
    mode,
    externalRequests: 0,
    genuineBaseAdmissions: 0,
    seedInitializations: 0,
    networkDenied: true,
    baseSeam: 'Two empty immutable bases, real SavedSourceGenerations consecutiveFork',
    cases: [],
  };
  try {
    const template = await read(join(T, 'fixtures/template.json'));
    template.metadata.pair = participantPair(base);
    const store = await createMarketStorage(join(root, 'product'), productFiles(template));
    const standalone = new ProductDailyStore(store.root, template.metadata.pair);
    await standalone.load();
    let beforePublication = standalone.capture();
    writer = await ParticipantRegistry.initialize(join(root, 'participants'), store, base);
    if (
      [
        'before-product',
        'after-product',
        'participant-stage',
        'acknowledgement',
        'unknown-product',
      ].includes(mode)
    ) {
      const publish = writer.publishProduct.bind(writer);
      writer.publishProduct = (u, options) =>
        publish(u, {
          ...options,
          fault: async (phase) => {
            if (mode === 'unknown-product' && phase === 'before-product') {
              await put(join(store.root, 'PENDING.json'), { syntheticUnknown: true });
              throw Error('SYNTHETIC_UNKNOWN_PRODUCT');
            }
            if (phase === mode) throw Error('SYNTHETIC_INTERRUPTION_' + phase);
          },
        });
    }
    reader = await ParticipantRegistry.open(writer.root, store.root, base);
    lagging = await ParticipantRegistry.open(writer.root, store.root, base);
    held = lagging.capture();
    const initialCsv = Buffer.from(held.product.csv),
      initialRows = structuredClone(held.product.rows);
    heldExport = lagging.productDaily.openExport(
      held.product,
      held.product.bundleId,
      'daily',
      new AbortController().signal,
    );
    const { fixture, auth } = await import('../market-feed/access-fixture.mjs');
    app = await fixture(
      {
        participants: reader,
        productDaily: reader.productDaily,
        sourceGenerations: base,
      },
      ['qualification', 'r3-final', 'r4-all'].includes(mode)
        ? {
            evidenceRoot: join(root, 'evidence'),
            webRoot: join(W, 'dist/web'),
            account: { webRoot: join(W, 'account/dist/ui'), register: async () => {} },
          }
        : {},
    );
    const inject = app.inject.bind(app);
    app.inject = async (...args) => {
      assert(++localRequests <= (mode === 'repeatable' ? 512 : 128), 'FIXTURE_LOCAL_REQUEST_BOUND');
      const url = typeof args[0] === 'string' ? args[0] : args[0].url;
      const reserve = url.includes('/downloads/') ? 5 * 1024 ** 2 : 128 * 1024;
      chargedLocalBytes += reserve;
      const response = await inject(...args);
      observedLocalBytes += Buffer.byteLength(response.body);
      assert(Buffer.byteLength(response.body) <= reserve, 'METHOD_RESPONSE_BOUND');
      assert(observedLocalBytes <= 16 * 1024 ** 2, 'FIXTURE_LOCAL_BYTES');
      return response;
    };
    const origin = await app.app.listen({ host: '127.0.0.1', port: 0 });
    listenerStart = realNow();
    const getLive = async () => {
      assert(realNow() - listenerStart < 900000);
      if (boundary) now = NativeDate.now();
      app.controls.now = now;
      const r = await app.inject('/api/v2/live');
      assert.equal(r.statusCode, 200, r.body.slice(0, 200));
      const body = r.json();
      return {
        datasetVersion: body.datasetVersion,
        servedAtUtc: body.servedAtUtc,
        btcPriceUsd: body.btcPriceUsd,
        ethPriceUsd: body.ethPriceUsd,
        freshness: body.freshness,
        participant: reader.status().generation,
        readerStatus: reader.status(),
        sequence: reader.productDaily.capture().metadata.marketStorage?.sequence,
      };
    };
    const onAdoption = async (selected, check) => {
      check();
      const live = await getLive();
      if (mode === 'repeatable' || boundary)
        return {
          ...live,
          expectedSelected: selected.product.version,
          immediateAdoption:
            live.datasetVersion === selected.product.version
              ? 'ADOPTED'
              : 'WAITING_NORMAL_ONE_SECOND_READER_POLL',
        };
      assert.equal(
        live.datasetVersion,
        selected.product.version,
        JSON.stringify(live.readerStatus),
      );
      const after = writer.productDaily.capture();
      if (mode === 'policy-clock' || mode === 'policy-payout') {
        await standalone.refresh(now);
        assert.equal(standalone.reloadStatus().error, null);
        assert.equal(standalone.capture().version, after.version);
        if (
          (mode === 'policy-clock' && after.metadata.marketStorage.sequence === 2) ||
          (mode === 'policy-payout' && after.metadata.coverage.ledgerDates === 2503)
        )
          receipt.guardChecks = await checkGuardCorrections(
            store.root,
            beforePublication,
            after,
            mode === 'policy-clock' ? 'clock' : 'payout',
          );
      }
      beforePublication = after;
      return live;
    };
    const profile = ['r3-final', 'r4-all'].includes(mode)
      ? {
          ...(await read(join(T, 'packet/PUBLIC_PROFILE.json'))),
          format: 'unified-five-feed-offline-1',
          mode: 'OFFLINE_ONLY',
        }
      : await read(join(W, 'config/unified-refresh-offline.json'));
    if (mode === 'r3-final')
      for (const j of profile.jobs)
        j.enabled = ['trade-15', 'trade-16', 'participants-1'].includes(j.id);
    if (mode === 'policy-clock') profile.jobs = profile.jobs.slice(0, 2);
    else if (mode === 'policy-payout') profile.jobs = profile.jobs.slice(0, 4);
    else if (!['mixed', 'qualification', 'r3-final', 'r4-all'].includes(mode))
      profile.jobs = profile.jobs.slice(0, 1);
    if (mode === 'budget') {
      profile.jobs = [
        profile.jobs[0],
        {
          ...structuredClone(profile.jobs[0]),
          id: 'trade-2',
          tradeSlot: 2,
          due: 60,
          deadline: 660,
        },
      ];
      profile.parent.httpAttempts = 3;
      profile.parent.httpExtras = 0;
      profile.parent.httpChargedBytes = 3 * 2162688;
      for (const j of profile.jobs)
        Object.assign(j.bounds, { httpAttempts: 3, httpExtras: 0, httpChargedBytes: 3 * 2162688 });
    }
    if (mode === 'exhaust') {
      const market = {
        ...profile.jobs[0],
        id: 'market-1',
        family: 'market',
        due: 0,
        tradeSlot: undefined,
        bounds: (await read(join(W, 'config/unified-refresh-offline.json'))).jobs.find(
          (j) => j.family === 'market',
        ).bounds,
      };
      profile.jobs = [
        market,
        { ...profile.jobs[0], due: 100, deadline: 700 },
        { ...market, id: 'market-2', due: 160, deadline: 760 },
      ];
    }
    if (mode === 'serial-blocked') {
      const whole = await read(join(W, 'config/unified-refresh-offline.json'));
      const market = structuredClone(whole.jobs.find((j) => j.family === 'market'));
      const part = structuredClone(whole.jobs.find((j) => j.family === 'participants'));
      const trade = structuredClone(whole.jobs.find((j) => j.family === 'trade'));
      Object.assign(market, { due: 0, deadline: 600 });
      Object.assign(part, { due: 30, deadline: 1830 });
      Object.assign(trade, { due: 60, deadline: 660 });
      profile.jobs = [market, part, trade];
    }
    const ac = new AbortController();
    if (mode === 'cancel') ac.abort();
    if (['prepare-delay', 'cancel-prepared', 'prepare-within', 'prepare-reserve'].includes(mode)) {
      const refresh = writer.refresh.bind(writer);
      let first = true;
      writer.refresh = async (...args) => {
        await refresh(...args);
        if (!first) return;
        first = false;
        if (mode === 'cancel-prepared') ac.abort();
        else
          now += (mode === 'prepare-within' ? 30 : mode === 'prepare-reserve' ? 550 : 200) * 1000;
      };
    }
    if (mode === 'prepare-reserve') profile.jobs[0].maximumStartLag = 590;
    if (mode === 'admission-delay') {
      let delayed = false;
      clock.now = () => {
        if (!delayed && existsSync(join(root, 'session/trade-1/ADMISSION.json'))) {
          delayed = true;
          now += 200000;
        }
        return now / 1000;
      };
    }
    const spawnFixture = (_exe, args, options) => {
      assert(
        children.size < (mode === 'repeatable' || boundary ? 5 : 1),
        'BOUNDED_NATIVE_CHILDREN',
      );
      const jobRoot = args.at(-1),
        a = JSON.parse(readFileSync(join(jobRoot, 'ADMISSION.json')));
      const selected = writer.productDaily.capture();
      const tradeOrdinal = a.family === 'trade' ? ++operatingTradeJobs : 0;
      const config = {
        codeBody: join(T, 'fixtures/protocol-code.json'),
        actualMain:
          mode === 'repeatable' ||
          operatingSmall ||
          mode === 'serial-blocked' ||
          T.endsWith('unified-refresh-public-qualification-r4'),
        ...(operatingSmall
          ? {
              noBodyRetry: !['operating-cancel-physical', 'operating-parent-death'].includes(mode),
              physicalPause: ['operating-cancel-physical', 'operating-parent-death'].includes(mode),
            }
          : {}),
        ...(mode === 'repeatable' && a.family === 'market' ? { parserDelay: 110 } : {}),
        ...(mode === 'repeatable' &&
        a.family === 'market' &&
        starts.filter((x) => x.job.startsWith('market-')).length === 0
          ? { graphRetries: 1 }
          : {}),
        ...(mode === 'repeatable' && a.family === 'trade' ? { responseCookie: true } : {}),
        ...(boundary
          ? {
              realClockBoundary: true,
              tradeMode: tradeOrdinal === 1 ? 'empty' : 'fresh',
              delay: a.family === 'participants' ? 121 : 0,
            }
          : {}),
        ...(mode === 'repeatable' && tradeOrdinal === 1 ? { noBodyRetry: true } : {}),
        ...(mode === 'r3-final'
          ? { closureAuthority: 'HDD-UNIFIED-REFRESH-PUBLIC-QUALIFICATION-R3' }
          : {}),
        ...(mode === 'policy-clock' && a.family === 'market' ? { marketLag: 220 } : {}),
        ...(mode === 'cancel-active' ? { pauseBeforeCollect: true } : {}),
        previousTrades: Object.fromEntries(
          selected.metadata.readings.filter((r) => r.kind === 'trade').map((r) => [r.asset, r]),
        ),
        ...(a.tradeSlot === 2
          ? { tradeMode: 'empty' }
          : a.tradeSlot === 3
            ? { tradeMode: 'repeat' }
            : {}),
        ...(a.tradeSlot === 6 ? { retry: true } : {}),
        ...(a.tradeSlot === 16 ? { largeResult: true } : {}),
        ...(mode === 'repeatable' && tradeOrdinal === 2 ? { tradeMode: 'repeat' } : {}),
        ...(mode === 'repeatable' && tradeOrdinal >= 3 && tradeOrdinal <= 8
          ? { emptyETH: true }
          : {}),
        ...(mode === 'repeatable' && tradeOrdinal === 17 ? { largeResult: true } : {}),
        ...(a.family === 'participants'
          ? {
              delay: boundary ? 121 : mode === 'repeatable' ? 405 : 400,
              ...(mode === 'repeatable' ? { auditDelay: 75 } : {}),
            }
          : {}),
        ...([
          'hash',
          'duplicate',
          'exit',
          'missing',
          'legacy',
          'length',
          'malformed',
          'truncated',
        ].includes(mode)
          ? { closure: mode, largeResult: mode !== 'legacy' }
          : {}),
        ...(['result-limit', 'result-over'].includes(mode)
          ? { exactResultBytes: mode === 'result-limit' ? 524288 : 524289 }
          : {}),
        ...(mode === 'exhaust' ? { exhaust: true } : {}),
        ...(mode === 'no-body' ? { noBody: true } : {}),
        ...(mode === 'no-body-retry' ? { noBodyRetry: true } : {}),
      };
      writeFileSync(join(jobRoot, 'FIXTURE.json'), JSON.stringify(config) + '\n', { flag: 'wx' });
      const child = spawn(
        'python',
        [
          '-I',
          '-S',
          join(
            W,
            boundary
              ? 'tests/unified-refresh/operating-boundary-native.py'
              : 'tests/unified-refresh/operating-native.py',
          ),
          jobRoot,
        ],
        options,
      );
      if (mode === 'cancel-active') setTimeout(() => ac.abort(), 150);
      children.add(child);
      if (operatingSmall)
        writeFileSync(
          join(jobRoot, 'SYNTHETIC_NATIVE_PID.json'),
          JSON.stringify({ pid: child.pid, parent: process.pid }) + '\n',
          { flag: 'wx' },
        );
      child.once('close', () => children.delete(child));
      if (operatingSmall && mode !== 'operating-smoke') {
        let buffered = '';
        child.stdout.on('data', (bytes) => {
          buffered += bytes.toString();
          const lines = buffered.split('\n');
          buffered = lines.pop();
          for (const line of lines) {
            let m;
            try {
              m = JSON.parse(line);
            } catch {
              continue;
            }
            if (
              (mode === 'operating-cancel-retry' &&
                m.type === 'operating-wait' &&
                m.seconds >= 2) ||
              (mode === 'operating-cancel-completion' && m.type === 'closed') ||
              (mode === 'operating-parent-stop' && m.type === 'operating-permit')
            )
              ac.abort();
          }
        });
        if (mode === 'operating-cancel-physical') {
          const timer = setInterval(() => {
            if (existsSync(join(jobRoot, '01/PHYSICAL_STARTED.json'))) {
              clearInterval(timer);
              ac.abort();
            }
          }, 5);
          child.once('close', () => clearInterval(timer));
        }
      }
      starts.push({ job: a.job, pid: child.pid, clock: now });
      return child;
    };
    let configuration;
    if (boundary) configuration = boundedOperatingConfig(clock.now(), true);
    if (mode === 'operating-receipt-failure') {
      fs.open = async (path, ...args) => {
        if (String(path).endsWith('NATIVE_CLOSURE.json'))
          throw Error('SYNTHETIC_FAILURE_RECEIPT_WRITE');
        return originals.open(path, ...args);
      };
      syncBuiltinESMExports();
    }
    if (operatingSmall) {
      configuration = await read(join(T, 'fixtures/OPERATING_CONFIG.json'));
      configuration.expiresAt = configuration.startsAt + 1801;
      for (const [f, v] of Object.entries(configuration.families)) {
        v.enabled = f === 'trade';
        v.period = 600;
      }
      if (mode === 'operating-job-capacity') {
        configuration.storage.jobs = 1;
        configuration.families.market.enabled = true;
      }
    }
    const result = await runUnified({
      taskRoot: root,
      registry: writer,
      onAdoption,
      spawnChild: spawnFixture,
      profile,
      configuration,
      clock,
      onFact: async (j, r) => {
        const f = await getLive();
        facts.push({ job: j.id, ...f });
        return f;
      },
      signal: ac.signal,
      ...(boundary ? { mode: 'DENIED_NETWORK_TEST', until: configuration.startsAt + 62 } : {}),
    });
    receipt.result = result;
    receipt.starts = starts;
    if (boundary) {
      assert.equal(
        result.status,
        'OFFLINE_OPERATING_COMPLETE',
        JSON.stringify(result).slice(-6000),
      );
      assert.equal(result.accounting.status, 'CLOSED');
      assert.equal(result.maximumPublicationWriters, 1);
      assert.equal(result.accounting.maxPhysical, 1);
      assert.deepEqual([...new Set(result.jobs.map((j) => j.family))].sort(), [
        'gas',
        'market',
        'participants',
        'protocol',
        'trade',
      ]);
      const part = result.jobs.find((j) => j.family === 'participants');
      assert(result.jobs.some((j) => j.family === 'trade' && j.completedAt < part.completedAt));
      receipt.completionMatrix = [];
      for (const j of result.jobs) {
        const jr = join(root, 'operating', j.job),
          r = await read(join(jr, 'COORDINATOR_RESULT.json'));
        const native = await read(join(jr, 'NATIVE_CLOSURE.json'));
        assert(
          native.exit.code === 0 &&
            !native.killed &&
            !native.closureProtocolError &&
            !native.ipcError &&
            native.closedMessageReceived &&
            native.resultMatchesClosedMessage &&
            native.accountingMatchesResult &&
            native.accountingClosed &&
            native.pending === null &&
            !r.error,
          JSON.stringify({ native, error: r.error }),
        );
        assert(r.source.status.startsWith('COMPLETE_'), JSON.stringify(r.source).slice(-3500));
        receipt.completionMatrix.push({
          job: j.job,
          family: j.family,
          status: j.status,
          emitter: await read(join(jr, 'COMPLETION_EMITTER.json')),
          native,
        });
      }
      receipt.cases = [
        'actual five-family native emitter/parser/publisher/storage/reader',
        'real epoch/local monotonic conversion',
        '121-second IPC wait with other-feed progress',
        'actual child wait before physical settlement',
        'empty trade completion',
      ];
    } else if (mode === 'r4-all') {
      assert.equal(starts.length, 23);
      receipt.completionMatrix = await Promise.all(
        starts.map(async (s) => ({
          job: s.job,
          ...(await read(join(root, 'session', s.job, 'COMPLETION_EMITTER.json'))),
          native: await read(join(root, 'session', s.job, 'NATIVE_CLOSURE.json')),
        })),
      );
      assert(
        receipt.completionMatrix.every(
          (m) => m.formatter === 'scripts/unified-refresh/offline_profile.py:closed_frame',
        ),
      );
      receipt.admissionSeam =
        'Exact R4 jobs/timing/caps translated only to OFFLINE_ONLY/unified-five-feed-offline-1; exact public documents tested separately; real public paths reject injected transports/clocks.';
    }
    receipt.facts = facts;
    if (operatingSmall) {
      assert.equal(children.size, 0);
      if (['operating-smoke', 'operating-job-capacity'].includes(mode)) {
        assert.equal(result.status, 'OFFLINE_OPERATING_COMPLETE', result.failure);
        assert.equal(result.jobs[0].status, 'QUALIFIED_ADOPTED');
        assert.equal(result.accounting.totals.http.attempts, 4);
        assert.equal(result.accounting.totals.http.extras, 1);
        const first = await read(join(root, 'operating', result.jobs[0].job, '01/AUDIT.json'));
        assert(first.closed && !first.complete && first.networkConnectionBegan);
        assert.equal(first.chargedObjects, 20000);
        if (mode === 'operating-job-capacity') {
          assert.equal(result.accounting.completed, 1);
          assert.equal(starts.length, 1);
          assert.equal(result.accounting.feeds.market.quarantine, 'OPERATING_JOB_BOUND');
        }
        const selected = writer.productDaily.capture();
        const download = '/api/v2/downloads/' + selected.bundleId + '/daily';
        const { keys } = await import('../market-feed/access-fixture.mjs');
        assert(
          [401, 403].includes(
            (await app.inject({ url: download, headers: auth(keys.invalid) })).statusCode,
          ),
        );
        const { applyMarketUpdate } = await import('../../dist/services/product-daily/market.js');
        const oldTrade = selected.metadata.readings.find((r) => r.kind === 'trade');
        const older = {
          ...oldTrade,
          observedAtUtc: new Date(Date.parse(oldTrade.observedAtUtc) - 1000).toISOString(),
        };
        assert.throws(() =>
          applyMarketUpdate(
            { ...selected, exceptions: [] },
            {
              readings: [older],
              liquidityHistory: [],
              receiptSha256: sha('SYNTHETIC regression refusal'),
            },
          ),
        );
        const { prepareWindow } = await import('../../scripts/participant-refresh.mjs');
        const h = writer.capture();
        const priorPin = { ...h.sourceGenerations.identity.snapshot };
        h.release();
        await assert.rejects(
          prepareWindow(writer, {
            base: {
              number: priorPin.number - 1,
              hash: priorPin.hash,
              timestamp: priorPin.timestamp,
            },
          }),
          /IMMEDIATELY_SELECTED_BASE/,
        );
        assert.equal(writer.status().productVersion, selected.version);
        receipt.affectedGuards = [
          'invalid synthetic key refused',
          'source-time regression refused',
          'different participant predecessor refused',
          'selected product preserved',
        ];
      } else {
        assert.equal(result.status, 'PARTIAL');
        assert.match(result.failure, /CANCEL|TERMINAL|UNKNOWN|Error/);
        assert.equal(result.accounting.status, 'UNKNOWN');
      }
      receipt.operatingFocused = {
        mode,
        status: result.status,
        completed: result.accounting.completed,
        pending: result.accounting.pending,
      };
    } else if (mode === 'serial-blocked') {
      const part = result.jobs.find((j) => j.family === 'participants');
      const trade = result.jobs.find((j) => j.family === 'trade');
      assert(part && trade, JSON.stringify(result).slice(-2000));
      assert.equal(part.status, 'QUALIFIED');
      assert.equal(trade.status, 'SKIPPED');
      assert.equal(starts.length, 2);
      receipt.counterexample = {
        testedCoordinator: 'runUnified whole-job await',
        fastFeedBeforeParticipantCompleted: false,
        dueTradeSkipped: true,
        decisiveProgressAssertionWouldFail: true,
      };
    } else if (mode === 'repeatable') {
      // The operating control/result holds bounded references, never all lifetime source reports.
      for (const j of result.jobs) {
        const raw = await fs.readFile(join(root, 'operating', j.receipt.file));
        assert.equal(sha(raw), j.receipt.sha256);
        j.result = JSON.parse(raw);
      }
      assert.equal(
        result.status,
        'OFFLINE_OPERATING_COMPLETE',
        JSON.stringify(result).slice(-5000),
      );
      assert(
        result.jobs.every(
          (j) =>
            j.status === 'QUALIFIED_ADOPTED' ||
            (j.family === 'trade' &&
              !j.result.error &&
              j.result.source.status.startsWith('COMPLETE_')),
        ),
        'NO_UNEXPECTED_NATIVE_FAILURE',
      );
      assert.equal(result.maximumPublicationWriters, 1);
      assert.equal(result.accounting.maxPhysical, 1);
      assert.equal(children.size, 0);
      const part = result.jobs.find((j) => j.family === 'participants');
      assert(part, 'ACTUAL_PARTICIPANT_REQUIRED');
      assert(
        result.jobs.filter((j) => j.family === 'trade' && j.completedAt < part.completedAt)
          .length >= 3,
        'OTHER_FEEDS_DURING_PARTICIPANT_WAIT',
      );
      assert(
        result.jobs.some((j) => j.family === 'gas' && j.completedAt < part.completedAt),
        'GAS_DURING_WAIT',
      );
      assert.equal(part.status, 'QUALIFIED_ADOPTED');
      assert(
        result.jobs.some(
          (j) =>
            j.family === 'market' &&
            j.startedAt < part.completedAt &&
            j.completedAt > part.completedAt &&
            j.status === 'QUALIFIED_ADOPTED',
        ),
        'PARTICIPANT_ADVANCE_BEFORE_COLLECTED_PRODUCT_PUBLICATION',
      );
      assert(
        facts.filter((f) => f.job.startsWith('timeline-')).length >= 20,
        'INDEPENDENT_TIMELINE',
      );
      assert(result.jobs.filter((j) => j.family === 'trade').length > 16, 'MORE_THAN_LEGACY_16');
      assert(
        facts.some(
          (f) =>
            f.job.startsWith('timeline-') &&
            f.freshness.ETH.status === 'stale' &&
            f.ethPriceUsd !== null,
        ),
        'HONEST_EMPTY_PAIR_AGING',
      );
      assert(
        facts.filter((f) => f.job.startsWith('timeline-')).at(-1).freshness.ETH.status === 'fresh',
        'RECOVERY_MEASURED',
      );
      const partRoot = join(root, 'operating', part.job),
        auditWait = await read(join(partRoot, 'AUDIT_WAIT.json'));
      assert(
        result.jobs.some(
          (j) =>
            j.family === 'trade' &&
            j.completedAt > auditWait.startedAt &&
            j.completedAt < auditWait.endedAt &&
            j.publication === 'changed',
        ),
        'PRICE_ADVANCE_DURING_PARTICIPANT_AUDIT',
      );
      const physical = [];
      for (const j of result.jobs) {
        const jr = join(root, 'operating', j.job);
        const ledger =
          j.family === 'trade'
            ? j.result.source.accounting.requests
            : (await fs.readFile(join(jr, 'LEDGER.jsonl'), 'utf8'))
                .trim()
                .split('\n')
                .map(JSON.parse);
        for (const row of ledger) {
          const p =
            j.family === 'trade'
              ? join(jr, String(row.attempt).padStart(2, '0'))
              : join(jr, 'captures', String(row.attempt).padStart(5, '0'));
          const start = await read(join(p, 'PHYSICAL_STARTED.json')),
            end = await read(join(p, 'PHYSICAL_CLOSED.json'));
          assert.equal(start.nonce, end.nonce);
          physical.push({ job: j.job, start: start.at, end: end.closedAt, permit: start.permit });
          const q = await read(join(p, 'request.json'));
          assert(
            !('headers' in q) && !('cookies' in q) && !('authorization' in q),
            'NO_OUTGOING_REPLAY',
          );
        }
      }
      physical.sort((a, b) => a.permit - b.permit);
      for (let i = 1; i < physical.length; i++)
        assert(physical[i].start >= physical[i - 1].end + 1, 'INDEPENDENT_PHYSICAL_SERIAL_PACING');
      receipt.physicalMeasurement = {
        requests: physical.length,
        maximumConcurrent: 1,
        intervals: physical,
        source: 'actual common worker physical-entry/closure receipts and exclusive physical lock',
      };
      await lagging.refresh(undefined, true);
      assert.equal(lagging.status().error, null);
      assert.equal(lagging.status().productVersion, writer.status().productVersion);
      const final = lagging.productDaily.capture();
      await verifyMarketCertificate(store.root, final);
      const chunks = [];
      for await (const b of heldExport.stream) chunks.push(b);
      await heldExport.released;
      heldExport = null;
      assert.equal(sha(Buffer.concat(chunks)), sha(initialCsv));
      for (const old of initialRows.filter((r) => r.dateUtc <= '2026-10-09')) {
        const row = final.rows.find((r) => r.dateUtc === old.dateUtc);
        for (const k of ['btcPriceUsd', 'ethPriceUsd', 'btcRecordedAtUtc', 'ethRecordedAtUtc'])
          assert.equal(row[k], old[k]);
      }
      const url = '/api/v2/downloads/' + final.bundleId + '/daily';
      assert.notEqual((await app.inject(url)).statusCode, 200);
      const csv = await app.inject({ url, headers: auth() });
      assert.equal(csv.statusCode, 200);
      assert.equal(csv.body, final.csv.toString());
      assert.equal((await app.inject({ url, method: 'HEAD', headers: auth() })).statusCode, 200);
      receipt.journal = await auditJournal(store.root);
      receipt.storage = await read(join(store.root, 'STORAGE.json'));
      receipt.cases = [
        'actual native five families',
        'cooperative physical permits',
        'serialized actual paired storage',
        '405-second participant wait',
        'delayed market',
        'independent timeline API',
        'held CSV and missed-generation adoption',
      ];
      process.env.HDD_TASK_ROOT = T;
      const { finalProof } = await import('../../scripts/unified-refresh/final-proof.mjs');
      const { createBudget } = await import('../trade-feed/budget.mjs');
      const { restoreProof } = await import('../trade-feed/final.mjs');
      process.env.HDD_TASK_ROOT = T;
      const budget = createBudget(join(root, 'evidence'), {
        attempts: 200,
        bytes: 256 * 1024 ** 2,
        apiSeconds: 900,
      });
      const save = (name, value) =>
        put(join(root, 'evidence', 'SYNTHETIC_' + name + '.json'), {
          ...value,
          synthetic: true,
          genuineBaseAdmissions: 0,
        });
      heldExport = lagging.productDaily.openExport(
        held.product,
        held.product.bundleId,
        'daily',
        new AbortController().signal,
      );
      const proof = await finalProof({
        T: root,
        real: writer,
        seed: held.product,
        f: app,
        heldExport,
        save,
        synthetic: true,
      });
      heldExport = null;
      await fs.mkdir(join(root, 'temp'));
      await restoreProof({
        R: root,
        profile: { productRoot: store.root, participantRoot: writer.root },
        final: proof,
        save,
        admittedBase: base,
        budget,
        baseAdmissionCount: 0,
      });
      receipt.finalizationAccounting = budget.snapshot();
      receipt.finalization = 'SYNTHETIC_BACKUP_RESTORE_PASS';
    } else if (['mixed', 'qualification', 'r3-final', 'r4-all'].includes(mode)) {
      assert.equal(
        result.status,
        'OFFLINE_PROFILE_COMPLETE',
        result.failure ?? JSON.stringify(result.jobs.at(-1)),
      );
      assert.equal(result.accounting.status, 'CLOSED');
      assert.equal(children.size, 0);
      await lagging.refresh(undefined, true);
      assert.equal(lagging.status().error, null);
      assert.equal(lagging.status().productVersion, writer.status().productVersion);
      const final = lagging.productDaily.capture();
      await verifyMarketCertificate(store.root, final);
      const state = await read(join(store.root, 'STORAGE.json'));
      if (mode !== 'r3-final') assert(state.segment >= 1);
      assert(state.generations.length <= 2);
      assert.equal(sha(held.product.csv), sha(initialCsv));
      const chunks = [];
      for await (const b of heldExport.stream) chunks.push(b);
      await heldExport.released;
      assert.equal(sha(Buffer.concat(chunks)), sha(initialCsv));
      heldExport = null;
      // Exact fixed closes, original oracle values/times, and quiet ledger remain unchanged.
      for (const old of initialRows.filter((r) => r.dateUtc <= '2026-10-09')) {
        const row = final.rows.find((r) => r.dateUtc === old.dateUtc);
        for (const k of ['btcPriceUsd', 'ethPriceUsd', 'btcRecordedAtUtc', 'ethRecordedAtUtc'])
          assert.equal(row[k], old[k]);
      }
      const daily = await app.inject('/api/v2/daily?from=2026-10-10&to=2026-10-11&limit=10');
      assert.equal(daily.statusCode, 200, daily.body);
      const url = '/api/v2/downloads/' + final.bundleId + '/daily';
      assert.notEqual((await app.inject(url)).statusCode, 200);
      const csv = await app.inject({ url, headers: auth() });
      assert.equal(csv.statusCode, 200, csv.body.slice(0, 200));
      assert.equal(csv.body, final.csv.toString());
      const head = await app.inject({ url, method: 'HEAD', headers: auth() });
      assert.equal(head.statusCode, 200);
      assert.equal(head.body, '');
      assert(facts.some((f) => f.freshness.BTC.status === 'stale'));
      assert.equal(
        facts.at(-1).freshness.BTC.status,
        ['r3-final', 'r4-all'].includes(mode) ? 'stale' : 'fresh',
      );
      if (mode !== 'r3-final')
        assert.equal(result.jobs.find((j) => j.job === 'trade-2').publication, 'retained');
      if (mode !== 'r3-final')
        assert.equal(result.jobs.find((j) => j.job === 'trade-3').publication, 'no-op');
      assert.equal(result.jobs.find((j) => j.job === 'participants-1').publication, 'changed');
      for (const n of mode === 'r3-final' ? [15, 16] : [1, 4, 6, 15, 16])
        assert(await fs.stat(join(root, `session/trade-${n}/WINDOW_${n}_UPDATE.json`)));
      assert((await fs.stat(join(root, 'session/trade-16/RESULT.json'))).size > 32768);
      receipt.journal = await auditJournal(store.root);
      receipt.storage = state;
      receipt.cases =
        mode === 'r3-final'
          ? [
              'actual late trade slots 15/16 and basename captures',
              'final consecutive participant collector/auditor/paired publication',
              'unchanged quiet prices and honest aging after participant wait',
              'held and lagging readers, full CSV/access, native compact closure',
            ]
          : [
              'five native collector families',
              '16 finite trade slots',
              'empty/no-op/stale/newer',
              'UTC boundary',
              'real paired participant transition',
              'held export',
              'lagging ordinary reader',
              'retention/rotation',
              'Daily/protected CSV/HEAD',
              'large compact native closure',
            ];
      if (['qualification', 'r3-final', 'r4-all'].includes(mode)) {
        const { finalProof } = await import('../../scripts/unified-refresh/final-proof.mjs');
        process.env.HDD_TASK_ROOT = T;
        const { createBudget } = await import('../trade-feed/budget.mjs');
        const { restoreProof, previews } = await import('../trade-feed/final.mjs');
        const budget = createBudget(join(root, 'evidence'), {
          attempts: 200,
          bytes: 256 * 1024 ** 2,
          apiSeconds: 900,
        });
        const save = (name, value) => put(join(root, 'evidence', name + '.json'), value);
        heldExport = lagging.productDaily.openExport(
          held.product,
          held.product.bundleId,
          'daily',
          new AbortController().signal,
        );
        const proof = await finalProof({
          T: root,
          real: writer,
          seed: held.product,
          f: app,
          heldExport,
          save,
          synthetic: true,
        });
        heldExport = null;
        await fs.mkdir(join(root, 'temp'));
        if (mode === 'qualification') await previews({ R: root, origin, save, f: app, budget });
        // Same restore orchestration, with previous mutable roots actively denied.
        await restoreProof({
          R: root,
          profile: { productRoot: store.root, participantRoot: writer.root },
          final: proof,
          save,
          admittedBase: base,
          budget,
          baseAdmissionCount: 0,
        });
        receipt.finalization = 'PASS';
        receipt.finalizationAccounting = budget.snapshot();
      }
    } else if (
      [
        'hash',
        'duplicate',
        'exit',
        'missing',
        'legacy',
        'length',
        'malformed',
        'truncated',
        'unknown-product',
        'cancel-active',
        'result-over',
      ].includes(mode)
    ) {
      assert.equal(result.status, 'PARTIAL');
      assert.equal(result.networkClosureKnown, false);
      assert(await fs.stat(join(store.root, 'MARKET_REFRESH.lock')));
      if (mode === 'legacy') {
        const native = await read(join(root, 'session/trade-1/NATIVE_CLOSURE.json'));
        assert.equal(native.ipcError, 'Error: CLOSED_RESULT_IDENTITY');
        assert((await fs.stat(join(root, 'session/trade-1/RESULT.json'))).size < 32768);
      }
      receipt.cases = ['unknown closure retained/refused'];
    } else {
      assert.equal(result.accounting.status, 'CLOSED');
      receipt.cases = [mode];
      if (mode === 'result-limit') {
        assert.equal(result.status, 'OFFLINE_PROFILE_COMPLETE');
        assert.equal((await fs.stat(join(root, 'session/trade-1/RESULT.json'))).size, 524288);
      }
      if (mode === 'no-body') {
        assert.equal(result.status, 'PARTIAL');
        assert.equal(result.accounting.attempts, 1);
        assert.equal(result.accounting.httpChargedBytes, 2162688);
        assert.equal(result.accounting.chargedEntities, 20000);
        assert.equal(result.accounting.returnedEntities, 0);
        assert.equal(result.accounting.unknownEntityReservations, 20000);
        assert.equal(writer.status().productVersion, held.product.version);
        assert.equal(existsSync(join(root, 'session/trade-1/01/response.body')), false);
      }
      if (mode === 'no-body-retry') {
        assert.equal(result.status, 'OFFLINE_PROFILE_COMPLETE');
        assert.equal(result.accounting.attempts, 4);
        assert.equal(result.accounting.httpExtras, 1);
        assert.equal(result.accounting.httpChargedBytes, 4 * 2162688);
        assert.equal(result.accounting.unknownEntityReservations, 20000);
        assert.notEqual(writer.status().productVersion, held.product.version);
        assert.equal(existsSync(join(root, 'session/trade-1/01/response.body')), false);
      }
      if (mode.startsWith('policy-')) {
        assert.equal(result.status, 'OFFLINE_PROFILE_COMPLETE');
        assert.equal(receipt.guardChecks?.status, 'PASS');
      }
      if (['before-product', 'after-product', 'participant-stage'].includes(mode))
        assert(await fs.stat(join(root, 'session/trade-1/OWNED_RECOVERY.json')));
      if (mode === 'acknowledgement')
        assert(await fs.stat(join(root, 'session/trade-1/COMMITTED_REPORTING_FAILURE.json')));
      if (mode === 'budget') {
        assert.equal(starts.length, 1);
        assert(result.jobs.some((j) => j.reason === 'PARENT_OR_CLOSURE_RESERVE'));
      }
      if (mode === 'cancel') assert.equal(starts.length, 0);
      if (
        ['prepare-delay', 'admission-delay', 'cancel-prepared', 'prepare-reserve'].includes(mode)
      ) {
        assert.equal(starts.length, 0);
        assert.equal(result.accounting.attempts, 0);
        assert.equal(result.accounting.pending, null);
        const skipped = await read(join(root, 'session/trade-1/DISPATCH_SKIPPED.json'));
        assert.equal(skipped.closure, 'NO_CHILD');
        assert.equal(
          skipped.reason,
          mode === 'cancel-prepared'
            ? 'CANCELLED_DURING_PREPARATION'
            : mode === 'prepare-reserve'
              ? 'PREPARATION_CONSUMED_RESERVE'
              : 'MISSED_DUE_DURING_PREPARATION',
        );
        assert.equal(
          result.status,
          mode === 'cancel-prepared' ? 'CANCELLED' : 'OFFLINE_PROFILE_COMPLETE',
        );
        assert.equal(existsSync(join(root, 'session/trade-1/ACCOUNTING.json')), false);
      }
      if (mode === 'prepare-within') {
        assert.equal(result.status, 'OFFLINE_PROFILE_COMPLETE');
        assert.equal(starts.length, 1);
        assert.equal(result.jobs[0].startedOffset, 30);
        const admission = await read(join(root, 'session/trade-1/ADMISSION.json'));
        assert.equal(
          admission.deadlineUnixSeconds,
          NativeDate.parse('2026-10-11T00:03:00Z') / 1000,
        );
        assert.equal(admission.deadlineUnixSeconds - starts[0].clock / 1000, 570);
      }
      if (mode === 'exhaust') {
        assert.deepEqual(result.disabledFeeds, ['market']);
        assert.equal(starts.length, 2);
      }
    }
    receipt.status = 'PASS';
  } catch (e) {
    receipt.status = 'FAIL';
    receipt.failure = String(e);
    receipt.stack = e.stack;
    await put(join(root, 'evidence/INITIAL_FAILURE.json'), { error: String(e), stack: e.stack });
    throw e;
  } finally {
    if (heldExport) {
      heldExport.stream.destroy();
      await heldExport.released.catch(() => {});
    }
    held?.release();
    if (app) await app.close();
    for (const child of children) {
      const closed = new Promise((resolve) => child.once('close', resolve));
      child.kill();
      await closed;
    }
    receipt.closeErrors = [];
    for (const [name, resource] of [
      ['lagging', lagging],
      ['reader', reader],
      ['writer', writer],
      ['base', base],
    ]) {
      try {
        await resource?.close();
      } catch (e) {
        receipt.closeErrors.push({ name, error: String(e) });
      }
    }
    receipt.resources = {
      nativeChildrenRemaining: children.size,
      apiClosed: !app?.app.server.listening,
      listenerMilliseconds: listenerStart === null ? 0 : realNow() - listenerStart,
      localRequests,
      observedLocalBytes,
      chargedLocalBytes,
    };
    globalThis.Date = NativeDate;
    Object.defineProperty(performance, 'now', { configurable: true, value: realNow });
    net.Socket.prototype.connect = originals.connect;
    dns.lookup = originals.lookup;
    dns.promises.lookup = originals.promiseLookup;
    globalThis.fetch = originals.fetch;
    fs.open = originals.open;
    syncBuiltinESMExports();
    await put(join(root, 'evidence/RESULT.json'), receipt);
    console.log(JSON.stringify({ status: receipt.status, root, mode, failure: receipt.failure }));
  }
  return 0;
}
