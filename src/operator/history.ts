import { z } from 'zod';
import { safePath } from './files.ts';
import { connect, databaseConfig } from '../db/connect.ts';
import { selectionSchema } from '../contracts/history.ts';
import { readBounded, inspectInput } from '../worker/history/input.ts';
import { importHistory } from '../worker/history/store.ts';
import { exportHistory } from '../worker/history/export.ts';

export const historyHelp =
  'history inspect <input.json> [selection.json] [receipt.json] | history import <input.json> <selection.json> <destination.json> [receipt.json] [--replace <revision>] | history export <new.csv>';
async function json(path: string, signal: AbortSignal) {
  await safePath(path, false);
  return JSON.parse((await readBounded(path, signal, 16384)).toString('utf8'));
}
export async function runHistory(args: string[], signal: AbortSignal, env = process.env) {
  const [command, path, ...rest] = args;
  if (command === 'help') return { usage: historyHelp };
  if (!path) throw new Error(historyHelp);
  if (command === 'export') {
    if (rest.length) throw new Error(historyHelp);
    const c = await connect(databaseConfig('worker', env), { signal });
    const abort = () => {
      void c.end().catch(() => {});
    };
    signal.addEventListener('abort', abort, { once: true });
    try {
      return await exportHistory(c, path, signal);
    } finally {
      signal.removeEventListener('abort', abort);
      await c.end().catch(() => {});
    }
  }
  if (command !== 'inspect' && command !== 'import') throw new Error(historyHelp);
  await safePath(path, false);
  const bytes = await readBounded(path, signal);
  const selection = rest[0] ? selectionSchema.parse(await json(rest[0], signal)) : undefined;
  const inspected = inspectInput(bytes, selection);
  const receiptPath = command === 'import' ? rest[2] : rest[1];
  if (selection?.provenance.kind === 'bounded-public-download') {
    if (!receiptPath || receiptPath === '--replace')
      throw new Error('Acquisition receipt required.');
    const r = await json(receiptPath, signal);
    if (
      r.source !== 'hexdailystats' ||
      r.chainId !== 369 ||
      r.sourceKind !== 'bounded-public-download' ||
      r.outcome !== 'downloaded-not-yet-validated' ||
      r.requestedUrl !== 'https://hexdailystats.com/fulldatapulsechain' ||
      r.finalUrl !== selection.provenance.url ||
      r.acquiredAt !== selection.provenance.acquiredAt ||
      r.sha256 !== inspected.inventory.sha256 ||
      r.savedBytes !== bytes.length ||
      r.observedWireBodyBytes < bytes.length ||
      r.observedWireBodyBytes > 16777216 ||
      r.encoding !== 'identity' ||
      !Array.isArray(r.requests) ||
      r.requests.length < 1 ||
      r.requests.length > 2 ||
      r.requests.at(-1)?.status !== 200
    )
      throw new Error('Acquisition receipt mismatch.');
  }
  if (command === 'inspect') {
    if (rest.length > 2) throw new Error(historyHelp);
    return {
      ...inspected.inventory,
      identicalDuplicates: inspected.identicalDuplicates ?? null,
      metadata: inspected.metadata ?? null,
      priceAvailability: inspected.rows
        ? Object.fromEntries(
            [...new Set(inspected.rows.map((r) => r.referencePriceUsd.availability))].map((k) => [
              k,
              inspected.rows!.filter((r) => r.referencePriceUsd.availability === k).length,
            ]),
          )
        : null,
      dryRun: true,
    };
  }
  if (!selection || !rest[1]) throw new Error(historyHelp);
  const expected = z
    .strictObject({
      project: z.string().regex(/^hexdailydata-v2-[a-z0-9-]+$/),
      instance: z.uuid(),
      purpose: z.literal('new-isolated-history-test'),
    })
    .parse(await json(rest[1], signal));
  if (expected.project !== env.HDD_V2_PROJECT || expected.instance !== env.HDD_V2_DB_INSTANCE)
    throw new Error('History destination identity mismatch.');
  const tail = rest.slice(selection.provenance.kind === 'bounded-public-download' ? 3 : 2);
  const replace =
    tail.length === 2 && tail[0] === '--replace' ? z.uuid().parse(tail[1]) : undefined;
  if (tail.length && replace === undefined) throw new Error(historyHelp);
  const c = await connect(databaseConfig('worker', env), { signal });
  const abort = () => {
    void c.end().catch(() => {});
  };
  signal.addEventListener('abort', abort, { once: true });
  try {
    signal.throwIfAborted();
    return await importHistory(c, inspected, signal, replace);
  } finally {
    signal.removeEventListener('abort', abort);
    await c.end().catch(() => {});
  }
}
