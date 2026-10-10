// Explicit offline abort of a proved, closed trade writer before product commit.
// This never completes an update, changes a pointer, or grants a provider session.
import { readFile, lstat, realpath, open, rename, unlink, readdir } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { z } from 'zod';
import { canonical, sha } from '../dist/services/source-update/generation.js';
import { admitProduct } from '../dist/services/product-daily/store.js';
import { auditJournal, verifyMarketCertificate } from '../dist/services/product-daily/storage.js';
import { PairSchema } from '../dist/contracts/product-daily.js';

const digest = z.string().regex(/^[0-9a-f]{64}$/);
const keys = [
  'intent',
  'participantLock',
  'participantCurrent',
  'marketLock',
  'productCurrent',
  'storage',
  'certificate',
  'accounting',
  'trial',
  'ownerClosure',
  'update',
  'audit',
  'admission',
];
const planSchema = z.strictObject({
  format: z.literal('closed-trade-abort-1'),
  root: z.string(),
  productRoot: z.string(),
  sessionRoot: z.string(),
  ownerClosurePath: z.string(),
  owner: z.uuid(),
  pid: z.number().int().positive(),
  sequence: z.number().int().positive(),
  cycle: z.number().int().min(4).max(16),
  selected: z.strictObject({ version: digest, manifestSha256: digest }),
  pair: PairSchema,
  hashes: z.strictObject(Object.fromEntries(keys.map((k) => [k, digest]))),
  evidenceArchive: z.unknown(),
});
const same = (a, b) => canonical(a) === canonical(b);
async function exists(p) {
  try {
    await lstat(p);
    return true;
  } catch (e) {
    if (e.code === 'ENOENT') return false;
    throw e;
  }
}
async function raw(p, max = 262144) {
  if ((await realpath(p)) !== resolve(p)) throw Error('RECOVERY_PATH_ALIAS');
  const s = await lstat(p);
  if (!s.isFile() || s.isSymbolicLink() || s.nlink !== 1 || s.size > max)
    throw Error('RECOVERY_FILE_BOUND_OR_LINK');
  const b = await readFile(p);
  if (b.length !== s.size) throw Error('RECOVERY_FILE_CHANGED');
  return b;
}
async function exclusive(p, value) {
  const f = await open(p, 'wx');
  try {
    await f.writeFile(canonical(value) + '\n');
    await f.sync();
  } finally {
    await f.close();
  }
}
function dead(pid) {
  try {
    process.kill(pid, 0);
  } catch (e) {
    if (e.code === 'ESRCH') return;
    throw Error('RECOVERY_OWNER_STATE_UNKNOWN');
  }
  throw Error('RECOVERY_OWNER_STILL_ACTIVE');
}
function paths(p) {
  return {
    intent: join(p.root, 'INTENT.json'),
    participantLock: join(p.root, 'SELECTION.lock'),
    participantCurrent: join(p.root, 'CURRENT.json'),
    marketLock: join(p.productRoot, 'MARKET_REFRESH.lock'),
    productCurrent: join(p.productRoot, 'CURRENT.json'),
    storage: join(p.productRoot, 'STORAGE.json'),
    certificate: join(p.productRoot, `verified-${p.selected.version}.json`),
    accounting: join(p.sessionRoot, 'ACCOUNTING.json'),
    trial: join(p.sessionRoot, 'TRIAL_FINAL.json'),
    ownerClosure: p.ownerClosurePath,
    update: join(p.sessionRoot, `ROUND_${p.cycle}_UPDATE.json`),
    audit: join(p.sessionRoot, `ROUND_${p.cycle}_AUDIT.json`),
    admission: join(p.sessionRoot, 'ADMISSION.json'),
  };
}
async function verify(p, productLockOwned = false) {
  for (const root of [p.root, p.productRoot, p.sessionRoot])
    if (
      resolve(root) !== root ||
      (await realpath(root)) !== root ||
      (await lstat(root)).isSymbolicLink()
    )
      throw Error('RECOVERY_ROOT_ALIAS');
  dead(p.pid);
  const found = {};
  for (const [k, path] of Object.entries(paths(p))) {
    const b = await raw(path);
    if (sha(b) !== p.hashes[k]) throw Error('RECOVERY_BINDING:' + k);
    found[k] = JSON.parse(b);
  }
  const {
    intent,
    participantLock,
    participantCurrent,
    productCurrent,
    storage,
    marketLock,
    accounting,
    trial,
    ownerClosure,
    update,
    audit,
    admission,
  } = found;
  if (
    intent.kind !== 'product' ||
    intent.owner !== p.owner ||
    participantLock.owner !== p.owner ||
    participantLock.pid !== p.pid ||
    marketLock.pid !== p.pid ||
    marketLock.output !== p.sessionRoot ||
    marketLock.taskId !== 'HDD-BTC-ETH-CURRENT-REFERENCE-FRESHNESS-R2' ||
    !same(intent.previous, participantCurrent) ||
    !same(productCurrent, p.selected) ||
    !same(participantCurrent.product, p.selected) ||
    intent.generation !== p.pair.generation ||
    participantCurrent.generation !== p.pair.generation ||
    intent.descriptorSha256 !== participantCurrent.descriptorSha256
  )
    throw Error('RECOVERY_OWNER_OR_POINTER');
  if (
    accounting.status !== 'CLOSED' ||
    accounting.pending !== null ||
    accounting.closureKnown !== true ||
    !accounting.requests.every(
      (r) => r.closed && r.native?.reaped && !r.native.timeout && !r.native.interrupted,
    ) ||
    trial.networkClosureKnown !== true ||
    trial.publicationUncertain !== true ||
    trial.networkSessionCount !== 1 ||
    ownerClosure.pid !== p.pid ||
    !ownerClosure.known ||
    !ownerClosure.base?.known ||
    ownerClosure.errors.length ||
    ownerClosure.base.errors.length
  )
    throw Error('RECOVERY_CLOSURE');
  if (
    admission.authorityTaskId !== 'HDD-BTC-ETH-OPERATING-REFRESH-R1' ||
    admission.jobRoot !== p.sessionRoot ||
    admission.tradeProfileId !== 'operating-16-slots-v1' ||
    audit.sessionAdmissionSha256 !== p.hashes.admission ||
    audit.status !== 'QUALIFIED' ||
    audit.cycle !== p.cycle ||
    !same(intent.productUpdate, update) ||
    update.receiptSha256 !== p.hashes.audit ||
    Object.keys(update).sort().join(',') !== 'liquidityHistory,readings,receiptSha256' ||
    update.liquidityHistory.length ||
    update.readings.length !== 2 ||
    !update.readings.every(
      (r) => r.kind === 'trade' && r.method === 'bitstamp-recent-trade-usd-1',
    ) ||
    new Set(update.readings.map((r) => r.asset)).size !== 2 ||
    !update.readings.some((r) => r.asset === 'BTC') ||
    !update.readings.some((r) => r.asset === 'ETH')
  )
    throw Error('RECOVERY_FAILED_UPDATE');
  if (
    storage.sequence !== p.sequence ||
    !same(storage.current, p.selected) ||
    !same(storage.journalSelected, p.selected)
  )
    throw Error('RECOVERY_FRONTIER');
  for (const n of [
    'PENDING.json',
    'COMMITTED.json',
    'RETENTION_PENDING.json',
    'WRITER.lock',
    'MAINTENANCE.lock',
    ...(productLockOwned ? [] : ['SELECTION.lock']),
  ])
    if (await exists(join(p.productRoot, n))) throw Error('RECOVERY_PENDING_OR_WRITER');
  // No unexpected staged writes may be interpreted as a settled operation.
  for (const root of [p.root, p.productRoot])
    for (const n of await readdir(root))
      if (n.startsWith('pending-')) throw Error('RECOVERY_STAGED_WRITE');
  return found;
}
async function frontierFiles(root) {
  const files = {};
  let total = 0,
    count = 0;
  for (const directory of ['journal', 'operations'])
    for (const name of await readdir(join(root, directory))) {
      if (!/^[A-Za-z0-9_.-]+$/.test(name) || ++count > 1024) throw Error('RECOVERY_FRONTIER_BOUND');
      const b = await raw(join(root, directory, name), 32 * 1024 ** 2);
      total += b.length;
      if (total > 128 * 1024 ** 2) throw Error('RECOVERY_FRONTIER_BOUND');
      files[directory + '/' + name] = sha(b);
    }
  return files;
}
/** Explicit owner-authorized maintenance entry. No CLI performs a mutation. */
export async function abortClosedTradePublication(unknownPlan, { phase = async () => {} } = {}) {
  const p = planSchema.parse(unknownPlan),
    bound = paths(p);
  await verify(p);
  const suffix = p.owner;
  const targets = {
    intent: join(p.root, `CLOSED_INTENT-${suffix}.json`),
    participantLock: join(p.root, `CLOSED_LOCK-${suffix}.json`),
    // Product storage has a strict serving/retention allowlist. Keep retired
    // ownership evidence with the participant recovery records, not in that root.
    marketLock: join(p.root, `CLOSED_MARKET_REFRESH-${suffix}.json`),
  };
  const intentPath = join(p.root, `RECOVERY_INTENT-${suffix}.json`),
    receiptPath = join(p.root, `RECOVERY-${suffix}.json`);
  for (const f of [...Object.values(targets), intentPath, receiptPath])
    if (await exists(f)) throw Error('RECOVERY_DESTINATION_EXISTS');
  let recoveryLock,
    productLock,
    mutating = false,
    complete = false;
  const own =
    canonical({
      format: 'closed-trade-abort-1',
      pid: process.pid,
      failedOwner: p.owner,
      planSha256: sha(canonical(p)),
    }) + '\n';
  try {
    recoveryLock = await open(join(p.root, 'RECOVERY.lock'), 'wx');
    await recoveryLock.writeFile(own);
    await recoveryLock.sync();
    productLock = await open(join(p.productRoot, 'SELECTION.lock'), 'wx');
    await productLock.writeFile(own);
    await productLock.sync();
    await verify(p, true);
    const product = await admitProduct(
      join(p.productRoot, p.selected.version),
      p.selected.manifestSha256,
    );
    if (
      !same(product.metadata.pair, p.pair) ||
      product.metadata.marketStorage?.sequence !== p.sequence
    )
      throw Error('RECOVERY_SELECTED_PRODUCT');
    await verifyMarketCertificate(p.productRoot, product);
    const journal = await auditJournal(p.productRoot),
      frontier = await frontierFiles(p.productRoot);
    if (journal.sequence !== p.sequence) throw Error('RECOVERY_JOURNAL_SEQUENCE');
    await phase('verified');
    await verify(p, true);
    if (!same(frontier, await frontierFiles(p.productRoot)))
      throw Error('RECOVERY_LATE_FRONTIER_DRIFT');
    for (const f of [...Object.values(targets), intentPath, receiptPath])
      if (await exists(f)) throw Error('RECOVERY_DESTINATION_EXISTS');
    // After this durable intent, any interruption retains both fresh exclusion locks.
    mutating = true;
    await exclusive(intentPath, {
      format: 'closed-trade-abort-1',
      plan: p,
      frontier,
      journal,
      selected: p.selected,
      providerRequests: 0,
    });
    await phase('intent');
    for (const k of ['intent', 'participantLock', 'marketLock']) {
      if (sha(await raw(bound[k])) !== p.hashes[k]) throw Error('RECOVERY_RENAME_DRIFT');
      await rename(bound[k], targets[k]);
      await phase('renamed-' + k);
    }
    if (
      sha(await raw(bound.productCurrent)) !== p.hashes.productCurrent ||
      sha(await raw(bound.participantCurrent)) !== p.hashes.participantCurrent ||
      sha(await raw(bound.storage)) !== p.hashes.storage
    )
      throw Error('RECOVERY_POINTER_DRIFT');
    const receipt = {
      format: 'closed-trade-abort-1',
      outcome: 'ABORTED_BEFORE_PRODUCT',
      selected: p.selected,
      sequence: p.sequence,
      originalOwner: p.owner,
      originalPid: p.pid,
      planSha256: sha(canonical(p)),
      originalHashes: p.hashes,
      retiredFiles: targets,
      productUnchanged: true,
      providerRequests: 0,
      completedAtUtc: new Date().toISOString(),
    };
    await exclusive(receiptPath, receipt);
    await phase('receipt');
    complete = true;
    return receipt;
  } finally {
    if (productLock) await productLock.close();
    if (recoveryLock) await recoveryLock.close();
    if (!mutating || complete) {
      for (const [handle, path] of [
        [productLock, join(p.productRoot, 'SELECTION.lock')],
        [recoveryLock, join(p.root, 'RECOVERY.lock')],
      ])
        if (handle) {
          if ((await raw(path)).toString() !== own) throw Error('RECOVERY_EXCLUSION_CHANGED');
          await unlink(path);
        }
    }
  }
}
