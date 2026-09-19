import assert from 'node:assert/strict';
import { mkdir, open, rename, unlink, rmdir, writeFile, stat } from 'node:fs/promises';
import { join, resolve, relative, isAbsolute } from 'node:path';
import { randomUUID } from 'node:crypto';
import { syncDirectory, reserve, fingerprint } from '../../src/worker/exports/files.ts';
const root = resolve('artifacts/task-05/platform-' + randomUUID());
const rel = relative(resolve('artifacts/task-05'), root);
assert.ok(!rel.startsWith('..') && !isAbsolute(rel));
await mkdir(root, { recursive: true });
const result = { platform: process.platform, node: process.version, reserve: await reserve(root) };
let handle;
try {
  await writeFile(join(root, 'member'), 'immutable-test-bytes');
  handle = await open(join(root, 'member'), 'r');
  const before = fingerprint(await handle.stat());
  try {
    await rename(join(root, 'member'), join(root, 'renamed'));
    result.renameWithOpenHandle = 'PASS';
  } catch (e) {
    result.renameWithOpenHandle = { code: e.code, message: e.message };
  }
  assert.equal(await handle.readFile('utf8'), 'immutable-test-bytes');
  result.openReaderFinished = true;
  await handle.close();
  handle = null;
  try {
    await syncDirectory(root);
    result.directoryFsync = 'PASS';
  } catch (e) {
    result.directoryFsync = { result: 'UNSUPPORTED_PUBLICATION_FAILS_CLOSED', code: e.code };
  }
  await writeFile(join(root, 'replacement'), 'different-test-bytes');
  assert.notEqual(fingerprint(await stat(join(root, 'replacement'))), before);
  result.replacementStatDetection = 'PASS';
} finally {
  await handle?.close();
  for (const name of ['member', 'renamed', 'replacement'])
    await unlink(join(root, name)).catch((e) => {
      if (e.code !== 'ENOENT') throw e;
    });
  await rmdir(root);
  await writeFile(
    'artifacts/task-05/platform-results.json',
    JSON.stringify(result, null, 2) + '\n',
  );
}
console.log(JSON.stringify(result, null, 2));
