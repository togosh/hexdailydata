import { createHash } from 'node:crypto';
import { open, readFile, lstat, realpath, type FileHandle } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { z } from 'zod';
import {
  SourceStartSchema,
  SourceDiscrepancySchema,
  SourceStakeSnapshotSchema,
  type SourceStakeRecord,
} from '../../contracts/source-stakes.ts';
import { ApiFailure, restart, unavailable } from '../../api/errors.ts';
import { PageCursors } from '../queries/cursor.ts';

const hash = z.string().regex(/^[0-9a-f]{64}$/);
const file = z.strictObject({
  bytes: z
    .number()
    .int()
    .min(0)
    .max(2 ** 31),
  sha256: hash,
});
const page = z.strictObject({
  segment: z.enum(['R2', 'R3', 'R4']),
  globalPage: z.number().int().min(1).max(1912),
  localPage: z.number().int().min(1).max(1912),
  path: z.string().regex(/^pages\/\d{5}\.ndjson$/),
  sha256: hash,
  sourceAttempt: z.number().int().min(1).max(16000),
  firstOrdinal: z.number().int().min(0).max(954680),
  count: z.number().int().min(0).max(500),
  receiptSha256: hash,
  part: z.string().regex(/^part-\d{3}\.zip$/),
  responseSha256: hash,
  requestSha256: hash,
});
const names = [
  'records.ndjson',
  'offsets.bin',
  'numeric.bin',
  'owners.bin',
  'owner-rows.bin',
  'pages.json',
  'discrepancies.ndjson',
] as const;
const manifestSchema = z.object({
  schemaVersion: z.literal(1),
  datasetVersion: hash,
  snapshot: SourceStakeSnapshotSchema,
  coverage: z.literal('complete_source_inventory_at_pin'),
  refreshEnabled: z.literal(false),
  rowCount: z.literal(954680),
  distinctSourceOwners: z.literal(183048),
  discrepancyOccurrences: z.literal(2081),
  discrepancyStartIds: z.literal(905),
  maxRecordBytes: z.literal(16384),
  actualMaxRecordBytes: z.number().int().min(1).max(16384),
  files: z.strictObject(
    Object.fromEntries(names.map((n) => [n, file])) as Record<(typeof names)[number], typeof file>,
  ),
});
export interface SourceStakeBinding {
  datasetVersion: string;
  manifestSha256: string;
}
export type SourceStakeReader = Pick<SavedSourceStakes, 'root' | 'read'>;
type Selection = {
  source: 'subgraph';
  chain: 'pulsechain';
  limit?: number;
  cursor?: string;
  address?: string;
  datasetVersion?: string;
};
type State = {
  manifest: z.infer<typeof manifestSchema>;
  records: FileHandle;
  recordsStat: { size: number; mtimeMs: number };
  offsets: Buffer;
  numeric: Buffer;
  owners: Buffer;
  ownerRows: Buffer;
  pages: z.infer<typeof page>[];
  discrepancies: Map<string, z.infer<typeof SourceDiscrepancySchema>[]>;
};
const sha = (b: Buffer) => createHash('sha256').update(b).digest('hex');

/** Immutable full-data reader. Only compact binary indexes live in memory.
 * Publication/replacement verifies files once; requests use bounded positional reads.
 * Caller supplies the accepted manifest binding, independently of the data directory.
 */
export class SavedSourceStakes {
  readonly root: string;
  private state: State | undefined;
  private busy = 0;
  readonly metrics = {
    requests: 0,
    parsedRecords: 0,
    recordReads: 0,
    recordBytes: 0,
    maximumRecordsPerRequest: 0,
  };
  constructor(root: string) {
    this.root = resolve(root);
  }

