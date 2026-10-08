import { mkdir, open, readdir, rename, lstat, realpath, unlink } from 'node:fs/promises';
import { dirname, resolve, relative, isAbsolute, join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { readBounded } from '../worker/history/input.ts';
import {
  hash,
  stable,
  parseRows,
  loadMapping,
  normalize,
  csv,
  nominal,
  compare,
  validScalar,
  type Mapping,
  type Daily,
  type Price,
} from './normalize.ts';

const signal = () => new AbortController().signal;
export const boundedRead = (path: string) => readBounded(path, signal());
export type FileIdentity = { bytes: number; sha256: string };
type Manifest = {
  format: string;
  mappingSha256: string;
  files: Record<string, FileIdentity>;
  counts: { daily: number; prices: number; exceptions: number };
};
const identity = (b: Buffer): FileIdentity => ({ bytes: b.length, sha256: hash(b) });
export function makePackage(
  pulse: Buffer,
  ethereum: Buffer,
  ledger: Buffer,
  mappingBytes: Buffer,
  implementationSha256: string,
) {
  const mapping = loadMapping(mappingBytes);
  for (const [name, b] of Object.entries({ pulse, ethereum, ledger })) {
    if (hash(b) !== mapping.inputHashes[name as keyof Mapping['inputHashes']])
      throw Error('INPUT_DIGEST_' + name);
  }
  if (!/^[0-9a-f]{64}$/.test(implementationSha256)) throw Error('IMPLEMENTATION_DIGEST');
  const pulseRows = parseRows(pulse),
    ethereumRows = parseRows(ethereum);
  // The accepted ledger is checked, never rewritten, substituted or joined on row position.
  const ledgerDoc = JSON.parse(ledger.toString());
  if (
    ledgerDoc.format !== 'hdd-contract-ledger-1' ||
    ledgerDoc.items.length !== 2498 ||
    ledgerDoc.items.some((x: { contractDay: number }, i: number) => x.contractDay !== i)
  )
    throw Error('LEDGER_DOMAIN');
  const result = normalize(pulseRows, ethereumRows, mapping);
  const files: Record<string, Buffer> = {
    'daily.ndjson': Buffer.from(result.daily.map(stable).join('')),
    'daily.csv': Buffer.from(
      csv(result.daily, ['day', 'recordedAtUtc', ...mapping.fields.map((f) => f.target)]),
    ),
    'prices.ndjson': Buffer.from(result.prices.map(stable).join('')),
    'prices.csv': Buffer.from(csv(result.prices, ['series', 'day', 'recordedAtUtc', 'quoteUsd'])),
    'EXCEPTIONS.ndjson': Buffer.from(result.exceptions.map(stable).join('')),
    'FIELD_MAPPING.json': mappingBytes,
  };
  const fieldCounts = Object.fromEntries(
    mapping.fields.map((f) => [
      f.target,
      result.daily.filter((row) => row[f.target] !== null).length,
    ]),
  );
  const seriesCounts = Object.fromEntries(
    mapping.priceSeries.map((p) => {
      const rows = result.prices.filter((row) => row.series === p.series);
      const available = rows.filter((row) => row.quoteUsd !== null);
      return [
        p.series,
        {
          rows: rows.length,
          available: available.length,
          first: available[0] ?? null,
          last: available.at(-1) ?? null,
        },
      ];
    }),
  );
  const receipt = {
    format: 'hdd-history-import-receipt-1',
    implementationSha256,
    mappingSha256: hash(mappingBytes),
    inputs: mapping.inputHashes,
    backingArchive: {
      file: 'hdd-hds-parity-mainline-readiness-r1-return.zip',
      sha256: 'e7caf57981503f3321c4d9ef91d1144b276ad397a182b24b12e5bac5c4f3edde',
      pulse: 'public-session/03.body',
      ethereum: 'public-session/02.body',
      producer: 'public-session/09.body + 10.body',
      license: 'public-session/07.body',
    },
    inputRows: { pulse: pulseRows.length, ethereum: ethereumRows.length },
    outputCounts: {
      daily: result.daily.length,
      prices: result.prices.length,
      exceptions: result.exceptions.length,
    },
    originalSourceDays: { first: 1, last: 2501, day0: 'absent' },
    recordedAtUtc: {
      first: result.daily[0]?.recordedAtUtc,
      last: result.daily.at(-1)?.recordedAtUtc,
    },
    fieldCounts,
    seriesCounts,
    timeConvention: mapping.timeConvention,
    ledger: {
      rows: 2498,
      sha256: hash(ledger),
      joined: false,
      unchanged: true,
      reason:
        'HDS latest endDay<=currentDay has no per-row update interval; day offsets/close are not established.',
    },
    outputs: Object.fromEntries(Object.entries(files).map(([name, b]) => [name, identity(b)])),
    credits: mapping.credits,
    limitations: mapping.limitations,
  };
  files['IMPORT_RECEIPT.json'] = Buffer.from(stable(receipt));
  const manifest: Manifest = {
    format: 'hdd-history-bootstrap-1',
    mappingSha256: hash(mappingBytes),
    files: Object.fromEntries(Object.entries(files).map(([name, b]) => [name, identity(b)])),
    counts: receipt.outputCounts,
  };
  files['MANIFEST.json'] = Buffer.from(stable(manifest));
  return { files, manifest, receipt, manifestSha256: hash(files['MANIFEST.json']) };
}
function jsonLines(bytes: Buffer) {
  if (!bytes.toString().endsWith('\n')) throw Error('FINAL_NEWLINE');
  return bytes
    .toString()
    .trimEnd()
    .split('\n')
    .filter(Boolean)
    .map((line) => JSON.parse(line));
}
const expectedNames = [
  'daily.ndjson',
  'daily.csv',
  'prices.ndjson',
  'prices.csv',
  'EXCEPTIONS.ndjson',
  'FIELD_MAPPING.json',
  'IMPORT_RECEIPT.json',
];
export async function validatePackage(directory: string, expectedManifestSha256: string) {
  if (!/^[0-9a-f]{64}$/.test(expectedManifestSha256)) throw Error('EXPECTED_MANIFEST_REQUIRED');
  const names = (await readdir(directory)).sort();
  if (JSON.stringify(names) !== JSON.stringify([...expectedNames, 'MANIFEST.json'].sort()))
    throw Error('PACKAGE_MEMBERS');
  const manifestBytes = await boundedRead(join(directory, 'MANIFEST.json'));
  if (hash(manifestBytes) !== expectedManifestSha256) throw Error('MANIFEST_DIGEST');
  const manifest = JSON.parse(manifestBytes.toString()) as Manifest;
  if (
    manifest.format !== 'hdd-history-bootstrap-1' ||
    JSON.stringify(Object.keys(manifest.files).sort()) !== JSON.stringify([...expectedNames].sort())
  )
    throw Error('MANIFEST_SHAPE');
  const files: Record<string, Buffer> = {};
  for (const name of expectedNames) {
    const b = await boundedRead(join(directory, name));
    if (b.length !== manifest.files[name]!.bytes || hash(b) !== manifest.files[name]!.sha256)
      throw Error('FILE_DIGEST_' + name);
    files[name] = b;
  }
  const mapping = loadMapping(files['FIELD_MAPPING.json']!);
  if (hash(files['FIELD_MAPPING.json']!) !== manifest.mappingSha256) throw Error('MAPPING_DIGEST');
  const daily = jsonLines(files['daily.ndjson']!) as Daily[],
    prices = jsonLines(files['prices.ndjson']!) as Price[],
    exceptions = jsonLines(files['EXCEPTIONS.ndjson']!);
  if (
    daily.length !== manifest.counts.daily ||
    prices.length !== manifest.counts.prices ||
    exceptions.length !== manifest.counts.exceptions
  )
    throw Error('ROW_COUNTS');
  const columns = ['day', 'recordedAtUtc', ...mapping.fields.map((f) => f.target)];
  let previous = -1;
  for (const row of daily) {
    if (
      JSON.stringify(Object.keys(row)) !== JSON.stringify(columns) ||
      !Number.isInteger(row.day) ||
      row.day <= previous
    )
      throw Error('DAILY_SHAPE_ORDER');
    previous = row.day;
    if (row.recordedAtUtc !== null && !Number.isFinite(Date.parse(row.recordedAtUtc)))
      throw Error('DAILY_DATE');
    for (const f of mapping.fields) {
      const v = row[f.target];
      if (v !== null) {
        if (typeof v !== 'string' || validScalar(v, f) === null) throw Error('SCALAR_ONLY');
        if (f.kind === 'held') throw Error('HELD_FIELD');
      }
    }
    if ([1, 2].includes(row.day) && mapping.fields.some((f) => row[f.target] !== null))
      throw Error('SKELETON');
  }
  const seen = new Set<string>();
  for (const row of prices) {
    if (
      JSON.stringify(Object.keys(row)) !==
      JSON.stringify(['series', 'day', 'recordedAtUtc', 'quoteUsd'])
    )
      throw Error('PRICE_SHAPE');
    const series = mapping.priceSeries.find(
      (p) => p.series === row.series && p.kind === 'reference',
    );
    if (!series) throw Error('PRICE_SERIES');
    const key = row.series + ':' + row.day;
    if (seen.has(key)) throw Error('DUPLICATE_PRICE');
    seen.add(key);
    if (
      !Number.isInteger(row.day) ||
      !Number.isFinite(Date.parse(row.recordedAtUtc)) ||
      row.recordedAtUtc.slice(0, 10) < series.fromDate! ||
      nominal(row.day) < series.fromDate! ||
      (series.toDate &&
        (row.recordedAtUtc.slice(0, 10) > series.toDate || nominal(row.day) > series.toDate))
    )
      throw Error('PRICE_ERA');
    if (
      row.quoteUsd !== null &&
      (typeof row.quoteUsd !== 'string' || compare(row.quoteUsd, '0') <= 0)
    )
      throw Error('PRICE_VALUE');
  }
  if (
    !files['daily.csv']!.equals(Buffer.from(csv(daily, columns))) ||
    !files['prices.csv']!.equals(
      Buffer.from(csv(prices, ['series', 'day', 'recordedAtUtc', 'quoteUsd'])),
    )
  )
    throw Error('CSV_PARITY');
  const receipt = JSON.parse(files['IMPORT_RECEIPT.json']!.toString());
  if (
    receipt.mappingSha256 !== manifest.mappingSha256 ||
    JSON.stringify(receipt.inputs) !== JSON.stringify(mapping.inputHashes)
  )
    throw Error('RECEIPT_BINDING');
  return { manifestSha256: expectedManifestSha256, counts: manifest.counts, daily, prices };
}
async function ownedDestination(destination: string, allowedRoot: string) {
  const root = resolve(allowedRoot),
    target = resolve(destination),
    rel = relative(root, target);
  if (!rel || rel.startsWith('..') || isAbsolute(rel)) throw Error('OUTPUT_OUTSIDE_OWNED_ROOT');
  await mkdir(root, { recursive: true });
  if ((await realpath(root)) !== root) throw Error('OUTPUT_ROOT_LINK');
  // Outputs are one direct child to avoid links/aliases through intermediate paths.
  if (dirname(target) !== root) throw Error('OUTPUT_DIRECT_CHILD_REQUIRED');
  return target;
}
export async function publishPackage(
  destination: string,
  allowedRoot: string,
  product: ReturnType<typeof makePackage>,
  beforePublish?: () => Promise<void>,
) {
  const target = await ownedDestination(destination, allowedRoot);
  const lockPath = target + '.lock';
  if (
    await lstat(lockPath).then(
      () => true,
      (error) => {
        if (error.code === 'ENOENT') return false;
        throw error;
      },
    )
  )
    throw Error('OUTPUT_PUBLICATION_LOCK');
  const existing = await lstat(target).catch((error: NodeJS.ErrnoException) => {
    if (error.code === 'ENOENT') return null;
    throw error;
  });
  if (existing) {
    if (!existing.isDirectory() || existing.isSymbolicLink()) throw Error('OUTPUT_COLLISION');
    await validatePackage(target, product.manifestSha256);
    return { changed: false, manifestSha256: product.manifestSha256 };
  }
  // Exclusive task-local admission. A failed publication leaves its lock and staging
  // as evidence; it never clears another writer's state or silently restarts.
  const lock = await open(lockPath, 'wx');
  let completed = false;
  try {
    await lock.writeFile('history-bootstrap publication\n');
    await lock.sync();
    const staging = target + '.pending-' + randomUUID();
    await mkdir(staging);
    for (const [name, b] of Object.entries(product.files)) {
      const file = await open(join(staging, name), 'wx');
      try {
        await file.writeFile(b);
        await file.sync();
      } finally {
        await file.close();
      }
    }
    await validatePackage(staging, product.manifestSha256);
    if (beforePublish) await beforePublish();
    if (
      await lstat(target).then(
        () => true,
        (error) => {
          if (error.code === 'ENOENT') return false;
          throw error;
        },
      )
    )
      throw Error('OUTPUT_COLLISION');
    await rename(staging, target);
    await validatePackage(target, product.manifestSha256);
    completed = true;
    return { changed: true, manifestSha256: product.manifestSha256 };
  } finally {
    await lock.close();
    if (completed) await unlink(lockPath);
  }
}
