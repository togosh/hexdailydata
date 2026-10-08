import { createHash } from 'node:crypto';
import { open, lstat, readFile, realpath, type FileHandle } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { z } from 'zod';
import { SourceStakeSnapshotSchema } from '../../contracts/source-stakes.ts';
import { SourceHolderSchema, SourceHolderTotalsSchema, HolderVersionSchema, holderAnomaly,
  type SourceHolderRecord, type SourceHolderLookup } from '../../contracts/source-holders.ts';
import { restart, unavailable } from '../../api/errors.ts';
import { PageCursors } from '../queries/cursor.ts';

const names = ['records.ndjson', 'offsets.bin', 'addresses.bin', 'pages.json', 'anomalies.json'] as const;
const file = z.strictObject({ bytes: z.number().int().min(0).max(2 ** 31), sha256: HolderVersionSchema });
const pageSchema = z.strictObject({
  segment: z.enum(['HOLDER_R2', 'HOLDER_R3']), globalPage: z.number().int().min(1).max(5598),
  localPage: z.number().int().min(1).max(5324), sourceAttempt: z.number().int().min(1).max(16000),
  firstOrdinal: z.number().int().min(0).max(664405), count: z.number().int().min(0).max(500),
  path: z.string().regex(/^pages\/\d{5}\.ndjson$/), sha256: HolderVersionSchema,
  receiptSha256: HolderVersionSchema, requestSha256: HolderVersionSchema, responseSha256: HolderVersionSchema,
  part: z.string().regex(/^part-\d{3}\.zip$/),
});
const manifestSchema = z.object({
  schemaVersion: z.literal(1), datasetVersion: HolderVersionSchema, snapshot: SourceStakeSnapshotSchema,
  coverage: z.literal('complete_source_inventory_at_pin'), refreshEnabled: z.literal(false),
  rowCount: z.literal(664405), maxRecordBytes: z.literal(4096), actualMaxRecordBytes: z.number().int().min(1).max(4096),
  totals: SourceHolderTotalsSchema,
  files: z.strictObject(Object.fromEntries(names.map(n => [n, file])) as Record<(typeof names)[number], typeof file>),
});
type Manifest = z.infer<typeof manifestSchema>;
type State = { manifest: Manifest; records: FileHandle; size: number; mtimeMs: number; offsets: Buffer;
  addresses: Buffer; pages: z.infer<typeof pageSchema>[] };
export interface SourceHolderBinding { datasetVersion: string; manifestSha256: string }
export type SourceHolderReader = Pick<SavedSourceHolders, 'root' | 'read' | 'lookup'>;
const sha = (b: Buffer) => createHash('sha256').update(b).digest('hex');

/** Explicitly activated immutable saved data. Never hashes or scans a dataset per request. */
export class SavedSourceHolders {
  readonly root: string;
  private state: State | undefined;
  private busy = 0;
  private replacementStatus: 'accepted' | 'rejected' = 'rejected';
  readonly metrics = { activationMilliseconds: 0, activationParsedRecords: 0, activationRssBytes: 0,
    requests: 0, parsedRecords: 0, recordBytes: 0, maximumRecordsPerRequest: 0 };
  constructor(root: string) { this.root = resolve(root); }