  async replace(binding: SourceStakeBinding): Promise<void> {
    if (this.busy) throw Error('SOURCE_READER_BUSY');
    hash.parse(binding.datasetVersion);
    hash.parse(binding.manifestSha256);
    const directory = join(this.root, binding.datasetVersion);
    if ((await realpath(directory)) !== directory || (await lstat(directory)).isSymbolicLink())
      throw Error('INVALID_SOURCE_DIRECTORY');
    const manifestPath = join(directory, 'manifest.json');
    const ms = await lstat(manifestPath);
    if (!ms.isFile() || ms.isSymbolicLink() || ms.size > 65536)
      throw Error('INVALID_SOURCE_MANIFEST');
    const raw = await readFile(manifestPath);
    if (sha(raw) !== binding.manifestSha256) throw Error('SOURCE_MANIFEST_IDENTITY');
    const manifest = manifestSchema.parse(JSON.parse(raw.toString('utf8')));
    if (manifest.datasetVersion !== binding.datasetVersion) throw Error('SOURCE_VERSION_MISMATCH');
    const handles = new Map<string, FileHandle>();
    try {
      const buffers = new Map<string, Buffer>();
      for (const name of names) {
        const path = join(directory, name),
          expected = manifest.files[name];
        const stat = await lstat(path);
        if (!stat.isFile() || stat.isSymbolicLink() || stat.size !== expected.bytes)
          throw Error('SOURCE_FILE_SIZE');
        const handle = await open(path, 'r');
        handles.set(name, handle);
        const before = await handle.stat();
        if (before.size !== stat.size) throw Error('SOURCE_FILE_CHANGED');
        const h = createHash('sha256'),
          chunk = Buffer.alloc(1024 * 1024);
        let position = 0;
        while (position < stat.size) {
          const { bytesRead } = await handle.read(
            chunk,
            0,
            Math.min(chunk.length, stat.size - position),
            position,
          );
          if (!bytesRead) throw Error('SOURCE_FILE_TRUNCATED');
          h.update(chunk.subarray(0, bytesRead));
          position += bytesRead;
        }
        const after = await handle.stat();
        if (
          h.digest('hex') !== expected.sha256 ||
          after.size !== before.size ||
          after.mtimeMs !== before.mtimeMs
        )
          throw Error('SOURCE_FILE_IDENTITY');
        if (name !== 'records.ndjson') {
          if (stat.size > 32 * 1024 * 1024) throw Error('SOURCE_INDEX_BOUND');
          const b = Buffer.alloc(stat.size);
          if (
            (await handle.read(b, 0, b.length, 0)).bytesRead !== b.length ||
            sha(b) !== expected.sha256
          )
            throw Error('SOURCE_INDEX_CHANGED');
          buffers.set(name, b);
        }
      }
      const offsets = buffers.get('offsets.bin')!,
        numeric = buffers.get('numeric.bin')!,
        owners = buffers.get('owners.bin')!,
        ownerRows = buffers.get('owner-rows.bin')!;
      if (
        offsets.length !== 954680 * 16 ||
        numeric.length !== 954680 * 12 ||
        owners.length !== 183048 * 28 ||
        ownerRows.length !== 954680 * 4
      )
        throw Error('SOURCE_INDEX_SIZE');
      const pages = z
        .array(page)
        .length(1912)
        .parse(JSON.parse(buffers.get('pages.json')!.toString('utf8')));
      let expectedOffset = 0,
        expectedOrdinal = 0;
      for (const [i, p] of pages.entries()) {
        if (
          p.globalPage !== i + 1 ||
          p.firstOrdinal !== expectedOrdinal ||
          (!p.count && i !== 1911)
        )
          throw Error('SOURCE_PAGE_CHAIN');
        expectedOrdinal += p.count;
      }
      if (expectedOrdinal !== 954680) throw Error('SOURCE_PAGE_COUNT');
      // Binary metadata only; no second parse of the million source records.
      const numericSeen = new Uint8Array(954680);
      for (let i = 0; i < 954680; i++) {
        const off = Number(offsets.readBigUInt64LE(i * 16)),
          length = offsets.readUInt32LE(i * 16 + 8);
        const p = pages[offsets.readUInt16LE(i * 16 + 12) - 1],
          row = offsets.readUInt16LE(i * 16 + 14);
        if (
          off !== expectedOffset ||
          length < 2 ||
          length > 16384 ||
          !p ||
          row >= p.count ||
          p.firstOrdinal + row !== i
        )
          throw Error('SOURCE_OFFSET_INDEX');
        expectedOffset += length;
        const numericOrdinal = numeric.readUInt32LE(i * 12 + 8);
        if (
          numericOrdinal >= 954680 ||
          numericSeen[numericOrdinal] ||
          numeric.readBigUInt64LE(i * 12) >= 1n << 40n ||
          (i && numeric.readBigUInt64LE(i * 12) <= numeric.readBigUInt64LE((i - 1) * 12))
        )
          throw Error('SOURCE_NUMERIC_INDEX');
        numericSeen[numericOrdinal] = 1;
      }
      if (expectedOffset !== manifest.files['records.ndjson'].bytes)
        throw Error('SOURCE_RECORD_EXTENT');
      let ownerOffset = 0;
      const seen = new Uint8Array(954680);
      for (let i = 0; i < 183048; i++) {
        const at = i * 28,
          offset = owners.readUInt32LE(at + 20),
          count = owners.readUInt32LE(at + 24);
        if (
          offset !== ownerOffset ||
          !count ||
          offset + count > 954680 ||
          (i && Buffer.compare(owners.subarray(at - 28, at - 8), owners.subarray(at, at + 20)) >= 0)
        )
          throw Error('SOURCE_OWNER_INDEX');
        let previous = -1;
        for (let j = offset; j < offset + count; j++) {
          const ordinal = ownerRows.readUInt32LE(j * 4);
          if (ordinal >= 954680 || ordinal <= previous || seen[ordinal])
            throw Error('SOURCE_OWNER_ROWS');
          seen[ordinal] = 1;
          previous = ordinal;
        }
        ownerOffset += count;
      }
      if (ownerOffset !== 954680) throw Error('SOURCE_OWNER_COUNT');
      const discrepancies = new Map<string, z.infer<typeof SourceDiscrepancySchema>[]>();
      let issueCount = 0;
      for (const line of buffers
        .get('discrepancies.ndjson')!
        .toString('utf8')
        .trimEnd()
        .split('\n')) {
        const issue = SourceDiscrepancySchema.parse(JSON.parse(line));
        const entries = discrepancies.get(issue.startId) ?? [];
        entries.push(issue);
        if (entries.length > 32) throw Error('SOURCE_ISSUE_BOUND');
        discrepancies.set(issue.startId, entries);
        issueCount++;
      }
      if (issueCount !== 2081 || discrepancies.size !== 905)
        throw Error('SOURCE_DISCREPANCY_COUNT');
      const records = handles.get('records.ndjson')!;
      const recordStat = await records.stat();
      const next: State = {
        manifest,
        records,
        recordsStat: { size: recordStat.size, mtimeMs: recordStat.mtimeMs },
        offsets,
        numeric,
        owners,
        ownerRows,
        pages,
        discrepancies,
      };
      if (this.busy) throw Error('SOURCE_READER_BUSY');
      const previous = this.state;
      this.state = next;
      handles.delete('records.ndjson');
      await previous?.records.close();
    } finally {
      await Promise.all([...handles.values()].map((h) => h.close()));
    }
  }


