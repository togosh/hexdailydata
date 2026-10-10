/** Local immutable market storage. No provider, timer, database or private configuration. */
import {
  lstat,
  realpath,
  mkdir,
  open,
  readFile,
  readdir,
  rename,
  unlink,
  rmdir,
  statfs,
} from 'node:fs/promises';
import { join, resolve, dirname, relative, isAbsolute } from 'node:path';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { isDeepStrictEqual } from 'node:util';
import {
  digest,
  benchmarkCloseBinding,
  benchmarkCloseMethod,
  type ProductMetadata,
} from '../../contracts/product-daily.ts';
import { hash, stable } from '../../history-bootstrap/normalize.ts';
import {
  applyMarketUpdate,
  marketJournalEntry,
  migrateMarketMetadata,
  preserveMarketHistory,
} from './market.ts';
import { productFiles } from './project.ts';
import {
  verifyOperationFrontier,
  auditOperations,
  reserveOperation,
  settleOperation,
  validateSettlement,
  type Reservation,
} from './storage-operations.ts';
import {
  ProductDailyStore,
  admitProduct,
  cachedProductExceptions,
  writeProductGeneration,
  type ProductWriter,
  type AdmittedProduct,
} from './store.ts';

export const storagePolicy = Object.freeze({
  format: 'market-storage-1',
  segmentRecords: 16,
  segmentBytes: 2 * 1024 ** 2,
  journalRecords: 1000000,
  totalBytes: 8 * 1024 ** 3,
  entries: 100000,
  reserveBytes: 64 * 1024 ** 2,
  protectedFreeBytes: 10 * 1024 ** 3,
  generations: 16,
  pins: 8,
});
const pointer = z.strictObject({ version: digest, manifestSha256: digest });
const identity = z.strictObject({ bytes: z.number().int().nonnegative(), sha256: digest });
const generation = z.strictObject({
  ...pointer.shape,
  files: z.record(z.string(), identity),
  certificate: identity.nullable(),
});
const stateSchema = z.strictObject({
  format: z.literal('market-storage-1'),
  owner: digest,
  seed: pointer,
  seedBytes: z
    .number()
    .int()
    .min(0)
    .max(64 * 1024 ** 2),
  current: pointer,
  rollback: pointer.nullable(),
  pins: z.array(digest).max(8),
  sequence: z.number().int().min(0).max(1000000),
  head: digest,
  archiveHead: digest,
  journalSelected: pointer,
  operationSequence: z.number().int().min(0).max(8192),
  operationHead: digest,
  segment: z.number().int().nonnegative(),
  segmentRecords: z.number().int().min(0).max(16),
  segmentBytes: z.number().int().min(0).max(storagePolicy.segmentBytes),
  segmentHash: digest,
  journalBytes: z
    .number()
    .int()
    .min(0)
    .max(8 * 1024 ** 3),
  journalEntries: z.number().int().min(0).max(100000),
  operationBytes: z.number().int().nonnegative(),
  operationEntries: z.number().int().nonnegative(),
  generations: z.array(generation).max(16),
  reclaimedBytes: z.number().int().nonnegative(),
});
type State = z.infer<typeof stateSchema>;
type Pointer = z.infer<typeof pointer>;
const ownerSchema = z.strictObject({
  format: z.literal('market-storage-owner-1'),
  root: z.string(),
  task: z.literal('HDD-MARKET-STORAGE-RECOVERY-R1'),
  nonce: z.string().uuid(),
});
const names = ['MANIFEST.json', 'daily.ndjson', 'daily.csv', 'metadata.json', 'exceptions.ndjson'];
const same = (a: unknown, b: unknown) => stable(a) === stable(b);
const ptr = (s: Pointer) => ({ version: s.version, manifestSha256: s.manifestSha256 });
const segmentName = (i: number) => `journal/${String(i).padStart(8, '0')}.ndjson`;
const certificateName = (version: string) => `verified-${version}.json`;
const operationName = (sequence: number) => `operations/${String(sequence).padStart(8, '0')}.json`;
const exists = async (p: string) =>
  lstat(p).catch((e: NodeJS.ErrnoException) => {
    if (e.code === 'ENOENT') return null;
    throw e;
  });

export async function safeStoragePath(root: string, child = '') {
  root = resolve(root);
  if (
    isAbsolute(child) ||
    child.includes('\\') ||
    child.split('/').some((p) => p === '..' || p === '.')
  )
    throw Error('STORAGE_PATH_ESCAPE');
  const target = resolve(root, child),
    rel = relative(root, target);
  if (rel.startsWith('..') || isAbsolute(rel)) throw Error('STORAGE_PATH_ESCAPE');
  // Check every existing ancestor, including ancestors above the marked root.
  let p = target;
  for (;;) {
    const s = await exists(p);
    if (s && (s.isSymbolicLink() || (s.isFile() && s.nlink !== 1) || (await realpath(p)) !== p))
      throw Error('STORAGE_ALIAS');
    const parent = dirname(p);
    if (parent === p) break;
    p = parent;
  }
  return target;
}
export async function storageBytes(root: string, child: string, maximum = 2 * 1024 ** 2) {
  const p = await safeStoragePath(root, child),
    s = await lstat(p);
  if (!s.isFile() || s.size > maximum) throw Error('STORAGE_FILE_BOUND');
  const b = await readFile(p);
  if (b.length !== s.size) throw Error('STORAGE_FILE_CHANGED');
  return b;
}
async function exclusive(root: string, child: string, bytes: Buffer) {
  const p = await safeStoragePath(root, child),
    f = await open(p, 'wx');
  try {
    await f.writeFile(bytes);
    await f.sync();
  } finally {
    await f.close();
  }
}
async function atomic(root: string, child: string, value: unknown) {
  const temp = `write-${randomUUID()}.json`;
  await exclusive(root, temp, Buffer.from(stable(value)));
  await safeStoragePath(root, child);
  await rename(join(root, temp), join(root, child));
}
async function owner(root: string) {
  const b = await storageBytes(root, 'STORAGE_OWNER.json', 4096),
    o = ownerSchema.parse(JSON.parse(b.toString()));
  if (o.root !== resolve(root)) throw Error('STORAGE_OWNER_ROOT');
  return hash(b);
}
async function readState(root: string) {
  const s = stateSchema.parse(
    JSON.parse((await storageBytes(root, 'STORAGE.json', 65536)).toString()),
  );
  if (s.owner !== (await owner(root))) throw Error('STORAGE_OWNER_MISMATCH');
  const versions = new Set(s.generations.map((g) => g.version));
  if (
    versions.size !== s.generations.length ||
    !versions.has(s.current.version) ||
    (s.rollback &&
      (!versions.has(s.rollback.version) || s.rollback.version === s.current.version)) ||
    s.pins.some((p) => !versions.has(p)) ||
    new Set(s.pins).size !== s.pins.length
  )
    throw Error('STORAGE_REFERENCES');
  if (!same(s.current, s.journalSelected)) {
    const r = JSON.parse((await storageBytes(root, 'RECOVERY.json', 4096)).toString());
    if (
      r.format !== 'market-rollback-1' ||
      r.root !== resolve(root) ||
      r.owner !== s.owner ||
      !same(r.selected, s.current) ||
      !same(r.from, s.journalSelected) ||
      r.journalHead !== s.head ||
      r.archiveHead !== s.archiveHead
    )
      throw Error('STORAGE_RECOVERY_CONFLICT');
  }
  return s;
}
async function catalog(root: string, p: Pointer) {
  const files: Record<string, { bytes: number; sha256: string }> = {};
  await admitProduct(await safeStoragePath(root, p.version), p.manifestSha256);
  for (const n of names) {
    const b = await storageBytes(root, `${p.version}/${n}`, 64 * 1024 ** 2);
    files[n] = { bytes: b.length, sha256: hash(b) };
  }
  const cert = (await exists(join(root, certificateName(p.version))))
    ? await storageBytes(root, certificateName(p.version), 8192)
    : null;
  return { ...p, files, certificate: cert ? { bytes: cert.length, sha256: hash(cert) } : null };
}
const generationBytes = (s: State) =>
  s.generations.reduce(
    (n, g) =>
      n + Object.values(g.files).reduce((v, f) => v + f.bytes, 0) + (g.certificate?.bytes ?? 0),
    0,
  );
