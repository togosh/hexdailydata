import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { join, dirname, basename } from 'node:path';
import {
  root,
  metadata,
  realRows,
  exceptions,
  syntheticProtocol,
  fresh,
  receipt,
  hash,
} from './helpers.mjs';
import {
  applyMarketUpdate,
  validateLedgerSegments,
} from '../../dist/services/product-daily/market.js';
import { productFiles } from '../../dist/services/product-daily/project.js';
import {
  protocolValues,
  baseLedgerTail,
  decodeDailyWord,
} from '../../dist/contracts/protocol-daily.js';
import {
  publishStoredMarket,
  backupStorage,
  auditJournal,
} from '../../dist/services/product-daily/storage.js';
const initial = { rows: realRows, metadata, exceptions },
  u = JSON.parse(await readFile(join(syntheticProtocol.root, 'ROUND_1_UPDATE.json')));
const b = applyMarketUpdate(initial, u);
assert.equal(b.metadata.coverage.ledgerDates, 2500);
assert.equal(b.metadata.ledgerObservedAtUtc, metadata.ledgerObservedAtUtc);
assert.equal(protocolValues(u.readings[0]).tshareRateHEX, '12345.6');
assert.equal(protocolValues(u.readings[0]).activeTshares, '99');
assert.equal(protocolValues(u.readings[0]).queuedTshares, '12');
assert.strictEqual(applyMarketUpdate(b, u), b);
for (const mutate of [
  (x) => (x.ledgerAppend.overlap[0] = '0'),
  (x) => x.ledgerAppend.from++,
  (x) => x.ledgerAppend.words.reverse(),
  (x) => (x.ledgerAppend.words[0] = '1'),
  (x) => (x.readings[0].blockHash = '0x' + 'a'.repeat(64)),
]) {
  const bad = structuredClone(u);
  mutate(bad);
  assert.throws(() => applyMarketUpdate(b, bad));
}
assert.equal(decodeDailyWord('0').payoutPerTshareHEX, null);
const now = Date.now;
Date.now = () => Date.parse('2027-01-01T00:00:00Z');
try {
  const future = structuredClone(u),
    time = Date.parse('2026-11-20T00:00:00Z');
  future.readings[0].observedAtUtc = new Date(time).toISOString();
  future.readings[0].globalWords[10] = String(time / 1000);
  future.readings[0].globalWords[4] = '2530';
  future.ledgerAppend.words = Array.from({ length: 32 }, (_, i) =>
    String(((10n ** 20n) << 72n) + BigInt(i)),
  );
  const full = applyMarketUpdate(initial, future);
  assert.equal(full.metadata.coverage.ledgerDates, 2530);
  validateLedgerSegments(full.rows, full.metadata);
  const oversize = structuredClone(future);
  oversize.ledgerAppend.words.push('0');
  oversize.readings[0].globalWords[4] = '2531';
  assert.throws(() => applyMarketUpdate(initial, oversize));
  const noNew = structuredClone(u);
  noNew.ledgerAppend.words = [];
  noNew.readings[0].globalWords[4] = '2498';
  const delayed = applyMarketUpdate(initial, noNew);
  assert.equal(delayed.metadata.coverage.ledgerDates, 2498);
  assert.deepEqual(delayed.rows, initial.rows);
  // Explicit synthetic capacity seed: no real journal lineage is copied into it.
  const syntheticMetadata = structuredClone(b.metadata);
  delete syntheticMetadata.marketStorage;
  let base = { ...b, metadata: syntheticMetadata };
  const start = Date.parse('2026-11-01T00:00:00Z');
  while (base.metadata.observations.length < 511) {
    const r = structuredClone(u.readings[0]),
      n = base.metadata.observations.length;
    r.blockNumber += 100 + n;
    r.observedAtUtc = new Date(start + n * 1000).toISOString();
    r.globalWords[10] = String(start / 1000 + n);
    r.globalWords[4] = '2500';
    base = applyMarketUpdate(base, {
      readings: [r],
      ledgerAppend: { from: 2500, overlap: u.ledgerAppend.words.slice(-2), words: [] },
      liquidityHistory: [],
      receiptSha256: hash(String(n)),
    });
  }
  const store = await fresh('protocol-rotation', productFiles(base)),
    quiet = store.capture().metadata.readings.filter((r) => r.kind !== 'protocol');
  const lengths = [];
  for (let n = 511; n <= 512; n++) {
    const r = structuredClone(u.readings[0]);
    r.blockNumber += 100 + n;
    r.observedAtUtc = new Date(start + n * 1000).toISOString();
    r.globalWords[10] = String(start / 1000 + n);
    r.globalWords[4] = '2500';
    const w = await store.acquireWriter();
    try {
      await publishStoredMarket(store, w, {
        readings: [r],
        ledgerAppend: { from: 2500, overlap: u.ledgerAppend.words.slice(-2), words: [] },
        liquidityHistory: [],
        receiptSha256: hash('publish' + n),
      });
    } finally {
      await store.releaseWriter(w);
    }
    lengths.push(store.capture().metadata.observations.length);
  }
  assert.deepEqual(lengths, [512, 1]);
  assert.deepEqual(
    store.capture().metadata.readings.filter((r) => r.kind !== 'protocol'),
    quiet,
  );
  const backup = await backupStorage(store.root, join(dirname(store.root), 'backup'));
  await receipt('REDUCER_ROTATION_' + basename(dirname(store.root)), {
    status: 'PASS',
    synthetic: true,
    externalRequests: 0,
    lengths,
    checks: [
      '32 accepted; 33 refused',
      'overlap/duplicate/order/conflict',
      'zero share null',
      'active vs queued',
      'nonmaterialization despite later day',
      'exact units',
      '512 checkpoint rotation',
      'quiet keys retained',
    ],
    backup,
    journal: await auditJournal(store.root),
  });
  console.log('PASS protocol/ledger reducer and 511/512 publication/backup');
} finally {
  Date.now = now;
}
