// Explicit one-shot offline build/publication. No providers, SQL or automatic server startup.
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { validatePackage } from '../dist/history-bootstrap/package.js';
import { hash } from '../dist/history-bootstrap/normalize.js';
import { projectDaily, productFiles } from '../dist/services/product-daily/project.js';
import {
  writeProductGeneration,
  ProductDailyStore,
  admitProduct,
} from '../dist/services/product-daily/store.js';
import { readProductProfile } from '../dist/services/product-daily/open.js';

const [command, ...args] = process.argv.slice(2);
const values = {};
for (let i = 0; i < args.length; i += 2) {
  if (!args[i]?.startsWith('--') || !args[i + 1] || Object.hasOwn(values, args[i]))
    throw Error('INVALID_ARGUMENTS');
  values[args[i]] = args[i + 1];
}
const allowed = {
  build: ['--profile'],
  select: ['--profile', '--version', '--manifest'],
  rollback: ['--profile', '--version', '--manifest'],
  verify: ['--directory', '--manifest'],
};
if (
  !allowed[command] ||
  JSON.stringify(Object.keys(values).sort()) !== JSON.stringify([...allowed[command]].sort())
)
  throw Error('INVALID_COMMAND');
if (command === 'verify') {
  const p = await admitProduct(values['--directory'], values['--manifest']);
  console.log(JSON.stringify({ status: 'VERIFIED', version: p.version, rows: p.rows.length }));
} else {
  const p = await readProductProfile(values['--profile']);
  if (command === 'build') {
    const history = await validatePackage(p.history, p.historyManifestSha256);
    const ledger = await readFile(p.ledger);
    if (hash(ledger) !== p.ledgerSha256) throw Error('LEDGER_DIGEST');
    const mapping = JSON.parse(await readFile(join(p.history, 'FIELD_MAPPING.json'), 'utf8'));
    const exceptionBytes = await readFile(join(p.history, 'EXCEPTIONS.ndjson'));
    if (exceptionBytes.length > 16 * 1024 * 1024) throw Error('EXCEPTION_BOUND');
    const exceptions = exceptionBytes
      .toString()
      .trimEnd()
      .split('\n')
      .filter(Boolean)
      .map(JSON.parse);
    const product = productFiles(
      projectDaily({
        daily: history.daily,
        prices: history.prices,
        exceptions,
        ledger: JSON.parse(ledger),
        pair: p.pair,
        inputHashes: { historyManifest: p.historyManifestSha256, ledger: p.ledgerSha256 },
        credits: mapping.credits,
      }),
    );
    const result = await writeProductGeneration(p.productRoot, product);
    console.log(
      JSON.stringify({
        status: 'BUILT_UNSELECTED',
        version: result.version,
        manifestSha256: result.manifestSha256,
        rows: result.rows.length,
        coverage: result.metadata.coverage,
      }),
    );
  } else {
    const store = new ProductDailyStore(p.productRoot, p.pair);
    console.log(
      JSON.stringify(
        await store.select(
          { version: values['--version'], manifestSha256: values['--manifest'] },
          { rollback: command === 'rollback' },
        ),
      ),
    );
  }
}