export async function checkMarketCapacity(root: string, reservation = storagePolicy.reserveBytes) {
  const s = await readState(root),
    disk = await statfs(root);
  await verifyOperationFrontier(root, s);
  const bytes =
    s.seedBytes + s.journalBytes + s.operationBytes + generationBytes(s) + 2 * 1024 ** 2; // bounded control/receipt allowance
  const entries = s.journalEntries + s.operationEntries + s.generations.length * 7 + 64;
  if (bytes + reservation > storagePolicy.totalBytes) throw Error('MARKET_STORAGE_BYTES');
  if (entries + 256 > storagePolicy.entries || s.sequence >= storagePolicy.journalRecords)
    throw Error('MARKET_STORAGE_ENTRIES');
  if (disk.bavail * disk.bsize - reservation < storagePolicy.protectedFreeBytes)
    throw Error('PROTECTED_FREE_SPACE');
  return { bytes, entries, reservation, freeBytes: disk.bavail * disk.bsize };
}

/** Only creates a new root. Original seed/data are read-only byte buffers. */
export async function createMarketStorage(
  root: string,
  seed: Parameters<typeof writeProductGeneration>[1],
) {
  root = resolve(root);
  await safeStoragePath(dirname(root), root.split(/[\\/]/).at(-1)!);
  const plannedSeedBytes =
    Object.values(seed.files).reduce((n, b) => n + b.length, 0) * 2 + storagePolicy.reserveBytes;
  const initialDisk = await statfs(dirname(root));
  if (
    plannedSeedBytes > storagePolicy.totalBytes ||
    initialDisk.bavail * initialDisk.bsize - plannedSeedBytes < storagePolicy.protectedFreeBytes
  )
    throw Error('PROTECTED_FREE_SPACE');
  await mkdir(root); // exclusive root ownership; never retrofit an accepted old root
  await exclusive(
    root,
    'STORAGE_OWNER.json',
    Buffer.from(
      stable({
        format: 'market-storage-owner-1',
        root,
        task: 'HDD-MARKET-STORAGE-RECOVERY-R1',
        nonce: randomUUID(),
      }),
    ),
  );
  const admitted = await writeProductGeneration(root, seed);
  if (admitted.metadata.marketStorage)
    throw Error('USE_VERIFIED_BACKUP_RESTORE_FOR_COMPACT_STORAGE');
  const store = new ProductDailyStore(root, admitted.metadata.pair);
  await store.select(ptr(seed));
  await mkdir(join(root, 'journal'));
  await mkdir(join(root, 'operations'));
  const metadata = migrateMarketMetadata(admitted.metadata, seed.version),
    m = metadata.marketStorage!;
  const seedBytes = Buffer.from(
    stable({
      seed: ptr(seed),
      originalMetadata: admitted.metadata,
      migration: m,
      externalSeedFiles: seed.version,
    }),
  );
  await exclusive(root, 'SEED.json', seedBytes);
  const s: State = {
    format: 'market-storage-1',
    owner: await owner(root),
    seed: ptr(seed),
    seedBytes: seedBytes.length,
    current: ptr(seed),
    rollback: null,
    pins: [],
    sequence: 0,
    head: m.head,
    archiveHead: m.head,
    journalSelected: ptr(seed),
    operationSequence: 0,
    operationHead: m.head,
    segment: 0,
    segmentRecords: 0,
    segmentBytes: 0,
    segmentHash: hash(Buffer.alloc(0)),
    journalBytes: 0,
    journalEntries: 0,
    operationBytes: 0,
    operationEntries: 0,
    generations: [await catalog(root, ptr(seed))],
    reclaimedBytes: 0,
  };
  await exclusive(root, 'STORAGE.json', Buffer.from(stable(s)));
  return store;
}

/** One conservative reservation before a finite collector is spawned; never refund uncertainty.
 * The existing collector independently enforces its capture budget. This avoids a lifetime scan.
 */
export async function reserveCaptureStorage(
  store: ProductDailyStore,
  writer: ProductWriter,
  output: string,
) {
  await assertWriter(store, writer);
  if (store.writerUncertain(writer)) throw Error('PUBLICATION_UNCERTAIN');
  await planRetention(store.root, writer, store);
  await safeStoragePath(dirname(resolve(output)), resolve(output).split(/[\\/]/).at(-1)!);
  if (await exists(output)) throw Error('CAPTURE_OUTPUT_EXISTS');
  const s = await readState(store.root),
    bytes = 1024 ** 3,
    entries = 8192;
  await checkMarketCapacity(store.root, bytes + storagePolicy.reserveBytes + 4096);
  if (s.operationEntries + s.journalEntries + entries + 512 > storagePolicy.entries)
    throw Error('MARKET_STORAGE_ENTRIES');
  store.markWriterUncertain(writer);
  const result = await reserveOperation(store.root, s, 'capture', output, bytes, entries);
  await atomic(store.root, 'STORAGE.json', { ...s, ...result.state });
  store.settleWriter(writer);
  return result.reservation;
}

/** Enumerate only this newly closed finite capture directory, once. Never a lifetime scan.
 * Conservative charged rewrites/reservations remain charges; unknown closure never settles.
 */