  /** Bounded positional primitives for the admitted, single-generation overlay. */
  async rowAt(ordinal: number, signal: AbortSignal) {
    const s = this.state; if (!s) throw unavailable();
    if (!Number.isInteger(ordinal) || ordinal < 0 || ordinal >= 954680) throw unavailable();
    this.busy++;
    try {
      signal.throwIfAborted(); const st = await s.records.stat();
      if (st.size !== s.recordsStat.size || st.mtimeMs !== s.recordsStat.mtimeMs) throw unavailable();
      return await this.record(s, ordinal, signal);
    } finally { this.busy--; }
  }
  async lowerBound(id: string, signal: AbortSignal) {
    let lo = 0, hi = 954680;
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
    const s = this.state; if (!s || !Number.isInteger(ordinal) || ordinal < 0 || ordinal >= 954680) throw unavailable();
    const at = ordinal * 16;
    return { ordinal, sourcePage: s.pages[s.offsets.readUInt16LE(at + 12) - 1]!, rowInPage: s.offsets.readUInt16LE(at + 14) };
  }

  ownerCount(address: string) {
    const s = this.state; if (!s || !/^0x[0-9a-f]{40}$/.test(address)) throw unavailable();
    return this.owner(s, address).count;
  }
  async ownerAt(address: string, position: number, signal: AbortSignal) {
    const s = this.state; if (!s) throw unavailable();
    const owner = this.owner(s, address);
    if (!Number.isInteger(position) || position < 0 || position >= owner.count) throw unavailable();
    return this.rowAt(s.ownerRows.readUInt32LE((owner.offset + position) * 4), signal);
  }
  async byNumericId(id: string, signal: AbortSignal) {
    const s = this.state; if (!s || !/^(0|[1-9][0-9]{0,17})$/.test(id)) throw unavailable();
    const key = BigInt(id); let lo = 0, hi = 954680;
    while (lo < hi) { const mid = (lo + hi) >>> 1;
      if (s.numeric.readBigUInt64LE(mid * 12) < key) lo = mid + 1; else hi = mid; }
    if (lo === 954680 || s.numeric.readBigUInt64LE(lo * 12) !== key) return null;
    const row = await this.rowAt(s.numeric.readUInt32LE(lo * 12 + 8), signal);
    if (row.reported.stakeId !== id) throw unavailable(); return row;
  }

