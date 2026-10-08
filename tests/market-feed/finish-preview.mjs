// Finish the one admitted preview before its original deadline. No census readers reopen.
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { ProductDailyStore } from '../../dist/services/product-daily/store.js';
import { preview } from './preview.mjs';
import { root } from './access-fixture.mjs';
const p = JSON.parse(await readFile(join(root, 'PRODUCT_PROFILE.json')));
const productDaily = new ProductDailyStore(p.productRoot, p.pair);
await productDaily.load();
await preview({ productDaily }, true, Number(process.argv[2] ?? '2'));