export async function settleCaptureStorage(
  store: ProductDailyStore,
  writer: ProductWriter,
  output: string,
  chargedBytes: number,
  reservation: Reservation,
) {
  await assertWriter(store, writer);
  if (store.writerUncertain(writer)) throw Error('PUBLICATION_UNCERTAIN');
  if (!Number.isSafeInteger(chargedBytes) || chargedBytes < 0) throw Error('CAPTURE_CHARGE');
  const pending = [''];
  let bytes = 0,
    entries = 0;
  while (pending.length) {
    const child = pending.pop()!,
      path = await safeStoragePath(output, child),
      s = await lstat(path);
    if (++entries > 8192) throw Error('CAPTURE_ENTRIES');
    if (s.isDirectory())
      for (const n of await readdir(path)) pending.push(child ? child + '/' + n : n);
    else if (s.isFile()) bytes += s.size;
    else throw Error('CAPTURE_MEMBER');
    if (bytes > 1024 ** 3) throw Error('CAPTURE_BYTES');
  }
  const actual = Math.max(bytes, chargedBytes) + 1024 ** 2; // final local job/settlement receipt reserve
  if (actual > 1024 ** 3 || entries + 16 > 8192) throw Error('CAPTURE_SETTLEMENT_BOUND');
  const state = await readState(store.root);
  const accounting = JSON.parse((await storageBytes(output, 'ACCOUNTING.json', 65536)).toString());
  const result = JSON.parse((await storageBytes(output, 'RESULT.json', 131072)).toString());
  if (
    accounting.status !== 'CLOSED' ||
    accounting.pending !== null ||
    !same(result.accounting, accounting) ||
    accounting.storageChargedBytes !== chargedBytes
  )
    throw Error('CAPTURE_CLOSURE_EVIDENCE');
  // Direct frontier/reservation/proof checks; full historical audit is maintenance-only.
  await validateSettlement(store.root, state, reservation, output, actual, entries + 16);
  const decision = {
    output: resolve(output),
    reservation,
    actualChargedBytes: actual,
    entries: entries + 16,
    providerChargesUnchanged: true,
  };
  store.markWriterUncertain(writer);
  const counters = await settleOperation(
    store.root,
    state,
    reservation,
    output,
    actual,
    entries + 16,
  );
  await exclusive(output, 'LOCAL_STORAGE_SETTLEMENT.json', Buffer.from(stable(decision)));
  await atomic(store.root, 'STORAGE.json', { ...state, ...counters });
  store.settleWriter(writer);
  return decision;
}

type Fault = (point: string) => void | Promise<void>;
async function assertWriter(store: ProductDailyStore, writer: ProductWriter) {
  store.assertWriter(writer);
  await safeStoragePath(store.root);
  if (await exists(join(store.root, 'MAINTENANCE.lock'))) throw Error('STORAGE_MAINTENANCE_BUSY');
}
async function appendRecord(root: string, s: State, record: unknown, fault: Fault) {
  const bytes = Buffer.from(stable(record));
  // One bounded history import may carry the actual saved buckets. A 1 MiB
  // history record plus fifteen ordinary 64 KiB records still fits one 2 MiB
  // segment, preserving sequence-to-segment lookup and the existing 16-record rule.
  const history = (record as { update?: { benchmarkHistory?: unknown } }).update?.benchmarkHistory;
  if (bytes.length > (history ? 1024 ** 2 : 65536)) throw Error('MARKET_RECORD_BOUND');
  let segment = s.segment,
    count = s.segmentRecords,
    old = Buffer.alloc(0);
  if (count) {
    old = await storageBytes(root, segmentName(segment));
    if (old.length !== s.segmentBytes || hash(old) !== s.segmentHash)
      throw Error('MARKET_JOURNAL_TAIL');
  }
  let rotated = false;
  if (
    count === storagePolicy.segmentRecords ||
    old.length + bytes.length > storagePolicy.segmentBytes
  ) {
    await fault('journal-seal');
    segment++;
    count = 0;
    old = Buffer.alloc(0);
    rotated = true;
  }
  const path = await safeStoragePath(root, segmentName(segment));
  const f = await open(path, count ? 'r+' : 'wx');
  try {
    if (count && (await f.stat()).size !== old.length) throw Error('MARKET_JOURNAL_CHANGED');
    let written = 0;
    while (written < bytes.length) {
      const amount =
        written === 0 ? Math.max(1, Math.floor(bytes.length / 2)) : bytes.length - written;
      const result = await f.write(bytes, written, amount, old.length + written);
      if (!result.bytesWritten) throw Error('JOURNAL_SHORT_WRITE');
      written += result.bytesWritten;
      if (written < bytes.length) await fault('journal-partial');
    }
    await f.sync();
    await fault('journal-write');
  } finally {
    await f.close();
  }
  return {
    segment,
    segmentRecords: count + 1,
    segmentBytes: old.length + bytes.length,
    segmentHash: hash(Buffer.concat([old, bytes])),
    journalBytes: s.journalBytes + bytes.length,
    journalEntries: s.journalEntries + (rotated || s.sequence === 0 ? 1 : 0),
  };
}

async function journalRecord(root: string, sequence: number) {
  if (!Number.isInteger(sequence) || sequence < 1 || sequence > storagePolicy.journalRecords)
    throw Error('JOURNAL_SEQUENCE');
  const segment = Math.floor((sequence - 1) / storagePolicy.segmentRecords);
  const raw = await storageBytes(root, segmentName(segment));
  if (raw.at(-1) !== 10) throw Error('JOURNAL_PARTIAL');
  const lines = raw.toString().trimEnd().split('\n');
  if (lines.length > storagePolicy.segmentRecords) throw Error('JOURNAL_SEGMENT_BOUND');
  const record = JSON.parse(lines[(sequence - 1) % storagePolicy.segmentRecords] ?? 'null');
  if (!record || record.sequence !== sequence) throw Error('JOURNAL_SEQUENCE');
  const { archiveHash, ...envelope } = record;
  if (
    hash(stable(envelope)) !== archiveHash ||
    hash(
      stable({ sequence: record.sequence, previous: record.previous, update: record.update }),
    ) !== record.head
  )
    throw Error('JOURNAL_ENVELOPE');
  return record;
}

/** A compact snapshot cannot enter serving through a bare pointer/admission receipt.
 * Read at most the candidate and cached-reader journal segments, not the lifetime log.
 * The trusted publisher certifies each deterministic transition after durable append;
 * skipped readers additionally prove their exact former snapshot is still archived.
 */
