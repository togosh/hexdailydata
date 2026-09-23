import { open, lstat, type FileHandle } from 'node:fs/promises';
import { constants } from 'node:fs';
import { spawn } from 'node:child_process';
import { join } from 'node:path';
import { safePath } from './files.ts';

/** Linux flock belongs to the shared open file description, so the parent keeps
 * it after the short flock child exits. Never unlink the persistent lock inode. */
export async function maintenanceLease(roots: string[], signal: AbortSignal) {
  const files: FileHandle[] = [];
  async function release() {
    for (const file of files.splice(0).reverse()) await file.close();
  }
  try {
    for (const root of roots) {
      signal.throwIfAborted();
      await safePath(root);
      const file = await open(
        join(root, '.maintenance.lock'),
        constants.O_CREAT | constants.O_RDWR | constants.O_NOFOLLOW,
        0o600,
      );
      files.push(file);
      const info = await file.stat();
      if (!info.isFile() || info.nlink !== 1) throw new Error('Invalid maintenance lock file.');
      const child = spawn('flock', ['--exclusive', '--nonblock', '3'], {
        stdio: ['ignore', 'ignore', 'ignore', file.fd],
        signal,
        killSignal: 'SIGKILL',
      });
      await new Promise<void>((resolve, reject) => {
        child.once('error', () => reject(new Error('Maintenance filesystem lock unavailable.')));
        child.once('close', (code) =>
          code === 0
            ? resolve()
            : reject(new Error('Maintenance filesystem already active or unavailable.')),
        );
      });
      signal.throwIfAborted();
    }
    return Object.assign(release, {
      check: async () => {
        for (let i = 0; i < files.length; i++) {
          const held = await files[i]!.stat(),
            path = await lstat(join(roots[i]!, '.maintenance.lock'));
          if (
            !path.isFile() ||
            path.isSymbolicLink() ||
            path.ino !== held.ino ||
            path.dev !== held.dev ||
            held.nlink !== 1
          )
            throw Error('Maintenance filesystem ownership lost.');
        }
      },
    });
  } catch (error) {
    await release().catch(() => {});
    throw error;
  }
}
