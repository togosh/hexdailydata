// Narrow correction recheck. Reuse the existing synthetic product/journal only;
// no restore, provider, participant-base admission, source-row read or publication.
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import { join } from 'node:path';
import { syncBuiltinESMExports } from 'node:module';
import { ProductDailyStore, admitProduct } from '../../dist/services/product-daily/store.js';
import { ParticipantRegistry } from '../../dist/services/source-update/refresh.js';
import { stable } from '../../dist/history-bootstrap/normalize.js';
const R = process.env.HDD_TASK_ROOT;
assert(R?.endsWith('btc-eth-daily-close-reader-adoption-r1'));
const root = join(R, 'synthetic-runtime/product'),
  paired = join(R, 'synthetic-runtime/participants');
const productPointer = join(root, 'CURRENT.json'),
  pairedPointer = join(paired, 'CURRENT.json');
const productRaw = await fs.readFile(productPointer),
  pairedRaw = await fs.readFile(pairedPointer);
const pointer = JSON.parse(productRaw),
  pairPointer = JSON.parse(pairedRaw);
const next = await admitProduct(join(root, pointer.version), pointer.manifestSha256);
const state = JSON.parse(await fs.readFile(join(root, 'STORAGE.json')));
const prior = await admitProduct(join(root, state.rollback.version), state.rollback.manifestSha256);
assert.equal(prior.metadata.marketStorage.sequence, 24);
assert.equal(next.metadata.marketStorage.sequence, 25);
const pair = next.metadata.pair;
const originalRead = fs.readFile;
let hit = 0,
  at = 0,
  mutation;
fs.readFile = async function (path, ...args) {
  const b = await originalRead(path, ...args);
  if (
    mutation &&
    String(path) === join(root, 'verified-' + next.version + '.json') &&
    ++hit === at
  ) {
    const run = mutation;
    mutation = null;
    await run();
  }
  return b;
};
syncBuiltinESMExports();
const results = [];
const productLock = join(root, 'SELECTION.lock'),
  pairLock = join(paired, 'SELECTION.lock');
// All four target paths are literal descendants of this task-owned fixture.
const changes = [
  [
    'late product pointer',
    () => fs.writeFile(productPointer, stable(state.rollback)),
    /PRODUCT_POINTER_CHANGED/,
  ],
  [
    'late product lock',
    () => fs.writeFile(productLock, 'SYNTHETIC reader fence\n', { flag: 'wx' }),
    /PRODUCT_SELECTION_BUSY/,
  ],
  [
    'late paired pointer',
    () => fs.writeFile(pairedPointer, stable({ ...pairPointer, product: state.rollback })),
    /PARTICIPANT_POINTER_CHANGED/,
  ],
  [
    'late paired lock',
    () => fs.writeFile(pairLock, 'SYNTHETIC reader fence\n', { flag: 'wx' }),
    /PARTICIPANT_SELECTION_BUSY/,
  ],
];
async function restore(name) {
  mutation = null;
  await fs.writeFile(productPointer, productRaw);
  await fs.writeFile(pairedPointer, pairedRaw);
  if (name === 'late product lock') await fs.unlink(productLock);
  if (name === 'late paired lock') await fs.unlink(pairLock);
}
try {
  for (const [name, change, pattern] of changes) {
    const store = new ProductDailyStore(root, pair);
    await store.load();
    const before = store.capture();
    // Explicit negative-only source-view seam. It carries the already-qualified
    // pair identity and cannot read any rows. Products still use actual admission.
    // The complete real-base positive paths are in reader-adoption.mjs evidence.
    const view = {
      selection: pair.generation,
      identity: {
        generation: pair.generation,
        familyVersions: {
          tokenHolders: pair.holderDatasetVersion,
          stakeStarts: pair.stakeDatasetVersion,
        },
        holderRows: pair.holderRecordCount,
        stakeRows: pair.stakeStartRecordCount,
        snapshot: { observedAtUtc: pair.observedAtUtc },
      },
      close: async () => {},
    };
    const reg = new ParticipantRegistry(paired, store, view, {
      pointer: { ...pairPointer, product: state.rollback },
      product: prior,
      source: view,
      held: 0,
    });
    reg.prepared.set(pair.generation, view);
    hit = 0;
    at = 2;
    mutation = change; // during the second awaited proof, after early pointer checks
    try {
      await reg.refresh();
      assert.equal(hit, 2);
      assert.match(reg.status().error, pattern);
      assert.equal(reg.current.product, prior);
      assert.equal(store.capture(), before);
      results.push({
        name,
        status: 'REFUSED',
        error: reg.status().error,
        pairedMemoryUnchanged: true,
        productMemoryUnchanged: true,
        syntheticNegativeView: true,
      });
    } finally {
      await restore(name);
      await reg.close();
    }
  }
  for (const [name, change, pattern] of changes.slice(0, 2)) {
    const store = new ProductDailyStore(root, pair);
    await store.load();
    const before = store.capture();
    hit = 0;
    at = 1;
    mutation = change;
    try {
      await assert.rejects(store.adoptCoordinated(next, pair), pattern);
      assert.equal(hit, 1);
      assert.equal(store.capture(), before);
      results.push({ name: 'direct ' + name, status: 'REFUSED' });
    } finally {
      await restore(name);
    }
  }
  // Positive closing fence over the actual certified current product, no source stub.
  const clean = new ProductDailyStore(root, pair);
  await clean.load();
  let pairedChecks = 0;
  await clean.adoptCoordinated(next, pair, async () => {
    assert.deepEqual(await fs.readFile(pairedPointer), pairedRaw);
    pairedChecks++;
  });
  assert.equal(clean.capture(), next);
  assert.equal(pairedChecks, 1);
  results.push({
    name: 'unchanged certified selection with paired validator',
    status: 'PASS',
    noSyntheticSourceView: true,
  });
  await fs.writeFile(
    join(R, 'evidence/FINAL_ADOPTION_FENCES.json'),
    JSON.stringify(
      {
        status: 'PASS',
        newBaseAdmissions: 0,
        newSeedInitializations: 0,
        providerRequests: 0,
        newPublications: 0,
        results,
      },
      null,
      2,
    ) + '\n',
    { flag: 'wx' },
  );
} finally {
  mutation = null;
  fs.readFile = originalRead;
  syncBuiltinESMExports();
}
console.log('PASS late product/paired pointer and lock refusal before either adoption');
