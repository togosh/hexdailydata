// Create-once file collection only; never invokes reconstruction or changes accounting.
import assert from 'node:assert/strict';
import { createReadStream, constants } from 'node:fs';
import { mkdir, copyFile, readFile, writeFile, lstat, open, readdir } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { resolve, join } from 'node:path';
import { fileURLToPath } from 'node:url';

export async function identity(path) {
  const stat = await lstat(path);
  assert(stat.isFile() && !stat.isSymbolicLink(), 'Regular source required');
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(path)) hash.update(chunk);
  return { bytes: stat.size, sha256: hash.digest('hex') };
}
export async function seal(destination, sources, binding = {}) {
  await mkdir(destination); // Existing or partial destinations refuse without replacement.
  const files = {};
  for (const [name, source] of Object.entries(sources)) {
    assert(/^[a-z0-9-]+\.(json|jsonl|log)$/.test(name));
    const before = await identity(source),
      target = join(destination, name);
    await copyFile(source, target, constants.COPYFILE_EXCL);
    const fd = await open(target, 'r+');
    try {
      await fd.sync();
    } finally {
      await fd.close();
    }
    assert.deepEqual(await identity(target), before);
    assert.deepEqual(await identity(source), before, 'Source changed during collection');
    files[name] = before;
  }
  const manifest = { binding, files };
  await writeFile(join(destination, 'manifest.json'), JSON.stringify(manifest, null, 2) + '\n', {
    flag: 'wx',
    flush: true,
  });
  return manifest;
}
export async function verify(destination, expectedFiles) {
  const manifest = JSON.parse(await readFile(join(destination, 'manifest.json'), 'utf8'));
  assert(manifest.files && Object.keys(manifest.files).length > 0, 'Empty/missing seal inventory');
  if (expectedFiles)
    assert.deepEqual(
      Object.keys(manifest.files).sort(),
      [...expectedFiles].sort(),
      'Incomplete seal inventory',
    );
  assert.deepEqual(
    (await readdir(destination)).sort(),
    [...Object.keys(manifest.files), 'manifest.json'].sort(),
    'Seal membership changed',
  );
  for (const [name, expected] of Object.entries(manifest.files)) {
    assert(/^[a-z0-9-]+\.(json|jsonl|log)$/.test(name));
    assert.deepEqual(await identity(join(destination, name)), expected);
  }
  return manifest;
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const [command, destination, mapping] = process.argv.slice(2);
  if (command === 'verify') console.log(JSON.stringify(await verify(destination)));
  else if (command === 'seal') {
    const input = JSON.parse(await readFile(mapping, 'utf8'));
    console.log(JSON.stringify(await seal(destination, input.sources, input.binding)));
  } else throw Error('seal|verify <destination> [mapping.json]');
}
