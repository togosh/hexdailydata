import { constants } from 'node:fs';
import {
  open,
  lstat,
  realpath,
  readdir,
  unlink,
  rmdir,
  statfs,
  type FileHandle,
} from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { createHash } from 'node:crypto';
import { datasets, type Dataset } from './datasets.ts';
export const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
export const maxBundleBytes = 4 * 1024 * 1024 * 1024;
export const readerGraceMs = 60000,
  readerTimeoutMs = 120000,
  maxReaders = 32,
  jobTimeoutMs = 30 * 60 * 1000;
const members = new Set([...datasets.map((d) => d + '.csv'), 'manifest.json']);
export async function directory(path: string) {
  const s = await lstat(path);
  const normalized = (p: string) =>
    process.platform === 'win32' ? resolve(p).toLowerCase() : resolve(p);
  if (
    !s.isDirectory() ||
    s.isSymbolicLink() ||
    normalized(await realpath(path)) !== normalized(path)
  )
    throw new Error('Export directory is not an owned ordinary directory.');
}
export async function exportRoot(path: string, allowCreate = true) {
  const root = resolve(path);
  await directory(root);
  const marker = join(root, '.hdd-exports');
  try {
    const info = await lstat(marker);
    if (!info.isFile() || info.isSymbolicLink() || info.nlink !== 1 || info.size !== 24)
      throw new Error('Invalid export root marker.');
    const h = await open(marker, constants.O_RDONLY | constants.O_NOFOLLOW);
    try {
      if ((await h.readFile('utf8')) !== 'HEXDailyData exports v1\n')
        throw new Error('Wrong export root.');
    } finally {
      await h.close();
    }
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e;
    if (!allowCreate) throw e;
    if ((await readdir(root)).length) throw new Error('New export root must be empty.');
    const h = await open(marker, 'wx', 0o600);
    try {
      await h.writeFile('HEXDailyData exports v1\n');
      await h.sync();
    } finally {
      await h.close();
    }
    await syncDirectory(root);
  }
  return root;
}
export async function reserve(root: string) {
  const s = await statfs(root, { bigint: true }),
    free = s.bavail * s.bsize,
    total = s.blocks * s.bsize;
  if (free < 8n * 1024n ** 3n || free * 5n < total)
    throw new Error('Export disk reserve requires 8 GiB AND 20% free.');
  return { free: free.toString(), total: total.toString() };
}
export async function syncDirectory(path: string) {
  // Fail closed on platforms/filesystems which cannot acknowledge directory durability.
  const h = await open(path, constants.O_RDONLY);
  try {
    await h.sync();
  } finally {
    await h.close();
  }
}
export function fingerprint(s: Awaited<ReturnType<FileHandle['stat']>>) {
  return [s.dev, s.ino, s.size, s.mtimeMs, s.ctimeMs].join(':');
}
export async function member(root: string, id: string, name: Dataset | 'manifest') {
  if (!uuid.test(id)) throw new Error('Invalid immutable bundle identity.');
  await directory(root);
  const path = join(root, id);
  await directory(path);
  const file = join(path, name === 'manifest' ? 'manifest.json' : name + '.csv');
  const before = await lstat(file);
  if (!before.isFile() || before.isSymbolicLink() || before.nlink !== 1)
    throw new Error('Export member is not a private ordinary file.');
  const h = await open(file, constants.O_RDONLY | constants.O_NOFOLLOW);
  if (fingerprint(await h.stat()) !== fingerprint(before)) {
    await h.close();
    throw new Error('Export file replaced during open.');
  }
  return h;
}
export async function digestHandle(h: FileHandle, signal: AbortSignal) {
  signal.throwIfAborted();
  const sha = createHash('sha256');
  let bytes = 0;
  const stream = h.createReadStream({ autoClose: false, start: 0, signal });
  // Abort errors may arrive after iterator teardown; never leave an unhandled stream error.
  stream.on('error', () => {});
  for await (const b of stream) {
    signal.throwIfAborted();
    bytes += b.length;
    if (bytes > maxBundleBytes) throw new Error('Bundle member exceeds bound.');
    sha.update(b);
  }
  return { sha256: sha.digest('hex'), bytes: String(bytes) };
}
/** Nonrecursive removal: only enumerated standard files inside checked UUID/work directories. */
export async function removeBundle(root: string, id: string) {
  if (!uuid.test(id) && !/^\.work-[0-9a-f-]{36}$/.test(id))
    throw new Error('Unowned cleanup identity.');
  await directory(root);
  const path = join(root, id);
  try {
    await directory(path);
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') return;
    throw e;
  }
  const names = await readdir(path);
  if (names.some((n) => !members.has(n))) throw new Error('Unexpected file blocks export cleanup.');
  for (const name of names) {
    const p = join(path, name),
      s = await lstat(p);
    if (!s.isFile() || s.isSymbolicLink() || s.nlink !== 1)
      throw new Error('Unsafe cleanup member.');
  }
  for (const name of names) await unlink(join(path, name));
  await rmdir(path);
  await syncDirectory(root);
}
