import { lstat, realpath, readdir } from 'node:fs/promises';
import { resolve, relative, sep, join, isAbsolute } from 'node:path';
import { ApiFailure } from './errors.ts';

const contains = (parent: string, child: string) => {
  const p = relative(parent, child);
  return p === '' || (p !== '..' && !p.startsWith('..' + sep) && !isAbsolute(p));
};
async function ordinary(path: string, directory = false) {
  const s = await lstat(path);
  if (s.isSymbolicLink() || (directory ? !s.isDirectory() : !s.isFile() || s.nlink !== 1))
    throw Error('Unsafe static member.');
}
export async function validateStaticRoots(roots: string[], exportPath?: string) {
  const exports = exportPath ? await realpath(exportPath) : undefined;
  if (exportPath && exports !== resolve(exportPath)) throw Error('Export root alias.');
  for (const root of roots) {
    await ordinary(root, true);
    const canonical = await realpath(root);
    if (canonical !== resolve(root) || (exports && (contains(canonical, exports) || contains(exports, canonical))))
      throw Error('Static/export roots overlap or alias.');
    let count = 0;
    const walk = async (dir: string): Promise<void> => {
      for (const item of await readdir(dir, { withFileTypes: true })) {
        if (++count > 10000) throw Error('Static inventory exceeds bound.');
        const path = join(dir, item.name);
        await ordinary(path, item.isDirectory());
        if (item.isDirectory()) await walk(path);
        else if (/\.csv$/i.test(item.name) || item.name === '.hdd-exports') throw Error('CSV belongs outside static roots.');
      }
    };
    await walk(root);
  }
}

// Recheck requested paths too: a post-start symlink/hardlink is not a static alias.
export async function checkStaticPath(root: string, rawPath: string) {
  let path: string;
  try { path = decodeURIComponent(rawPath); } catch { throw new ApiFailure(400, 'invalid_request', 'Invalid path.'); }
  if (path.includes('\\') || path.includes('\0') || /\.csv(?:\/|$)/i.test(path))
    throw new ApiFailure(404, 'not_found', 'Route not found.');
  const target = resolve(root, '.' + path);
  if (!contains(resolve(root), target)) throw new ApiFailure(404, 'not_found', 'Route not found.');
  let current = resolve(root);
  for (const name of relative(current, target).split(sep).filter(Boolean)) {
    current = join(current, name);
    try {
      const s = await lstat(current);
      if (s.isSymbolicLink() || (!s.isDirectory() && (!s.isFile() || s.nlink !== 1)))
        throw new ApiFailure(404, 'not_found', 'Route not found.');
    } catch (e) { if ((e as NodeJS.ErrnoException).code === 'ENOENT') return; throw e; }
  }
}
