// Remaining offline path, deliberately no participant-base admission or live authority.
import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { ProductDailyStore } from '../../dist/services/product-daily/store.js';
import { composed } from './composed.mjs';
const R = process.env.HDD_TASK_ROOT;
assert(R?.endsWith('btc-eth-current-reference-freshness-r2'));
const inputs = JSON.parse(await readFile(join(R, 'packet/INPUTS.json')));
const productDaily = new ProductDailyStore(
  join(R, 'runtime/product'),
  inputs.acceptedSeedProfile.pair,
);
await productDaily.load();
assert.equal(
  productDaily.capture().version,
  inputs.preserveAcceptedInputsAndExistingCells.closeProduct,
);
const save = (n, v) =>
  writeFile(join(R, 'evidence', n + '.json'), JSON.stringify(v, null, 2) + '\n');
try {
  await composed({
    R,
    real: { root: join(R, 'runtime/participants'), productDaily },
    base: null,
    save,
  });
  console.log('PASS offline product coordinator; genuine paired preflight remains BLOCKED');
} catch (e) {
  await save('PRODUCT_ONLY_FAILURE_' + Date.now(), { error: String(e), stack: e.stack });
  throw e;
}
