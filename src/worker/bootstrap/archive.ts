import { createReadStream, createWriteStream } from 'node:fs';
import { open, stat } from 'node:fs/promises';
import { Readable, Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { createGzip, createGunzip } from 'node:zlib';
import { createHash } from 'node:crypto';

export const archiveLimits = {
  rowBytes: 1024 * 1024,
  memberBytes: 8 * 1024 ** 3,
  totalBytes: 32 * 1024 ** 3,
  manifestBytes: 64 * 1024,
  maximumRatio: 1000,
};
function octal(value: number, width: number) {
  const s = value.toString(8);
  if (s.length > width - 1) throw new Error('Tar size overflow.');
  return s.padStart(width - 1, '0') + '\0';
}
function tarHeader(name: string, size: number) {
  if (
    !/^(seed\.json|backup\.json|database\.sql|tables\/[a-z_]+\.ndjson)$/.test(name) ||
    name.length >= 100
  )
    throw new Error('Invalid seed member name.');
  const h = Buffer.alloc(512);
  h.write(name, 0, 100, 'ascii');
  h.write('0000600\0', 100);
  h.write('0000000\0', 108);
  h.write('0000000\0', 116);
  h.write(octal(size, 12), 124);
  h.write('00000000000\0', 136);
  h.fill(32, 148, 156);
  h[156] = 48;
  h.write('ustar\0', 257);
  h.write('00', 263);
  h.write(
    octal(
      h.reduce((n, b) => n + b, 0),
      7,
    ) + ' ',
    148,
  );
  return h;
}
export async function packArchive(
  destination: string,
  members: { name: string; path?: string; data?: Buffer; size: number }[],
  signal: AbortSignal,
) {
  async function* chunks() {
    for (const m of members) {
      signal.throwIfAborted();
      yield tarHeader(m.name, m.size);
      let count = 0;
      if (m.data) {
        count = m.data.length;
        yield m.data;
      } else {
        for await (const chunk of createReadStream(m.path!)) {
          signal.throwIfAborted();
          count += chunk.length;
          yield chunk;
        }
      }
      if (count !== m.size) throw new Error('Seed member changed during packing.');
      const padding = (512 - (count % 512)) % 512;
      if (padding) yield Buffer.alloc(padding);
    }
    yield Buffer.alloc(1024);
  }
  await pipeline(
    Readable.from(chunks()),
    createGzip(),
    createWriteStream(destination, { flags: 'wx', mode: 0o600 }),
    { signal },
  );
  const file = await open(destination, 'r+');
  try {
    await file.sync();
  } finally {
    await file.close();
  }
}
class Bytes {
  private iterator: AsyncIterator<Buffer>;
  private buffer = Buffer.alloc(0);
  private ended = false;
  constructor(stream: AsyncIterable<Buffer>) {
    this.iterator = stream[Symbol.asyncIterator]();
  }
  async take(n: number, optional = false): Promise<Buffer> {
    const parts: Buffer[] = [];
    let size = 0;
    while (size < n) {
      if (!this.buffer.length && !this.ended) {
        const next = await this.iterator.next();
        this.ended = !!next.done;
        this.buffer = next.value ?? Buffer.alloc(0);
      }
      if (!this.buffer.length) {
        if (optional && !size) return Buffer.alloc(0);
        throw new Error('Truncated seed archive.');
      }
      const count = Math.min(n - size, this.buffer.length);
      parts.push(this.buffer.subarray(0, count));
      this.buffer = this.buffer.subarray(count);
      size += count;
    }
    return Buffer.concat(parts, size);
  }
}
function readOctal(b: Buffer) {
  const text = b.toString('ascii').replace(/\0.*$/, '').trim();
  if (!/^[0-7]+$/.test(text)) throw new Error('Unsupported tar numeric field.');
  const n = parseInt(text, 8);
  if (!Number.isSafeInteger(n)) throw new Error('Tar field overflow.');
  return n;
}
/** A deliberately small ustar reader: no extraction, PAX extensions, links or scripts.
 * Only exact allowlisted regular member names are ever passed to the SQL importer.
 */
export async function readArchive(
  path: string,
  allowed: string[],
  visit: (name: string, size: number, content: AsyncIterable<Buffer>) => Promise<void>,
  signal: AbortSignal,
  firstMember = 'seed.json',
) {
  const compressed = (await stat(path)).size;
  if (compressed > archiveLimits.totalBytes) throw new Error('Compressed seed exceeds bound.');
  let total = 0;
  const bound = new Transform({
    transform(chunk, encoding, callback) {
      total += chunk.length;
      if (
        total > archiveLimits.totalBytes ||
        total > Math.max(1024 * 1024, compressed * archiveLimits.maximumRatio)
      )
        callback(new Error('Seed expanded size/ratio limit.'));
      else callback(null, chunk);
    },
  });
  const source = createReadStream(path),
    gunzip = createGunzip();
  const digest = createHash('sha256');
  let compressedRead = 0;
  const hashed = new Transform({
    transform(chunk, encoding, callback) {
      compressedRead += chunk.length;
      if (compressedRead > archiveLimits.totalBytes)
        return callback(new Error('Compressed seed exceeds bound.'));
      digest.update(chunk);
      callback(null, chunk);
    },
  });
  const pumping = pipeline(source, hashed, gunzip, bound, { signal });
  // Observe immediately so an early SQL/manifest failure never leaves an unhandled rejection.
  void pumping.catch(() => {});
  const reader = new Bytes(bound),
    seen = new Set<string>();
  try {
    for (;;) {
      signal.throwIfAborted();
      const h = await reader.take(512);
      if (h.every((v) => v === 0)) {
        if (!(await reader.take(512)).every((v) => v === 0))
          throw new Error('Malformed archive terminator.');
        // Our canonical format has exactly two terminator blocks, never a second archive.
        if ((await reader.take(1, true)).length) throw new Error('Trailing seed archive data.');
        break;
      }
      const checksum = readOctal(h.subarray(148, 156));
      const copy = Buffer.from(h);
      copy.fill(32, 148, 156);
      if (
        copy.reduce((n, b) => n + b, 0) !== checksum ||
        h.toString('ascii', 257, 263) !== 'ustar\0' ||
        h.toString('ascii', 263, 265) !== '00' ||
        h[156] !== 48 ||
        h.subarray(157, 257).some((v) => v !== 0) ||
        h.subarray(345, 500).some((v) => v !== 0)
      )
        throw new Error('Unsupported/corrupt seed tar header.');
      const nameField = h.subarray(0, 100),
        end = nameField.indexOf(0);
      if (end < 1 || nameField.subarray(end).some((v) => v !== 0))
        throw new Error('Invalid seed member name encoding.');
      const name = nameField.subarray(0, end).toString('ascii');
      if (!allowed.includes(name) || seen.has(name) || (seen.size === 0 && name !== firstMember))
        throw new Error('Unknown, duplicate or misordered seed member.');
      seen.add(name);
      const size = readOctal(h.subarray(124, 136));
      if (size > (name === firstMember ? archiveLimits.manifestBytes : archiveLimits.memberBytes))
        throw new Error('Seed member exceeds bound.');
      let left = size;
      async function* content() {
        while (left) {
          signal.throwIfAborted();
          const chunk = await reader.take(Math.min(left, 65536));
          left -= chunk.length;
          yield chunk;
        }
      }
      await visit(name, size, content());
      if (left) throw new Error('Seed member not consumed.');
      const padding = (512 - (size % 512)) % 512;
      if ((await reader.take(padding)).some((v) => v !== 0))
        throw new Error('Invalid tar padding.');
    }
    if (seen.size !== allowed.length) throw new Error('Missing seed members.');
    await pumping;
    return { sha256: digest.digest('hex'), bytes: compressedRead };
  } catch (error) {
    source.destroy();
    hashed.destroy();
    gunzip.destroy();
    bound.destroy();
    await pumping.catch(() => {});
    throw error;
  }
}
export async function* lines(chunks: AsyncIterable<Buffer>) {
  let pending = Buffer.alloc(0);
  for await (const chunk of chunks) {
    pending = Buffer.concat([pending, chunk]);
    let index: number;
    while ((index = pending.indexOf(10)) !== -1) {
      if (index === 0 || index > archiveLimits.rowBytes)
        throw new Error('Invalid/overlarge seed row.');
      yield new TextDecoder('utf-8', { fatal: true }).decode(pending.subarray(0, index));
      pending = pending.subarray(index + 1);
    }
    if (pending.length > archiveLimits.rowBytes) throw new Error('Seed row exceeds bound.');
  }
  if (pending.length) throw new Error('Unterminated seed row.');
}
