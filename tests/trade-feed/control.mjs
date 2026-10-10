import assert from 'node:assert/strict';
import { readFile, open, rename, mkdir } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { randomUUID, createHash } from 'node:crypto';

export const digest = (b) => createHash('sha256').update(b).digest('hex');
export function parseCommand(raw, last) {
  if (raw.length > 4096) throw Error('COMMAND_BOUND');
  const value = JSON.parse(
    new TextDecoder('utf-8', { fatal: true }).decode(raw).replace(/^\uFEFF/, ''),
  );
  assert(value && typeof value === 'object' && !Array.isArray(value));
  assert.deepEqual(Object.keys(value).sort(), ['command', 'ordinal']);
  assert(Number.isSafeInteger(value.ordinal) && value.ordinal > 0, 'COMMAND_ORDINAL');
  assert(['offline', 'trial', 'finalize', 'close'].includes(value.command), 'COMMAND_KIND');
  if (value.ordinal <= last) return null;
  assert.equal(value.ordinal, last + 1, 'COMMAND_SEQUENCE');
  return value;
}
export async function atomicCommand(root, value) {
  root = resolve(root);
  parseCommand(Buffer.from(JSON.stringify(value)), value.ordinal - 1);
  await mkdir(root, { recursive: true });
  const temp = join(root, 'command-' + randomUUID() + '.tmp');
  const file = await open(temp, 'wx');
  try {
    await file.writeFile(JSON.stringify(value) + '\n', 'utf8');
    await file.sync();
  } finally {
    await file.close();
  }
  await rename(temp, join(root, 'COMMAND.json'));
}
export async function readCommand(root, last) {
  const raw = await readFile(join(root, 'COMMAND.json')).catch((e) => {
    if (e.code === 'ENOENT') return null;
    throw e;
  });
  if (!raw) return { command: null };
  try {
    return { command: parseCommand(raw, last) };
  } catch (e) {
    return { command: null, refusal: { sha256: digest(raw), bytes: raw.length, error: String(e) } };
  }
}
export async function closeOwned(resources) {
  const closed = [],
    errors = [];
  for (const [name, close] of resources) {
    if (!close) continue;
    try {
      await close();
      closed.push(name);
    } catch (e) {
      errors.push({ name, error: String(e) });
    }
  }
  return { closed, errors, known: errors.length === 0 };
}
