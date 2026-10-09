// Separate process: explicitly deny original runtime and restored seed access.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import { syncBuiltinESMExports } from 'node:module';
import { resolve, join, dirname, basename } from 'node:path';
const root = process.env.HDD_TASK_ROOT;
const evidence = process.env.HDD_RESTORE_EVIDENCE;
const report = JSON.parse(await fsp.readFile(evidence, 'utf8'));
const denied = [resolve(report.root), resolve(root, 'seed')];
for (const api of [fs, fsp])
  for (const method of [
    'open',
    'openSync',
    'readFile',
    'readFileSync',
    'readdir',
    'readdirSync',
    'stat',
    'statSync',
    'lstat',
    'lstatSync',
    'realpath',
    'realpathSync',
  ]) {
    if (typeof api[method] !== 'function') continue;
    const original = api[method];
    api[method] = function (path, ...args) {
      if (
        typeof path === 'string' &&
        denied.some(
          (p) =>
            resolve(path) === p ||
            resolve(path).startsWith(p + '\\') ||
            resolve(path).startsWith(p + '/'),
        )
      )
        throw Error('RESTORE_ORIGINAL_ROOT_ACCESS_DENIED');
      return original.call(this, path, ...args);
    };
  }
syncBuiltinESMExports();
const { restoreStorage, publishStoredMarket, auditJournal } =
  await import('../../dist/services/product-daily/storage.js');
const { ProductDailyStore } = await import('../../dist/services/product-daily/store.js');
const { hash } = await import('../../dist/history-bootstrap/normalize.js');
const backup = report.backup,
  destination = join(dirname(backup.destination), 'restored');
const actual = Date.now;
Date.now = () => Date.parse('2026-11-01T00:00:00Z');
try {
  const restored = await restoreStorage(backup.destination, destination, backup.sha256);
  const metadata = JSON.parse(
    await fsp.readFile(join(destination, restored.selected.version, 'metadata.json')),
  );
  const s = new ProductDailyStore(destination, metadata.pair);
  await s.load();
  const old = s.capture(),
    readings = structuredClone(old.metadata.readings),
    at = new Date(Date.parse(old.metadata.effectiveAtUtc) + 60000).toISOString();
  for (const r of readings) r.observedAtUtc = at;
  const u = {
    readings,
    liquidityHistory: [],
    receiptSha256: hash('synthetic restore subsequent update'),
    methodRevision: 'pulsex-four-pool-derived-usd-2',
  };
  const lease = await s.acquireWriter();
  let result;
  try {
    result = await publishStoredMarket(s, lease, u);
  } finally {
    await s.releaseWriter(lease);
  }
  assert(result.changed);
  assert.equal(
    s.capture().metadata.marketStorage.sequence,
    old.metadata.marketStorage.sequence + 1,
  );
  assert.deepEqual(s.capture().metadata.liquidityHistory, old.metadata.liquidityHistory);
  const audit = await auditJournal(destination);
  const outcome = {
    status: 'PASS',
    synthetic: true,
    externalRequests: 0,
    originalRootAccess: 'DENIED_BEFORE_IMPORT',
    denied,
    restored,
    subsequentPublication: result.selected,
    journal: audit,
    backup,
  };
  await fsp.writeFile(
    join(root, 'evidence', 'RESTORE_' + basename(dirname(destination)) + '.json'),
    JSON.stringify(outcome, null, 2) + '\n',
    { flag: 'wx' },
  );
  console.log(JSON.stringify(outcome));
} finally {
  Date.now = actual;
}
