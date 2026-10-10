// Network-denied, tiny synthetic participant identity; REAL registry and storage.
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import { join } from 'node:path';
import {
  T,
  put,
  admission,
  fixtureRoot,
  capture,
  sampleTrades,
  publishTrade,
  checkTradeService,
  tradeProfile,
  validateOperatingScope,
} from './operating-policy.mjs';
import { finishRecoveryProof, literalLookup } from './recovery-owner.mjs';
const { ParticipantRegistry, participantPair } =
  await import('../../dist/services/source-update/refresh.js');
const { ProductDailyStore } = await import('../../dist/services/product-daily/store.js');
const { productFiles, columns } = await import('../../dist/services/product-daily/project.js');
const { createMarketStorage, auditJournal, inspectStorage, verifyMarketCertificate } =
  await import('../../dist/services/product-daily/storage.js');
const { ACCEPTED } = await import('../../dist/contracts/saved-generation.js');
const { sha } = await import('../../dist/services/source-update/generation.js');
const { contractDayAt } = await import('../../dist/domain/day.js');
assert.equal(process.argv[2], 'r2');
assert.equal(admission.authorityTaskId, 'HDD-BTC-ETH-OPERATING-REFRESH-R2');
const scope = JSON.parse(await fs.readFile(join(T, 'packet/SCOPE.json')));
assert.equal(validateOperatingScope(scope).cycles, 16);
assert.equal(
  tradeProfile({ ...admission, authorityTaskId: 'HDD-BTC-ETH-OPERATING-REFRESH-R1' }).cycles,
  16,
);
assert.equal(tradeProfile({}).cycles, 3);
assert.throws(() =>
  tradeProfile({ ...admission, authorityTaskId: 'HDD-BTC-ETH-OPERATING-REFRESH-R3' }),
);
const NativeDate = Date;
let now = Date.parse('2026-10-10T20:00:00Z');
globalThis.Date = class extends NativeDate {
  constructor(...a) {
    super(...(a.length ? a : [now]));
  }
  static now() {
    return now;
  }
};
const root = await fixtureRoot('actual-all-slots-'),
  h = sha('explicit tiny synthetic identity');
let baseCloses = 0;
const base = {
  root: join(root, 'synthetic-base-not-a-serving-dataset'),
  selection: ACCEPTED.generation,
  identity: {
    generation: ACCEPTED.generation,
    familyVersions: { tokenHolders: h, stakeStarts: h },
    holderRows: 0,
    stakeRows: 0,
    snapshot: { observedAtUtc: '2026-10-09T00:00:00Z' },
  },
  close: async () => {
    baseCloses++;
  },
};
const pair = participantPair(base),
  date = '2026-10-10';
const values = (ordinal) =>
  ['BTC', 'ETH'].map(
    (asset) =>
      sampleTrades(
        JSON.stringify([
          {
            date: String(now / 1000 - 1),
            tid: String(10000 + ordinal),
            price: String((asset === 'BTC' ? 80000 : 2500) + ordinal),
          },
        ]),
        asset,
        [],
      ).selected,
  );
const initial = values(0),
  row = Object.fromEntries(columns.map((k) => [k, null]));
