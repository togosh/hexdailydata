import assert from 'node:assert/strict';
import { fork } from 'node:child_process';
import { once } from 'node:events';
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { createHash, randomUUID } from 'node:crypto';
import pg from 'pg';
import { connect, databaseConfig } from '../../dist/db/connect.js';
import { migrateCurrent } from '../../dist/db/migrate.js';
import { ReadDatabase } from '../../dist/services/queries/database.js';
import { stakeEvents } from '../../dist/services/queries/stake-events.js';
import { StakeEventsQuery } from '../../dist/contracts/stake-events.js';
import { verifyHttp } from './http.mjs';
const decode = (token) => JSON.parse(Buffer.from(token, 'base64url').toString());
const encode = (token) => Buffer.from(JSON.stringify(token)).toString('base64url');
import { StakeEventsResponseSchema as Response } from '../../dist/contracts/stake-events.js';
import {
  bootstrap,
  commit,
  acquire,
  expectedCursor,
  start,
  end,
  ga,
  transfer,
  A,
  B,
  C,
  ZERO,
  LARGE,
  hash,
} from './fixture.mjs';

const evidence = {
  label: 'SYNTHETIC SQL/LOOPBACK ONLY',
  suite: process.env.LAB_SUITE,
  tests: [],
  writer: [],
  http: [],
  processes: [],
  plans: [],
  externalCalls: 0,
};
const save = () => writeFileSync('/evidence/result.json', JSON.stringify(evidence, null, 2) + '\n');
const sha = (raw) => createHash('sha256').update(raw).digest('hex');
const json = (file) => JSON.parse(readFileSync(file, 'utf8'));
const children = new Set(),
  reads = [];
let native,
  admin,
  parityDb,
  prototype,
  server,
  serverNo = 0,
  clientNo = 0,
  now = Date.parse('2026-09-25T00:00:00Z');
const signal = () => AbortSignal.timeout(3000);
const expectedCore = [
  { origin: 1, block: 101, log: 1, stake: '1', kind: 'stake_start' },
  { origin: 369, block: 102, log: 1, stake: '2', kind: 'stake_start' },
  { origin: 369, block: 102, log: 2, stake: '2', kind: 'stake_end' },
  { origin: 369, block: 103, log: 0, stake: '1', kind: 'good_accounting' },
  { origin: 369, block: 104, log: 0, stake: '1', kind: 'stake_end' },
];
const expectedPages = Array.from({ length: 103 }, (_, i) => ({
  origin: 369,
  block: 105,
  log: 2 * i + 1,
  stake: String(10 + i),
  kind: 'stake_start',
}));
const key = (e) => `${e.origin}:${hash(e.block)}:${e.log}`;
const shape = (e) => ({ eventId: e.eventId, stakeId: e.stakeId, kind: e.kind });
const expectedShape = (rows) =>
  rows.map((e) => ({ eventId: key(e), stakeId: e.stake, kind: e.kind }));
