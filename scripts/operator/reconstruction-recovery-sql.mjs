// Mounted into the existing immutable release; never dispatches an operator or RPC.
import assert from 'node:assert/strict';
import { readFile, open, lstat } from 'node:fs/promises';
import { constants } from 'node:fs';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { createInterface } from 'node:readline';
import { connect, databaseConfig } from '/app/dist/db/connect.js';
import { beginAuditSnapshot, inspectAuditTarget } from '/app/dist/operator/canary-audit.js';
import { pinnedAuditAdmissionSchema } from '/app/dist/operator/canary-plan.js';
import {
  reconstructionStateSchema,
  ReconstructionSession,
} from '/app/dist/operator/reconstruction-state.js';
import { atomicJson } from '/app/dist/operator/files.js';
import { totalColumns } from '/app/dist/services/projections/reduce.js';
import { digest, hex } from '/app/dist/services/projections/input.js';

globalThis.fetch = () => {
  throw Error('Provider dispatch forbidden');
};
const plan = JSON.parse(
  await readFile(process.argv.find((a) => a.startsWith('--plan='))?.slice(7) ?? '/input/plan.json'),
);
const statePath = plan.storagePath + '/reconstruction.json';
const hash = (b) => createHash('sha256').update(b).digest('hex');
if (process.argv.includes('--capture')) {
  const bytes = await readFile(statePath);
  console.log(JSON.stringify({ bytes: bytes.toString('base64'), sha256: hash(bytes) }));
} else {
  assert.equal(process.env.HDD_V2_ALLOW_LIVE_RPC, 'false');
  const lines = createInterface({ input: process.stdin })[Symbol.asyncIterator]();
  const message = async () => {
    const line = await lines.next();
    assert(!line.done, 'Host disconnected');
    return JSON.parse(line.value);
  };
  const request = await message(),
    beforeBytes = Buffer.from(request.before, 'base64');
  const { checksum, ...before } = JSON.parse(beforeBytes);
  assert.equal(checksum, digest(before));
  reconstructionStateSchema.parse(before);
  assert.equal(before.digest, digest(plan));
  const abort = new AbortController(),
    clients = [],
    locks = [];
  const timer = setTimeout(() => process.exit(2), 540000);
  let reader,
    snapshot = false;
  try {
    for (const root of [plan.storagePath, plan.quotaPath]) {
      const file = await open(
        root + '/.maintenance.lock',
        constants.O_RDONLY | constants.O_NOFOLLOW,
      );
      locks.push(file);
      assert.equal((await file.stat()).nlink, 1);
      const child = spawn('flock', ['--exclusive', '--nonblock', '3'], {
        stdio: ['ignore', 'ignore', 'ignore', file.fd],
      });
      await new Promise((resolve, reject) => {
        child.once('error', reject);
        child.once('close', (n) =>
          n === 0 ? resolve() : reject(Error('Filesystem ownership active')),
        );
      });
    }
    const roots = await ReconstructionSession.roots(plan);
    assert.deepEqual(roots, [before.storage, before.quota]);
    await assert.rejects(lstat(plan.storagePath + '/blocked.json'), { code: 'ENOENT' });
    const owner = await connect(databaseConfig('worker'), { signal: abort.signal });
    clients.push(owner);
    owner.on('error', () => abort.abort());
    await owner.query('SET default_transaction_read_only=on');
    for (const pair of [
      [4244, 0],
      [4244, 1],
      [4250, 0],
      [4242, 1],
      [4242, 369],
    ])
      assert.equal(
        (await owner.query('SELECT pg_try_advisory_lock($1::int,$2::int) held', pair)).rows[0].held,
        true,
      );
    reader = await connect(databaseConfig('api'), { signal: abort.signal });
    clients.push(reader);
    reader.on('error', () => abort.abort());
    await reader.query('SET default_transaction_read_only=on');
    await beginAuditSnapshot(reader, 540000);
    snapshot = true;
    const current = (await reader.query('SELECT * FROM hdd.current_state WHERE chain_id=1'))
      .rows[0];
    const counts = {};
    for (const table of Object.keys(pinnedAuditAdmissionSchema.shape.counts.shape))
      counts[table] = (await reader.query('SELECT count(*)::text n FROM hdd.' + table)).rows[0].n;
    const expected = {
      ...plan.admission,
      checkpoint: before.accepted.header,
      revision: before.accepted.revision,
      counts,
      current: Object.fromEntries(['contract_day', ...totalColumns].map((k) => [k, current[k]])),
    };
    const inspected = await inspectAuditTarget(reader, owner, plan.profile, expected, true);
    const receipts = (
      await reader.query(
        "SELECT revision,block_number,batch_digest,previous_sync->>'block_number' previous_number,previous_sync->>'block_hash' previous_hash,previous_sync->>'revision' previous_revision FROM hdd.checkpoints_recent WHERE chain_id=1 AND revision>$1 ORDER BY revision LIMIT 4097",
        [request.previous.revision],
      )
    ).rows;
    assert(receipts.length <= 4096);
    let pin = request.previous;
    for (const r of receipts) {
      assert.equal(BigInt(r.revision), BigInt(pin.revision) + 1n);
      assert.equal(r.previous_revision, pin.revision);
      assert.equal(r.previous_number, pin.header.number);
      assert.equal(r.previous_hash, pin.header.hash.replace('0x', '\\x'));
      assert(/^[a-f0-9]{64}$/.test(r.batch_digest));
      const h = (
        await reader.query('SELECT * FROM hdd.blocks_recent WHERE chain_id=1 AND number=$1', [
          r.block_number,
        ])
      ).rows[0];
      assert(h);
      pin = {
        header: {
          number: h.number,
          hash: hex(h.hash),
          parentHash: hex(h.parent_hash),
          timestamp: h.timestamp,
        },
        revision: r.revision,
      };
    }
    assert.deepEqual(pin, before.accepted, 'SQL receipt continuity');
    const beyond = (
      await reader.query(
        'SELECT (SELECT count(*) FROM hdd.blocks_recent WHERE chain_id=1 AND number>$1)::text blocks,(SELECT count(*) FROM hdd.events WHERE origin_chain_id=1 AND block_number>$1)::text events,(SELECT count(*) FROM hdd.transfers_recent WHERE origin_chain_id=1 AND block_number>$1)::text transfers,(SELECT count(*) FROM hdd.undo_recent WHERE chain_id=1 AND revision>$2)::text undo,(SELECT count(*) FROM hdd.daily_stats WHERE chain_id=1 AND (close_block>$1 OR payout_block>$1))::text daily',
        [pin.header.number, pin.revision],
      )
    ).rows[0];
    assert(Object.values(beyond).every((v) => v === '0'));
    const proof = {
      accepted: pin,
      instance: plan.instance,
      canonical: inspected.canonical.digest,
      canonicalEvidence: inspected.canonical,
      inventory: inspected.inventoryDigest,
      counts,
      receipts,
      noFutureRows: true,
      consistent: true,
      roles: ['hdd_v2_worker:read-only', 'hdd_v2_api:repeatable-read/read-only'],
      realProviderCalls: 0,
    };
    console.log(JSON.stringify({ proof }));
    const command = await message();
    if (command.action === 'close') process.exit(0);
    assert.equal(command.action, 'commit');
    const postBytes = Buffer.from(command.post, 'base64'),
      { checksum: postChecksum, ...post } = JSON.parse(postBytes);
    assert.equal(postChecksum, digest(post));
    assert.deepEqual(post, {
      ...before,
      status: 'paused',
      reason: 'RECOVERED_AFTER_POWER_LOSS',
      canonicalAtPause: proof.canonical,
      lastEnded: null,
    });
    const actual = await readFile(statePath);
    assert(
      actual.equals(beforeBytes) || actual.equals(postBytes),
      'Control changed under recovery',
    );
    abort.signal.throwIfAborted();
    for (const [i, root] of [plan.storagePath, plan.quotaPath].entries()) {
      const held = await locks[i].stat(),
        present = await lstat(root + '/.maintenance.lock');
      assert(
        !present.isSymbolicLink() &&
          present.ino === held.ino &&
          present.dev === held.dev &&
          held.nlink === 1,
        'Filesystem exclusion changed',
      );
    }
    assert.equal(
      (
        await owner.query(
          "SELECT count(*)::int n FROM pg_locks WHERE pid=pg_backend_pid() AND locktype='advisory' AND granted",
        )
      ).rows[0].n,
      5,
    );
    // atomicJson uses compact JSON. Preserve the exact intended encoding by
    // requiring the same compact serialization on the host before committing.
    const payload = { ...post, checksum: postChecksum };
    const canonicalBytes = Buffer.from(JSON.stringify(payload) + '\n');
    assert.deepEqual(postBytes, canonicalBytes);
    if (!actual.equals(postBytes))
      await atomicJson(plan.storagePath, 'reconstruction.json', payload);
    console.log(JSON.stringify({ committed: true, sha256: hash(await readFile(statePath)) }));
    await message(); // Host closes only after evidence/result/lock cleanup settles.
  } finally {
    clearTimeout(timer);
    if (snapshot) await reader.query('ROLLBACK').catch(() => {});
    for (const c of clients) await c.end().catch(() => {});
    for (const f of locks.reverse()) await f.close();
  }
}
