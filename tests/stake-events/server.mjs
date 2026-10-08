// Test-only instrumentation around the actual application and actual read-only database.
import { writeFileSync } from 'node:fs';
import { ReadDatabase } from '../../dist/services/queries/database.js';
import { databaseConfig } from '../../dist/db/connect.js';
import { createApp } from '../../dist/api/app.js';
const reads = [],
  records = [];
class ObservedReadDatabase extends ReadDatabase {
  async read(signal, fn, snapshot = false) {
    const trace = { snapshot, aborted: false, queries: [] };
    reads.push(trace);
    const aborted = () => {
      trace.aborted = true;
    };
    signal.addEventListener('abort', aborted, { once: true });
    try {
      return await super.read(
        signal,
        async (client) => {
          const original = client.query;
          client.query = async (sql, parameters = []) => {
            const start = performance.now();
            try {
              const result = await original.call(client, sql, parameters);
              trace.queries.push({
                sql,
                parameters,
                rows: result.rowCount,
                milliseconds: performance.now() - start,
              });
              return result;
            } catch (e) {
              trace.queries.push({
                sql,
                parameters,
                errorCode: e.code ?? 'connection_closed',
                milliseconds: performance.now() - start,
              });
              throw e;
            }
          };
          try {
            return await fn(client);
          } finally {
            client.query = original;
          }
        },
        snapshot,
      );
    } catch (e) {
      trace.errorCode = e.code ?? 'connection_closed';
      throw e;
    } finally {
      signal.removeEventListener('abort', aborted);
    }
  }
}
const db = new ObservedReadDatabase(databaseConfig('api'));
const app = createApp({
  dependencies: { db, close: () => db.close() },
  now: () => Number(process.env.LAB_NOW),
});
app.addHook('onSend', async (request, reply, payload) => {
  records.push({
    method: request.method,
    url: request.url,
    status: reply.statusCode,
    headers: reply.getHeaders(),
    bytes: typeof payload === 'string' ? Buffer.byteLength(payload) : null,
    body: typeof payload === 'string' ? JSON.parse(payload) : null,
  });
  return payload;
});
const base = await app.listen({ host: '127.0.0.1', port: 0 });
process.send?.({ ready: true, pid: process.pid, port: Number(new URL(base).port) });
let stopping = false;
async function stop() {
  if (stopping) return;
  stopping = true;
  await app.close();
  writeFileSync(
    process.env.LAB_SERVER_RECEIPT,
    JSON.stringify(
      {
        pid: process.pid,
        simulatedNow: process.env.LAB_NOW,
        records,
        reads,
        counters: db.counters,
        connectionsClosed: true,
      },
      null,
      2,
    ) + '\n',
  );
  process.disconnect?.();
}
process.on('message', (message) => {
  if (message === 'stop') void stop();
  if (message === 'stats')
    process.send?.({
      reads: reads.length,
      aborted: reads.filter((r) => r.aborted).length,
      counters: db.counters,
    });
});
process.on('SIGTERM', () => void stop());
