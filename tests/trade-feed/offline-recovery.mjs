import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import { join } from 'node:path';
import net from 'node:net';
import tls from 'node:tls';
import dns from 'node:dns';
import http from 'node:http';
import https from 'node:https';
import { syncBuiltinESMExports } from 'node:module';
const deny = () => {
  throw Error('OFFLINE_NETWORK_DENIED');
};
net.connect =
  net.createConnection =
  net.Socket.prototype.connect =
  net.Server.prototype.listen =
    deny;
tls.connect = http.get = http.request = https.get = https.request = deny;
globalThis.fetch = deny;
for (const o of [dns, dns.promises])
  for (const k of Object.keys(o))
    if (k === 'lookup' || k.startsWith('resolve') || k === 'reverse') o[k] = deny;
syncBuiltinESMExports();
const C = String.raw`C:\Code\HEXDailyData-Subgraph-First-Launch-Proof-R2\btc-eth-current-reference-freshness-r2\operating-refresh-r1\offline-recovery-r1`;
const { sha, canonical } = await import('../../dist/services/source-update/generation.js');
const { productFiles, columns } = await import('../../dist/services/product-daily/project.js');
const { createMarketStorage, publishStoredMarket, planRetention, inspectStorage } =
  await import('../../dist/services/product-daily/storage.js');
const { sampleTrades } = await import('../../dist/services/product-daily/trades.js');
const { contractDayAt } = await import('../../dist/domain/day.js');
const { abortClosedTradePublication } =
  await import('../../scripts/trade-publication-recovery.mjs');
