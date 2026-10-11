import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
const root = new URL('../delivery/samples/', import.meta.url);
const output = new URL('../dist/api/samples/', import.meta.url);
const manifest = await readFile(new URL('MANIFEST.json', root));
if (manifest.length > 16384) throw Error('SAMPLE_BOUND');
const parsed = JSON.parse(manifest);
const files = new Map([['MANIFEST.json', manifest]]);
for (const name of ['daily', 'stakes', 'holders', 'maturities', 'markets']) {
  const bytes = await readFile(new URL(`${name}.csv`, root));
  if (
    bytes.length > 16384 ||
    parsed.files[name].bytes !== bytes.length ||
    parsed.files[name].sha256 !== createHash('sha256').update(bytes).digest('hex')
  )
    throw Error('SAMPLE_INTEGRITY');
  files.set(`${name}.csv`, bytes);
}
await mkdir(output, { recursive: true });
for (const [name, bytes] of files) await writeFile(new URL(name, output), bytes);
console.log('Five fixed synthetic samples verified and copied.');