export async function verifyMarketCertificate(
  root: string,
  next: AdmittedProduct,
  previous?: AdmittedProduct,
  prepared = false,
) {
  const m = next.metadata.marketStorage;
  if (!m) {
    if (await exists(join(root, 'STORAGE.json'))) {
      const s = await readState(root);
      if (!same(s.current, ptr(next)) || !same(s.seed, ptr(next)))
        throw Error('MARKET_LEGACY_SEED');
    }
    return;
  }
  const state = await readState(root),
    raw = await storageBytes(root, certificateName(next.version), 8192);
  const cert = JSON.parse(raw.toString()),
    record = await journalRecord(root, m.sequence);
  if (
    cert.format !== 'market-publication-1' ||
    !same(cert.selected, ptr(next)) ||
    cert.seedVersion !== m.seedVersion ||
    cert.sequence !== m.sequence ||
    cert.head !== m.head ||
    cert.archiveHead !== record.archiveHash ||
    cert.recordSha256 !== hash(stable(record)) ||
    !same(record.selected, ptr(next)) ||
    record.head !== m.head
  )
    throw Error('MARKET_CERTIFICATE');
  if (prepared && !same(state.current, ptr(next))) {
    const pendingRaw = await storageBytes(root, 'PENDING.json', 1024 ** 2 + 131072),
      pending = JSON.parse(pendingRaw.toString());
    if (pendingRaw.length > 131072 && !pending.record?.update?.benchmarkHistory)
      throw Error('MARKET_PENDING_BOUND');
    if (
      !previous ||
      !same(state.current, ptr(previous)) ||
      !same(pending.record, record) ||
      record.previous !== state.head ||
      record.archivePrevious !== state.archiveHead ||
      record.sequence !== state.sequence + 1 ||
      !same(record.previousGeneration, state.current)
    )
      throw Error('MARKET_PREPARED_CERTIFICATE');
  } else {
    const g = state.generations.find((g) => g.version === next.version);
    if (
      !same(state.current, ptr(next)) ||
      !g?.certificate ||
      g.certificate.sha256 !== hash(raw) ||
      g.certificate.bytes !== raw.length
    )
      throw Error('MARKET_CERTIFICATE_FRONTIER');
    if (
      same(state.current, state.journalSelected) &&
      (state.head !== m.head ||
        state.sequence !== m.sequence ||
        state.archiveHead !== record.archiveHash)
    )
      throw Error('MARKET_CERTIFICATE_FRONTIER');
  }
  if (previous?.metadata.marketStorage && previous.version !== next.version) {
    const p = previous.metadata.marketStorage,
      old = await journalRecord(root, p.sequence);
    if (
      !same(old.selected, ptr(previous)) ||
      old.head !== p.head ||
      p.seedVersion !== m.seedVersion
    )
      throw Error('MARKET_READER_ANCESTRY');
  } else if (
    previous &&
    previous.version !== next.version &&
    previous.version !== state.seed.version
  )
    throw Error('MARKET_READER_SEED');
}

/** Reader-only bridge for the one fixed, certified HDS -> candle-close transition.
 * The intermediate directory may have been pruned. Rebuild its exact identity from
 * the cached admitted predecessor and one retained journal update, never publish it.
 * Endpoint certificates plus ordinary preservation still govern the newest product.
 * This reads two additional bounded records, not the intervening lifetime journal.
 */
export async function verifyMarketReaderAdvance(
  root: string,
  next: AdmittedProduct,
  previous: AdmittedProduct,
) {
  await verifyMarketCertificate(root, next, previous);
  let comparison: Pick<AdmittedProduct, 'version' | 'manifestSha256' | 'rows' | 'metadata'> =
    previous;
  const a = previous.metadata.marketStorage,
    b = next.metadata.marketStorage;
  if (
    previous.version === benchmarkCloseBinding.predecessorVersion &&
    previous.manifestSha256 === benchmarkCloseBinding.predecessorManifest &&
    next.metadata.benchmarkHistory?.methodRevision === benchmarkCloseMethod &&
    a &&
    b &&
    b.sequence > a.sequence + 1
  ) {
    const old = await journalRecord(root, a.sequence);
    const transition = await journalRecord(root, a.sequence + 1);
    if (
      !same(transition.previousGeneration, ptr(previous)) ||
      transition.previous !== a.head ||
      transition.archivePrevious !== old.archiveHash ||
      !transition.update?.benchmarkHistory
    )
      throw Error('BENCHMARK_READER_TRANSITION');
    const reconstructed = applyMarketUpdate(
      { ...previous, exceptions: cachedProductExceptions(previous) },
      transition.update,
    );
    // The ordinary reducer retains all exact predecessor, receipt, +1 and quiet guards.
    preserveMarketHistory(previous, reconstructed);
    const identity = productFiles(reconstructed);
    if (
      !same(transition.selected, ptr(identity)) ||
      reconstructed.metadata.marketStorage?.head !== transition.head ||
      reconstructed.metadata.marketStorage?.sequence !== transition.sequence
    )
      throw Error('BENCHMARK_READER_IDENTITY');
    comparison = {
      ...reconstructed,
      version: identity.version,
      manifestSha256: identity.manifestSha256,
    };
  }
  preserveMarketHistory(comparison, next);
  return comparison;
}

/** Known-owner recovery must match the exact saved intent, not any later certified product. */
export async function verifyStoredTransition(
  root: string,
  next: AdmittedProduct,
  previous: AdmittedProduct,
  update: unknown,
) {
  await verifyMarketCertificate(root, next, previous);
  const sequence = next.metadata.marketStorage?.sequence;
  if (!sequence) throw Error('RECOVERY_TRANSITION_SEQUENCE');
  const record = await journalRecord(root, sequence);
  if (
    !isDeepStrictEqual(record.previousGeneration, ptr(previous)) ||
    !isDeepStrictEqual(record.update, update)
  )
    throw Error('RECOVERY_TRANSITION_INTENT');
}

