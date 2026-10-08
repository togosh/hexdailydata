import { writeFile } from 'node:fs/promises';
import { profile, pointer } from './inputs.mjs';
import { ProductDailyStore } from '../../dist/services/product-daily/store.js';
import {
  ProductQuery,
  ProductDailyResponseSchema,
  ProductLiveResponseSchema,
  ProductHomeResponseSchema,
} from '../../dist/contracts/product-daily.js';
import { PageCursors } from '../../dist/services/queries/cursor.js';
const store = new ProductDailyStore(profile.productRoot, profile.pair),
  s = await store.load(),
  now = Date.now();
const daily = ProductDailyResponseSchema.parse(
  store.read(
    s,
    ProductQuery.parse({ from: '2020-01-01', to: '2020-01-31' }),
    'daily',
    new PageCursors(),
    now,
    'public',
  ),
);
const examples = {
  daily: { recorded: daily },
  markets: { recorded: daily },
  home: { recorded: ProductHomeResponseSchema.parse(store.home(s, now)) },
  latest: { recorded: ProductLiveResponseSchema.parse(store.live(s, now)) },
  downloads: { recorded: store.catalog(s) },
};
await writeFile(
  'src/documentation/product-examples.json',
  JSON.stringify(examples, null, 2) + '\n',
  { flag: 'wx' },
);
console.log(
  JSON.stringify({
    datasetVersion: pointer.version,
    examples: Object.keys(examples),
    rows: daily.items.length,
  }),
);
