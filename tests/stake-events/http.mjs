import assert from 'node:assert/strict';
import http from 'node:http';
import { once } from 'node:events';
import { createApp } from '../../dist/api/app.js';
import { ApiErrorSchema } from '../../dist/contracts/api.js';

async function stats(server) {
  const received = once(server.child, 'message');
  server.child.send('stats');
  return (await received)[0];
}
export async function verifyHttp({ admin, db, server, request, evidence }) {
  const path = '/api/v2/stake-events',
    base = server.base;
  const first = await request({});
  const witness = [];
  for (const [query, status] of [
    ['', 200],
    ['?limit=0', 400],
    ['?address=0x' + '22'.repeat(20) + '&cursor=' + first.nextCursor, 409],
  ]) {
    for (const method of ['GET', 'HEAD']) {
      const response = await fetch(base + path + query, {
        method,
        headers: { 'if-none-match': '*' },
        redirect: 'error',
      });
      const raw = await response.text();
      assert.equal(response.status, status);
      assert.equal(response.headers.get('cache-control'), 'no-store');
      assert.equal(response.headers.get('x-content-type-options'), 'nosniff');
      assert.equal(response.headers.get('content-type'), 'application/json; charset=utf-8');
      assert.equal(response.headers.get('etag'), null);
      if (method === 'HEAD') assert.equal(raw, '');
      else if (status !== 200) ApiErrorSchema.parse(JSON.parse(raw));
      else assert.deepEqual(JSON.parse(raw), first);
      witness.push({
        method,
        query,
        status,
        bodyBytes: Buffer.byteLength(raw),
        headers: Object.fromEntries(response.headers),
      });
    }
  }
  const beforeInvalid = await stats(server);
  for (const query of [
    'limit=50&limit=50',
    'address=&address=x',
    'fromBlock=9223372036854775808',
    'fromBlock=-1',
    'limit=01',
    'stakeId=1099511627776',
    'kind=',
    'cursor=' + 'x'.repeat(2049),
    'evil=' + 'x'.repeat(4096),
  ]) {
    const r = await fetch(base + path + '?' + query, { redirect: 'error' });
    assert.equal(r.status, 400);
    ApiErrorSchema.parse(await r.json());
  }
  const afterInvalid = await stats(server);
  assert.equal(afterInvalid.reads, beforeInvalid.reads);
  const post = await fetch(base + path, { method: 'POST', redirect: 'error' });
  assert.equal(post.status, 405);
  assert.equal(post.headers.get('allow'), 'GET, HEAD');
  assert.equal(ApiErrorSchema.parse(await post.json()).error.code, 'read_only');
  const quota = createApp({ dependencies: { db }, admission: { capacity: 1, concurrent: 1 } });
  try {
    const qbase = await quota.listen({ host: '127.0.0.1', port: 0 });
    assert.equal((await fetch(qbase + path)).status, 200);
    const r = await fetch(qbase + path);
    assert.equal(r.status, 429);
    assert.equal(r.headers.get('retry-after'), '60');
    ApiErrorSchema.parse(await r.json());
  } finally {
    await quota.close();
  }

  // Lock only this disposable fixture. A real SELECT blocks inside the production reader.
  await admin.query('BEGIN');
  await admin.query('LOCK hdd.events IN ACCESS EXCLUSIVE MODE');
  let deadline;
  try {
    const started = performance.now();
    const r = await fetch(base + path, { redirect: 'error', signal: AbortSignal.timeout(6000) });
    const body = ApiErrorSchema.parse(await r.json());
    deadline = { status: r.status, ms: performance.now() - started, body };
    assert.equal(r.status, 503);
    assert.equal(body.error.code, 'source_unavailable');
    assert.ok(deadline.ms >= 1800 && deadline.ms < 4000);
    const head = await fetch(base + path, {
      method: 'HEAD',
      redirect: 'error',
      signal: AbortSignal.timeout(6000),
    });
    assert.equal(head.status, 503);
    assert.equal(await head.text(), '');
    witness.push({
      method: 'HEAD',
      status: 503,
      bodyBytes: 0,
      headers: Object.fromEntries(head.headers),
    });
  } finally {
    await admin.query('ROLLBACK');
  }
  await request({});
  await admin.query('BEGIN');
  await admin.query('LOCK hdd.source_history IN ACCESS EXCLUSIVE MODE');
  try {
    const r = await fetch(base + path + '?cursor=' + first.nextCursor, {
      redirect: 'error',
      signal: AbortSignal.timeout(6000),
    });
    const body = ApiErrorSchema.parse(await r.json());
    assert.equal(r.status, 503);
    assert.equal(body.error.code, 'source_unavailable');
    evidence.provenanceReadFailure = { status: r.status, body };
  } finally {
    await admin.query('ROLLBACK');
  }
  const beforeDisconnect = await stats(server);
  await admin.query('BEGIN');
  await admin.query('LOCK hdd.events IN ACCESS EXCLUSIVE MODE');
  let blockedPid;
  const req = http.get(base + path);
  req.on('error', () => {});
  try {
    const end = performance.now() + 1500;
    while (performance.now() < end) {
      await admin.query('SELECT pg_stat_clear_snapshot()');
      const row = (
        await admin.query(
          "SELECT pid FROM pg_stat_activity WHERE datname=current_database() AND usename='hdd_v2_api' AND wait_event_type='Lock' AND query LIKE 'WITH candidates AS MATERIALIZED%'",
        )
      ).rows[0];
      if (row) {
        blockedPid = row.pid;
        break;
      }
      await new Promise((r) => setTimeout(r, 20));
    }
    assert.ok(blockedPid, 'real app SELECT must be waiting before the client disconnects');
    const closed = new Promise((resolve) => req.once('close', resolve));
    req.destroy();
    await closed;
    const abortDeadline = performance.now() + 1000;
    let current;
    do {
      current = await stats(server);
      if (current.aborted > beforeDisconnect.aborted) break;
      await new Promise((r) => setTimeout(r, 20));
    } while (performance.now() < abortDeadline);
    assert.ok(
      current.aborted > beforeDisconnect.aborted,
      'actual app reply close must abort ReadDatabase',
    );
  } finally {
    req.destroy();
    await admin.query('ROLLBACK');
  }
  const end = performance.now() + 3000;
  while (
    (await admin.query('SELECT pid FROM pg_stat_activity WHERE pid=$1', [blockedPid])).rowCount &&
    performance.now() < end
  )
    await new Promise((r) => setTimeout(r, 20));
  assert.equal(
    (await admin.query('SELECT pid FROM pg_stat_activity WHERE pid=$1', [blockedPid])).rowCount,
    0,
  );
  await request({});
  const afterDisconnect = await stats(server);
  assert.ok(afterDisconnect.counters.connections > beforeDisconnect.counters.connections);
  // Corrupt only a disposable event payload, then restore its exact original bytes.
  const stored = (
    await admin.query(
      'SELECT payload FROM hdd.events WHERE origin_chain_id=1 AND block_number=101 AND log_index=1',
    )
  ).rows[0].payload;
  await admin.query(
    'UPDATE hdd.events SET payload=$1 WHERE origin_chain_id=1 AND block_number=101 AND log_index=1',
    [JSON.stringify({ ...stored, transactionHash: '0x' + 'ff'.repeat(32) })],
  );
  try {
    const response = await fetch(base + path + '?stakeId=1', { redirect: 'error' });
    const body = ApiErrorSchema.parse(await response.json());
    assert.equal(response.status, 503);
    assert.equal(body.error.code, 'source_unavailable');
    evidence.serializationFailure = { status: response.status, body };
  } finally {
    await admin.query(
      'UPDATE hdd.events SET payload=$1 WHERE origin_chain_id=1 AND block_number=101 AND log_index=1',
      [JSON.stringify(stored)],
    );
  }
  await request({});
  evidence.httpIntegration = {
    getHead: witness,
    invalidReads: afterInvalid.reads - beforeInvalid.reads,
    quota: { status: 429, retryAfter: '60' },
    deadline,
    disconnect: {
      blockedBackendPid: blockedPid,
      before: beforeDisconnect,
      after: afterDisconnect,
      backendClosed: true,
      freshRead: true,
    },
  };
}
