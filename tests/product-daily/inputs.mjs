import assert from 'node:assert/strict';
import { readFile, mkdir, writeFile } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { readProductProfile } from '../../dist/services/product-daily/open.js';
import { validatePackage } from '../../dist/history-bootstrap/package.js';
import { hash } from '../../dist/history-bootstrap/normalize.js';
export const root = resolve(process.env.HDD_TASK_ROOT ?? '');
assert(root.endsWith('unified-daily-live-r1'), 'Explicit task root required');
export const profile = await readProductProfile(join(root, 'PRODUCT_PROFILE.json'));
export const json = async (path) => JSON.parse(await readFile(path, 'utf8'));
const history = await validatePackage(profile.history, profile.historyManifestSha256);
const ledgerBytes = await readFile(profile.ledger);
assert.equal(hash(ledgerBytes), profile.ledgerSha256);
const mapping = await json(join(profile.history, 'FIELD_MAPPING.json'));
export const input = {
  daily: history.daily,
  prices: history.prices,
  exceptions: (await readFile(join(profile.history, 'EXCEPTIONS.ndjson'), 'utf8'))
    .trim()
    .split('\n')
    .map((line) => JSON.parse(line)),
  ledger: JSON.parse(ledgerBytes),
  pair: profile.pair,
  inputHashes: { historyManifest: profile.historyManifestSha256, ledger: profile.ledgerSha256 },
  credits: mapping.credits,
};
export const pointer = await json(join(profile.productRoot, 'CURRENT.json'));
export async function receipt(name, value) {
  await mkdir(join(root, 'evidence'), { recursive: true });
  await writeFile(join(root, 'evidence', name), JSON.stringify(value, null, 2) + '\n', {
    flag: 'wx',
  });
}
