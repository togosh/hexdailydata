import type pg from 'pg';
import { performance } from 'node:perf_hooks';

const elapsed = new WeakMap<pg.Client, number>();
export const sqlMilliseconds = (client: pg.Client) => elapsed.get(client) ?? 0;
/** Measures awaited SQL on the dedicated session. It records no parameters or bodies. */
export async function query(client: pg.Client, text: string, values?: unknown[]) {
  const start = performance.now();
  try {
    return await client.query(text, values);
  } finally {
    elapsed.set(client, sqlMilliseconds(client) + performance.now() - start);
  }
}
