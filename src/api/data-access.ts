import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import type { FastifyRequest, FastifyReply } from 'fastify';
import { ApiFailure, restart } from './errors.ts';

export const dataRoutes = new Set([
  'home', 'daily', 'markets', 'stakes', 'stakeEvents', 'stake', 'address',
  'addressStakes', 'holders', 'calculator', 'archiveCharts', 'nativeCharts', 'maturities',
]);
export interface PaidReads {
  begin(request: FastifyRequest, reply: FastifyReply,
    work: { route: string; signal: AbortSignal; deadline: number }): Promise<void>;
  close(): Promise<void>;
}
export function suppliedKey(request: FastifyRequest) {
  return request.raw.rawHeaders.some((name, i) => i % 2 === 0 && name.toLowerCase() === 'authorization');
}
export function developerRequired(): never {
  throw new ApiFailure(403, 'developer_access_required',
    'This selection requires an active API key. See /api for access, or /downloads for complete files.');
}

/** Process-local transport bounds. No addresses or pseudonyms leave this map. */
export class PublicAdmission {
  private secret = randomBytes(32);
  private entries = new Map<string, { attempts: number; active: number; until: number }>();
  private timer: NodeJS.Timeout;
  readonly limits: { attempts: number; active: number; entries: number; windowMs: number };
  constructor(limits: Partial<PublicAdmission['limits']> = {}) {
    this.limits = { attempts: 120, active: 8, entries: 2048, windowMs: 60000, ...limits };
    for (const [key, max] of Object.entries({ attempts: 120, active: 8, entries: 2048, windowMs: 60000 })) {
      const n = this.limits[key as keyof typeof this.limits];
      if (!Number.isInteger(n) || n < 1 || n > max) throw Error('INVALID_PUBLIC_BOUNDS');
    }
    this.timer = setInterval(() => {
      const now = performance.now();
      for (const [key, b] of this.entries) if (!b.active && b.until <= now) this.entries.delete(key);
    }, this.limits.windowMs).unref();
  }
  acquire(address: string | undefined, now = performance.now()) {
    for (const [key, b] of this.entries) if (!b.active && b.until <= now) this.entries.delete(key);
    const key = createHmac('sha256', this.secret).update(address ?? 'unknown-socket').digest('hex');
    let b = this.entries.get(key);
    if (!b) {
      if (this.entries.size >= this.limits.entries) throw new ApiFailure(429, 'public_request_limit', 'Public browsing is busy. Try again shortly.');
      b = { attempts: 0, active: 0, until: now + this.limits.windowMs };
      this.entries.set(key, b);
    }
    if (b.until <= now) { b.attempts = 0; b.until = now + this.limits.windowMs; }
    if (b.attempts >= this.limits.attempts || b.active >= this.limits.active)
      throw new ApiFailure(429, 'public_request_limit', 'Public browsing limit reached. Try again shortly.');
    b.attempts++; b.active++;
    let released = false;
    return () => { if (!released) { released = true; b.active--; } };
  }
  stats() { return { entries: this.entries.size, active: [...this.entries.values()].reduce((n, b) => n + b.active, 0) }; }
  clear() { clearInterval(this.timer); this.entries.clear(); }
}

/** A public-only envelope around unchanged SQL keyset cursors; no visitor state. */
export class PublicBrowse {
  private secret = randomBytes(32);
  prepare(route: string, query: Record<string, any>, now: number) {
    if (route === 'stakeEvents' || (route === 'stakes' &&
      ['maturityFromDay', 'maturityToDay', 'minPrincipalHearts'].some(k => query[k] !== undefined))) developerRequired();
    const global = route === 'holders' || (route === 'stakes' && !query.address);
    if (!global) return null;
    if (query.limit > 50) developerRequired();
    const { cursor, ...selection } = query;
    const binding = createHmac('sha256', this.secret).update(JSON.stringify([route, selection])).digest('base64url');
    let page = 1, expires = now + 60000;
    if (cursor) {
      try {
        if (cursor.length > 2048 || !/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/.test(cursor)) throw restart();
        const [body, signature] = cursor.split('.');
        const actual = Buffer.from(signature, 'base64url');
        const expected = createHmac('sha256', this.secret).update(body).digest();
        if (actual.length !== expected.length || !timingSafeEqual(actual, expected)) throw restart();
        const v = JSON.parse(Buffer.from(body, 'base64url').toString('utf8'));
        if (v.v !== 1 || v.binding !== binding || !Number.isInteger(v.page) || v.page < 2 || v.page > 6 ||
            !Number.isSafeInteger(v.expires) || v.expires <= now || typeof v.inner !== 'string') throw restart();
        page = v.page; expires = v.expires; query.cursor = v.inner;
      } catch { throw restart(); }
    }
    if (page > 5) developerRequired();
    return (inner: string | null) => {
      if (!inner) return null;
      const body = Buffer.from(JSON.stringify({ v: 1, binding, page: page + 1, expires, inner })).toString('base64url');
      const value = body + '.' + createHmac('sha256', this.secret).update(body).digest('base64url');
      if (value.length > 2048) throw new ApiFailure(503, 'source_unavailable', 'Pagination unavailable.');
      return value;
    };
  }
}
