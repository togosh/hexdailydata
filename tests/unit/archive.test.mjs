import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, readFile, writeFile } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { gzipSync, gunzipSync } from 'node:zlib';
import { packArchive, readArchive, lines } from '../../src/worker/bootstrap/archive.ts';

const signal = new AbortController().signal;
test('seed tar accepts exact regular members; rejects traversal/link/duplicate/extra/missing/truncated/bomb', async () => {
  const root = resolve('artifacts/task-03');
  await mkdir(root, { recursive: true });
  const dir = await mkdtemp(join(root, 'archive-test-'));
  assert.ok(dir.startsWith(root + '\\') || dir.startsWith(root + '/'));
  try {
    const path = join(dir, 'valid.gz');
    await packArchive(path, [{ name: 'seed.json', data: Buffer.from('{}'), size: 2 }], signal);
    const raw = gunzipSync(await readFile(path));
    const consume = async (name, size, chunks) => {
      for await (const chunk of chunks) assert.ok(chunk.length <= 65536);
    };
    await readArchive(path, ['seed.json'], consume, signal);
    async function bad(name, edit, allowed = ['seed.json']) {
      const output = join(dir, name + '.gz');
      const bytes = Buffer.from(raw);
      const changed = edit(bytes) ?? bytes;
      await writeFile(output, gzipSync(changed));
      await assert.rejects(() => readArchive(output, allowed, consume, signal));
    }
    function checksum(h) {
      h.fill(32, 148, 156);
      h.write(
        h
          .subarray(0, 512)
          .reduce((a, b) => a + b, 0)
          .toString(8)
          .padStart(6, '0') + '\0 ',
        148,
      );
    }
    for (const name of ['../outside', '/absolute', 'C:\\drive', 'tables/../x', 'SEED.JSON'])
      await bad(name.replace(/[^a-z]/gi, ''), (b) => {
        b.fill(0, 0, 100);
        b.write(name, 0);
        checksum(b);
      });
    await bad('link', (b) => {
      b[156] = 50;
      checksum(b);
    });
    await bad('duplicate', (b) => Buffer.concat([b.subarray(0, 1024), b]));
    await bad('extra', (b) => b, ['seed.json', 'tables/accounts.ndjson']);
    await bad('truncated', (b) => b.subarray(0, 513));
    await bad('tail', (b) => Buffer.concat([b, Buffer.from('x')]));
    await bad('large', (b) => {
      b.write('77777777777\0', 124);
      checksum(b);
    });
    const row = (async function* () {
      yield Buffer.alloc(1024 * 1024 + 1, 65);
    })();
    await assert.rejects(async () => {
      for await (const line of lines(row)) void line;
    }, /bound/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
