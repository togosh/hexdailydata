import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { root, metadata, realRows, hash, receipt, inputs } from './helpers.mjs';
import { baseLedgerTail, decodeDailyWord } from '../../dist/contracts/protocol-daily.js';
import { restoreStorage } from '../../dist/services/product-daily/storage.js';
const ledgerRaw = await readFile(
  join(root, 'method-reference/accepted-ledger/PAIRED_DAILY_LEDGER.json'),
);
const ledger = JSON.parse(ledgerRaw);
assert.deepEqual(ledger.domain, [0, 2498]);
assert.equal(ledger.words.length, 2498);
let fields = 0;
for (const [i, w] of ledger.words.entries()) {
  assert.equal(w.day, i);
  const r = realRows.find((r) => r.contractDay === i);
  assert(r);
  const decoded = decodeDailyWord(w.packed);
  assert.equal(decoded.payoutHearts, w.payout);
  assert.equal(decoded.payoutStakeShares, w.shares);
  for (const [k, v] of Object.entries(decoded)) {
    assert.equal(r[k], v);
    fields++;
  }
}
assert.deepEqual(
  ledger.words.slice(-2).map((w) => w.packed),
  baseLedgerTail,
);
const backup = join(root, 'accepted-public/real-backup'),
  manifest = JSON.parse(await readFile(join(backup, 'BACKUP.json')));
for (const name of [
  'MANIFEST.json',
  'metadata.json',
  'daily.csv',
  'daily.ndjson',
  'exceptions.ndjson',
])
  assert.deepEqual(
    await readFile(join(root, 'seed', name)),
    await readFile(join(backup, inputs.bundledSeed.datasetVersion, name)),
  );
const restored = await restoreStorage(
  backup,
  join(root, 'selected-data'),
  hash(await readFile(join(backup, 'BACKUP.json'))),
);
assert.equal(restored.selected.version, inputs.bundledSeed.datasetVersion);
await writeFile(
  join(root, 'PROTOCOL_PROFILE.json'),
  JSON.stringify({ productRoot: join(root, 'selected-data'), pair: metadata.pair }, null, 2) + '\n',
  { flag: 'wx' },
);
await receipt('SEED_LEDGER_VERIFICATION', {
  status: 'PASS',
  rows: realRows.length,
  ledgerWords: 2498,
  exactPayoutFields: fields,
  originalLedgerSha256: hash(ledgerRaw),
  baseTail: baseLedgerTail,
  backupManifestSha256: hash(await readFile(join(backup, 'BACKUP.json'))),
  restored,
  externalRequests: 0,
});
console.log('PASS exact 2498-word/seed identity and supported genuine backup restore');
