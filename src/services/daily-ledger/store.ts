import { createHash, randomUUID } from 'node:crypto';
import { readFile, open, rename, mkdir, unlink } from 'node:fs/promises';
import { join } from 'node:path';
import type { z } from 'zod';
import {
  DailyLedgerResponseSchema,
  ledgerDatasetSchema,
  ledgerManifestSchema,
  ledgerUnavailable,
  ledgerDate,
} from '../../contracts/daily-ledger.ts';
import { contractDayAt } from '../../domain/day.ts';
import { ApiFailure, unavailable } from '../../api/errors.ts';

type Dataset = z.infer<typeof ledgerDatasetSchema>;
type Selection = { dataset: Dataset; version: string; manifestSha256: string };
export interface DailyLedgerReader {
  read(
    query: { from: string; to: string; datasetVersion?: string },
    signal: AbortSignal,
  ): Promise<z.infer<typeof DailyLedgerResponseSchema>>;
}
const digest = (data: Uint8Array) => createHash('sha256').update(data).digest('hex');
function validate(data: Buffer, manifestBytes: Buffer): Selection {
  if (data.length > 8 * 1024 * 1024 || manifestBytes.length > 1024 * 1024)
    throw Error('Saved ledger exceeds bounds.');
  const manifest = ledgerManifestSchema.parse(JSON.parse(manifestBytes.toString('utf8')));
  const version = digest(data);
  if (
    version !== manifest.version ||
    version !== manifest.datasetSha256 ||
    data.length !== manifest.datasetBytes
  )
    throw Error('Ledger manifest mismatch.');
  const dataset = ledgerDatasetSchema.parse(JSON.parse(data.toString('utf8')));
  if (Date.parse(dataset.metadata.captureStartedAt) > Date.parse(dataset.metadata.fetchedAt))
    throw Error('Capture interval reversed.');
  const sources = new Map(dataset.sources.map((s) => [s.id, s]));
  if (sources.size !== 20) throw Error('Duplicate source identity.');
  for (const [index, row] of dataset.items.entries()) {
    if (row.contractDay !== index) throw Error('Daily coverage is not ordered/contiguous.');
    const a = sources.get(row.sourceRefs[0]),
      b = sources.get(row.sourceRefs[1]);
    if (
      !a ||
      !b ||
      a.provider !== 'pulsechainOfficial' ||
      b.provider !== 'g4mm4Pulsechain' ||
      a.endpoint !== 'https://rpc.pulsechain.com/' ||
      b.endpoint !== 'https://rpc-pulsechain.g4mm4.io/' ||
      a.beginInclusive !== b.beginInclusive ||
      a.endExclusive !== b.endExclusive ||
      index < a.beginInclusive ||
      index >= a.endExclusive
    )
      throw Error('Missing/conflicting paired source interval.');
    for (const s of [a, b])
      if (
        Date.parse(s.captureStartedAt) < Date.parse(dataset.metadata.captureStartedAt) ||
        Date.parse(s.captureFinishedAt) > Date.parse(dataset.metadata.fetchedAt) ||
        Date.parse(s.captureFinishedAt) < Date.parse(s.captureStartedAt)
      )
        throw Error('Mixed capture interval.');
  }
  for (const source of dataset.sources) {
    const rows = dataset.items.slice(source.beginInclusive, source.endExclusive);
    if (
      !rows.length ||
      rows.length > 256 ||
      rows.length !== source.endExclusive - source.beginInclusive
    )
      throw Error('Invalid source range.');
    const words = [32n, BigInt(rows.length), ...rows.map((r) => BigInt(r.packed))];
    const result = Buffer.from(words.map((v) => v.toString(16).padStart(64, '0')).join(''), 'hex');
    if (digest(result) !== source.resultSha256) throw Error('Paired source words conflict.');
  }
  // Private selection, never exposed for mutation. Reads return a separately parsed response.
  return { dataset, version, manifestSha256: digest(manifestBytes) };
}
export class SavedDailyLedger implements DailyLedgerReader {
  private selected: Selection | undefined;
  constructor(
    private readonly root: string,
    private readonly accepted: { datasetSha256: string; manifestSha256: string },
  ) {}
  private validate(data: Buffer, manifest: Buffer) {
    if (
      digest(data) !== this.accepted.datasetSha256 ||
      digest(manifest) !== this.accepted.manifestSha256
    )
      throw Error('Saved ledger differs from the explicitly accepted input binding.');
    return validate(data, manifest);
  }
  async reopen(): Promise<void> {
    const pointer = JSON.parse(await readFile(join(this.root, 'selected.json'), 'utf8')) as {
      version: string;
    };
    if (!/^[0-9a-f]{64}$/.test(pointer.version)) throw Error('Invalid selected version.');
    const next = this.validate(
      await readFile(join(this.root, pointer.version + '.json')),
      await readFile(join(this.root, pointer.version + '.manifest.json')),
    );
    if (next.version !== pointer.version) throw Error('Selected version mismatch.');
    this.selected = next;
  }
  async publish(data: Buffer, manifest: Buffer): Promise<void> {
    const next = this.validate(data, manifest); // No file or selection changes until full validation passes.
    await mkdir(this.root, { recursive: true });
    for (const [name, bytes] of [
      [next.version + '.json', data],
      [next.version + '.manifest.json', manifest],
    ] as const) {
      try {
        const file = await open(join(this.root, name), 'wx');
        try {
          await file.writeFile(bytes);
          await file.sync();
        } finally {
          await file.close();
        }
      } catch (e) {
        if (
          (e as NodeJS.ErrnoException).code !== 'EEXIST' ||
          !(await readFile(join(this.root, name))).equals(bytes)
        )
          throw e;
      }
    }
    const temp = join(this.root, randomUUID() + '.tmp');
    try {
      const file = await open(temp, 'wx');
      try {
        await file.writeFile(JSON.stringify({ version: next.version }) + '\n');
        await file.sync();
      } finally {
        await file.close();
      }
      await rename(temp, join(this.root, 'selected.json'));
      this.selected = next;
    } finally {
      await unlink(temp).catch(() => {});
    }
  }
  async read(query: { from: string; to: string; datasetVersion?: string }, signal: AbortSignal) {
    signal.throwIfAborted();
    const selection = this.selected;
    if (!selection) throw unavailable();
    if (query.datasetVersion && query.datasetVersion !== selection.version)
      throw new ApiFailure(409, 'cursor_incompatible', 'Saved dataset changed; restart selection.');
    const from = contractDayAt(BigInt(Date.parse(query.from) / 1000)),
      to = contractDayAt(BigInt(Date.parse(query.to) / 1000));
    if (to < from || to - from >= 366)
      throw new ApiFailure(400, 'invalid_request', 'Invalid ledger range.');
    const items = selection.dataset.items.slice(from, Math.min(to + 1, 2498));
    const ids = new Set(items.flatMap((r) => r.sourceRefs));
    const missing = Array.from({ length: to - from + 1 }, (_, i) => from + i)
      .filter((d) => d >= 2498)
      .map((d) => ({
        contractDay: d,
        nominalDateUtc: ledgerDate(d),
        reason: 'outside_captured_domain' as const,
      }));
    signal.throwIfAborted();
    return DailyLedgerResponseSchema.parse({
      chain: 'pulsechain',
      source: 'contract-ledger',
      datasetVersion: selection.version,
      manifestSha256: selection.manifestSha256,
      metadata: selection.dataset.metadata,
      unavailable: ledgerUnavailable,
      sources: selection.dataset.sources.filter((s) => ids.has(s.id)),
      coverage: {
        from: query.from,
        to: query.to,
        requested: to - from + 1,
        returned: items.length,
        missing,
      },
      items,
    });
  }
}
