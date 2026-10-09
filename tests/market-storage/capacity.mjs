import assert from 'node:assert/strict';
import * as fsp from 'node:fs/promises';
import fsDefault from 'node:fs/promises';
import { syncBuiltinESMExports } from 'node:module';
import { join, dirname, basename } from 'node:path';
import { fresh, smallSeed, publish, update, receipt } from './helpers.mjs';
import {
  checkMarketCapacity,
  reserveCaptureStorage,
  settleCaptureStorage,
  inspectStorage,
  auditJournal,
} from '../../dist/services/product-daily/storage.js';
import { preserveMarketHistory } from '../../dist/services/product-daily/market.js';
const realNow = Date.now;
Date.now = () => Date.parse('2026-11-01T00:00:00Z');
const s = await fresh('capacity', smallSeed()),
  checks = [];
try {
  const realStatfs = fsDefault.statfs;
  try {
    fsDefault.statfs = async () => ({ bavail: 100, bsize: 4096 });
    syncBuiltinESMExports();
    await assert.rejects(checkMarketCapacity(s.root), /PROTECTED_FREE/);
  } finally {
    fsDefault.statfs = realStatfs;
    syncBuiltinESMExports();
  }
  checks.push('protected free refusal before publication');
  const lease = await s.acquireWriter();
  try {
    const output = join(dirname(s.root), 'closed-synthetic-capture');
    const reservation = await reserveCaptureStorage(s, lease, output);
    assert.equal(reservation.bytes, 1024 ** 3);
    await fsp.mkdir(output);
    await fsp.writeFile(join(output, 'body.bin'), Buffer.alloc(100));
    const accounting = { status: 'CLOSED', pending: null, storageChargedBytes: 200 };
    await fsp.writeFile(join(output, 'ACCOUNTING.json'), JSON.stringify(accounting));
    await fsp.writeFile(join(output, 'RESULT.json'), JSON.stringify({ accounting }));
    const outcome = await settleCaptureStorage(s, lease, output, 200, reservation);
    assert(outcome.actualChargedBytes >= 1024 ** 2 + 200);
    assert.equal(outcome.providerChargesUnchanged, true);
    // Repeat settlement cannot refund the same reservation twice.
    await assert.rejects(
      settleCaptureStorage(s, lease, output, 200, reservation),
      /WRONG_OR_SETTLED/,
    );
    checks.push(
      'finite capture reservation before spawn; closed-only bounded settlement; no double settlement',
    );
  } finally {
    await s.releaseWriter(lease);
  }
  await publish(s, update(0));
  const old = s.capture();
  await publish(s, update(2000));
  const next = s.capture();
  const bad = structuredClone(next.metadata);
  bad.marketStorage.checkpoints = [];
  assert.throws(
    () =>
      preserveMarketHistory(old, {
        ...next,
        metadata: {
          ...bad,
          observations: next.metadata.observations.filter(
            (r) => r.observedAtUtc !== old.metadata.readings[0].observedAtUtc,
          ),
        },
      }),
    /HISTORY_REGRESSION/,
  );
  const pending = await fresh('unknown-capture', smallSeed()),
    w = await pending.acquireWriter();
  await reserveCaptureStorage(pending, w, join(dirname(pending.root), 'unknown-output'));
  await pending.releaseWriter(w);
  assert.equal((await inspectStorage(pending.root)).state.operationBytes, 1024 ** 3 + 4096);
  checks.push('unknown unused capture reservation remains charged', 'checkpoint omission refused');
  await receipt('CAPACITY_' + basename(dirname(s.root)), {
    status: 'PASS',
    synthetic: true,
    externalRequests: 0,
    checks,
    root: s.root,
    unknownRoot: pending.root,
  });
  console.log('PASS capacity and compact preservation');
} finally {
  Date.now = realNow;
}
