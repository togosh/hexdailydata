import assert from 'node:assert/strict';
import { readFile, readdir } from 'node:fs/promises';
import { join, basename } from 'node:path';
import { createHash } from 'node:crypto';
import { fresh, smallSeed, update, publish, receipt } from './helpers.mjs';
import { ProductDailyStore } from '../../dist/services/product-daily/store.js';
import { auditJournal } from '../../dist/services/product-daily/storage.js';
import { marketEvidence } from '../../dist/services/product-daily/market.js';
const originalNow = Date.now;
Date.now = () => Date.parse('2026-11-01T00:00:00Z');
let store = await fresh('stream', smallSeed());
const seed = store.capture(),
  started = performance.now(),
  daily = new Map(),
  latest = new Map(),
  identities = createHash('sha256');
const key = (r) =>
  r.kind === 'market' ? 'market:' + r.asset : r.kind === 'tracked-liquidity' ? 'liquidity' : r.kind;
function reduce(readings) {
  for (const r of readings) {
    const k = key(r),
      d = r.observedAtUtc.slice(0, 10) + ':' + k;
    if (!daily.has(d) || Date.parse(daily.get(d).observedAtUtc) < Date.parse(r.observedAtUtc))
      daily.set(d, structuredClone(r));
    if (!latest.has(k) || Date.parse(latest.get(k).observedAtUtc) < Date.parse(r.observedAtUtc))
      latest.set(k, structuredClone(r));
    identities.update(JSON.stringify(r) + '\n');
  }
}
reduce(seed.metadata.observations);
const witnesses = [],
  timings = [];
let peakObjects = 0,
  peakMetadataBytes = 0,
  reclaimedBytes = 0;
try {
  for (let i = 0; i < 5250; i++) {
    const u = update(i),
      start = performance.now(),
      result = await publish(store, u);
    timings.push(performance.now() - start);
    reduce(u.readings);
    const s = store.capture();
    peakObjects = Math.max(peakObjects, s.metadata.observations.length);
    peakMetadataBytes = Math.max(peakMetadataBytes, Buffer.byteLength(JSON.stringify(s.metadata)));
    reclaimedBytes += result.retention?.removedBytes ?? 0;
    assert(s.metadata.observations.length <= 512);
    assert.equal(
      Object.keys(s.metadata.inputHashes).length,
      Object.keys(seed.metadata.inputHashes).length + 1,
    );
    if (
      [0, 250, 251, 252, 255, 256, 2042, 2043, 2048, 4095, 4096, 5249].includes(i) ||
      i % 1000 === 999
    ) {
      const observed = new Map();
      for (const r of marketEvidence(s.metadata))
        observed.set(r.observedAtUtc.slice(0, 10) + ':' + key(r), r);
      assert.deepEqual([...observed].sort(), [...daily].sort());
      assert.deepEqual(
        [...latest.values()].sort((a, b) => key(a).localeCompare(key(b))),
        s.metadata.readings,
      );
      for (const row of s.rows) {
        const liq = daily.get(row.dateUtc + ':liquidity');
        assert.equal(row.trackedLiquidityUsd, liq?.value ?? null);
        assert.equal(row.liquidityRecordedAtUtc, liq?.observedAtUtc ?? null);
        if (row.dateUtc > seed.metadata.through) {
          assert.equal(row.hexPriceUsd, null);
          assert.equal(row.btcPriceUsd, null);
          assert.equal(row.snapshotRecordedAtUtc, null);
        }
      }
      const st = JSON.parse(await readFile(join(store.root, 'STORAGE.json')));
      assert(st.generations.length <= 2);
      witnesses.push({
        i,
        sequence: st.sequence,
        head: st.head,
        active: s.metadata.observations.length,
        checkpoints: s.metadata.marketStorage.checkpoints.length,
        metadataBytes: Buffer.byteLength(JSON.stringify(s.metadata)),
        retainedBytes: st.generations.reduce(
          (n, g) => n + Object.values(g.files).reduce((a, f) => a + f.bytes, 0),
          0,
        ),
      });
    }
    if (i === 2600) {
      store = new ProductDailyStore(store.root, seed.metadata.pair);
      await store.load();
    }
    if (i % 1000 === 999) console.log('completed synthetic updates', i + 1);
  }
  const before = await readFile(join(store.root, 'STORAGE.json'));
  const replay = await publish(store, update(5249));
  assert.equal(replay.changed, false);
  assert.deepEqual(await readFile(join(store.root, 'STORAGE.json')), before);
  await assert.rejects(publish(store, update(0)), /OLDER_MARKET/);
  const conflict = update(5249);
  conflict.readings[0].value = '9';
  await assert.rejects(publish(store, conflict), /SAME_TIME/);
  const mixed = update(5250);
  mixed.readings[0] = update(0).readings[0];
  await assert.rejects(publish(store, mixed), /OLDER_MARKET/);
  assert.deepEqual(await readFile(join(store.root, 'STORAGE.json')), before);
  const audit = await auditJournal(store.root);
  assert.equal(audit.objects, 10500);
  assert.equal(audit.sequence, 5250);
  const final = store.capture(),
    st = JSON.parse(before);
  timings.sort((a, b) => a - b);
  const result = {
    status: 'PASS',
    synthetic: true,
    externalRequests: 0,
    fixtureRoot: store.root,
    observations: 10500,
    updates: 5250,
    seedObservations: seed.metadata.observations.length,
    utcDates: daily.size / 2,
    restartAfterUpdate: 2601,
    peakActiveObjects: peakObjects,
    peakMetadataBytes,
    journal: audit,
    retainedGenerations: st.generations.length,
    reclaimedBytes,
    observationsSha256: identities.digest('hex'),
    meanPublicationMs: timings.reduce((a, b) => a + b, 0) / timings.length,
    p95PublicationMs: timings[Math.floor(timings.length * 0.95)],
    maxPublicationMs: timings.at(-1),
    elapsedSeconds: (performance.now() - started) / 1000,
    finalVersion: final.version,
    witnesses,
    checks: [
      'independent uninterrupted reducer',
      '10500 paired objects',
      'more than three UTC dates',
      'application restart',
      '512 recent bound',
      'daily checkpoints and exact original timestamps',
      'quiet/null fields and gaps',
      'old archived update refused',
      'indivisible mixed old/new update refused',
      'same-time conflict',
      'latest exact replay no-op',
      'current plus rollback retained',
      'full journal re-audit',
    ],
  };
  await receipt('STREAM_' + basename(join(store.root, '..')), result);
  console.log(JSON.stringify(result));
} finally {
  Date.now = originalNow;
}
