import type pg from 'pg';
import { connect, type DatabaseConfig } from '../../db/connect.ts';
import { unavailable } from '../../api/errors.ts';

/** Every transaction owns one lease. Download locks use separate dedicated sessions. */
export class ReadDatabase {
  private idle: pg.Client[] = [];
  private all = new Set<pg.Client>();
  private opening = 0;
  private closed = false;
  private stopped = new AbortController();
  readonly config: DatabaseConfig;
  readonly counters = { connections: 0, connectionSetupMs: 0, dataQueries: 0 };
  constructor(config: DatabaseConfig) {
    if (config.user !== 'hdd_v2_api') throw new Error('Read API role required.');
    this.config = config;
  }
  async connection(signal?: AbortSignal) {
    if (this.closed) throw unavailable();
    const bound = AbortSignal.any([
      this.stopped.signal,
      AbortSignal.timeout(5000),
      ...(signal ? [signal] : []),
    ]);
    const started = performance.now();
    const c = await connect(this.config, { signal: bound, queryTimeoutMillis: 3000 });
    c.on('error', () => {});
    const abort = () => {
      void c.end().catch(() => {});
    };
    bound.addEventListener('abort', abort, { once: true });
    try {
      bound.throwIfAborted();
      const { rows } = await c.query(
        'SELECT version FROM hdd.schema_migrations ORDER BY version LIMIT 6',
      );
      if (rows.map((r) => r.version).join(',') !== '1,2,3,4') throw unavailable();
      await c.query(
        "SET default_transaction_read_only=on; SET statement_timeout='2000ms'; SET idle_in_transaction_session_timeout='3000ms'",
      );
      this.counters.connections++;
      this.counters.connectionSetupMs += performance.now() - started;
      return c;
    } catch (e) {
      await c.end();
      throw e;
    } finally {
      bound.removeEventListener('abort', abort);
    }
  }
  async read<T>(
    signal: AbortSignal,
    fn: (c: pg.Client) => Promise<T>,
    snapshot = false,
  ): Promise<T> {
    signal.throwIfAborted();
    if (this.closed) throw unavailable();
    let c = this.idle.pop();
    if (!c) {
      if (this.all.size + this.opening >= 8) throw unavailable();
      this.opening++;
      try {
        c = await this.connection(signal);
        this.all.add(c);
      } finally {
        this.opening--;
      }
    }
    const client = c;
    let broken = false;
    const abort = () => {
      broken = true;
      void client.end().catch(() => {});
    };
    const timer = setTimeout(abort, 3000).unref();
    signal.addEventListener('abort', abort, { once: true });
    try {
      if (signal.aborted || this.closed) {
        abort();
        throw unavailable();
      }
      if (snapshot) await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
      const result = await fn(client);
      if (snapshot) await client.query('COMMIT');
      if (broken) throw unavailable();
      return result;
    } catch (e) {
      broken = true;
      throw e;
    } finally {
      clearTimeout(timer);
      signal.removeEventListener('abort', abort);
      if (broken || this.closed) {
        this.all.delete(client);
        await client.end().catch(() => {});
      } else this.idle.push(client);
    }
  }
  async close() {
    this.closed = true;
    this.stopped.abort();
    await Promise.allSettled([...this.all].map((c) => c.end()));
    this.all.clear();
    this.idle = [];
  }
}
