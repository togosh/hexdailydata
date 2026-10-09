import { readFile, mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import {
  createMarketStorage,
  publishStoredMarket,
} from '../../dist/services/product-daily/storage.js';
import { productFiles } from '../../dist/services/product-daily/project.js';
export const root = process.env.HDD_TASK_ROOT;
if (!root || !root.endsWith('market-storage-recovery-r1')) throw Error('TASK_ROOT_REQUIRED');
export const hash = (b) => createHash('sha256').update(b).digest('hex');
export const inputs = JSON.parse(await readFile(join(root, 'INPUTS.json')));
export const files = {
  version: inputs.bundledSeed.datasetVersion,
  manifestSha256: inputs.bundledSeed.manifestSha256,
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
export const pair = metadata.pair;
export const exceptions = files.files['exceptions.ndjson']
  .toString()
  .trim()
  .split('\n')
  .map(JSON.parse);
export const realRows = files.files['daily.ndjson'].toString().trim().split('\n').map(JSON.parse);
await mkdir(join(root, 'scratch'), { recursive: true });
await mkdir(join(root, 'evidence'), { recursive: true });
export async function fresh(label, seed = files) {
  const parent = await mkdtemp(join(root, 'scratch/', label + '-'));
  return createMarketStorage(join(parent, 'store'), seed);
}
export function update(i, base = metadata, interval = 60000) {
  const at = new Date(Date.parse('2026-10-09T23:00:00Z') + i * interval).toISOString();
  const readings = structuredClone(base.readings).sort(
    (a, b) => (a.kind === 'market' ? -1 : 1) - (b.kind === 'market' ? -1 : 1),
  );
  for (const r of readings) {
    r.observedAtUtc = at;
    if (r.kind === 'market') r.value = '0.00' + String(100000 + i);
    else {
      for (let n = 0; n < r.set.pools.length; n++) r.set.pools[n].valueUsd = String(10000 + i + n);
      r.value = String(r.set.pools.reduce((n, p) => n + BigInt(p.valueUsd), 0n));
    }
  }
  return {
    readings,
    liquidityHistory: [],
    receiptSha256: hash('synthetic:' + i + ':' + interval),
    methodRevision: 'pulsex-four-pool-derived-usd-2',
  };
}
export async function publish(store, u, fault = () => {}) {
  const lease = await store.acquireWriter();
  try {
    return await publishStoredMarket(store, lease, u, () => {}, fault);
  } finally {
    await store.releaseWriter(lease).catch((e) => {
      if (!String(e).includes('UNCERTAIN')) throw e;
    });
  }
}
export async function receipt(name, value) {
  await writeFile(join(root, 'evidence', name + '.json'), JSON.stringify(value, null, 2) + '\n', {
    flag: 'wx',
  });
}
export function smallSeed() {
  const rows = [structuredClone(realRows.at(-1))];
  const m = {
    ...structuredClone(metadata),
    from: rows[0].dateUtc,
    through: rows[0].dateUtc,
    rows: 1,
    liquidityHistory: [],
  };
  return productFiles({ rows, metadata: m, exceptions: [] });
}
