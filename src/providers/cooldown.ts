import { readFile, writeFile, rename, mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import type { CooldownStore } from './budget.ts';

/** One file per role avoids cross-process lost-update races; readers take the max.
 * Keep this small directory across restarts. The entry point must own its process-role
 * database session lock; a crashed process releases that lock without stale lock files.
 */
export async function cooldownFiles(
  directory: string,
  role: 'api' | 'worker',
): Promise<CooldownStore & { close(): Promise<void> }> {
  await mkdir(directory, { recursive: true });
  const path = join(directory, role + '.json');
  async function readOne(name: string) {
    try {
      const text = await readFile(join(directory, name + '.json'), 'utf8');
      if (text.length > 100 || !/^\d+$/.test(text))
        throw new Error('Malformed persisted cooldown.');
      const value = Number(text);
      if (!Number.isSafeInteger(value)) throw new Error('Invalid persisted cooldown.');
      return value;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return 0;
      throw error;
    }
  }
  return {
    async read() {
      return Math.max(await readOne('api'), await readOne('worker'));
    },
    async extend(until) {
      if (!Number.isSafeInteger(until) || until < 0) throw new Error('Invalid cooldown deadline.');
      const next = Math.max(until, await readOne(role));
      await writeFile(path + '.tmp', String(next), { mode: 0o600, flush: true });
      await rename(path + '.tmp', path);
    },
    async close() {},
  };
}
