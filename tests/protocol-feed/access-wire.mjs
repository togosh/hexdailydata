// Narrow original-hold completion proof over actual loopback HTTP. Account seams
// remain explicitly synthetic; injected reply status is not settlement evidence.
import assert from 'node:assert/strict';
import { readFile, readdir, stat, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import net from 'node:net';
import { ProductDailyStore } from '../../dist/services/product-daily/store.js';
import { fixture, wire, until, keys, charge } from '../market-feed/access-fixture.mjs';
const R = process.env.HDD_TASK_ROOT;
assert(R?.endsWith('hex-protocol-daily-refresh-r1'));
const reports = await Promise.all(
  (await readdir(join(R, 'evidence')))
    .filter((n) => n.startsWith('APPLICATION_protocol-application-') && n.endsWith('.json'))
    .map(async (n) => ({ n, time: (await stat(join(R, 'evidence', n))).mtimeMs })),
);
const report = JSON.parse(
  await readFile(join(R, 'evidence', reports.sort((a, b) => b.time - a.time)[0].n)),
);
assert.equal(report.status, 'PASS');
assert(resolve(report.root).startsWith(resolve(R, 'scratch') + '\\'));
const metadata = JSON.parse(await readFile(join(R, 'seed/metadata.json')));
const reader = new ProductDailyStore(report.root, metadata.pair);
await reader.load();
const f = await fixture({ productDaily: reader });
f.controls.now = Date.now();
const headers = [['Authorization', 'Bearer ' + keys.good]],
  outcomes = [];
async function settlement(start, success, status) {
  await until(() => f.events.slice(start).some((e) => e.stage === 'lifecycle.terminal'));
  const events = f.events.slice(start),
    reserved = events.filter((e) => e.stage === 'lifecycle.reserved'),
    final = events.filter((e) => e.stage === 'finalize'),
    terminal = events.filter((e) => e.stage === 'lifecycle.terminal');
  assert.equal(reserved.length, 1);
  assert.equal(final.length, 1);
  assert.equal(terminal.length, 1);
  const hold = reserved[0].hold;
  assert.deepEqual(hold, {
    id: hold.id,
    accountId: 'synthetic-account',
    periodId: 'original-period',
    windowId: 'original-window',
  });
  assert.deepEqual(final[0].hold, hold);
  assert.deepEqual(terminal[0].hold, hold);
  assert.equal(final[0].success, success);
  assert.equal(final[0].status, status);
  assert.equal(terminal[0].state, success ? 'charged' : 'released');
  outcomes.push({ hold, success, status, reason: final[0].reason, terminal: terminal[0].state });
}
try {
  for (const url of [
    '/api/v2/live',
    '/api/v2/home',
    '/api/v2/daily?from=2026-10-01&to=2026-10-10&metric=dailyPayoutHEX',
  ]) {
    let start = f.events.length;
    const get = await wire(f.app, url, headers);
    assert.equal(get.statusCode, 200);
    await settlement(start, true, 200);
    start = f.events.length;
    const head = await wire(f.app, url, headers, 'HEAD');
    assert.equal(head.statusCode, 200);
    assert.equal(head.body, '');
    assert.equal(head.headers.etag, get.headers.etag);
    await settlement(start, true, 200);
    start = f.events.length;
    const cached = await wire(
      f.app,
      url,
      [...headers, ['If-None-Match', get.headers.etag]],
      'HEAD',
    );
    assert.equal(cached.statusCode, 304);
    assert.equal(cached.body, '');
    await settlement(start, true, 304);
  }
  let refreshes = 0;
  const refresh = reader.refresh.bind(reader);
  reader.refresh = async (...args) => {
    refreshes++;
    return refresh(...args);
  };
  for (const key of [keys.invalid, keys.revoked])
    assert.equal(
      (await wire(f.app, '/api/v2/live', [['Authorization', 'Bearer ' + key]])).statusCode,
      401,
    );
  assert.equal((await wire(f.app, '/api/v2/live', [...headers, ...headers])).statusCode, 401);
  assert.equal(refreshes, 0);
  const capture = reader.capture.bind(reader);
  reader.capture = () => {
    throw Error('SYNTHETIC_WIRE_READ_FAILURE');
  };
  let start = f.events.length;
  assert.equal((await wire(f.app, '/api/v2/live', headers)).statusCode, 503);
  await settlement(start, false, 503);
  reader.capture = capture;
  let release,
    entered = false;
  reader.refresh = async () => {
    entered = true;
    await new Promise((r) => {
      release = r;
    });
  };
  start = f.events.length;
  charge();
  const socket = net.createConnection({ host: '127.0.0.1', port: f.app.server.address().port });
  socket.on('error', () => {});
  socket.on('connect', () =>
    socket.write(
      'GET /api/v2/live HTTP/1.1\r\nHost: 127.0.0.1\r\nAuthorization: Bearer ' +
        keys.good +
        '\r\nConnection: close\r\n\r\n',
    ),
  );
  try {
    await until(() => entered);
    socket.destroy();
    await settlement(start, false, null);
  } finally {
    socket.destroy();
    release?.();
    reader.refresh = refresh;
  }
  assert.equal(new Set(outcomes.map((x) => x.hold.id)).size, outcomes.length);
  await writeFile(
    join(R, 'evidence/ACCESS_WIRE_RECHECK.json'),
    JSON.stringify(
      {
        status: 'PASS',
        externalRequests: 0,
        syntheticAccountSeams: true,
        root: report.root,
        chargedOriginalHolds: 9,
        releasedOriginalHolds: 2,
        outcomes,
      },
      null,
      2,
    ) + '\n',
    { flag: 'wx' },
  );
  console.log(
    'PASS 9 original holds charged over real loopback; failed/cancelled exact holds released',
  );
} finally {
  await f.close();
}
