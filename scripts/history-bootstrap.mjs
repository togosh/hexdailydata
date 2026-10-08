// Explicit offline internal bootstrap. Does not start an app, SQL, provider or scheduler.
import { fileURLToPath } from 'node:url';
import { resolve, dirname, join } from 'node:path';
import { readFile } from 'node:fs/promises';
import { hash } from '../dist/history-bootstrap/normalize.js';
import {
  boundedRead,
  makePackage,
  publishPackage,
  validatePackage,
} from '../dist/history-bootstrap/package.js';
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2),
  command = args.shift(),
  options = {};
while (args.length) {
  const key = args.shift(),
    value = args.shift();
  if (!key?.startsWith('--') || !value || Object.hasOwn(options, key)) throw Error('ARGUMENTS');
  options[key] = value;
}
if (command === 'verify') {
  if (Object.keys(options).sort().join(',') !== '--directory,--manifest')
    throw Error('verify --directory PATH --manifest SHA256');
  const result = await validatePackage(resolve(options['--directory']), options['--manifest']);
  console.log(
    JSON.stringify({
      status: 'VERIFIED',
      manifestSha256: result.manifestSha256,
      counts: result.counts,
    }),
  );
} else if (command === 'build') {
  if (
    Object.keys(options).sort().join(',') !== '--ethereum,--ledger,--name,--pulse' ||
    !/^[a-z0-9-]{1,60}$/.test(options['--name'])
  )
    throw Error('build --pulse PATH --ethereum PATH --ledger PATH --name NEW_NAME');
  const source = [
    'src/history-bootstrap/normalize.ts',
    'src/history-bootstrap/package.ts',
    'scripts/history-bootstrap.mjs',
  ];
  const revision = hash(
    Buffer.concat(await Promise.all(source.map((p) => readFile(join(root, p))))),
  );
  const product = makePackage(
    await boundedRead(resolve(options['--pulse'])),
    await boundedRead(resolve(options['--ethereum'])),
    await boundedRead(resolve(options['--ledger'])),
    await boundedRead(join(root, 'config/history-bootstrap.mapping.json')),
    revision,
  );
  const owned = join(root, 'artifacts/history-bootstrap');
  console.log(
    JSON.stringify({
      status: 'INTERNAL_ONLY',
      ...(await publishPackage(join(owned, options['--name']), owned, product)),
      counts: product.manifest.counts,
    }),
  );
} else
  throw Error('Use explicit build or verify. No acquisition or API activation command exists.');
