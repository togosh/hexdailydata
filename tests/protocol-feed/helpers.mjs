import { readFile, mkdir, mkdtemp, writeFile, readdir, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { restoreStorage, createMarketStorage } from '../../dist/services/product-daily/storage.js';
import { ProductDailyStore } from '../../dist/services/product-daily/store.js';
export const root = process.env.HDD_TASK_ROOT;
if (!root?.endsWith('hex-protocol-daily-refresh-r1')) throw Error('PROTOCOL_TASK_ROOT');
export const hash = (b) => createHash('sha256').update(b).digest('hex');
export const inputs = JSON.parse(await readFile(join(root, 'INPUTS.json')));
export const metadata = JSON.parse(await readFile(join(root, 'seed/metadata.json')));
export const realRows = (await readFile(join(root, 'seed/daily.ndjson'), 'utf8'))
  .trim()
  .split('\n')
  .map(JSON.parse);
export const exceptions = (await readFile(join(root, 'seed/exceptions.ndjson'), 'utf8'))
  .trim()
  .split('\n')
  .map(JSON.parse);
const candidates = await Promise.all(
  (await readdir(join(root, 'evidence')))
    .filter((n) => n.startsWith('SYNTHETIC_PROTOCOL_') && n.endsWith('.json'))
    .map(async (n) => ({ n, time: (await stat(join(root, 'evidence', n))).mtimeMs })),
);
export const syntheticProtocol = candidates.length
  ? JSON.parse(
      await readFile(join(root, 'evidence', candidates.sort((a, b) => b.time - a.time)[0].n)),
    )
  : null;
await mkdir(join(root, 'scratch'), { recursive: true });
export async function fresh(label, seed) {
  const parent = await mkdtemp(join(root, 'scratch', label + '-')),
    dest = join(parent, 'store');
  if (seed) return createMarketStorage(dest, seed);
  const backup = join(root, 'accepted-public/real-backup');
  await restoreStorage(backup, dest, hash(await readFile(join(backup, 'BACKUP.json'))));
  const store = new ProductDailyStore(dest, metadata.pair);
  await store.load();
  return store;
}
export async function receipt(name, value) {
  await writeFile(join(root, 'evidence', name + '.json'), JSON.stringify(value, null, 2) + '\n', {
    flag: 'wx',
  });
}
