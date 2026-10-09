// Task-local conservative reservations, including unknown/failed local responses.
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync, existsSync, statfsSync } from 'node:fs';
import { join } from 'node:path';
import { wire } from '../market-feed/access-fixture.mjs';
const R = process.env.HDD_TASK_ROOT;
assert(R?.endsWith('btc-eth-daily-close-integration-r1'));
const file = join(R, 'evidence/LOOPBACK_ACCOUNTING.json');
const accounting = existsSync(file)
  ? JSON.parse(readFileSync(file))
  : {
      attempts: 0,
      chargedBytes: 0,
      observedBytes: 0,
      maximumAttempts: 1000,
      maximumChargedBytes: 268435456,
      externalRequests: 0,
      responses: [],
      processes: [],
    };
const save = () => writeFileSync(file, JSON.stringify(accounting, null, 2) + '\n');
export function reserveResponse(path) {
  const free = statfsSync(R);
  assert(free.bavail * free.bsize >= 10 * 1024 ** 3);
  const reservation = path.includes('/downloads/')
    ? 8 * 1024 ** 2
    : path.startsWith('/assets/')
      ? 4 * 1024 ** 2
      : 512 * 1024;
  const charged = reservation + 65536;
  assert(
    accounting.attempts < 1000 &&
      accounting.chargedBytes + charged <= accounting.maximumChargedBytes,
  );
  const record = {
    id: ++accounting.attempts,
    path,
    reservation,
    chargedBytes: charged,
    status: 'RESERVED',
  };
  accounting.responses.push(record);
  accounting.chargedBytes += charged;
  save();
  return record;
}
export function checkResponse(record, observed) {
  assert(record && record.status === 'RESERVED');
  record.observedBytes = observed;
  accounting.observedBytes += observed;
  record.status = observed <= record.reservation ? 'CLOSED' : 'BOUND_VIOLATION';
  save();
  assert(observed <= record.reservation);
}
export function guardFixture(f, seconds) {
  const start = Date.now(),
    due = start + seconds * 1000;
  const record = {
    pid: process.pid,
    startedAt: new Date(start).toISOString(),
    maximumSeconds: seconds,
    closed: false,
  };
  accounting.processes.push(record);
  save();
  const close = f.close.bind(f),
    inject = f.inject.bind(f);
  let closure;
  f.close = () =>
    (closure ??= (async () => {
      clearTimeout(timer);
      await close();
      record.closed = true;
      record.seconds = (Date.now() - start) / 1000;
      save();
    })());
  const timer = setTimeout(() => {
    record.expired = true;
    save();
    void f.close();
  }, seconds * 1000);
  f.inject = async (options) => {
    assert(Date.now() < due);
    const path = typeof options === 'string' ? options : options.url,
      reservation = reserveResponse(path);
    const response = await inject(options);
    checkResponse(reservation, Buffer.byteLength(response.body));
    return response;
  };
}
export async function measuredWire(app, path) {
  const reservation = reserveResponse(path),
    result = await wire(app, path);
  checkResponse(reservation, Buffer.byteLength(result.body));
  return result;
}
