import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, open, unlink, rmdir } from 'node:fs/promises';
import { join } from 'node:path';
import { setImmediate as turn } from 'node:timers/promises';
import { digestHandle } from '../../src/worker/exports/files.ts';

const parent = 'artifacts/task-06';
await mkdir(parent, { recursive: true });
const root = await mkdtemp(join(parent, 'digest-abort-'));
const path = join(root, 'owned.bin');
try {
  await writeFile(path, Buffer.alloc(8 * 1024 * 1024, 1));
  for (const when of ['before', 'during']) {
    const h = await open(path, 'r');
    const controller = new AbortController();
    let timer;
    try {
      if (when === 'before') controller.abort();
      else timer = setImmediate(() => controller.abort());
      await assert.rejects(digestHandle(h, controller.signal), { name: 'AbortError' });
    } finally {
      clearImmediate(timer);
      await h.close();
    }
    await turn();
    console.log('PASS', when, 'read abort; caller caught error and handle closed');
  }
} finally {
  await unlink(path);
  await rmdir(root);
}
