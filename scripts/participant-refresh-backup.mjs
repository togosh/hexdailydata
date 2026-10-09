// Compact paired backup: immutable bases remain external prerequisites.
import { readFile, mkdir, lstat, realpath, open } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { canonical, sha } from '../dist/services/source-update/generation.js';
import {
  ParticipantDescriptorSchema,
  participantLimits,
} from '../dist/contracts/participant-update.js';
import { ACCEPTED } from '../dist/contracts/saved-generation.js';
import { backupStorage, restoreStorage } from '../dist/services/product-daily/storage.js';
import { ParticipantRegistry } from '../dist/services/source-update/refresh.js';
const member =
  /^(?:SEED\.json|CURRENT\.json|[0-9a-f]{64}\/(?:UPDATE|PROOF|INDEX|DESCRIPTOR)\.json)$/;
async function raw(root, name, max = participantLimits.overlayBytes) {
  if (!member.test(name)) throw Error('BACKUP_MEMBER');
  const path = join(root, name),
    s = await lstat(path);
  if (!s.isFile() || s.isSymbolicLink() || (await realpath(path)) !== resolve(path) || s.size > max)
    throw Error('BACKUP_FILE');
  return readFile(path);
}
async function put(path, b) {
  const f = await open(path, 'wx');
  try {
    await f.writeFile(b);
    await f.sync();
  } finally {
    await f.close();
  }
}
export async function backupParticipants(registry, destination) {
  destination = resolve(destination);
  await registry.refresh(undefined, true);
  const held = registry.capture();
  let lock;
  try {
    lock = await open(join(registry.root, 'SELECTION.lock'), 'wx');
    const current = await raw(registry.root, 'CURRENT.json'),
      p = JSON.parse(current);
    if (
      p.generation !== held.sourceGenerations.selection ||
      p.product.version !== held.product.version
    )
      throw Error('BACKUP_PAIR');
    const names = ['SEED.json', 'CURRENT.json'];
    let g = p.generation;
    for (let i = 0; g !== ACCEPTED.generation; i++) {
      if (i >= participantLimits.segments) throw Error('BACKUP_CHAIN_BOUND');
      const d = ParticipantDescriptorSchema.parse(
        JSON.parse(await raw(registry.root, `${g}/DESCRIPTOR.json`, 65536)),
      );
      if (d.generation !== g) throw Error('BACKUP_CHAIN');
      for (const file of ['UPDATE', 'PROOF', 'INDEX', 'DESCRIPTOR'])
        names.push(`${g}/${file}.json`);
      g = d.predecessor;
    }
    await mkdir(destination);
    const product = await backupStorage(registry.productDaily.root, join(destination, 'product'));
    const files = {};
    let total = 0;
    for (const name of names) {
      const b = await raw(registry.root, name);
      total += b.length;
      if (total > participantLimits.overlayBytes) throw Error('BACKUP_SIZE');
      if (name.includes('/'))
        await mkdir(join(destination, 'participants', name.split('/')[0]), { recursive: true });
      else await mkdir(join(destination, 'participants'), { recursive: true });
      await put(join(destination, 'participants', name), b);
      files[name] = { bytes: b.length, sha256: sha(b) };
    }
    if (!(await raw(registry.root, 'CURRENT.json')).equals(current))
      throw Error('BACKUP_POINTER_CHANGED');
    const manifest = {
      format: 'participant-product-backup-1',
      productBackupSha256: product.sha256,
      selected: p,
      externalBases: ACCEPTED.baseBindings,
      externalAcceptedOverlay: { generation: ACCEPTED.generation, bundle: ACCEPTED.bundle },
      files,
    };
    const b = Buffer.from(canonical(manifest) + '\n');
    await put(join(destination, 'BACKUP.json'), b);
    return {
      status: 'PASS',
      destination,
      sha256: sha(b),
      files: names.length,
      participantBytes: total,
      product,
    };
  } finally {
    held.release();
    if (lock) {
      await lock.close();
      const { unlink } = await import('node:fs/promises');
      await unlink(join(registry.root, 'SELECTION.lock'));
    }
  }
}
export async function restoreParticipants(backup, destination, identity, base) {
  backup = resolve(backup);
  destination = resolve(destination);
  const b = await readFile(join(backup, 'BACKUP.json'));
  if (b.length > 4 * 1024 * 1024 || sha(b) !== identity) throw Error('BACKUP_IDENTITY');
  const m = JSON.parse(b);
  if (
    m.format !== 'participant-product-backup-1' ||
    canonical(m.externalBases) !== canonical(ACCEPTED.baseBindings) ||
    canonical(m.externalAcceptedOverlay) !==
      canonical({ generation: ACCEPTED.generation, bundle: ACCEPTED.bundle })
  )
    throw Error('BACKUP_BASE_BINDING');
  const names = Object.keys(m.files);
  if (names.length > 4 * participantLimits.segments + 2) throw Error('BACKUP_ENTRIES');
  let total = 0;
  for (const name of names) {
    if (!member.test(name)) throw Error('BACKUP_MEMBER');
    total += m.files[name].bytes;
  }
  if (total > participantLimits.overlayBytes) throw Error('BACKUP_SIZE');
  await mkdir(destination);
  await restoreStorage(
    join(backup, 'product'),
    join(destination, 'product'),
    m.productBackupSha256,
  );
  const root = join(destination, 'participants');
  await mkdir(root);
  for (const name of names) {
    const value = await raw(join(backup, 'participants'), name),
      f = m.files[name];
    if (value.length !== f.bytes || sha(value) !== f.sha256) throw Error('BACKUP_FILE_IDENTITY');
    if (name.includes('/')) await mkdir(join(root, name.split('/')[0]), { recursive: true });
    await put(join(root, name), value);
  }
  const registry = await ParticipantRegistry.open(root, join(destination, 'product'), base);
  if (
    registry.status().generation !== m.selected.generation ||
    registry.status().productVersion !== m.selected.product.version
  ) {
    await registry.close();
    throw Error('RESTORE_PAIR');
  }
  return {
    registry,
    receipt: {
      status: 'PASS',
      backupSha256: identity,
      selected: m.selected,
      externalBases: m.externalBases,
      providerRequests: 0,
    },
  };
}