  async close() {
    if (this.busy) throw Error('SOURCE_READER_BUSY');
    const s = this.state;
    this.state = undefined;
    await s?.records.close();
  }

  private owner(s: State, address: string) {
    const key = Buffer.from(address.slice(2), 'hex');
    let lo = 0,
      hi = 183048;
    while (lo < hi) {
      const mid = (lo + hi) >>> 1;
      if (Buffer.compare(s.owners.subarray(mid * 28, mid * 28 + 20), key) < 0) lo = mid + 1;
      else hi = mid;
    }
    if (lo === 183048 || !s.owners.subarray(lo * 28, lo * 28 + 20).equals(key))
      return { offset: 0, count: 0 };
    return {
      offset: s.owners.readUInt32LE(lo * 28 + 20),
      count: s.owners.readUInt32LE(lo * 28 + 24),
    };
  }

  private async record(s: State, ordinal: number, signal: AbortSignal): Promise<SourceStakeRecord> {
    signal.throwIfAborted();
    if (!Number.isInteger(ordinal) || ordinal < 0 || ordinal >= 954680) throw unavailable();
    const offset = Number(s.offsets.readBigUInt64LE(ordinal * 16)),
      length = s.offsets.readUInt32LE(ordinal * 16 + 8);
    const b = Buffer.alloc(length);
    const { bytesRead } = await s.records.read(b, 0, length, offset);
    this.metrics.recordReads++;
    this.metrics.recordBytes += bytesRead;
    if (bytesRead !== length || b[length - 1] !== 10) throw unavailable();
    const reported = SourceStartSchema.parse(JSON.parse(b.toString('utf8')));
    this.metrics.parsedRecords++;
    const p = s.pages[s.offsets.readUInt16LE(ordinal * 16 + 12) - 1]!;
    return {
      reported,
      recordState: reported.stakeEnd
        ? reported.stakeGoodAccounting
          ? 'end_and_ga_link_present'
          : 'end_link_present'
        : reported.stakeGoodAccounting
          ? 'ga_link_present'
          : 'no_end_or_ga_link',
      provenance: {
        segment: p.segment,
        sourcePage: p.localPage,
        sourceAttempt: p.sourceAttempt,
        rowInPage: s.offsets.readUInt16LE(ordinal * 16 + 14),
        originalPageSha256: p.sha256,
      },
      discrepancies: s.discrepancies.get(reported.id) ?? [],
    };
  }

  /** Entity IDs retain lexical order; this bounded lookup is separate from numeric stake IDs. */
  async byEntityId(id: string, signal: AbortSignal): Promise<SourceStakeRecord | null> {
    if (!/^[A-Za-z0-9_.:-]{1,256}$/.test(id)) throw unavailable();
    const s = this.state;
    if (!s) throw unavailable();
    this.busy++;
    try {
      let lo = 0,
        hi = 954680;
      while (lo < hi) {
        const mid = (lo + hi) >>> 1,
          row = await this.record(s, mid, signal);
        if (row.reported.id < id) lo = mid + 1;
        else hi = mid;
      }
      if (lo === 954680) return null;
      const row = await this.record(s, lo, signal);
      return row.reported.id === id ? row : null;
    } finally {
      this.busy--;
    }
  }

