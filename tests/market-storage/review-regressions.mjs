import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import { syncBuiltinESMExports } from 'node:module';
import { join, dirname, basename } from 'node:path';
import { fresh, smallSeed, update, publish, receipt } from './helpers.mjs';
import {
  publishStoredMarket,
  auditJournal,
  checkMarketCapacity,
  backupStorage,
  restoreStorage,
  reserveCaptureStorage,
  settleCaptureStorage,
} from '../../dist/services/product-daily/storage.js';
import {
  ProductDailyStore,
  writeProductGeneration,
} from '../../dist/services/product-daily/store.js';
import { applyMarketUpdate } from '../../dist/services/product-daily/market.js';
import { productFiles } from '../../dist/services/product-daily/project.js';
const now = Date.now;
Date.now = () => Date.parse('2026-11-01T00:00:00Z');
const results = [];
try {
  const provenance = await fresh('sealed-provenance', smallSeed());
  for (let i = 0; i < 17; i++) {
    const w = await provenance.acquireWriter();
    try {
      await publishStoredMarket(
        provenance,
        w,
        update(i),
        () => {},
        () => {},
        {
          output: 'synthetic://no-provider',
          update: 'ROUND_1_UPDATE.json',
          updateSha256: 'a'.repeat(64),
          audit: 'ROUND_1_AUDIT.json',
          auditSha256: 'b'.repeat(64),
        },
      );
    } finally {
      await provenance.releaseWriter(w);
    }
  }
  await auditJournal(provenance.root);
  const earlier = join(provenance.root, 'journal/00000000.ndjson'),
    raw = await fs.readFile(earlier, 'utf8');
  const tampered = raw.replace(
    '"updateSha256":"' + 'a'.repeat(64) + '"',
    '"updateSha256":"' + 'c'.repeat(64) + '"',
  );
  assert.equal(Buffer.byteLength(raw), Buffer.byteLength(tampered));
  assert.notEqual(raw, tampered);
  await fs.writeFile(earlier, tampered);
  await assert.rejects(auditJournal(provenance.root), /JOURNAL_CHAIN/);
  results.push({
    test: 'earlier sealed capture-reference same-length corruption',
    root: provenance.root,
    status: 'REFUSED',
  });
  const forged = await fresh('forged-frontier', smallSeed());
  await publish(forged, update(0));
  const old = forged.capture(),
    candidate = productFiles(applyMarketUpdate({ ...old, exceptions: [] }, update(1)));
  await writeProductGeneration(forged.root, candidate);
  const w = await forged.acquireWriter();
  try {
    await assert.rejects(
      forged.select(
        { version: candidate.version, manifestSha256: candidate.manifestSha256 },
        { writer: w },
      ),
      /ENOENT|CERTIFICATE/,
    );
  } finally {
    await forged.releaseWriter(w);
  }
  assert.equal(forged.capture().version, old.version);
  const running = new ProductDailyStore(forged.root, old.metadata.pair);
  await running.load();
  const pointer = { version: candidate.version, manifestSha256: candidate.manifestSha256 };
  await fs.writeFile(join(forged.root, 'CURRENT.json'), JSON.stringify(pointer));
  await fs.writeFile(
    join(forged.root, 'admitted-' + candidate.version + '.json'),
    JSON.stringify(pointer),
  );
  await running.refresh(1000);
  assert.equal(running.capture().version, old.version);
  assert(running.reloadStatus().error);
  await assert.rejects(
    new ProductDailyStore(forged.root, old.metadata.pair).load(),
    /ENOENT|CERTIFICATE/,
  );
  results.push({
    test: 'self-consistent compact generation without durable append/certificate',
    root: forged.root,
    status: 'SELECT_LOAD_REFRESH_REFUSED',
  });
  const op = await fresh('operation-identities', smallSeed()),
    a = join(dirname(op.root), 'capture-a'),
    b = join(dirname(op.root), 'capture-b');
  const lease = await op.acquireWriter();
  let ra, rb;
  try {
    ra = await reserveCaptureStorage(op, lease, a);
    rb = await reserveCaptureStorage(op, lease, b);
    await fs.mkdir(a);
    const accounting = { status: 'CLOSED', pending: null, storageChargedBytes: 200 };
    await fs.writeFile(join(a, 'ACCOUNTING.json'), JSON.stringify(accounting));
    await fs.writeFile(join(a, 'RESULT.json'), JSON.stringify({ accounting }));
    await assert.rejects(settleCaptureStorage(op, lease, a, 200, rb), /WRONG_OR_SETTLED/);
    await settleCaptureStorage(op, lease, a, 200, ra);
  } finally {
    await op.releaseWriter(lease);
  }
  const restarted = new ProductDailyStore(op.root, op.capture().metadata.pair);
  await restarted.load();
  const audited = await auditJournal(op.root);
  assert.equal(audited.operations.unresolved.length, 1);
  assert.equal(audited.operations.unresolved[0].id, rb.id);
  const statePath = join(op.root, 'STORAGE.json'),
    state = JSON.parse(await fs.readFile(statePath));
  state.operationBytes--;
  await fs.writeFile(statePath, JSON.stringify(state) + '\n');
  await assert.rejects(auditJournal(op.root), /OPERATION_COUNTERS/);
  await assert.rejects(checkMarketCapacity(op.root), /OPERATION_COUNTERS/);
  results.push({
    test: 'two reservations / wrong settlement / restart / counter tamper / unknown charge retained',
    root: op.root,
    status: 'PASS',
    audit: audited.operations,
  });
  const back = await fresh('backup-capacity', smallSeed());
  await publish(back, update(0));
  const backup = await backupStorage(back.root, join(dirname(back.root), 'backup-good'));
  await backupStorage(back.root, join(dirname(back.root), 'backup-second'));
  const bs = JSON.parse(await fs.readFile(join(back.root, 'STORAGE.json')));
  assert.equal(bs.operationSequence, 2);
  assert(bs.operationBytes >= backup.reservation.bytes * 2);
  const low = await fresh('backup-low-space', smallSeed()),
    dest = join(dirname(low.root), 'backup-low'),
    rest = join(dirname(back.root), 'restore-low');
  const statfs = fs.statfs;
  try {
    fs.statfs = async () => ({ bavail: 100, bsize: 4096 });
    syncBuiltinESMExports();
    await assert.rejects(backupStorage(low.root, dest), /PROTECTED_FREE/);
    await assert.rejects(restoreStorage(backup.destination, rest, backup.sha256), /PROTECTED_FREE/);
  } finally {
    fs.statfs = statfs;
    syncBuiltinESMExports();
  }
  await assert.rejects(fs.lstat(dest), /ENOENT/);
  await assert.rejects(fs.lstat(rest), /ENOENT/);
  results.push({
    test: 'backup output reservations accumulate; backup/restore low-space refusal before destination',
    root: back.root,
    lowRoot: low.root,
    status: 'PASS',
  });
  await receipt('REVIEW_REGRESSIONS_' + basename(dirname(op.root)), {
    status: 'PASS',
    synthetic: true,
    externalRequests: 0,
    results,
  });
  console.log('PASS four integrity/accounting regression groups');
} finally {
  Date.now = now;
}