/** Invoked only after existing frozen source checks. Transaction failure never clears ownership. */
export async function publishStoredMarket(
  store: ProductDailyStore,
  writer: ProductWriter,
  update: unknown,
  beforeCommit: () => void = () => {},
  fault: Fault = () => {},
  captureReference: unknown = null,
) {
  await assertWriter(store, writer);
  const root = store.root,
    s = await readState(root),
    base = store.capture();
  if (
    !same(s.current, ptr(base)) ||
    !same(JSON.parse((await storageBytes(root, 'CURRENT.json', 4096)).toString()), s.current)
  )
    throw Error('MARKET_STORAGE_POINTER');
  if ((await exists(join(root, 'PENDING.json'))) || (await exists(join(root, 'COMMITTED.json'))))
    throw Error('MARKET_PENDING_OPERATION');
  await checkMarketCapacity(root);
  const exceptions = (await storageBytes(root, `${base.version}/exceptions.ndjson`, 64 * 1024 ** 2))
    .toString()
    .trimEnd()
    .split('\n')
    .filter(Boolean)
    .map((l) => JSON.parse(l) as Record<string, unknown>);
  const metadata = migrateMarketMetadata(base.metadata, s.seed.version);
  if (metadata.marketStorage!.head !== s.head || metadata.marketStorage!.sequence !== s.sequence)
    throw Error('MARKET_STORAGE_HEAD');
  const product = applyMarketUpdate({ ...base, metadata, exceptions }, update);
  if (product.metadata.marketStorage!.sequence === s.sequence)
    return { changed: false, selected: s.current, storage: s };
  const entry = marketJournalEntry(metadata, update),
    files = productFiles(product),
    selected = ptr(files);
  const reference = z
    .strictObject({
      output: z.string().min(1).max(2048),
      update: z.string().regex(/^(?:ROUND_[123]|WINDOW_[1-9][0-9]{0,3})_UPDATE\.json$/),
      updateSha256: digest,
      audit: z.string().regex(/^(?:ROUND_[123]|WINDOW_[1-9][0-9]{0,3})_AUDIT\.json$/),
      auditSha256: digest,
    })
    .nullable()
    .parse(captureReference);
  const envelope = {
    ...entry,
    previousGeneration: s.current,
    selected,
    captureReference: reference,
    archivePrevious: s.archiveHead,
  };
  const record = { ...envelope, archiveHash: hash(stable(envelope)) };
  const plannedBytes =
    Object.values(files.files).reduce((n, b) => n + b.length, 0) +
    Buffer.byteLength(stable(record)) +
    1024 * 1024;
  await checkMarketCapacity(root, Math.max(storagePolicy.reserveBytes, plannedBytes));
  // Intent is exclusive and durable before any archive/generation/pointer mutation.
  await exclusive(root, 'PENDING.json', Buffer.from(stable({ previous: s, record })));
  store.markWriterUncertain(writer);
  await fault('intent');
  const tail = await appendRecord(root, s, record, fault);
  await fault('checkpoint');
  await writeProductGeneration(root, files);
  await fault('generation');
  const certificate = {
    format: 'market-publication-1',
    selected,
    seedVersion: s.seed.version,
    sequence: entry.sequence,
    head: entry.head,
    archiveHead: record.archiveHash,
    recordSha256: hash(stable(record)),
  };
  await exclusive(root, certificateName(selected.version), Buffer.from(stable(certificate)));
  const next: State = {
    ...s,
    ...tail,
    sequence: entry.sequence,
    head: entry.head,
    archiveHead: record.archiveHash,
    journalSelected: selected,
    current: selected,
    rollback: s.current,
    generations: [...s.generations, await catalog(root, selected)],
  };
  stateSchema.parse(next);
  beforeCommit();
  await store.select(selected, { writer, beforeCommit });
  store.markWriterUncertain(writer);
  await fault('pointer');
  await atomic(root, 'STORAGE.json', next);
  await fault('state');
  await exclusive(
    root,
    'COMMITTED.json',
    Buffer.from(
      stable({ previous: s.current, selected, sequence: entry.sequence, head: entry.head }),
    ),
  );
  await unlink(join(root, 'PENDING.json'));
  store.settleWriter(writer);
  await fault('acknowledgement');
  await unlink(join(root, 'COMMITTED.json'));
  store.settleWriter(writer);
  // Actual publication path performs the same exact identity-bound retention as the operator.
  const plan = await planRetention(root, writer, store);
  const retention = await applyRetention(root, plan, writer, store, fault);
  return {
    changed: true,
    selected,
    storage: await readState(root),
    retention: { plan, ...retention },
  };
}

