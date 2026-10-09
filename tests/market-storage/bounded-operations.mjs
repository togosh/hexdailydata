import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import { syncBuiltinESMExports } from 'node:module';
import { join, dirname, basename } from 'node:path';
import { fresh, smallSeed, update, receipt } from './helpers.mjs';
import {
  reserveOperation,
  settleOperation,
  auditOperations,
} from '../../dist/services/product-daily/storage-operations.js';
import {
  encodeBackupManifest,
  backupStorage,
  restoreStorage,
  auditJournal,
} from '../../dist/services/product-daily/storage.js';
import {
  applyMarketUpdate,
  marketEvidence,
  migrateMarketMetadata,
} from '../../dist/services/product-daily/market.js';
const priorNow = Date.now;
Date.now = () => Date.parse('2026-11-01T00:00:00Z');
try {
  const store = await fresh('bounded-operations', smallSeed());
  let state = JSON.parse(await fs.readFile(join(store.root, 'STORAGE.json')));
  const counts = [];
  for (let i = 0; i < 40; i++) {
    let reads = 0,
      listings = 0;
    const read = fs.readFile,
      list = fs.readdir;
    let r;
    try {
      fs.readFile = async (...args) => {
        if (String(args[0]).includes('operations')) reads++;
        return read(...args);
      };
      fs.readdir = async (...args) => {
        listings++;
        return list(...args);
      };
      syncBuiltinESMExports();
      r = await reserveOperation(
        store.root,
        state,
        'capture',
        join(dirname(store.root), 'synthetic-' + i),
        10000,
        10,
      );
      state = { ...state, ...r.state };
      state = {
        ...state,
        ...(await settleOperation(store.root, state, r.reservation, r.reservation.output, 100, 1)),
      };
    } finally {
      fs.readFile = read;
      fs.readdir = list;
      syncBuiltinESMExports();
    }
    counts.push({ i, reads, listings });
    assert.equal(listings, 0);
    if (i) assert.equal(reads, counts[1].reads);
    await assert.rejects(
      settleOperation(store.root, state, r.reservation, r.reservation.output, 100, 1),
      /WRONG_OR_SETTLED/,
    );
  }
  const audit = await auditOperations(store.root, state);
  assert.equal(audit.events, 80);
  assert.equal(audit.files.length, 120);
  assert.equal(audit.bytes, 40 * (100 + 12288));
  await fs.writeFile(join(store.root, 'STORAGE.json'), JSON.stringify(state));
  const backup = await backupStorage(store.root, join(dirname(store.root), 'backup'));
  const restored = join(dirname(store.root), 'restored');
  await restoreStorage(backup.destination, restored, backup.sha256);
  assert.equal((await auditJournal(restored)).operations.files.length, 121);
  const catalog = Object.fromEntries(
    Array.from({ length: 62500 }, (_, i) => [
      `journal/${String(i).padStart(8, '0')}.ndjson`,
      { bytes: 1, sha256: 'a'.repeat(64) },
    ]),
  );
  assert.throws(
    () => encodeBackupManifest({ format: 'market-backup-1', state, files: catalog }),
    /BACKUP_MANIFEST_BOUND/,
  );
  const valid = encodeBackupManifest({ format: 'market-backup-1', state, files: {} });
  assert(valid.length < 4 * 1024 ** 2);

  // Quiet independent fields must survive rotation without acquiring another key's time.
  const seed = store.capture(),
    at = update(0).readings[0].observedAtUtc;
  const quiet = [
    {
      kind: 'market',
      asset: 'BTC',
      quote: 'USD',
      observation: 'spot',
      value: '123.00000001',
      observedAtUtc: at,
    },
    {
      kind: 'gas',
      chainId: 369,
      unit: 'wei/gas',
      gasPriceWei: '123456789',
      baseFeeWei: null,
      priorityFeeWei: '0',
      observedAtUtc: at,
    },
  ];
  let candidate = applyMarketUpdate(
    { ...seed, metadata: migrateMarketMetadata(seed.metadata, seed.version), exceptions: [] },
    { ...update(0), readings: [...update(0).readings, ...quiet] },
  );
  for (let i = 1; i < 260; i++) candidate = applyMarketUpdate(candidate, update(i));
  assert(candidate.metadata.marketStorage.checkpoints.length > 0);
  for (const q of quiet)
    assert.deepEqual(
      candidate.metadata.readings.find(
        (r) => r.kind === q.kind && (q.kind !== 'market' || r.asset === 'BTC'),
      ),
      q,
    );
  const oldDay = candidate.rows.find((r) => r.dateUtc === at.slice(0, 10));
  assert.equal(oldDay.btcPriceUsd, quiet[0].value);
  assert.equal(oldDay.btcRecordedAtUtc, at);
  assert.equal(oldDay.gasPriceWei, quiet[1].gasPriceWei);
  assert.equal(oldDay.baseFeeWei, null);
  assert.equal(oldDay.priorityFeeWei, '0');
  assert.equal(oldDay.gasRecordedAtUtc, at);
  const nextDay = candidate.rows.find((r) => r.dateUtc > at.slice(0, 10));
  assert.equal(nextDay.btcPriceUsd, null);
  assert.equal(nextDay.gasPriceWei, null);
  assert(
    marketEvidence(candidate.metadata).some((r) => r.kind === 'gas' && r.observedAtUtc === at),
  );
  await receipt('BOUNDED_OPERATIONS_' + basename(dirname(store.root)), {
    status: 'PASS',
    synthetic: true,
    externalRequests: 0,
    root: store.root,
    counts,
    audit,
    backup,
    restored,
    oversizedManifestEntries: 62500,
    oversizedManifest: 'REFUSED_BEFORE_DESTINATION_COPY',
    quietKeysAcrossRotation: 'PASS',
    nullVersusZero: 'PRESERVED',
  });
  console.log(
    'PASS constant operation reads, exclusive settlement proof, exact backup bound, quiet independent keys/nulls',
  );
} finally {
  Date.now = priorNow;
}
