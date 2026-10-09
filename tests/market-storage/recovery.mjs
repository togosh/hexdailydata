import assert from 'node:assert/strict';
import { readFile, writeFile, open, readdir, link, symlink, mkdir } from 'node:fs/promises';
import { join, dirname, basename } from 'node:path';
import { fresh, smallSeed, update, publish, receipt, root } from './helpers.mjs';
import { ProductDailyStore } from '../../dist/services/product-daily/store.js';
import {
  inspectStorage,
  auditJournal,
  planRetention,
  applyRetention,
  planRollback,
  applyRollback,
  backupStorage,
  restoreStorage,
  reconcileAcknowledgement,
  safeStoragePath,
  checkMarketCapacity,
} from '../../dist/services/product-daily/storage.js';
const realNow = Date.now;
Date.now = () => Date.parse('2026-11-01T00:00:00Z');
const results = [];
try {
  for (const point of [
    'intent',
    'journal-partial',
    'journal-write',
    'checkpoint',
    'generation',
    'pointer',
    'state',
    'cleanup-before',
    'cleanup-after',
  ]) {
    const s = await fresh('failure-' + point, smallSeed());
    if (point.startsWith('cleanup')) await publish(s, update(0));
    const previous = s.capture(),
      pointerBefore = await readFile(join(s.root, 'CURRENT.json'));
    await assert.rejects(
      publish(s, update(point.startsWith('cleanup') ? 1 : 0), (p) => {
        if (p === point) throw Error('SYNTHETIC_' + point);
      }),
      /SYNTHETIC/,
    );
    const observed = await inspectStorage(s.root);
    assert.equal(observed.status, 'BLOCKED');
    assert((await readdir(s.root)).includes('SELECTION.lock'));
    await assert.rejects(planRetention(s.root), /WRITER/);
    await assert.rejects(planRollback(s.root), /WRITER/);
    if (
      ['intent', 'journal-partial', 'journal-write', 'checkpoint', 'generation'].includes(point)
    ) {
      assert.deepEqual(await readFile(join(s.root, 'CURRENT.json')), pointerBefore);
      const reader = new ProductDailyStore(s.root, previous.metadata.pair);
      await reader.load();
      assert.equal(reader.capture().version, previous.version);
    }
    results.push({ point, root: s.root, status: 'EXPECTED_BLOCKED', failure: observed.error });
  }
  const ack = await fresh('missing-ack', smallSeed());
  await assert.rejects(
    publish(ack, update(0), (p) => {
      if (p === 'acknowledgement') throw Error('SYNTHETIC_ACK_LOST');
    }),
    /ACK_LOST/,
  );
  assert(!(await readdir(ack.root)).includes('SELECTION.lock'));
  const recovered = await reconcileAcknowledgement(ack.root);
  assert.equal(recovered.providerOutcomeUnchanged, true);
  await publish(ack, update(1));
  results.push({
    point: 'missing acknowledgement',
    root: ack.root,
    status: 'RECONCILED',
    decision: recovered,
  });
  const s = await fresh('rollback', smallSeed());
  await publish(s, update(0));
  await publish(s, update(1));
  const running = new ProductDailyStore(s.root, s.capture().metadata.pair);
  await running.load();
  const broken = running.capture(),
    target = JSON.parse(await readFile(join(s.root, 'STORAGE.json'))).rollback;
  const path = join(s.root, broken.version, 'metadata.json'),
    bytes = await readFile(path);
  const bad = Buffer.from(bytes);
  bad[10] ^= 1;
  await writeFile(path, bad);
  const plan = await planRollback(s.root),
    decision = await applyRollback(s.root, plan);
  await running.refresh(1000);
  assert.equal(running.capture().version, target.version);
  assert.equal(running.live(running.capture(), Date.now()).freshness.HEX.status, 'stale');
  const restarted = new ProductDailyStore(s.root, s.capture().metadata.pair);
  await restarted.load();
  assert.equal(restarted.capture().version, target.version);
  await assert.rejects(publish(restarted, update(2)), /STORAGE_HEAD/);
  results.push({
    point: 'same-length selected corruption / explicit rollback',
    root: s.root,
    status: 'STALE_ROLLBACK_ADOPTED',
    decision,
  });
  // Current exact plans do not survive pointer/state changes or invented removable paths.
  const p = await fresh('bad-plans', smallSeed());
  await publish(p, update(0));
  const oldPlan = await planRetention(p.root);
  await publish(p, update(1));
  await assert.rejects(applyRetention(p.root, oldPlan), /STALE/);
  const modified = await planRetention(p.root);
  modified.remove = [{ version: '../seed', files: {} }];
  await assert.rejects(applyRetention(p.root, modified), /STALE/);
  await assert.rejects(safeStoragePath(p.root, '../other'), /PATH_ESCAPE/);
  const foreign = await open(join(p.root, 'FOREIGN'), 'wx');
  await foreign.close();
  await assert.rejects(planRetention(p.root), /FOREIGN/);
  results.push({ point: 'stale / malicious / foreign plans', root: p.root, status: 'REFUSED' });
  const alias = await fresh('aliases', smallSeed());
  await link(
    join(alias.root, alias.capture().version, 'metadata.json'),
    join(dirname(alias.root), 'hardlink'),
  );
  await assert.rejects(planRetention(alias.root), /ALIAS/);
  const other = join(dirname(alias.root), 'junction');
  await symlink(alias.root, other, 'junction');
  await assert.rejects(safeStoragePath(other), /ALIAS/);
  results.push({ point: 'hardlink / junction aliases', root: alias.root, status: 'REFUSED' });
  const active = await fresh('active-writer', smallSeed()),
    lease = await active.acquireWriter();
  await assert.rejects(planRetention(active.root), /WRITER/);
  await active.releaseWriter(lease);
  const before = await readFile(join(active.root, 'STORAGE.json'));
  for (const [field, value, error] of [
    ['operationBytes', 8 * 1024 ** 3, /OPERATION_COUNTERS/],
    ['operationEntries', 100000, /OPERATION_COUNTERS/],
  ]) {
    const st = JSON.parse(before);
    st[field] = value;
    await writeFile(join(active.root, 'STORAGE.json'), JSON.stringify(st) + '\n');
    await assert.rejects(checkMarketCapacity(active.root), error);
  }
  // Isolated synthetic tampering stays in this failed fixture; no repair/reset.
  results.push({
    point: 'byte / entry capacity / active writer',
    root: active.root,
    status: 'REFUSED',
  });
  const archive = await fresh('archive-interrupted', smallSeed());
  await assert.rejects(
    backupStorage(archive.root, join(dirname(archive.root), 'backup'), (p) => {
      if (p === 'archive-verification') throw Error('SYNTHETIC_ARCHIVE');
    }),
    /ARCHIVE/,
  );
  assert.equal((await inspectStorage(archive.root)).status, 'BLOCKED');
  results.push({
    point: 'archive verification interruption',
    root: archive.root,
    status: 'EXPECTED_BLOCKED',
  });
  const corrupt = await fresh('journal-corrupt', smallSeed());
  await publish(corrupt, update(0));
  const jp = join(corrupt.root, 'journal/00000000.ndjson'),
    jb = await readFile(jp);
  jb[100] ^= 1;
  await writeFile(jp, jb);
  await assert.rejects(auditJournal(corrupt.root));
  await assert.rejects(publish(corrupt, update(1)), /TAIL/);
  results.push({ point: 'same-length journal corruption', root: corrupt.root, status: 'REFUSED' });
  // Real append path segment seal, using small domain only.
  const seal = await fresh('segment-seal', smallSeed());
  for (let i = 0; i < 16; i++) await publish(seal, update(i));
  await assert.rejects(
    publish(seal, update(16), (p) => {
      if (p === 'journal-seal') throw Error('SYNTHETIC_SEAL');
    }),
    /SEAL/,
  );
  results.push({ point: 'segment seal interruption', root: seal.root, status: 'EXPECTED_BLOCKED' });
  await receipt('RECOVERY_' + basename(dirname(s.root)), {
    status: 'PASS',
    synthetic: true,
    externalRequests: 0,
    results,
  });
  console.log('PASS', results.length, 'focused recovery/ownership outcomes');
} finally {
  Date.now = realNow;
}
