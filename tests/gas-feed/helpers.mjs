import { readFile, mkdir, mkdtemp, writeFile, readdir, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { createMarketStorage } from '../../dist/services/product-daily/storage.js';
import { productFiles } from '../../dist/services/product-daily/project.js';
export const root = process.env.HDD_TASK_ROOT;
if (!root?.endsWith('pulsechain-gas-feed-r1')) throw Error('GAS_TASK_ROOT');
export const hash = (b) => createHash('sha256').update(b).digest('hex');
export const inputs = JSON.parse(await readFile(join(root, 'INPUTS.json')));
export const files = {
  version: inputs.realSeed.datasetVersion,
  manifestSha256: inputs.realSeed.manifestSha256,
  files: {},
};
for (const n of [
  'MANIFEST.json',
  'daily.ndjson',
  'daily.csv',
  'metadata.json',
  'exceptions.ndjson',
])
  files.files[n] = await readFile(join(root, 'seed', n));
export const metadata = JSON.parse(files.files['metadata.json']);
export const realRows = files.files['daily.ndjson'].toString().trim().split('\n').map(JSON.parse);
export const exceptions = files.files['exceptions.ndjson']
  .toString()
  .trim()
  .split('\n')
  .map(JSON.parse);
const candidates = await Promise.all(
  (await readdir(join(root, 'evidence')))
    .filter((n) => n.startsWith('SYNTHETIC_GAS_gas-') && n.endsWith('.json'))
    .map(async (n) => ({ n, time: (await stat(join(root, 'evidence', n))).mtimeMs })),
);
export const syntheticGas = candidates.length
  ? JSON.parse(
      await readFile(join(root, 'evidence', candidates.sort((a, b) => b.time - a.time)[0].n)),
    )
  : null;
await mkdir(join(root, 'scratch'), { recursive: true });
export async function fresh(label, seed = files) {
  const parent = await mkdtemp(join(root, 'scratch', label + '-'));
  return createMarketStorage(join(parent, 'store'), seed);
}
export function smallSeed() {
  const rows = [realRows.at(-1)];
  return productFiles({
    rows,
    metadata: {
      ...metadata,
      from: rows[0].dateUtc,
      through: rows[0].dateUtc,
      rows: 1,
      liquidityHistory: [],
    },
    exceptions: [],
  });
}
export async function receipt(name, value) {
  await writeFile(join(root, 'evidence', name + '.json'), JSON.stringify(value, null, 2) + '\n', {
    flag: 'wx',
  });
}
export function profile(store, parent) {
  return {
    productRoot: store.root,
    history: join(parent, 'UNOPENED-history-reference'),
    historyManifestSha256: 'a'.repeat(64),
    ledger: join(parent, 'UNOPENED-ledger-reference'),
    ledgerSha256: 'b'.repeat(64),
    holdersRoot: join(parent, 'UNOPENED-holders-reference'),
    stakesRoot: join(parent, 'UNOPENED-stakes-reference'),
    overlayRoot: join(parent, 'UNOPENED-overlay-reference'),
    pair: store.capture().metadata.pair,
  };
}