  async replace(binding: SourceHolderBinding): Promise<void> {
    const started = performance.now();
    const handles = new Map<string, FileHandle>();
    try {
      if (this.busy) throw Error('HOLDER_READER_BUSY');
      HolderVersionSchema.parse(binding.datasetVersion); HolderVersionSchema.parse(binding.manifestSha256);
      const directory = join(this.root, binding.datasetVersion);
      if (await realpath(directory) !== directory || (await lstat(directory)).isSymbolicLink()) throw Error('HOLDER_DIRECTORY');
      const path = join(directory, 'manifest.json'), stat = await lstat(path);
      if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 65536) throw Error('HOLDER_MANIFEST');
      const raw = await readFile(path);
      if (sha(raw) !== binding.manifestSha256) throw Error('HOLDER_MANIFEST_IDENTITY');
      const manifest = manifestSchema.parse(JSON.parse(raw.toString('utf8')));
      if (manifest.datasetVersion !== binding.datasetVersion) throw Error('HOLDER_VERSION');
      const buffers = new Map<string, Buffer>();
      for (const name of names) {
        const p = join(directory, name), st = await lstat(p), expected = manifest.files[name];
        if (!st.isFile() || st.isSymbolicLink() || st.size !== expected.bytes) throw Error('HOLDER_FILE_SIZE');
        const handle = await open(p, 'r'); handles.set(name, handle);
        if (name === 'records.ndjson') continue;
        if (st.size > 32 * 1024 * 1024) throw Error('HOLDER_INDEX_BOUND');
        const bytes = Buffer.alloc(st.size);
        if ((await handle.read(bytes, 0, bytes.length, 0)).bytesRead !== bytes.length || sha(bytes) !== expected.sha256) throw Error('HOLDER_INDEX_IDENTITY');
        buffers.set(name, bytes);
      }
      const offsets = buffers.get('offsets.bin')!, addresses = buffers.get('addresses.bin')!;
      if (offsets.length !== 664405 * 16 || addresses.length !== 664405 * 24) throw Error('HOLDER_INDEX_SIZE');
      const pages = z.array(pageSchema).length(5598).parse(JSON.parse(buffers.get('pages.json')!.toString('utf8')));
      let count = 0;
      for (const [i, page] of pages.entries()) {
        if (page.globalPage !== i + 1 || page.firstOrdinal !== count || (!page.count && i !== 5597)) throw Error('HOLDER_PAGE_CHAIN');
        if (page.segment !== (i < 5324 ? 'HOLDER_R2' : 'HOLDER_R3') || page.localPage !== (i < 5324 ? i + 1 : i - 5323)) throw Error('HOLDER_SEGMENT');
        count += page.count;
      }
      if (count !== 664405) throw Error('HOLDER_PAGE_COUNT');
      const seen = new Uint8Array(664405), byOrdinal = Buffer.alloc(664405 * 20);
      for (let i = 0; i < 664405; i++) {
        const at = i * 24, ordinal = addresses.readUInt32LE(at + 20);
        if (ordinal >= 664405 || seen[ordinal] || (i && Buffer.compare(addresses.subarray(at - 24, at - 4), addresses.subarray(at, at + 20)) >= 0)) throw Error('HOLDER_ADDRESS_INDEX');
        seen[ordinal] = 1; addresses.copy(byOrdinal, ordinal * 20, at, at + 20);
      }
      const records = handles.get('records.ndjson')!, before = await records.stat();
      const hash = createHash('sha256'), chunk = Buffer.alloc(1024 * 1024);
      let pending = Buffer.alloc(0), position = 0, ordinal = 0, rowOffset = 0, previousId: string | undefined;
      while (position < before.size) {
        const { bytesRead } = await records.read(chunk, 0, Math.min(chunk.length, before.size - position), position);
        if (!bytesRead) throw Error('HOLDER_RECORD_TRUNCATED');
        hash.update(chunk.subarray(0, bytesRead)); position += bytesRead;
        const block = Buffer.concat([pending, chunk.subarray(0, bytesRead)]);
        let start = 0, end: number;
        while ((end = block.indexOf(10, start)) !== -1) {
          const line = block.subarray(start, end + 1), at = ordinal * 16;
          if (ordinal >= 664405 || line.length > 4096 || Number(offsets.readBigUInt64LE(at)) !== rowOffset || offsets.readUInt32LE(at + 8) !== line.length) throw Error('HOLDER_OFFSET');
          const page = pages[offsets.readUInt16LE(at + 12) - 1], rowInPage = offsets.readUInt16LE(at + 14);
          if (!page || rowInPage >= page.count || page.firstOrdinal + rowInPage !== ordinal) throw Error('HOLDER_ROW_PAGE');
          const row = SourceHolderSchema.parse(JSON.parse(line.toString('utf8')));
          if ((previousId !== undefined && row.id <= previousId) || !Buffer.from(row.holderAddress.slice(2), 'hex').equals(byOrdinal.subarray(ordinal * 20, ordinal * 20 + 20))) throw Error('HOLDER_ROW_INDEX');
          previousId = row.id; ordinal++; rowOffset += line.length; start = end + 1;
        }
        pending = Buffer.from(block.subarray(start));
        if (pending.length > 4096) throw Error('HOLDER_RECORD_BOUND');
      }
      const after = await records.stat();
      if (pending.length || ordinal !== 664405 || hash.digest('hex') !== manifest.files['records.ndjson'].sha256 || before.size !== after.size || before.mtimeMs !== after.mtimeMs) throw Error('HOLDER_RECORD_IDENTITY');
      const anomalies = JSON.parse(buffers.get('anomalies.json')!.toString('utf8'));
      if (!Array.isArray(anomalies) || anomalies.length !== 1 || anomalies[0].holderAddress !== '0x' + '0'.repeat(40) || anomalies[0].token !== '-5260750960931605989') throw Error('HOLDER_ANOMALY');
      if (this.busy) throw Error('HOLDER_READER_BUSY');
      const prior = this.state;
      this.state = { manifest, records, size: after.size, mtimeMs: after.mtimeMs, offsets, addresses, pages };
      handles.delete('records.ndjson'); this.replacementStatus = 'accepted';
      this.metrics.activationMilliseconds = performance.now() - started;
      this.metrics.activationParsedRecords = ordinal; this.metrics.activationRssBytes = process.memoryUsage().rss;
      await prior?.records.close();
    } catch (error) {
      this.replacementStatus = 'rejected'; throw error;
    } finally { await Promise.all([...handles.values()].map(h => h.close())); }
  }

  /** Bounded positional primitives for the admitted, single-generation overlay. */
  async rowAt(ordinal: number, signal: AbortSignal) {
    const s = this.state; if (!s) throw unavailable();
    if (!Number.isInteger(ordinal) || ordinal < 0 || ordinal >= 664405) throw unavailable();
    this.busy++;
    try {
      signal.throwIfAborted(); const st = await s.records.stat();
      if (st.size !== s.size || st.mtimeMs !== s.mtimeMs) throw unavailable();
      return await this.record(s, ordinal, signal);
    } finally { this.busy--; }
  }
  async lowerBound(id: string, signal: AbortSignal) {
    let lo = 0, hi = 664405;
    while (lo < hi) { const mid = (lo + hi) >>> 1;
      if ((await this.rowAt(mid, signal)).reported.id < id) lo = mid + 1; else hi = mid; }
    return lo;
  }
  async recordHashAt(ordinal: number, signal: AbortSignal) {
    await this.rowAt(ordinal, signal);
    const s = this.state!; const at = ordinal * 16, length = s.offsets.readUInt32LE(at + 8);
    const b = Buffer.alloc(length);
    if ((await s.records.read(b, 0, length, Number(s.offsets.readBigUInt64LE(at)))).bytesRead !== length) throw unavailable();
    return sha(b);
  }
  evidenceAt(ordinal: number) {
    const s = this.state; if (!s || !Number.isInteger(ordinal) || ordinal < 0 || ordinal >= 664405) throw unavailable();
    const at = ordinal * 16;
    return { ordinal, sourcePage: s.pages[s.offsets.readUInt16LE(at + 12) - 1]!, rowInPage: s.offsets.readUInt16LE(at + 14) };
  }

  async byEntityId(id: string, signal: AbortSignal) {
    const ordinal = await this.lowerBound(id, signal);
    if (ordinal === 664405) return null;
    const row = await this.rowAt(ordinal, signal); return row.reported.id === id ? row : null;
  }

  async close() {
    if (this.busy) throw Error('HOLDER_READER_BUSY');
    const prior = this.state; this.state = undefined; await prior?.records.close();
  }
  private async stable(s: State, signal: AbortSignal) {
    signal.throwIfAborted(); const st = await s.records.stat();
    if (st.size !== s.size || st.mtimeMs !== s.mtimeMs) throw unavailable();
  }
  private async record(s: State, ordinal: number, signal: AbortSignal): Promise<SourceHolderRecord> {
    signal.throwIfAborted(); const at = ordinal * 16, length = s.offsets.readUInt32LE(at + 8);
    const raw = Buffer.alloc(length), offset = Number(s.offsets.readBigUInt64LE(at));
    const { bytesRead } = await s.records.read(raw, 0, length, offset);
    if (bytesRead !== length || raw[length - 1] !== 10) throw unavailable();
    const reported = SourceHolderSchema.parse(JSON.parse(raw.toString('utf8')));
    this.metrics.parsedRecords++; this.metrics.recordBytes += bytesRead;
    const page = s.pages[s.offsets.readUInt16LE(at + 12) - 1]!;
    return { reported, anomaly: holderAnomaly(reported.tokenBalance, reported.holderAddress), provenance: {
      segment: page.segment, sourcePage: page.localPage, sourceAttempt: page.sourceAttempt,
      rowInPage: s.offsets.readUInt16LE(at + 14), originalPageSha256: page.sha256 } };
  }
  async lookup(address: string, version: string | undefined, signal: AbortSignal): Promise<SourceHolderLookup> {
    if (!/^0x[0-9a-f]{40}$/.test(address)) throw unavailable();
    const s = this.state;
    if (!s) {
      if (version) throw restart();
      return { state: 'unavailable', reason: 'reader_unavailable', holderDatasetVersion: null, snapshot: null, item: null, replacementStatus: 'rejected' };
    }
    if (version && version !== s.manifest.datasetVersion) throw restart();
    this.busy++; this.metrics.requests++; const before = this.metrics.parsedRecords;
    try {
      await this.stable(s, signal); const key = Buffer.from(address.slice(2), 'hex'); let lo = 0, hi = 664405;
      while (lo < hi) { const mid = (lo + hi) >>> 1;
        if (Buffer.compare(s.addresses.subarray(mid * 24, mid * 24 + 20), key) < 0) lo = mid + 1; else hi = mid; }
      const context = { holderDatasetVersion: s.manifest.datasetVersion, snapshot: s.manifest.snapshot, replacementStatus: this.replacementStatus };
      if (lo === 664405 || !s.addresses.subarray(lo * 24, lo * 24 + 20).equals(key)) return { ...context, state: 'not_present_in_saved_inventory', item: null, reason: null };
      const item = await this.record(s, s.addresses.readUInt32LE(lo * 24 + 20), signal);
      if (item.reported.holderAddress.toLowerCase() !== address) throw unavailable();
      return item.anomaly ? { ...context, state: 'source_anomaly', item, reason: item.anomaly }
        : { ...context, state: 'present_in_saved_inventory', item, reason: null };
    } finally { this.busy--; this.metrics.maximumRecordsPerRequest = Math.max(this.metrics.maximumRecordsPerRequest, this.metrics.parsedRecords - before); }
  }
  async read(q: { chain: 'pulsechain'; source: 'subgraph'; datasetVersion?: string; limit: number; cursor?: string; order: 'source-id-asc' }, signal: AbortSignal, cursors: PageCursors, now: number) {
    const s = this.state; if (!s) throw unavailable();
    if (q.datasetVersion && q.datasetVersion !== s.manifest.datasetVersion) throw restart();
    if (q.chain !== 'pulsechain' || q.source !== 'subgraph' || q.order !== 'source-id-asc' || !Number.isInteger(q.limit) || q.limit < 1 || q.limit > 100) throw unavailable();
    this.busy++; this.metrics.requests++; const before = this.metrics.parsedRecords;
    try {
      await this.stable(s, signal);
      const binding = sha(Buffer.from(JSON.stringify(['holders', q.chain, q.source, q.limit, q.order])));
      const cursor = cursors.decode(q.cursor, binding, now);
      if (cursor && (cursor.identity !== s.manifest.datasetVersion || !/^(0|[1-9][0-9]{0,6})$/.test(cursor.key))) throw restart();
      const offset = cursor ? Number(cursor.key) : 0; if (offset > 664405) throw restart();
      const items: SourceHolderRecord[] = [];
      for (let i = offset; i < Math.min(offset + q.limit, 664405); i++) items.push(await this.record(s, i, signal));
      const next = offset + items.length;
      return { chain: 'pulsechain', source: 'subgraph', datasetVersion: s.manifest.datasetVersion,
        snapshot: s.manifest.snapshot, coverage: 'complete_source_inventory_at_pin', refreshEnabled: false,
        totals: s.manifest.totals, order: 'source-id-asc', replacementStatus: this.replacementStatus, items,
        nextCursor: next < 664405 ? cursors.encode(binding, s.manifest.datasetVersion, String(next), now, cursor?.expires) : null };
    } finally { this.busy--; this.metrics.maximumRecordsPerRequest = Math.max(this.metrics.maximumRecordsPerRequest, this.metrics.parsedRecords - before); }
  }
}
