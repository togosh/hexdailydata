// Task-local aggregate reservation; never traverses referenced immutable bases.
import { readdir, lstat, realpath, statfs } from 'node:fs/promises';
import { join, resolve } from 'node:path';
export async function participantTaskCapacity(root, reservation) {
  root = resolve(root);
  if ((await realpath(root)) !== root) throw Error('TASK_ROOT_ALIAS');
  let bytes = 0,
    entries = 0;
  const pending = [root];
  while (pending.length) {
    const dir = pending.pop();
    for (const item of await readdir(dir, { withFileTypes: true })) {
      if (++entries > 120000 || item.isSymbolicLink()) throw Error('TASK_STORAGE_ENTRIES_OR_ALIAS');
      const path = join(dir, item.name);
      if (item.isDirectory()) pending.push(path);
      else if (item.isFile()) bytes += (await lstat(path)).size;
      else throw Error('TASK_STORAGE_FILE');
    }
  }
  if (bytes + reservation > 8 * 1024 ** 3) throw Error('TASK_8GIB_STAGING_RESERVATION');
  const disk = await statfs(root);
  if (disk.bavail * disk.bsize - reservation < 10 * 1024 ** 3) throw Error('PROTECTED_FREE_SPACE');
  return { bytes, entries, reservation, maximum: 8 * 1024 ** 3, protectedFree: 10 * 1024 ** 3 };
}