  async read(
    route: 'stakes' | 'stake' | 'address' | 'addressStakes',
    q: Selection,
    params: { id?: string; address?: string },
    signal: AbortSignal,
    cursors: PageCursors,
    now: number,
  ) {
    const s = this.state;
    if (!s) throw unavailable();
    signal.throwIfAborted();
    if (q.chain !== 'pulsechain' || q.source !== 'subgraph') throw unavailable();
    if (q.datasetVersion && q.datasetVersion !== s.manifest.datasetVersion) throw restart();
    this.busy++;
    this.metrics.requests++;
    const before = this.metrics.parsedRecords;
    try {
      const stat = await s.records.stat();
      if (stat.size !== s.recordsStat.size || stat.mtimeMs !== s.recordsStat.mtimeMs)
        throw unavailable();
      const envelope = {
        chain: 'pulsechain' as const,
        source: 'subgraph' as const,
        datasetVersion: s.manifest.datasetVersion,
        snapshot: s.manifest.snapshot,
        coverage: 'complete_source_inventory_at_pin' as const,
        refreshEnabled: false as const,
        inventorySourceStartCount: 954680 as const,
      };
      if (route === 'stake') {
        const id = BigInt(params.id!);
        let lo = 0,
          hi = 954680;
        while (lo < hi) {
          const mid = (lo + hi) >>> 1;
          if (s.numeric.readBigUInt64LE(mid * 12) < id) lo = mid + 1;
          else hi = mid;
        }
        const item =
          lo < 954680 && s.numeric.readBigUInt64LE(lo * 12) === id
            ? await this.record(s, s.numeric.readUInt32LE(lo * 12 + 8), signal)
            : null;
        if (item && item.reported.stakeId !== params.id) throw unavailable();
        if (item && q.address && q.address !== item.reported.stakerAddr.toLowerCase())
          throw new ApiFailure(
            409,
            'incompatible_owner',
            'Owner hint conflicts with saved source record.',
          );
        return {
          ...envelope,
          reportedStakeId: params.id,
          presence: item ? 'present_in_saved_inventory' : 'not_present_in_saved_inventory',
          item,
        };
      }
      const address = params.address ?? q.address ?? null,
        limit = q.limit ?? 50;
      if (
        !Number.isInteger(limit) ||
        limit < 1 ||
        limit > 100 ||
        (address && !/^0x[0-9a-f]{40}$/.test(address))
      )
        throw unavailable();
      const owner = address ? this.owner(s, address) : { offset: 0, count: 954680 };
      const binding = createHash('sha256')
        .update(JSON.stringify([route, q.source, q.chain, address, limit, 'source-id-asc']))
        .digest('hex');
      const cursor = cursors.decode(q.cursor, binding, now);
      if (cursor && cursor.identity !== s.manifest.datasetVersion) throw restart();
      const offset = cursor ? Number(cursor.key) : 0;
      if (
        (cursor && !/^(0|[1-9][0-9]{0,6})$/.test(cursor.key)) ||
        !Number.isInteger(offset) ||
        offset < 0 ||
        offset > owner.count
      )
        throw restart();
      const items: SourceStakeRecord[] = [];
      for (let i = offset; i < Math.min(offset + limit, owner.count); i++) {
        const ordinal = address ? s.ownerRows.readUInt32LE((owner.offset + i) * 4) : i;
        const row = await this.record(s, ordinal, signal);
        if (address && row.reported.stakerAddr.toLowerCase() !== address) throw unavailable();
        items.push(row);
      }
      const next = offset + items.length;
      const nextCursor =
        next < owner.count
          ? cursors.encode(binding, s.manifest.datasetVersion, String(next), now, cursor?.expires)
          : null;
      const body = { ...envelope, address, sourceStartCount: owner.count, items, nextCursor };
      return route === 'address' || route === 'addressStakes'
        ? { ...body, liquidBalance: null, ranks: null }
        : body;
    } finally {
      this.busy--;
      this.metrics.maximumRecordsPerRequest = Math.max(
        this.metrics.maximumRecordsPerRequest,
        this.metrics.parsedRecords - before,
      );
    }
  }
}