async function quiescent(root: string, writer?: ProductWriter, store?: ProductDailyStore) {
  if (writer && store) store.assertWriter(writer);
  else if (await exists(join(root, 'SELECTION.lock'))) throw Error('ACTIVE_OR_UNKNOWN_WRITER');
  for (const name of ['WRITER.lock', 'MARKET_REFRESH.lock', 'MAINTENANCE.lock'])
    if ((await exists(join(root, name))) && !(writer && name === 'MARKET_REFRESH.lock'))
      throw Error('ACTIVE_OR_UNKNOWN_WRITER');
  if (await exists(join(root, 'PENDING.json'))) throw Error('MARKET_PENDING_OPERATION');
}
export type RetentionPlan = {
  root: string;
  owner: string;
  stateSha256: string;
  expected: Pointer;
  remove: z.infer<typeof generation>[];
  admissions: { version: string; bytes: number; sha256: string }[];
  bytes: number;
  planSha256: string;
};
export async function planRetention(
  root: string,
  writer?: ProductWriter,
  store?: ProductDailyStore,
): Promise<RetentionPlan> {
  root = resolve(root);
  await quiescent(root, writer, store);
  const s = await readState(root),
    expected = pointer.parse(
      JSON.parse((await storageBytes(root, 'CURRENT.json', 4096)).toString()),
    );
  if (!same(expected, s.current)) throw Error('MARKET_STORAGE_POINTER');
  const protectedVersions = new Set([s.current.version, s.rollback?.version, ...s.pins]);
  const remove = s.generations.filter((g) => !protectedVersions.has(g.version));
  const allowed = new Set([
    'STORAGE_OWNER.json',
    'STORAGE.json',
    'SEED.json',
    'CURRENT.json',
    'journal',
    'operations',
    'LAST_RETENTION.json',
    'LAST_CAPTURE.json',
    'RECOVERY.json',
    'ORIGIN.json',
    'RESTORE_RESERVATION.json',
    'ACK_RECOVERY.json',
    'ACK_RECOVERY_ORIGINAL.json',
    ...s.generations.flatMap((g) => [
      g.version,
      `admitted-${g.version}.json`,
      ...(g.certificate ? [certificateName(g.version)] : []),
    ]),
    ...(writer ? ['SELECTION.lock', 'MARKET_REFRESH.lock'] : []),
  ]);
  for (const n of await readdir(root))
    if (!allowed.has(n)) throw Error('STORAGE_FOREIGN_OR_INCOMPLETE_FILE:' + n);
  const admissions: { version: string; bytes: number; sha256: string }[] = [];
  for (const g of s.generations) {
    if (!same(await catalog(root, g), g)) throw Error('STORAGE_GENERATION_CHANGED');
    const raw = await storageBytes(root, `admitted-${g.version}.json`, 4096);
    if (!same(JSON.parse(raw.toString()), ptr(g))) throw Error('STORAGE_ADMISSION_CHANGED');
    if (remove.some((r) => r.version === g.version))
      admissions.push({ version: g.version, bytes: raw.length, sha256: hash(raw) });
  }
  const body = {
    root,
    owner: s.owner,
    stateSha256: hash(await storageBytes(root, 'STORAGE.json', 65536)),
    expected,
    remove,
    admissions,
    bytes:
      remove.reduce(
        (n, g) =>
          n + Object.values(g.files).reduce((a, f) => a + f.bytes, 0) + (g.certificate?.bytes ?? 0),
        0,
      ) + admissions.reduce((n, f) => n + f.bytes, 0),
  };
  return { ...body, planSha256: hash(stable(body)) };
}
export async function applyRetention(
  root: string,
  plan: RetentionPlan,
  writer?: ProductWriter,
  store?: ProductDailyStore,
  fault: Fault = () => {},
) {
  root = resolve(root);
  if (!same(await planRetention(root, writer, store), plan)) throw Error('STALE_RETENTION_PLAN');
  // Existing publisher holds SELECTION.lock; standalone maintenance obtains the same exclusion.
  const lock = writer ? null : await open(await safeStoragePath(root, 'SELECTION.lock'), 'wx');
  let complete = false;
  try {
    let s = await readState(root);
    if (
      hash(await storageBytes(root, 'STORAGE.json', 65536)) !== plan.stateSha256 ||
      !same(JSON.parse((await storageBytes(root, 'CURRENT.json', 4096)).toString()), plan.expected)
    )
      throw Error('STALE_RETENTION_PLAN');
    if (!plan.remove.length) {
      complete = true;
      return { removedBytes: 0, generations: 0 };
    }
    // Every byte eligible for deletion is inventoried. No recursive delete or inferred path.
    await exclusive(root, 'RETENTION_PENDING.json', Buffer.from(stable(plan)));
    for (const g of plan.remove) {
      await fault('cleanup-before');
      if (!same(await catalog(root, g), g)) throw Error('STORAGE_GENERATION_CHANGED');
      for (const n of names) {
        const path = await safeStoragePath(root, `${g.version}/${n}`);
        const b = await storageBytes(root, `${g.version}/${n}`, 64 * 1024 ** 2);
        if (hash(b) !== g.files[n]!.sha256) throw Error('STORAGE_GENERATION_CHANGED');
        await unlink(path);
      }
      await rmdir(await safeStoragePath(root, g.version));
      const receipt = await storageBytes(root, `admitted-${g.version}.json`, 4096),
        expectedReceipt = plan.admissions.find((a) => a.version === g.version);
      if (
        !expectedReceipt ||
        receipt.length !== expectedReceipt.bytes ||
        hash(receipt) !== expectedReceipt.sha256
      )
        throw Error('STORAGE_ADMISSION_CHANGED');
      await unlink(await safeStoragePath(root, `admitted-${g.version}.json`));
      if (g.certificate) {
        const raw = await storageBytes(root, certificateName(g.version), 8192);
        if (hash(raw) !== g.certificate.sha256 || raw.length !== g.certificate.bytes)
          throw Error('STORAGE_CERTIFICATE_CHANGED');
        await unlink(await safeStoragePath(root, certificateName(g.version)));
      }
      await fault('cleanup-after');
    }
    const removed = new Set(plan.remove.map((g) => g.version));
    await atomic(root, 'STORAGE.json', {
      ...s,
      generations: s.generations.filter((g) => !removed.has(g.version)),
      reclaimedBytes: s.reclaimedBytes + plan.bytes,
    });
    await exclusive(
      root,
      `retention-${plan.planSha256}.json`,
      Buffer.from(stable({ plan, removedBytes: plan.bytes })),
    );
    // Receipts are returned to the caller's evidence; keep one bounded last receipt locally.
    await rename(
      join(root, `retention-${plan.planSha256}.json`),
      join(root, 'LAST_RETENTION.json'),
    );
    await unlink(join(root, 'RETENTION_PENDING.json'));
    complete = true;
    return { removedBytes: plan.bytes, generations: plan.remove.length };
  } finally {
    if (lock) {
      await lock.close();
      if (complete) await unlink(join(root, 'SELECTION.lock'));
    }
    if (!complete && writer && store) store.markWriterUncertain(writer);
  }
}

export async function inspectStorage(root: string) {
  try {
    const s = await readState(root);
    await quiescent(root);
    if (!same(JSON.parse((await storageBytes(root, 'CURRENT.json', 4096)).toString()), s.current))
      throw Error('MARKET_STORAGE_POINTER');
    const admitted = await admitProduct(
      await safeStoragePath(root, s.current.version),
      s.current.manifestSha256,
    );
    return {
      status: 'READABLE',
      state: s,
      observedAtUtc: admitted.metadata.effectiveAtUtc,
      capacity: await checkMarketCapacity(root),
    };
  } catch (e) {
    return { status: 'BLOCKED', error: String(e) };
  }
}

// Full retained-journal audit is a maintenance/restore operation, never a visitor request.
export async function auditJournal(root: string) {
  const s = await readState(root),
    seedRaw = await storageBytes(root, 'SEED.json', 64 * 1024 ** 2),
    seed = JSON.parse(seedRaw.toString());
  if (seedRaw.length !== s.seedBytes) throw Error('JOURNAL_SEED_BYTES');
  const m = migrateMarketMetadata(
    seed.originalMetadata as ProductMetadata,
    s.seed.version,
  ).marketStorage!;
  if (!same(m, seed.migration)) throw Error('JOURNAL_SEED');
  let head = m.head,
    archiveHead = m.head,
    sequence = 0,
    bytes = 0,
    objects = 0,
    previous = s.seed;
  const segments = await readdir(join(root, 'journal'));
  if (segments.length !== s.journalEntries) throw Error('JOURNAL_ENTRY_COUNT');
  for (let i = 0; i < segments.length; i++) {
    const raw = await storageBytes(root, segmentName(i));
    if (!raw.length || raw.at(-1) !== 10) throw Error('JOURNAL_PARTIAL');
    const lines = raw.toString().trimEnd().split('\n');
    if (
      lines.length > storagePolicy.segmentRecords ||
      (i < segments.length - 1 && lines.length !== storagePolicy.segmentRecords)
    )
      throw Error('JOURNAL_SEGMENT_BOUND');
    for (const line of lines) {
      const r = JSON.parse(line),
        { archiveHash, ...envelope } = r,
        { head: actual, previousGeneration, selected } = r;
      const body = { sequence: r.sequence, previous: r.previous, update: r.update };
      pointer.parse(previousGeneration);
      pointer.parse(selected);
      if (
        !same(previousGeneration, previous) ||
        body.sequence !== ++sequence ||
        body.previous !== head ||
        hash(stable(body)) !== actual ||
        r.archivePrevious !== archiveHead ||
        hash(stable(envelope)) !== archiveHash
      )
        throw Error('JOURNAL_CHAIN');
      previous = selected;
      head = actual;
      archiveHead = archiveHash;
      objects += body.update.readings.length;
    }
    bytes += raw.length;
    if (
      i === segments.length - 1 &&
      (raw.length !== s.segmentBytes ||
        hash(raw) !== s.segmentHash ||
        lines.length !== s.segmentRecords)
    )
      throw Error('JOURNAL_TAIL');
  }
  if (
    head !== s.head ||
    sequence !== s.sequence ||
    bytes !== s.journalBytes ||
    archiveHead !== s.archiveHead ||
    !same(previous, s.journalSelected)
  )
    throw Error('JOURNAL_STATE');
  const operations = await auditOperations(root, s);
  return {
    status: 'PASS',
    sequence,
    head,
    archiveHead,
    bytes,
    segments: segments.length,
    objects,
    operations,
  };
}

