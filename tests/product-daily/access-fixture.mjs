// Reuses the actual paid-read lifecycle and account-download authorizer.
// Identity/entitlement/meter seams are synthetic JavaScript. No SQL or payments.
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync, existsSync, appendFileSync } from 'node:fs';
import { join } from 'node:path';
import net from 'node:net';
import { setTimeout as delay } from 'node:timers/promises';
import { createApp } from '../../dist/api/app.js';
import { ApiFailure } from '../../dist/api/errors.js';
import { paidReadLifecycle } from '../../delivery/paid-reads.mjs';
import { accountDownloadAuthorizer } from '../../delivery/authorizer.mjs';
export const root = process.env.HDD_TASK_ROOT;
export const keys = Object.fromEntries(
  [
    ['good', 'A'],
    ['invalid', 'I'],
    ['revoked', 'R'],
  ].map(([k, v]) => [k, 'lab_' + v.repeat(43)]),
);
export const auth = (key = keys.good) => ({ authorization: 'Bearer ' + key });
export function charge() {
  const path = join(root, 'evidence/LOCAL_REQUEST_BUDGET.json'),
    b = existsSync(path)
      ? JSON.parse(readFileSync(path))
      : { attempts: 0, maximum: 2000, externalRequests: 0 };
  assert(b.attempts < 2000);
  b.attempts++;
  writeFileSync(path, JSON.stringify(b) + '\n');
}
export function trace(value) {
  appendFileSync(join(root, 'evidence/ACCESS_TRACES.ndjson'), JSON.stringify(value) + '\n');
}
export async function until(fn) {
  const due = Date.now() + 5000;
  while (!fn()) {
    assert(Date.now() < due, 'Timed out waiting for original hold settlement');
    await delay(5);
  }
}
export async function wire(app, url, fields = [], method = 'GET') {
  charge();
  if (!app.server.listening) await app.listen({ host: '127.0.0.1', port: 0 });
  return new Promise((done, reject) => {
    const socket = net.createConnection({ host: '127.0.0.1', port: app.server.address().port });
    let b = Buffer.alloc(0);
    const timer = setTimeout(() => {
      socket.destroy();
      reject(Error('LOOPBACK_TIMEOUT'));
    }, 5000);
    socket.on('connect', () =>
      socket.write(
        `${method} ${url} HTTP/1.1\r\nHost: 127.0.0.1:43211\r\nConnection: close\r\n${fields.map(([k, v]) => k + ': ' + v + '\r\n').join('')}\r\n`,
      ),
    );
    socket.on('data', (chunk) => (b = Buffer.concat([b, chunk])));
    socket.on('error', (e) => {
      clearTimeout(timer);
      reject(e);
    });
    socket.on('close', () => {
      clearTimeout(timer);
      const text = b.toString(),
        i = text.indexOf('\r\n\r\n'),
        head = text.slice(0, i).split('\r\n');
      const result = {
        statusCode: Number(head[0].split(' ')[1]),
        headers: Object.fromEntries(
          head.slice(1).map((l) => {
            const j = l.indexOf(':');
            return [l.slice(0, j).toLowerCase(), l.slice(j + 1).trim()];
          }),
        ),
        body: text.slice(i + 4),
      };
      trace({
        wire: { url, method, status: result.statusCode, headers: result.headers, bytes: b.length },
      });
      done(result);
    });
  });
}
export const cookie = {
  host: '127.0.0.1:43211',
  cookie: 'synthetic_session=valid',
  origin: 'http://127.0.0.1:43211',
};
export async function fixture(deps, options = {}) {
  const events = [],
    log = (stage, v = {}) => events.push({ stage, ...v });
  let ordinal = 0;
  const meter = {
    mode: 'period',
    async reserve(key, route, method) {
      log('reserve', { route, method });
      if (key !== keys.good)
        throw Object.assign(Error('SYNTHETIC_INVALID_KEY'), {
          status: 401,
          code: key === keys.revoked ? 'REVOKED_KEY' : 'INVALID_KEY',
        });
      return {
        id: 'synthetic-' + ++ordinal,
        accountId: 'synthetic-account',
        periodId: 'original-period',
        windowId: 'original-window',
      };
    },
    async finalize(hold, success, status, reason) {
      log('finalize', { hold, success, status, reason });
      return success ? 'charged' : 'released';
    },
    async drain() {
      log('drain');
    },
  };
  const lifecycle = paidReadLifecycle({
    meter,
    failure: (s, c, m) => new ApiFailure(s, c, m),
    uncertainHold: () => null,
    observe: (req, stage, v) => log('lifecycle.' + stage, { requestId: req.id, ...v }),
    finalizationMs: 100,
  });
  const authorize = accountDownloadAuthorizer({
    pool: { synthetic: true },
    origin: cookie.origin,
    boundedTransaction: async (_p, _o, work) => work({ synthetic: true }),
    async checkAccess(_q, key, clock, requireLegacyGrant) {
      log('download.key');
      assert.equal(requireLegacyGrant, false);
      if (key !== keys.good) throw Object.assign(Error('SYNTHETIC_INVALID_KEY'), { status: 401 });
      return { accountId: 'synthetic-account', instant: await clock() };
    },
    async session(req, work) {
      log('download.session');
      if (req.headers.cookie !== cookie.cookie)
        throw Object.assign(Error('SYNTHETIC_INVALID_SESSION'), { status: 401 });
      return work('synthetic-account', 'synthetic', {});
    },
    async lockAccount() {},
    async databaseTime() {
      return new Date('2026-10-08T00:00:00Z');
    },
    async selectPeriods() {
      return { current: { id: 'synthetic-period' } };
    },
  });
  const controls = { now: Date.parse('2026-10-08T00:00:00Z') };
  const app = createApp({
    dependencies: deps,
    paidReads: lifecycle,
    downloadAuthorizer: authorize,
    now: () => controls.now,
    ...options,
  });
  await app.ready();
  return {
    app,
    events,
    controls,
    lifecycle,
    async inject(options) {
      charge();
      const r = await app.inject(options);
      trace({ inject: options, status: r.statusCode, headers: r.headers, bytes: r.body.length });
      return r;
    },
    async close() {
      await app.close();
      assert.equal(lifecycle.stats().pending, 0);
      trace({ fixtureClosed: true, events });
    },
  };
}
