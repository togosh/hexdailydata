import type { FastifyRequest } from 'fastify';
import { ApiFailure } from './errors.ts';

export type DownloadAuthorization =
  | { accountId: string }
  | { status: 401 | 403 | 503 };
export type DownloadAuthorizer = (
  request: FastifyRequest,
  signal: AbortSignal,
) => Promise<DownloadAuthorization>;

// Finite, process-local protection, separate from successful JSON accounting.
// Active entries cannot be evicted; no waiting queue or credential cache.
export class DownloadAdmission {
  private readonly entries = new Map<string, { active: number; attempts: number; until: number }>();
  acquire(accountId: string) {
    const now = Date.now();
    for (const [id, value] of this.entries)
      if (!value.active && value.until <= now) this.entries.delete(id);
    let entry = this.entries.get(accountId);
    if (!entry) {
      if (this.entries.size >= 1024) throw new ApiFailure(429, 'download_limit', 'Download limit reached.');
      entry = { active: 0, attempts: 0, until: now + 60000 };
      this.entries.set(accountId, entry);
    }
    if (entry.until <= now) { entry.attempts = 0; entry.until = now + 60000; }
    if (++entry.attempts > 60 || entry.active >= 2)
      throw new ApiFailure(429, 'download_limit', 'Download limit reached.');
    entry.active++;
    let released = false;
    return () => { if (!released) { released = true; entry.active--; } };
  }
}