export function encodeBackupManifest(manifest: unknown) {
  const raw = Buffer.from(stable(manifest));
  if (raw.length > 4 * 1024 ** 2) throw Error('BACKUP_MANIFEST_BOUND');
  return raw;
}

export async function backupStorage(root: string, destination: string, fault: Fault = () => {}) {
  root = resolve(root);
  destination = resolve(destination);
  await quiescent(root);
  const lock = await open(await safeStoragePath(root, 'SELECTION.lock'), 'wx');
  let complete = false;
  try {
    let s = await readState(root);
    if (!same(s.current, s.journalSelected)) throw Error('ROLLBACK_INTEGRITY_NEEDS_RECONCILIATION');
    if (!same(JSON.parse((await storageBytes(root, 'CURRENT.json', 4096)).toString()), s.current))
      throw Error('MARKET_STORAGE_POINTER');
    await auditJournal(root);
    await safeStoragePath(dirname(destination), destination.split(/[\\/]/).at(-1)!);
    if (await exists(destination)) throw Error('BACKUP_DESTINATION_EXISTS');
    const plannedBytes =
      s.seedBytes +
      s.journalBytes +
      generationBytes(s) +
      s.operationSequence * 8192 +
      4 * 1024 ** 2;
    const plannedEntries =
      s.journalEntries + s.operationSequence * 2 + s.generations.length * 7 + 32;
    await checkMarketCapacity(root, plannedBytes + 4096 + storagePolicy.reserveBytes);
    const disk = await statfs(dirname(destination));
    if (disk.bavail * disk.bsize - plannedBytes < storagePolicy.protectedFreeBytes)
      throw Error('PROTECTED_FREE_SPACE');
    if (s.operationEntries + plannedEntries + s.journalEntries + 512 > storagePolicy.entries)
      throw Error('MARKET_STORAGE_ENTRIES');
    const reservation = await reserveOperation(
      root,
      s,
      'backup',
      destination,
      plannedBytes,
      plannedEntries,
    );
    s = { ...s, ...reservation.state };
    await atomic(root, 'STORAGE.json', s);
    const keep = new Set([s.current.version, s.rollback?.version, ...s.pins]);
    const generations = s.generations.filter((g) => keep.has(g.version));
    for (const g of generations)
      if (!same(await catalog(root, g), g)) throw Error('BACKUP_GENERATION');
    const paths = [
      'SEED.json',
      ...Array.from({ length: s.journalEntries }, (_, i) => segmentName(i)),
      ...(await auditOperations(root, s)).files,
      ...generations.flatMap((g) => names.map((n) => `${g.version}/${n}`)),
      ...generations.filter((g) => g.certificate).map((g) => certificateName(g.version)),
    ];
    const files: Record<string, { bytes: number; sha256: string }> = {};
    for (const path of paths) {
      const raw = await storageBytes(root, path, 64 * 1024 ** 2);
      files[path] = { bytes: raw.length, sha256: hash(raw) };
    }
    const manifest = { format: 'market-backup-1', state: { ...s, generations }, files };
    // Bound the exact final manifest before creating any destination or copying data.
    const manifestRaw = encodeBackupManifest(manifest);
    await mkdir(destination);
    await mkdir(join(destination, 'journal'));
    await mkdir(join(destination, 'operations'));
    for (const g of generations) await mkdir(join(destination, g.version));
    for (const path of paths) {
      const raw = await storageBytes(root, path, 64 * 1024 ** 2);
      if (raw.length !== files[path]!.bytes || hash(raw) !== files[path]!.sha256)
        throw Error('BACKUP_SOURCE_CHANGED');
      await exclusive(destination, path, raw);
      await fault('archive-verification');
      if (!(await storageBytes(destination, path, 64 * 1024 ** 2)).equals(raw))
        throw Error('BACKUP_COPY_CHANGED');
    }
    await exclusive(destination, 'BACKUP.json', manifestRaw);
    complete = true;
    return {
      status: 'PASS',
      destination,
      sha256: hash(manifestRaw),
      files: Object.keys(files).length,
      bytes: Object.values(files).reduce((n, f) => n + f.bytes, 0),
      current: s.current,
      rollback: s.rollback,
      reservation: reservation.reservation,
    };
  } finally {
    await lock.close();
    if (complete) await unlink(join(root, 'SELECTION.lock'));
  }
}

