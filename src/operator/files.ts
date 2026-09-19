import { access, lstat, open, realpath, statfs, writeFile, rename } from 'node:fs/promises';
import { constants } from 'node:fs';
import { resolve, parse, join } from 'node:path';

export const maxBackupBytes = 8 * 1024 ** 3;
/** Reject links in every existing component, including ancestors of an owned mount. */
export async function safePath(path: string, directory = true) {
  if (!path || !path.startsWith('/') || path !== resolve(path))
    throw new Error('Explicit normalized Linux path required.');
  let cursor = parse(path).root;
  for (const part of path.slice(cursor.length).split('/').filter(Boolean)) {
    cursor = join(cursor, part);
    if ((await lstat(cursor)).isSymbolicLink()) throw new Error('Symlink path refused.');
  }
  const info = await lstat(path);
  if (directory ? !info.isDirectory() : !info.isFile()) throw new Error('Wrong path type.');
  if ((await realpath(path)) !== path) throw new Error('Indirect path refused.');
  return info;
}
export async function reserve(path: string, workingBytes = 0) {
  await safePath(path);
  const disk = await statfs(path, { bigint: true });
  const free = disk.bavail * disk.bsize,
    total = disk.blocks * disk.bsize;
  const needed = BigInt(Math.ceil(workingBytes));
  if (free - needed < 8n * 1024n ** 3n || (free - needed) * 5n < total)
    throw new Error('Heavy work paused: working space plus 8GiB AND 20% reserve required.');
  return { freeBytes: free.toString(), totalBytes: total.toString(), workingBytes };
}
export async function writable(path: string) {
  await safePath(path);
  await access(path, constants.R_OK | constants.W_OK | constants.X_OK);
}
export async function syncPath(path: string) {
  const file = await open(path, 'r');
  try {
    await file.sync();
  } finally {
    await file.close();
  }
}
export async function atomicJson(root: string, name: string, value: unknown) {
  await safePath(root);
  if (!/^[a-z-]+\.json$/.test(name)) throw new Error('Invalid metadata name.');
  const temporary = join(root, name + '.tmp');
  try {
    await safePath(temporary, false);
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e;
  }
  await writeFile(temporary, JSON.stringify(value) + '\n', { mode: 0o600, flush: true });
  await rename(temporary, join(root, name));
  await syncPath(root);
}