const put = (p, v) => fs.writeFile(p, canonical(v) + '\n');
const exists = async (p) => {
  try {
    await fs.stat(p);
    return true;
  } catch (e) {
    if (e.code === 'ENOENT') return false;
    throw e;
  }
};
async function fresh() {
  const root = await fs.mkdtemp(join(C, 'fixtures', 'closed-owner-'));
  await fs.mkdir(join(root, 'participants'));
  await fs.mkdir(join(root, 'session'));
  const date = '2026-10-10',
    time = date + 'T00:00:00Z',
    h = sha('synthetic'),
    owner = '11111111-1111-4111-8111-111111111111',
    pid = 38812;
  const pair = {
    generation: h,
    holderDatasetVersion: h,
    stakeDatasetVersion: h,
    baseObservedAtUtc: time,
    observedAtUtc: time,
    coverage: 'accepted_base_plus_observed_updates',
    holderRecordCount: 0,
    stakeStartRecordCount: 0,
  };
  const readings = (i) =>
    ['BTC', 'ETH'].map(
      (asset) =>
        sampleTrades(
          JSON.stringify([
            { date: String(Date.parse(time) / 1000 + i), tid: String(i), price: String(100 + i) },
          ]),
          asset,
          [],
        ).selected,
    );
  const row = Object.fromEntries(columns.map((k) => [k, null]));
  Object.assign(row, {
    dateUtc: date,
    contractDay: contractDayAt(BigInt(Date.parse(date) / 1000)),
    btcPriceUsd: '101',
    ethPriceUsd: '101',
    btcRecordedAtUtc: readings(1)[0].observedAtUtc,
    ethRecordedAtUtc: readings(1)[1].observedAtUtc,
  });
  const metadata = {
    schemaVersion: 'daily-product-1',
    methodRevision: 'utc-recorded-snapshot-primary-price-1',
    inputHashes: { synthetic: h },
    pair,
    ledgerObservedAtUtc: time,
    from: date,
    through: date,
    rows: 1,
    effectiveAtUtc: time,
    readings: readings(1),
    observations: readings(1),
    liquidityHistory: [],
    coverage: { snapshotDates: 0, ledgerDates: 0, priceDates: 0, structuralDates: 1, gaps: [] },
    priceSegments: [],
    methods: [],
    credits: 'Synthetic only',
  };
  const store = await createMarketStorage(
    join(root, 'product'),
    productFiles({ rows: [row], metadata, exceptions: [] }),
  );
  const writer = await store.acquireWriter();
  try {
    await publishStoredMarket(store, writer, {
      readings: readings(2),
      liquidityHistory: [],
      receiptSha256: h,
    });
  } finally {
    await store.releaseWriter(writer);
  }
  const selected = JSON.parse(await fs.readFile(join(store.root, 'CURRENT.json'))),
    previous = { generation: h, descriptorSha256: h, product: selected };
  const admission = {
    authorityTaskId: 'HDD-BTC-ETH-OPERATING-REFRESH-R1',
    jobRoot: join(root, 'session'),
    tradeProfileId: 'operating-16-slots-v1',
  };
  await put(join(root, 'session/ADMISSION.json'), admission);
  const audit = {
    status: 'QUALIFIED',
    cycle: 6,
    sessionAdmissionSha256: sha(await fs.readFile(join(root, 'session/ADMISSION.json'))),
  };
  await put(join(root, 'session/ROUND_6_AUDIT.json'), audit);
  const update = {
    readings: readings(3),
    liquidityHistory: [],
    receiptSha256: sha(await fs.readFile(join(root, 'session/ROUND_6_AUDIT.json'))),
  };
  await put(join(root, 'session/ROUND_6_UPDATE.json'), update);
  await put(join(root, 'participants/CURRENT.json'), previous);
  await put(join(root, 'participants/INTENT.json'), {
    kind: 'product',
    owner,
    previous,
    generation: h,
    descriptorSha256: h,
    productUpdate: update,
  });
  await put(join(root, 'participants/SELECTION.lock'), { owner, pid });
  await put(join(root, 'product/MARKET_REFRESH.lock'), {
    taskId: 'HDD-BTC-ETH-CURRENT-REFERENCE-FRESHNESS-R2',
    pid,
    output: join(root, 'session'),
  });
  await put(join(root, 'session/ACCOUNTING.json'), {
    status: 'CLOSED',
    pending: null,
    closureKnown: true,
    requests: [{ closed: true, native: { reaped: true, timeout: false, interrupted: null } }],
  });
  await put(join(root, 'session/TRIAL_FINAL.json'), {
    networkClosureKnown: true,
    publicationUncertain: true,
    networkSessionCount: 1,
  });
  await put(join(root, 'OWNER_CLOSURE.json'), {
    pid,
    known: true,
    errors: [],
    base: { known: true, errors: [] },
  });
  const paths = {
    intent: 'participants/INTENT.json',
    participantLock: 'participants/SELECTION.lock',
    participantCurrent: 'participants/CURRENT.json',
    marketLock: 'product/MARKET_REFRESH.lock',
    productCurrent: 'product/CURRENT.json',
    storage: 'product/STORAGE.json',
    certificate: `product/verified-${selected.version}.json`,
    accounting: 'session/ACCOUNTING.json',
    trial: 'session/TRIAL_FINAL.json',
    ownerClosure: 'OWNER_CLOSURE.json',
    update: 'session/ROUND_6_UPDATE.json',
    audit: 'session/ROUND_6_AUDIT.json',
    admission: 'session/ADMISSION.json',
  };
  const hashes = {};
  for (const [k, path] of Object.entries(paths))
    hashes[k] = sha(await fs.readFile(join(root, path)));
  const plan = {
    format: 'closed-trade-abort-1',
    root: join(root, 'participants'),
    productRoot: store.root,
    sessionRoot: join(root, 'session'),
    ownerClosurePath: join(root, 'OWNER_CLOSURE.json'),
    owner,
    pid,
    sequence: 1,
    cycle: 6,
    selected,
    pair,
    hashes,
    evidenceArchive: { synthetic: true },
  };
  return {
    root,
    plan,
    paths,
    refresh: async (key) => {
      plan.hashes[key] = sha(await fs.readFile(join(root, paths[key])));
    },
  };
}
if (process.argv[2] !== 'owner-guards') {
  const cases = [];
  for (const mode of [
    'success',
    'active',
    'unknown',
    'foreign-owner',
    'changed-pointer',
    'frontier',
    'journal',
    'pending',
    'retention',
    'destination',
    'concurrent',
    'hardlink',
    'late-pointer',
    'late-journal',
    'intent',
    'renamed-intent',
    'renamed-participantLock',
    'renamed-marketLock',
    'receipt',
  ]) {
    const f = await fresh(),
      p = f.plan;
    const before = await fs.readFile(join(p.productRoot, 'CURRENT.json'));
    let phase = async () => {};
    const mutate = async (key, fn, rehash = false) => {
      const file = join(f.root, f.paths[key]);
      const v = JSON.parse(await fs.readFile(file));
      fn(v);
      await put(file, v);
      if (rehash) await f.refresh(key);
    };
    const originalKill = process.kill;
    if (mode === 'active') process.kill = () => true;
    if (mode === 'unknown')
      process.kill = () => {
        throw Object.assign(Error('unknown'), { code: 'EPERM' });
      };
    if (mode === 'foreign-owner')
      await mutate('intent', (v) => (v.owner = '22222222-2222-4222-8222-222222222222'), true);
    if (mode === 'changed-pointer')
      await mutate('participantCurrent', (v) => (v.product.version = 'f'.repeat(64)));
    if (mode === 'frontier') await mutate('storage', (v) => v.sequence++, true);
    if (mode === 'journal')
      await fs.appendFile(join(p.productRoot, 'journal/00000000.ndjson'), '{}\n');
    if (mode === 'pending') await put(join(p.productRoot, 'PENDING.json'), {});
    if (mode === 'retention') await put(join(p.productRoot, 'RETENTION_PENDING.json'), {});
    if (mode === 'destination') await put(join(p.root, `CLOSED_INTENT-${p.owner}.json`), {});
    if (mode === 'concurrent') await put(join(p.root, 'RECOVERY.lock'), {});
    if (mode === 'hardlink')
      await fs.link(join(p.root, 'INTENT.json'), join(f.root, 'hardlink.json'));
    if (mode === 'late-pointer')
      phase = async (name) => {
        if (name === 'verified')
          await mutate('participantCurrent', (v) => (v.product.version = 'e'.repeat(64)));
      };
    if (mode === 'late-journal')
      phase = async (name) => {
        if (name === 'verified')
          await fs.appendFile(join(p.productRoot, 'journal/00000000.ndjson'), '{}\n');
      };
    if (
      [
        'intent',
        'renamed-intent',
        'renamed-participantLock',
        'renamed-marketLock',
        'receipt',
      ].includes(mode)
    )
      phase = async (name) => {
        if (name === mode) throw Error('INJECTED_INTERRUPTION:' + name);
      };
    let result, error;
    try {
      result = await abortClosedTradePublication(p, { phase });
    } catch (e) {
      error = String(e);
    } finally {
      process.kill = originalKill;
    }
    assert.deepEqual(await fs.readFile(join(p.productRoot, 'CURRENT.json')), before);
    const afterIntent = [
      'intent',
      'renamed-intent',
      'renamed-participantLock',
      'renamed-marketLock',
      'receipt',
    ].includes(mode);
    if (mode === 'success') {
      assert.equal(result.outcome, 'ABORTED_BEFORE_PRODUCT');
      for (const n of ['INTENT.json', 'SELECTION.lock', 'RECOVERY.lock'])
        assert(!(await exists(join(p.root, n))));
      assert(!(await exists(join(p.productRoot, 'MARKET_REFRESH.lock'))));
      assert(!(await exists(join(p.productRoot, 'SELECTION.lock'))));
      assert.equal(
        sha(await fs.readFile(join(p.root, `CLOSED_INTENT-${p.owner}.json`))),
        p.hashes.intent,
      );
      assert.equal((await inspectStorage(p.productRoot)).status, 'READABLE');
      await planRetention(p.productRoot);
      await assert.rejects(abortClosedTradePublication(p));
    } else {
      assert(error, mode);
      if (afterIntent) {
        assert(await exists(join(p.root, 'RECOVERY.lock')));
        assert(await exists(join(p.productRoot, 'SELECTION.lock')));
      } else {
        assert(await exists(join(p.root, 'INTENT.json')));
        assert(await exists(join(p.root, 'SELECTION.lock')));
        assert(await exists(join(p.productRoot, 'MARKET_REFRESH.lock')));
      }
    }
    cases.push({
      mode,
      root: f.root,
      error: error ?? null,
      result: result ?? null,
      productPointerUnchanged: true,
      interruptedExclusionRetained: afterIntent,
    });
  }
  await put(join(C, 'evidence/RECOVERY_TESTS.json'), {
    status: 'PASS',
    publicRequests: 0,
    baseAdmissions: 0,
    networkHardDenied: true,
    cases,
  });
  console.log('OFFLINE_RECOVERY_PASS ' + cases.length);
} else {
  const { literalLookup, finishRecoveryProof } = await import('./recovery-owner.mjs');
  const all = await new Promise((resolve) =>
    literalLookup('127.0.0.1', { all: true }, (e, a) => {
      assert.equal(e, null);
      resolve(a);
    }),
  );
  assert.deepEqual(all, [{ address: '127.0.0.1', family: 4 }]);
  await new Promise((resolve) =>
    literalLookup('127.0.0.1', (e, a, f) => {
      assert.equal(e, null);
      assert.equal(a, '127.0.0.1');
      assert.equal(f, 4);
      resolve();
    }),
  );
  for (const h of ['localhost', '::1', 'www.bitstamp.net', '127.0.0.2'])
    assert.throws(() => literalLookup(h, {}, () => {}), /OFFLINE_DNS_DENIED/);
  const cases = [];
  for (const mode of [
    'pass',
    'application-close-failure',
    'base-close-failure',
    'restore-failure',
    'missing-restore',
    'prior-failure',
  ]) {
    let restores = 0,
      baseCloses = 0;
    const r = await finishRecoveryProof(
      [
        [
          'application',
          async () => {
            if (mode === 'application-close-failure') throw Error('INJECTED_APP_CLOSE');
          },
        ],
      ],
      async () => {
        baseCloses++;
        if (mode === 'base-close-failure') throw Error('INJECTED_BASE_CLOSE');
      },
      mode === 'missing-restore'
        ? null
        : async () => {
            restores++;
            if (mode === 'restore-failure') throw Error('INJECTED_RESTORE');
          },
      mode === 'prior-failure' ? { error: 'INJECTED_PRIOR' } : null,
    );
    assert.equal(baseCloses, 1);
    if (mode === 'pass') {
      assert.equal(r.failure, null);
      assert(r.restoreCompleted);
    } else assert(r.failure, mode);
    if (['application-close-failure', 'prior-failure', 'missing-restore'].includes(mode))
      assert.equal(restores, 0);
    cases.push({ mode, restores, baseCloses, ...r });
  }
  await put(join(C, 'evidence/OWNER_GUARDS.json'), {
    status: 'PASS',
    publicRequests: 0,
    baseAdmissions: 0,
    listeners: 0,
    literalLookup: 'deterministic no DNS',
    cases,
  });
  console.log('OWNER_GUARDS_PASS');
}