export async function restoreStorage(backup: string, destination: string, manifestSha256: string) {
  backup = resolve(backup);
  destination = resolve(destination);
  digest.parse(manifestSha256);
  const raw = await storageBytes(backup, 'BACKUP.json', 4 * 1024 ** 2);
  if (hash(raw) !== manifestSha256) throw Error('BACKUP_IDENTITY');
  const b = z
    .strictObject({
      format: z.literal('market-backup-1'),
      state: stateSchema,
      files: z.record(z.string(), identity),
    })
    .parse(JSON.parse(raw.toString()));
  const paths = [
    'SEED.json',
    ...Array.from({ length: b.state.journalEntries }, (_, i) => segmentName(i)),
    ...(await auditOperations(backup, b.state)).files,
    ...b.state.generations.flatMap((g) => names.map((n) => `${g.version}/${n}`)),
    ...b.state.generations.filter((g) => g.certificate).map((g) => certificateName(g.version)),
  ].sort();
  if (!same(paths, Object.keys(b.files).sort()) || paths.length > 100000)
    throw Error('BACKUP_MEMBERS');
  if (
    Object.values(b.files).reduce((n, f) => n + f.bytes, 0) >
    storagePolicy.totalBytes - storagePolicy.reserveBytes
  )
    throw Error('BACKUP_BOUND');
  await safeStoragePath(dirname(destination), destination.split(/[\\/]/).at(-1)!);
  const plannedBytes =
    Object.values(b.files).reduce((n, f) => n + f.bytes, 0) + storagePolicy.reserveBytes;
  const disk = await statfs(dirname(destination));
  if (disk.bavail * disk.bsize - plannedBytes < storagePolicy.protectedFreeBytes)
    throw Error('PROTECTED_FREE_SPACE');
  await mkdir(destination);
  await exclusive(
    destination,
    'RESTORE_RESERVATION.json',
    Buffer.from(stable({ backupSha256: manifestSha256, plannedBytes, entries: paths.length + 32 })),
  );
  await mkdir(join(destination, 'journal'));
  await mkdir(join(destination, 'operations'));
  for (const g of b.state.generations) await mkdir(join(destination, g.version));
  for (const path of paths) {
    const value = await storageBytes(backup, path, 64 * 1024 ** 2),
      f = b.files[path]!;
    if (value.length !== f.bytes || hash(value) !== f.sha256) throw Error('BACKUP_FILE_IDENTITY');
    await exclusive(destination, path, value);
  }
  await exclusive(
    destination,
    'STORAGE_OWNER.json',
    Buffer.from(
      stable({
        format: 'market-storage-owner-1',
        root: destination,
        task: 'HDD-MARKET-STORAGE-RECOVERY-R1',
        nonce: randomUUID(),
      }),
    ),
  );
  const s = { ...b.state, owner: await owner(destination) };
  await exclusive(destination, 'STORAGE.json', Buffer.from(stable(s)));
  for (const g of s.generations) {
    await admitProduct(join(destination, g.version), g.manifestSha256);
    await exclusive(destination, `admitted-${g.version}.json`, Buffer.from(stable(ptr(g))));
  }
  await exclusive(destination, 'CURRENT.json', Buffer.from(stable(s.current)));
  await exclusive(
    destination,
    'ORIGIN.json',
    Buffer.from(
      stable({
        backupSha256: manifestSha256,
        originalOwner: b.state.owner,
        restoredAt: new Date().toISOString(),
      }),
    ),
  );
  const journal = await auditJournal(destination);
  const current = await admitProduct(
    join(destination, s.current.version),
    s.current.manifestSha256,
  );
  const reader = new ProductDailyStore(destination, current.metadata.pair);
  await reader.load();
  return { status: 'PASS', selected: ptr(reader.capture()), journal, root: destination };
}

export type RollbackPlan = {
  root: string;
  owner: string;
  stateSha256: string;
  from: Pointer;
  target: z.infer<typeof generation>;
  journalHead: string;
  planSha256: string;
};
export async function planRollback(root: string): Promise<RollbackPlan> {
  root = resolve(root);
  await quiescent(root);
  const s = await readState(root),
    raw = await storageBytes(root, 'STORAGE.json', 65536);
  if (!same(JSON.parse((await storageBytes(root, 'CURRENT.json', 4096)).toString()), s.current))
    throw Error('MARKET_STORAGE_POINTER');
  if (!s.rollback || s.rollback.version === s.current.version) throw Error('NO_DISTINCT_ROLLBACK');
  const target = s.generations.find((g) => g.version === s.rollback!.version);
  if (
    !target ||
    !same(await catalog(root, target), target) ||
    !same(
      JSON.parse((await storageBytes(root, `admitted-${target.version}.json`, 4096)).toString()),
      ptr(target),
    )
  )
    throw Error('ROLLBACK_NOT_ADMITTED');
  await auditJournal(root);
  const body = {
    root,
    owner: s.owner,
    stateSha256: hash(raw),
    from: s.current,
    target,
    journalHead: s.head,
  };
  return { ...body, planSha256: hash(stable(body)) };
}
export async function applyRollback(root: string, plan: RollbackPlan) {
  root = resolve(root);
  if (!same(await planRollback(root), plan)) throw Error('STALE_ROLLBACK_PLAN');
  const lock = await open(await safeStoragePath(root, 'SELECTION.lock'), 'wx');
  let complete = false;
  try {
    const s = await readState(root);
    if (
      hash(await storageBytes(root, 'STORAGE.json', 65536)) !== plan.stateSha256 ||
      !same(JSON.parse((await storageBytes(root, 'CURRENT.json', 4096)).toString()), plan.from) ||
      !same(await catalog(root, plan.target), plan.target)
    )
      throw Error('STALE_ROLLBACK_PLAN');
    const selected = ptr(plan.target);
    // Only the explicit identity-bound recovery decision permits non-monotone reader adoption.
    const receipt = {
      format: 'market-rollback-1',
      root,
      owner: s.owner,
      from: s.current,
      selected,
      planSha256: plan.planSha256,
      at: new Date().toISOString(),
      providerOutcomeUnchanged: true,
      publicationBlockedUntilReconciled: true,
      journalHead: s.head,
      archiveHead: s.archiveHead,
    };
    await atomic(root, 'RECOVERY.json', receipt);
    await atomic(root, 'CURRENT.json', selected);
    // Preserve the corrupt generation and journal frontier as evidence, never guess how to resume.
    await atomic(root, 'STORAGE.json', {
      ...s,
      current: selected,
      rollback: null,
      pins: [...new Set([...s.pins, plan.from.version])],
    });
    complete = true;
    return receipt;
  } finally {
    await lock.close();
    if (complete) await unlink(join(root, 'SELECTION.lock'));
  }
}

/** Only an already completed pointer/state/journal operation with no lock can reconcile an ACK.
 * Orphan locks, partial writes, and mismatched evidence remain blocked, regardless of PID or age.
 */
export async function reconcileAcknowledgement(root: string) {
  root = resolve(root);
  await quiescent(root);
  const lock = await open(await safeStoragePath(root, 'SELECTION.lock'), 'wx');
  let complete = false;
  try {
    const s = await readState(root),
      ack = JSON.parse((await storageBytes(root, 'COMMITTED.json', 4096)).toString());
    if (
      !same(ack.selected, s.current) ||
      ack.sequence !== s.sequence ||
      ack.head !== s.head ||
      !same(JSON.parse((await storageBytes(root, 'CURRENT.json', 4096)).toString()), s.current)
    )
      throw Error('ACKNOWLEDGEMENT_CONFLICT');
    await admitProduct(join(root, s.current.version), s.current.manifestSha256);
    await auditJournal(root);
    if (
      !same(
        JSON.parse(
          (await storageBytes(root, `admitted-${s.current.version}.json`, 4096)).toString(),
        ),
        s.current,
      )
    )
      throw Error('ACK_ADMISSION');
    const decision = {
      format: 'market-ack-recovery-1',
      original: ack,
      at: new Date().toISOString(),
      providerOutcomeUnchanged: true,
    };
    await exclusive(root, 'ACK_RECOVERY.json', Buffer.from(stable(decision)));
    await rename(join(root, 'COMMITTED.json'), join(root, 'ACK_RECOVERY_ORIGINAL.json'));
    complete = true;
    return decision;
  } finally {
    await lock.close();
    if (complete) await unlink(join(root, 'SELECTION.lock'));
  }
}