Object.assign(row, {
  dateUtc: date,
  contractDay: contractDayAt(BigInt(Date.parse(date) / 1000)),
  btcPriceUsd: initial[0].value,
  ethPriceUsd: initial[1].value,
  btcRecordedAtUtc: initial[0].observedAtUtc,
  ethRecordedAtUtc: initial[1].observedAtUtc,
});
const metadata = {
  schemaVersion: 'daily-product-1',
  methodRevision: 'utc-recorded-snapshot-primary-price-1',
  inputHashes: { synthetic: h },
  pair,
  ledgerObservedAtUtc: initial[0].observedAtUtc,
  from: date,
  through: date,
  rows: 1,
  effectiveAtUtc: initial[0].observedAtUtc,
  readings: initial,
  observations: initial,
  liquidityHistory: [],
  coverage: { snapshotDates: 0, ledgerDates: 0, priceDates: 0, structuralDates: 1, gaps: [] },
  priceSegments: [],
  methods: [],
  credits: 'SYNTHETIC all-slot storage fixture; no genuine base records',
};
let writer, reader, held, heldExport;
const results = [];
try {
  const store = await createMarketStorage(
    join(root, 'product'),
    productFiles({ rows: [row], metadata, exceptions: [] }),
  );
  writer = await ParticipantRegistry.initialize(join(root, 'participants'), store, base);
  for (let i = 1; i <= 28; i++) {
    now += 1000;
    await writer.publishProduct({ readings: values(i), liquidityHistory: [], receiptSha256: h });
    await writer.refresh(undefined, true);
  }
  assert.equal(writer.productDaily.capture().metadata.marketStorage.sequence, 28);
  const beforeState = JSON.parse(await fs.readFile(join(store.root, 'STORAGE.json')));
  reader = await ParticipantRegistry.open(writer.root, store.root, base);
  held = reader.capture();
  const oldVersion = held.product.version,
    oldCsvSha = sha(held.product.csv);
  heldExport = reader.productDaily.openExport(
    held.product,
    held.product.bundleId,
    'daily',
    new AbortController().signal,
  );
  let attempt = 0;
  for (let cycle = 1; cycle <= 16; cycle++) {
    now += 60000;
    const readings = values(28 + cycle),
      m = { cycle, expiresAtUnixSeconds: now / 1000 + 30 };
    for (const asset of ['BTC', 'ETH']) {
      const r = readings.find((v) => v.asset === asset);
      m[asset.toLowerCase()] = await capture(root, ++attempt, `${asset}_${cycle}`, [
        { date: String(Date.parse(r.observedAtUtc) / 1000), tid: r.tradeId, price: r.value },
      ]);
    }
    const result = await publishTrade(
      writer.productDaily,
      root,
      m,
      () => true,
      (u, beforeCommit, captureReference) =>
        writer.publishProduct(u, { beforeCommit, captureReference }),
      [],
    );
    assert(result.changed);
    await writer.refresh(undefined, true);
    await reader.refresh(performance.now() + cycle * 2000);
    assert.equal(reader.status().error, null);
    assert.equal(reader.status().productVersion, result.selected.version);
    const view = reader.capture();
    const live = reader.productDaily.live(view.product, now),
      service = checkTradeService(live, view.product, now, now);
    assert.equal(service.status, 'FRESH');
    await verifyMarketCertificate(store.root, view.product);
    assert.equal(view.product.metadata.marketStorage.sequence, 28 + cycle);
    view.release();
    const state = JSON.parse(await fs.readFile(join(store.root, 'STORAGE.json')));
    const journal = await auditJournal(store.root);
    assert.equal(journal.sequence, 28 + cycle);
    assert(state.generations.length <= 2 && state.pins.length === 0);
    assert.equal(sha(held.product.csv), oldCsvSha);
    const event = (
      await fs.readFile(
        join(store.root, 'journal', String(state.segment).padStart(8, '0') + '.ndjson'),
        'utf8',
      )
    )
      .trim()
      .split('\n')
      .map(JSON.parse)
      .at(-1);
    assert.equal(event.captureReference.update, `WINDOW_${cycle}_UPDATE.json`);
    assert.equal(event.captureReference.audit, `WINDOW_${cycle}_AUDIT.json`);
    results.push({
      cycle,
      sequence: state.sequence,
      segment: state.segment,
      retainedGenerations: state.generations.length,
      publication: result,
      service,
    });
  }
  const last = reader.productDaily.capture();
  assert.equal((await auditJournal(store.root)).sequence, 44);
  const afterState = JSON.parse(await fs.readFile(join(store.root, 'STORAGE.json')));
  assert(afterState.segment > beforeState.segment);
  assert(afterState.reclaimedBytes > beforeState.reclaimedBytes);
  await assert.rejects(fs.stat(join(store.root, oldVersion)), (e) => e.code === 'ENOENT');
  const chunks = [];
  for await (const b of heldExport.stream) chunks.push(b);
  await heldExport.released;
  assert.equal(sha(Buffer.concat(chunks)), oldCsvSha);
  // Each branch below uses real publication/storage on its own synthetic capture,
  // retaining the same selected view for empty/repeat/stale observations.
  const behaviors = [];
  for (const mode of ['empty', 'repeat', 'stale', 'newer']) {
    const output = await fixtureRoot('actual-behavior-' + mode + '-');
    if (mode === 'stale') now += 300001;
    if (mode === 'newer') now = Math.ceil(now / 1000) * 1000 + 1000;
    const selected = writer.productDaily.capture();
    const readings = mode === 'newer' ? values(100) : selected.metadata.readings;
    const m = { cycle: 1, expiresAtUnixSeconds: now / 1000 + 30 };
    for (const [i, asset] of ['BTC', 'ETH'].entries()) {
      const r = readings.find((v) => v.asset === asset);
      m[asset.toLowerCase()] = await capture(
        output,
        i + 1,
        `${asset}_1`,
        mode === 'empty' && asset === 'ETH'
          ? []
          : [{ date: String(Date.parse(r.observedAtUtc) / 1000), tid: r.tradeId, price: r.value }],
      );
    }
    const result = await publishTrade(
      writer.productDaily,
      output,
      m,
      () => true,
      (u, beforeCommit, captureReference) =>
        writer.publishProduct(u, { beforeCommit, captureReference }),
      [],
    );
    await writer.refresh(undefined, true);
    await reader.refresh(performance.now() + 40000 + behaviors.length * 2000);
    if (mode === 'newer') assert(result.changed);
    else assert.equal(writer.productDaily.capture().version, selected.version);
    if (mode === 'repeat') assert(result.qualified && !result.changed);
    const service = checkTradeService(
      reader.productDaily.live(reader.productDaily.capture(), now),
      reader.productDaily.capture(),
      now,
      now,
    );
    assert.equal(service.status, mode === 'stale' ? 'STALE' : 'FRESH');
    behaviors.push({ mode, result, service });
  }
  const timestamp = Date.parse(last.metadata.readings[0].observedAtUtc);
  for (const [age, status] of [
    [300000, 'FRESH'],
    [300001, 'STALE'],
  ])
    assert.equal(
      checkTradeService(
        reader.productDaily.live(last, timestamp + age),
        last,
        timestamp + age,
        timestamp + age,
      ).status,
      status,
    );
  // Legacy ROUND_1..3 remain accepted by actual storage; ROUND_6 stays refused.
  const legacy = await fixtureRoot('actual-legacy-');
  const legacyAdmission = {
    task: admission.task,
    family: 'trade',
    jobRoot: legacy,
    nonce: admission.nonce,
  };
  await put(join(legacy, 'ADMISSION.json'), legacyAdmission);
  for (let cycle = 1; cycle <= 3; cycle++) {
    now += 1000;
    const rr = values(100 + cycle),
      m = { cycle, expiresAtUnixSeconds: now / 1000 + 30 };
    for (const [i, asset] of ['BTC', 'ETH'].entries()) {
      const r = rr.find((v) => v.asset === asset);
      m[asset.toLowerCase()] = await capture(legacy, cycle * 2 + i - 1, `${asset}_${cycle}`, [
        { date: String(Date.parse(r.observedAtUtc) / 1000), tid: r.tradeId, price: r.value },
      ]);
    }
    const result = await publishTrade(
      writer.productDaily,
      legacy,
      m,
      () => true,
      (u, beforeCommit, captureReference) => {
        assert.equal(captureReference.update, `ROUND_${cycle}_UPDATE.json`);
        return writer.publishProduct(u, { beforeCommit, captureReference });
      },
      [],
    );
    assert(result.changed);
    await writer.refresh(undefined, true);
  }
  const { publishStoredMarket } = await import('../../dist/services/product-daily/storage.js');
  const lease = await store.acquireWriter();
  const pointer = await fs.readFile(join(store.root, 'CURRENT.json'));
  try {
    await assert.rejects(
      publishStoredMarket(
        store,
        lease,
        { readings: values(999), liquidityHistory: [], receiptSha256: h },
        () => {},
        () => {},
        {
          output: root,
          update: 'ROUND_6_UPDATE.json',
          updateSha256: h,
          audit: 'ROUND_6_AUDIT.json',
          auditSha256: h,
        },
      ),
      (e) => e.name === 'ZodError',
    );
  } finally {
    await store.releaseWriter(lease);
  }
  assert.deepEqual(await fs.readFile(join(store.root, 'CURRENT.json')), pointer);
  const orchestration = [];
  for (const mode of [
    'pass',
    'app-close',
    'base-close',
    'restore-failure',
    'missing-restore',
    'prior-failure',
  ]) {
    let closed = 0,
      restores = 0;
    const r = await finishRecoveryProof(
      [
        [
          'application',
          async () => {
            if (mode === 'app-close') throw Error('SYNTHETIC_CLOSE');
          },
        ],
      ],
      async () => {
        closed++;
        if (mode === 'base-close') throw Error('SYNTHETIC_BASE_CLOSE');
      },
      mode === 'missing-restore'
        ? null
        : async () => {
            restores++;
            if (mode === 'restore-failure') throw Error('SYNTHETIC_RESTORE');
          },
      mode === 'prior-failure' ? { error: 'SYNTHETIC_PRIOR' } : null,
    );
    assert.equal(closed, 1);
    assert.equal(Boolean(r.failure), mode !== 'pass');
    if (['app-close', 'prior-failure'].includes(mode)) assert.equal(restores, 0);
    orchestration.push({ mode, ...r, baseCloses: closed, restores });
  }
  await new Promise((resolve, reject) =>
    literalLookup('127.0.0.1', { all: true }, (e, a) => {
      try {
        assert.ifError(e);
        assert.deepEqual(a, [{ address: '127.0.0.1', family: 4 }]);
        resolve();
      } catch (e) {
        reject(e);
      }
    }),
  );
  for (const host of ['localhost', '::1', 'www.bitstamp.net'])
    assert.throws(() => literalLookup(host, {}, () => {}));
  const { runOperatingTrades, runOperatingR2Trades } =
    await import('../../scripts/trade-refresh.mjs');
  await assert.rejects(runOperatingTrades({}), /EXISTING_OR_UNCERTAIN/);
  await assert.rejects(runOperatingR2Trades({}), /ENOENT/);
  await put(join(T, 'evidence/OPERATING_COMPLETION.json'), {
    status: 'PASS',
    synthetic: true,
    networkHardDenied: true,
    publicRequests: 0,
    baseAdmissions: 0,
    apiListeners: 0,
    actualParticipantRegistry: true,
    syntheticParticipantIdentityOnly: true,
    actualStoragePublications: 16,
    startingSequence: 28,
    endingSequence: 44,
    journalBefore: beforeState,
    journalAfter: afterState,
    allSlotResults: results,
    emptyRepeatStaleNewer: behaviors,
    legacyRound1Through3: true,
    round6Refused: true,
    heldExportPrunedButCoherent: true,
    orchestration,
    literalLoopback: 'PASS',
    oldR1SessionRefused: true,
  });
  console.log('ACTUAL_ALL_16_STORAGE_AND_FINAL_ORCHESTRATION_PASS');
} finally {
  if (heldExport && !heldExport.stream.destroyed) {
    heldExport.stream.destroy();
    await heldExport.released;
  }
  held?.release();
  await reader?.close();
  await writer?.close();
  assert.equal(baseCloses, 0);
  globalThis.Date = NativeDate;
}
