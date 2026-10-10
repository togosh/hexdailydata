import assert from 'node:assert/strict';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { wire } from '../market-feed/access-fixture.mjs';
const R = process.env.HDD_TASK_ROOT;
assert(R?.endsWith('btc-eth-current-reference-freshness-r2'));
const path = join(R, 'evidence/LOCAL_HTTP_ACCOUNTING.json');
const b = existsSync(path)
  ? JSON.parse(readFileSync(path))
  : { attempts: 0, chargedBytes: 0, observedBytes: 0, combinedApiSeconds: 0, requests: [] };
const save = () => writeFileSync(path, JSON.stringify(b, null, 2) + '\n');
export function reserve(
  url,
  bytes = (url.includes('/downloads/') ? 2 * 1024 ** 2 : 512 * 1024) + 65536,
) {
  assert(b.attempts < 256 && b.chargedBytes + bytes <= 256 * 1024 ** 2);
  const r = { attempt: ++b.attempts, url, reservedBytes: bytes, closed: false };
  b.chargedBytes += bytes;
  b.requests.push(r);
  save();
  return r;
}
export function complete(r, bytes, status) {
  assert(bytes <= r.reservedBytes);
  r.observedBytes = bytes;
  r.status = status;
  r.closed = true;
  b.observedBytes += bytes;
  save();
}
export function guard(f) {
  const inject = f.inject.bind(f);
  f.inject = async (o) => {
    const url = typeof o === 'string' ? o : o.url,
      r = reserve(url);
    const result = await inject(o);
    complete(
      r,
      Buffer.byteLength(result.body) + Buffer.byteLength(JSON.stringify(result.headers)) + 1024,
      result.statusCode,
    );
    return result;
  };
  return f;
}
export function listening(f) {
  const start = performance.now(),
    close = f.close.bind(f);
  assert(b.combinedApiSeconds < 1200);
  const timer = setTimeout(() => f.app.close(), (1200 - b.combinedApiSeconds) * 1000);
  f.close = async () => {
    try {
      await close();
    } finally {
      clearTimeout(timer);
      b.combinedApiSeconds += (performance.now() - start) / 1000;
      save();
      assert(b.combinedApiSeconds <= 1200);
    }
  };
}
export async function measuredWire(f, url) {
  const r = reserve(url),
    result = await wire(f.app, url);
  complete(
    r,
    Buffer.byteLength(result.body) + Buffer.byteLength(JSON.stringify(result.headers)) + 1024,
    result.statusCode,
  );
  return result;
}