async function test(name, fn) {
  const t = performance.now();
  try {
    await fn();
    evidence.tests.push({ name, status: 'PASS', ms: performance.now() - t });
    console.log('PASS', name);
  } catch (e) {
    evidence.tests.push({ name, status: 'FAIL', error: e.stack });
    throw e;
  } finally {
    save();
  }
}
function makeRead(instance) {
  const db = new ReadDatabase({ ...databaseConfig('api'), ...(instance ? { instance } : {}) });
  reads.push(db);
  return db;
}
async function direct(db, query) {
  const trace = [];
  const body = Response.parse(await stakeEvents(db, StakeEventsQuery.parse(query), signal()));
  return { body, trace };
}
async function produced(values = [], day, branch = 0) {
  const r = await commit(native, values, day, branch);
  evidence.writer.push({
    operation: 'commit',
    chain: 369,
    block: r.result.block,
    events: r.input.sources[0].events.map((e) => ({
      origin: e.originChainId,
      block: e.blockNumber,
      hash: e.blockHash,
      log: e.logIndex,
      value: e.value,
    })),
  });
  return r;
}
async function launchServer(instance = process.env.HDD_V2_DB_INSTANCE) {
  const file = `/evidence/server-${++serverNo}.json`;
  const child = fork(new URL('./server.mjs', import.meta.url), [], {
    execArgv: ['--max-old-space-size=192'],
    stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
    env: {
      ...process.env,
      HDD_V2_DB_INSTANCE: instance,
      LAB_SERVER_RECEIPT: file,
      LAB_NOW: String(now),
    },
  });
  children.add(child);
  let error = '';
  child.stderr.on('data', (c) => {
    error += c;
  });
  child.stdout.resume();
  const message = await Promise.race([
    once(child, 'message').then(([m]) => m),
    once(child, 'exit').then(([code]) => {
      throw Error(`server exit ${code}: ${error}`);
    }),
    new Promise((_, reject) => {
      const t = setTimeout(() => reject(Error('server start deadline')), 10000);
      t.unref();
    }),
  ]);
  const handle = { child, file, base: `http://127.0.0.1:${message.port}`, pid: message.pid };
  evidence.processes.push({
    kind: 'reader',
    pid: message.pid,
    simulatedNow: now,
    receipt: file.split('/').at(-1),
  });
  return handle;
}
async function stopServer(handle) {
  if (!handle) return;
  const settled = once(handle.child, 'exit');
  handle.child.send('stop');
  await Promise.race([
    settled,
    new Promise((_, reject) => {
      const t = setTimeout(() => reject(Error('reader stop deadline')), 5000);
      t.unref();
    }),
  ]);
  children.delete(handle.child);
  assert.equal(handle.child.exitCode, 0);
  assert.equal(json(handle.file).connectionsClosed, true);
}
async function request(query = {}, status = 200, handle = server) {
  const params = typeof query === 'string' ? query : new URLSearchParams(query).toString();
  const response = await fetch(handle.base + '/api/v2/stake-events?' + params, {
    redirect: 'error',
    signal: AbortSignal.timeout(6000),
  });
  const raw = await response.text();
  const body = JSON.parse(raw);
  assert.equal(response.status, status, raw);
  assert.ok(Buffer.byteLength(raw) <= 524288);
  if (status === 200) Response.parse(body);
  else {
    assert.equal(typeof body.requestId, 'string');
    assert.deepEqual(Object.keys(body.error).sort(), ['code', 'message', 'retryable']);
    assert.equal(body.error.retryable, status === 503 || status === 429);
    assert.equal(
      body.error.code,
      status === 409 ? 'reset_required' : status === 400 ? 'invalid_request' : 'source_unavailable',
    );
  }
  assert.equal(response.headers.get('cache-control'), 'no-store');
  assert.equal(response.headers.get('x-content-type-options'), 'nosniff');
  assert.equal(response.headers.get('content-type'), 'application/json; charset=utf-8');
  if (status === 200 && prototype) {
    const { label, ...expected } = await prototype.readActivity(
      parityDb,
      Object.fromEntries(new URLSearchParams(params)),
      signal(),
    );
    assert.deepEqual(body, expected);
    evidence.prototypeResponsesCompared = (evidence.prototypeResponsesCompared ?? 0) + 1;
  }
  evidence.http.push({
    query: params,
    status: response.status,
    headers: Object.fromEntries(response.headers),
    bodyBytes: Buffer.byteLength(raw),
    sha256: sha(raw),
    body,
  });
  return body;
}
async function walk(query = {}, onFirst) {
  const rows = [],
    pages = [];
  let cursor;
  for (let i = 0; i < 30; i++) {
    const r = await request({ ...query, ...(cursor ? { cursor } : {}) });
    pages.push({
      items: r.items.length,
      scanned: r.scannedEvents,
      caughtUp: r.caughtUp,
      upper: r.cutoff.blockNumber,
    });
    rows.push(...r.items);
    if (i === 0) await onFirst?.(r);
    if (r.caughtUp) {
      assert.equal(new Set(rows.map((x) => x.eventId)).size, rows.length);
      return { rows, pages, cursor: r.nextCursor };
    }
    assert.notEqual(r.nextCursor, cursor);
    cursor = r.nextCursor;
  }
  throw Error('Finite traversal cap reached');
}
async function consumer(file, query, options = {}) {
  const receipt = `/evidence/consumer-${++clientNo}.json`;
  const child = fork(new URL('./consumer.mjs', import.meta.url), [], {
    execArgv: ['--max-old-space-size=128'],
    stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
    env: {
      ...process.env,
      LAB_NOW: String(now),
      LAB_CONSUMER_OPTIONS: JSON.stringify({ base: server.base, file, query, receipt, ...options }),
    },
  });
  children.add(child);
  let stdout = '',
    stderr = '';
  child.stdout.on('data', (c) => (stdout += c));
  child.stderr.on('data', (c) => (stderr += c));
  const timer = setTimeout(() => child.kill('SIGTERM'), 120000);
  timer.unref();
  const [code, signal] = await once(child, 'exit');
  clearTimeout(timer);
  children.delete(child);
  const record = {
    kind: 'consumer',
    pid: child.pid,
    simulatedNow: now,
    exit: code,
    signal,
    receipt: receipt.split('/').at(-1),
    stdout,
    stderr,
  };
  evidence.processes.push(record);
  assert.equal(code, options.expectedExit ?? 0, stderr);
  const result = json(receipt);
  assert.ok(result.attempts.length <= 30);
  return result;
}
async function resetFixture() {
  await native?.writer.close();
  native = null;
  await admin.query('TRUNCATE hdd.chains,hdd.events,hdd.transfers_recent CASCADE');
}
async function resources(label) {
  const db = (
    await admin.query(
      "SELECT pg_read_file('/sys/fs/cgroup/cpu.max') AS cpu,pg_read_file('/sys/fs/cgroup/memory.max') AS memory,pg_read_file('/sys/fs/cgroup/memory.peak') AS peak",
    )
  ).rows[0];
  const runner = {
    cpu: readFileSync('/sys/fs/cgroup/cpu.max', 'utf8'),
    memory: readFileSync('/sys/fs/cgroup/memory.max', 'utf8'),
    peak: readFileSync('/sys/fs/cgroup/memory.peak', 'utf8'),
  };
  assert.equal(db.cpu.trim(), '50000 100000');
  assert.equal(runner.cpu.trim(), '50000 100000');
  assert.equal(db.memory.trim(), '1342177280');
  assert.equal(runner.memory.trim(), '805306368');
  (evidence.resources ??= []).push({ label, db, runner });
}
try {
  admin = new pg.Client({
    host: 'db',
    database: 'hexdailydata_v2',
    user: 'hdd_v2_admin',
    password: process.env.LAB_ADMIN_PASSWORD,
  });
  await admin.connect();
  const migrator = await connect(databaseConfig('migrator'));
  await migrateCurrent(migrator);
  await migrator.end();
  await resources('start');
  const db = makeRead();
  if (process.env.LAB_PROTOTYPE_READER) {
    prototype = await import(process.env.LAB_PROTOTYPE_READER);
    parityDb = makeRead();
  }
  server = await launchServer();
  await test('native unavailable then genuinely empty global feed; production constructor/fork initialization', async () => {
    await request({}, 503);
    const init = await bootstrap({ inherited: false, beforeNative: () => request({}, 503) });
    native = init.native;
    const empty = await request({});
    assert.equal(empty.caughtUp, true);
    assert.deepEqual(empty.items, []);
    assert.equal(empty.cutoff.blockNumber, '100');
    evidence.empty = { cursor: empty.nextCursor, scanned: empty.scannedEvents };
    await resetFixture();
  });
  await test('actual inherited and native lifecycle commits preserve event identity and exact amounts', async () => {
    const init = await bootstrap({ beforeNative: () => request({}, 503) });
    native = init.native;
    await produced(
      [
        transfer(B, ZERO, '1000'),
        start(2, B),
        end(2, B),
        transfer(ZERO, B, '1000'),
        { kind: 'claim' },
      ],
      10,
    );
    await produced([ga(1)], 12);
    await produced(
      [
        { ...end(1, A, '5', '0', 1, true), principal: LARGE, shares: LARGE },
        transfer(ZERO, A, (BigInt(LARGE) + 5n).toString()),
      ],
      12,
    );
    const r = await walk();
    if (process.env.LAB_PROTOTYPE_READER) {
      const { readActivity } = await import(process.env.LAB_PROTOTYPE_READER);
      const { label, ...prototype } = await readActivity(db, {}, signal());
      const actual = await request({});
      assert.deepEqual(actual, prototype);
      evidence.prototypeParity = {
        source: 'accepted continuity reader with import paths adapted only',
        removed: 'label',
        responseEqual: true,
      };
    }
    assert.deepEqual(r.rows.map(shape), expectedShape(expectedCore));
    assert.equal(r.rows[0].amounts.principalHearts, LARGE);
    assert.deepEqual(r.rows[2].amounts, {
      payoutHearts: '0',
      penaltyHearts: '0',
      principalHearts: null,
      stakeShares: null,
      servedDays: 0,
      previouslyUnlocked: false,
    });
    assert.equal(r.rows[3].amounts.principalHearts, null);
    assert.equal(r.rows[4].amounts.principalHearts, LARGE);
    const {
      rows: [s],
    } = await native.client.query(
      'SELECT payout_recorded FROM hdd.current_state WHERE chain_id=369',
    );
    assert.equal(s.payout_recorded, '5');
    const {
      rows: [cancelled],
    } = await native.client.query(
      'SELECT lifecycle FROM hdd.stakes WHERE chain_id=369 AND stake_id=2',
    );
    assert.equal(cancelled.lifecycle, 'cancelled');
    evidence.exactLedger = {
      expected: expectedCore,
      rows: r.rows,
      payoutRecordedOnce: s.payout_recorded,
      cancellationStoredAs: 'stake_end',
    };
    const fullTail = await request({ limit: '5' });
    assert.equal(fullTail.items.length, 5);
    assert.equal(fullTail.caughtUp, true);
    const common = await acquire(1);
    try {
      await assert.rejects(
        () => commit(common, [{ kind: 'claim' }], 12),
        /outside source binding|frozen/,
      );
    } finally {
      await common.writer.close();
    }
    evidence.commonPostForkAppend =
      'Actual common writer commit rejected by frozen source boundary; no origin1 post-fork product.';
    await request({ cursor: evidence.empty.cursor }, 409); // Different source lineage, same lab DB identity.
  });
  await test('bounded raw scans, complete 50/100/tail paging, same-block order and append-stable upper boundary', async () => {
    const values = [];
    for (let i = 0; i < 103; i++)
      values.push(transfer(B, ZERO, '1'), start(10 + i, B, '1', '1', 2));
    values.push(...Array.from({ length: 225 }, () => ({ kind: 'claim' })));
    await produced(values, 12);
    evidence.traversals = [];
    for (const q of [{}, { limit: '50' }, { limit: '100' }, { limit: '7' }]) {
      const r = await walk(q);
      assert.deepEqual(r.rows.map(shape), expectedShape([...expectedCore, ...expectedPages]));
      evidence.traversals.push({ query: q, pages: r.pages, events: r.rows.length });
    }
    const r = await walk({ limit: '50' }, async () => {
      await produced([transfer(B, ZERO, '1'), start(200, B, '1', '1')], 12);
    });
    assert.deepEqual(r.rows.map(shape), expectedShape([...expectedCore, ...expectedPages]));
    assert.ok(r.pages.every((p) => p.upper === '105'));
    const next = await request({ limit: '50', cursor: r.cursor });
    assert.deepEqual(
      next.items.map((x) => x.stakeId),
      ['200'],
    );
    assert.equal(next.caughtUp, true);
    evidence.appendDuringTraversal = { pages: r.pages, next: next.items };
  });
  await test('sparse/empty filters advance a bounded position and later matching events are collected', async () => {
    const sparse = await walk({ address: C });
    assert.equal(sparse.rows.length, 0);
    assert.ok(sparse.pages.some((p) => p.items === 0 && !p.caughtUp));
    const unchanged = await request({ address: C, cursor: sparse.cursor });
    assert.equal(unchanged.caughtUp, true);
    assert.equal(unchanged.scannedEvents, 0);
    await produced([{ kind: 'claim' }], 12);
    const unrelated = await request({ address: C, cursor: unchanged.nextCursor });
    assert.equal(unrelated.caughtUp, true);
    assert.equal(unrelated.items.length, 0);
    assert.equal(unrelated.scannedEvents, 1);
    await produced([transfer(ZERO, C, '2'), transfer(C, ZERO, '2'), start(250, C, '2', '1')], 12);
    const match = await request({ address: C, cursor: unrelated.nextCursor });
    assert.deepEqual(
      match.items.map((x) => x.stakeId),
      ['250'],
    );
    assert.equal(match.caughtUp, true);
    const owner = await walk({ address: A.toUpperCase().replace('0X', '0x') });
    assert.deepEqual(
      owner.rows.map((x) => x.kind),
      ['stake_start', 'good_accounting', 'stake_end'],
    );
    const normalized = await request({ address: A, cursor: owner.cursor });
    assert.equal(normalized.caughtUp, true);
    assert.equal(normalized.items.length, 0);
    const stake = await walk({ stakeId: '1' });
    assert.deepEqual(owner.rows, stake.rows);
    const ends = await walk({ kind: 'stake_end' });
    assert.deepEqual(
      ends.rows.map((x) => x.stakeId),
      ['2', '1'],
    );
    evidence.sparse = {
      pages: sparse.pages,
      unchangedScans: unchanged.scannedEvents,
      unrelatedScans: unrelated.scannedEvents,
      matched: match.items,
    };
  });
  await test('real reader/client OS restart beyond 60s and atomic inbox/checkpoint crash windows', async () => {
    const cappedFile = '/evidence/capped-bot.json';
    const capped = await consumer(cappedFile, { address: C }, { maxRequests: 1 });
    assert.equal(capped.status, 'INCOMPLETE');
    assert.equal(Object.keys(json(cappedFile).inbox).length, 0);
    assert.equal(json(cappedFile).caughtUp, false);
    assert.ok(json(cappedFile).cursor);
    const resumed = await consumer(cappedFile, { address: C });
    assert.equal(resumed.status, 'CAUGHT_UP');
    assert.deepEqual(
      Object.values(json(cappedFile).inbox).map((e) => e.stakeId),
      ['250'],
    );
    evidence.cappedConsumer = {
      firstRequests: 1,
      firstInbox: 0,
      firstStatus: capped.status,
      resumedStatus: resumed.status,
      resumedIds: ['250'],
    };
    const file = '/evidence/bot.json',
      q = { address: A, limit: '2' };
    const first = await consumer(file, q);
    assert.equal(first.status, 'CAUGHT_UP');
    assert.equal(Object.keys(json(file).inbox).length, 3);
    const saved = readFileSync(file);
    writeFileSync('/evidence/progress-before-restart.json', saved);
    const oldPid = server.pid;
    await stopServer(server);
    server = null;
    now += 120000;
    await produced([transfer(A, ZERO, '3'), start(300, A, '3', '2')], 12);
    server = await launchServer();
    assert.notEqual(server.pid, oldPid);
    const lost = await consumer(file, q, { fault: 'after-receive', expectedExit: 17 });
    assert.equal(lost.attempts.length, 1);
    assert.deepEqual(readFileSync(file), saved);
    await consumer(file, q, { fault: 'before-rename', expectedExit: 18 });
    assert.deepEqual(readFileSync(file), saved);
    await consumer(file, q, { fault: 'after-rename', expectedExit: 19 });
    assert.equal(Object.keys(json(file).inbox).length, 4);
    const retry = await consumer(file, q);
    assert.equal(retry.status, 'CAUGHT_UP');
    assert.equal(retry.notifications.length, 0);
    assert.equal(Object.keys(json(file).inbox).length, 4);
    evidence.restart = {
      oldReaderPid: oldPid,
      newReaderPid: server.pid,
      elapsedSyntheticMs: 120000,
      savedBytes: saved.length,
      savedSha256: sha(saved),
      newEvents: ['300'],
      inboxIds: Object.keys(json(file).inbox),
      notificationsAreNotExactlyOnce: true,
    };
  });
  await test('actual confirmed rewind/replacement: safe prior boundary resumes; affected inbox requires reset', async () => {
    const q = { address: A, limit: '2' },
      file = '/evidence/bot.json',
      prior = json(file).cursor;
    const anchor = (await expectedCursor(native.client)).blockNumber;
    const old = await produced([transfer(A, ZERO, '4'), start(400, A, '4', '2')], 12);
    await consumer(file, q);
    const affected = json(file).cursor,
      oldIdentity = Object.values(json(file).inbox).find((x) => x.stakeId === '400').eventId;
    const rewind = await native.writer.rewind(anchor, await expectedCursor(native.client));
    evidence.writer.push({ operation: 'rewind', ...rewind });
    const behind = await request({ ...q, cursor: affected }, 409);
    assert.equal(behind.error.code, 'reset_required');
    const replacement = await produced([transfer(A, ZERO, '4'), start(401, A, '4', '2')], 12, 1);
    const changed = await request({ ...q, cursor: affected }, 409);
    assert.equal(changed.error.code, 'reset_required');
    const safe = await request({ ...q, cursor: prior });
    assert.deepEqual(
      safe.items.map((x) => x.stakeId),
      ['401'],
    );
    assert.notEqual(safe.items[0].eventId, oldIdentity);
    const failed = await consumer(file, q);
    assert.equal(failed.status, 'RESET_REQUIRED');
    assert.ok(Object.values(json(file).inbox).some((x) => x.stakeId === '400'));
    writeFileSync('/evidence/invalidated-inbox.json', readFileSync(file));
    const replay = await consumer(file, q, { reset: true });
    assert.equal(replay.status, 'CAUGHT_UP');
    assert.ok(!Object.values(json(file).inbox).some((x) => x.stakeId === '400'));
    assert.ok(Object.values(json(file).inbox).some((x) => x.stakeId === '401'));
    evidence.rewind = {
      anchor,
      oldBlock: old.result.block,
      replacementBlock: replacement.result.block,
      oldIdentity,
      replacementIdentity: safe.items[0].eventId,
      priorBoundarySurvives: true,
      affectedBoundaryReset: true,
    };
  });
  await test('actual ordinary prune preserves lifecycle rows but loses old boundary proof; restore/source/instance guards', async () => {
    const stale = (await request({})).nextCursor;
    // Add an empty checkpoint so the old upper is strictly below the pruning floor.
    await produced([], 12);
    const before = (await native.client.query('SELECT count(*)::int AS n FROM hdd.events')).rows[0]
      .n;
    await produced([], 22);
    const pruned = await native.writer.prune();
    evidence.writer.push({ operation: 'prune', result: pruned });
    assert.ok(pruned.pruned > 0);
    const after = (await native.client.query('SELECT count(*)::int AS n FROM hdd.events')).rows[0]
      .n;
    assert.equal(before, after);
    const response = await request({ cursor: stale }, 409);
    assert.equal(response.error.code, 'reset_required');
    const fresh = await walk();
    assert.ok(fresh.rows.length > 0);
    const current = json('/evidence/bot.json').cursor;
    await request({ address: A, limit: '2', cursor: current }, 409);
    // Explicit synthetic restore-behind boundary fixture, not called a production restore.
    const sync = (
      await native.client.query('SELECT block_number FROM hdd.sync_state WHERE chain_id=369')
    ).rows[0];
    await native.client.query(
      'UPDATE hdd.sync_state SET block_number=block_number-1 WHERE chain_id=369',
    );
    const restored = await request({ cursor: fresh.cursor }, 409);
    assert.equal(restored.error.code, 'reset_required');
    await native.client.query('UPDATE hdd.sync_state SET block_number=$1 WHERE chain_id=369', [
      sync.block_number,
    ]);
    const history = (
      await native.client.query('SELECT sources FROM hdd.source_history WHERE chain_id=369')
    ).rows[0].sources;
    await native.client.query(
      "UPDATE hdd.source_history SET sources=jsonb_set(sources,'{binding,codeHash}',to_jsonb($1::text)) WHERE chain_id=369",
      [hash(999999)],
    );
    const mismatch = await request({ cursor: fresh.cursor }, 409);
    assert.equal(mismatch.error.code, 'reset_required');
    await native.client.query('UPDATE hdd.source_history SET sources=$1 WHERE chain_id=369', [
      JSON.stringify(history),
    ]);
    const newInstance = randomUUID();
    await admin.query('UPDATE hdd_identity.instance SET instance=$1', [newInstance]);
    const changedDb = makeRead(newInstance);
    await assert.rejects(
      () => direct(changedDb, { cursor: fresh.cursor }),
      (e) => e.code === 'reset_required',
    );
    await changedDb.close();
    const changedServer = await launchServer(newInstance);
    try {
      await request({ cursor: fresh.cursor }, 409, changedServer);
    } finally {
      await stopServer(changedServer);
    }
    await admin.query('UPDATE hdd_identity.instance SET instance=$1', [
      process.env.HDD_V2_DB_INSTANCE,
    ]);
    evidence.pruning = {
      beforeEvents: before,
      afterEvents: after,
      prune: pruned,
      outcome: response.error,
      restoreFixture: 'SQL cursor behind cutoff; no production restore executed',
      changedInstance:
        'Actual DB identity changed, new read connection, old progress rejected, then restored lab identity',
    };
  });
  await test('actual HTTP HEAD/errors/deadline/disconnect and existing admission', async () =>
    verifyHttp({ admin, db, server, request, evidence }));
  await test('bounded malformed/future/wrong-scope positions, finality and actual read-only/timeout/cancel guards', async () => {
    const full = await walk(),
      token = decode(full.cursor);
    for (const q of [
      { limit: '101' },
      { limit: '0' },
      { limit: '1e2' },
      { fromBlock: '999999' },
      { fromBlock: '01' },
      { address: A, stakeId: '1' },
      { chain: 'ethereum' },
      { kind: 'transfer' },
      { cursor: '' },
      { cursor: 'x'.repeat(2049) },
      { cursor: 'e30' },
      { evil: '1' },
    ])
      await request(q, 400);
    await request('limit=50&limit=50', 400);
    await request({ address: B, cursor: full.cursor }, 409);
    await request(
      { cursor: encode({ ...token, upper: { ...token.upper, number: '999999' } }) },
      409,
    );
    await request(
      { cursor: encode({ ...token, upper: { ...token.upper, finality: 'finalized' } }) },
      409,
    );
    const page = decode((await request({ limit: '1' })).nextCursor);
    await request(
      { limit: '1', cursor: encode({ ...page, position: { ...page.position, block: '999999' } }) },
      400,
    );
    await request(
      { limit: '1', cursor: encode({ ...page, position: { ...page.position, log: 2147483647 } }) },
      409,
    );
    const role = await db.read(
      signal(),
      async (c) =>
        (
          await c.query(
            "SELECT current_user, current_setting('transaction_read_only') AS ro, current_setting('statement_timeout') AS timeout",
          )
        ).rows[0],
      true,
    );
    assert.equal(role.current_user, 'hdd_v2_api');
    assert.equal(role.ro, 'on');
    assert.equal(role.timeout, '2s');
    await assert.rejects(
      () => db.read(signal(), (c) => c.query('DELETE FROM hdd.events')),
      (e) => ['25006', '42501'].includes(e.code),
    );
    let timeout;
    const started = performance.now();
    try {
      await db.read(AbortSignal.timeout(5000), (c) => c.query('SELECT pg_sleep(3)'));
    } catch (e) {
      timeout = e;
    }
    assert.equal(timeout?.code, '57014');
    const timeoutMs = performance.now() - started;
    const abort = new AbortController(),
      timer = setTimeout(() => abort.abort(), 40);
    try {
      await assert.rejects(() => db.read(abort.signal, (c) => c.query('SELECT pg_sleep(1)')));
    } finally {
      clearTimeout(timer);
    }
    await direct(db, {});
    evidence.guards = { role, statementTimeoutCode: timeout.code, timeoutMs, cancellation: true };
  });
  await test('finite owner demo prints only local notifications and terminates caught up', async () => {
    const result = await consumer('/evidence/owner-demo.json', { address: A, limit: '50' });
    assert.equal(result.status, 'CAUGHT_UP');
    evidence.ownerDemo = {
      command: 'python tools/run_sql.py --suite full --owner builder',
      status: result.status,
      requests: result.attempts.length,
      bodyBytes: result.attempts.reduce((n, r) => n + r.bytes, 0),
      notifications: result.notifications,
    };
    for (const line of result.notifications) console.log('DEMO', line);
  });
  await resources('end');
  evidence.status = 'PASS';
} catch (e) {
  evidence.status = 'FAIL';
  evidence.error = e.stack;
  console.error(e);
  process.exitCode = 1;
} finally {
  await stopServer(server).catch((e) => {
    evidence.serverCleanupError = e.message;
    process.exitCode = 1;
  });
  for (const child of children) {
    child.kill('SIGTERM');
    await Promise.race([once(child, 'exit'), new Promise((r) => setTimeout(r, 5000))]);
    if (child.exitCode === null) child.kill('SIGKILL');
  }
  await Promise.allSettled(reads.map((db) => db.close()));
  await native?.writer.close().catch(() => {});
  await admin?.end().catch(() => {});
  evidence.connectionsClosed = true;
  evidence.childrenSettled = [...children].every(
    (c) => c.exitCode !== null || c.signalCode !== null,
  );
  save();
}
