import assert from 'node:assert/strict';
import { writeFileSync, existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { wire } from '../market-feed/access-fixture.mjs';
const R = process.env.HDD_TASK_ROOT;
assert(R?.endsWith('btc-eth-daily-close-reader-adoption-r1'));
const path = join(R, 'evidence/READER_HTTP_ACCOUNTING.json');
const budget = existsSync(path)
  ? JSON.parse(readFileSync(path))
  : {
      attempts: 0,
      chargedBytes: 0,
      observedBytes: 0,
      combinedApiSeconds: 0,
      externalAttempts: 0,
      requests: [],
    };
const save = () => writeFileSync(path, JSON.stringify(budget, null, 2) + '\n');
function reserve(url, maximum) {
  assert(budget.attempts < 128 && budget.chargedBytes + maximum <= 128 * 1024 ** 2);
  const item = { attempt: ++budget.attempts, url, reservedBytes: maximum, closed: false };
  budget.chargedBytes += maximum;
  budget.requests.push(item);
  save();
  return item;
}
export function guard(f) {
  const opened = performance.now(),
    original = f.inject.bind(f),
    close = f.close.bind(f);
  const timer = setTimeout(
    () => {
      f.app.close();
    },
    (900 - budget.combinedApiSeconds) * 1000,
  );
  f.inject = async (options) => {
    const url = typeof options === 'string' ? options : options.url;
    const item = reserve(url, (url.includes('/downloads/') ? 2 * 1024 ** 2 : 512 * 1024) + 65536);
    try {
      const r = await original(options);
      item.observedBytes =
        Buffer.byteLength(r.body) + Buffer.byteLength(JSON.stringify(r.headers)) + 1024;
      assert(item.observedBytes <= item.reservedBytes);
      budget.observedBytes += item.observedBytes;
      item.status = r.statusCode;
      item.closed = true;
      return r;
    } finally {
      save();
    }
  };
  f.close = async () => {
    try {
      await close();
    } finally {
      clearTimeout(timer);
      budget.combinedApiSeconds += (performance.now() - opened) / 1000;
      save();
    }
  };
  return f;
}
export async function measuredWire(app, url) {
  const item = reserve(url, 512 * 1024 + 65536);
  try {
    const r = await wire(app, url);
    item.observedBytes =
      Buffer.byteLength(r.body) + Buffer.byteLength(JSON.stringify(r.headers)) + 1024;
    assert(item.observedBytes <= item.reservedBytes);
    budget.observedBytes += item.observedBytes;
    item.closed = true;
    item.status = r.statusCode;
    return r;
  } finally {
    save();
  }
}
