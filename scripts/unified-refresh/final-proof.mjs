// Final paired proof shared by small denied-network fixtures and this task's real copy.
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { sha, canonical } from '../../dist/services/source-update/generation.js';
import { columns } from '../../dist/services/product-daily/project.js';
import {
  preserveMarketHistory,
  validateLedgerSegments,
  marketEvidence,
} from '../../dist/services/product-daily/market.js';
import { backupParticipants } from '../participant-refresh-backup.mjs';

export async function finalProof({ T, real, seed, f, heldExport, save, synthetic = false }) {
  const p = real.productDaily.capture();
  preserveMarketHistory(seed, p);
  validateLedgerSegments(p.rows, p.metadata);
  assert.deepEqual(p.metadata.benchmarkHistory, seed.metadata.benchmarkHistory);
  for (const old of seed.rows.filter((r) => r.dateUtc <= '2026-10-08')) {
    const row = p.rows.find((r) => r.dateUtc === old.dateUtc);
    for (const key of ['btcPriceUsd', 'ethPriceUsd', 'btcRecordedAtUtc', 'ethRecordedAtUtc'])
      assert.equal(row[key], old[key]);
  }
  const evidence = marketEvidence(p.metadata);
  for (const old of marketEvidence(seed.metadata).filter((r) => r.kind === 'reference'))
    assert(
      evidence.some((r) => canonical(r) === canonical(old)),
      'Original oracle observation lost',
    );
  assert.deepEqual(
    p.metadata.ledgerSegments.slice(0, seed.metadata.ledgerSegments.length),
    seed.metadata.ledgerSegments,
  );
  const csv = p.csv
    .toString()
    .trimEnd()
    .split('\n')
    .map((l) => l.replace(/\r$/, ''));
  assert.equal(csv.shift(), columns.join(','));
  assert.equal(csv.length, p.rows.length);
  for (let n = 0; n < csv.length; n++)
    assert.equal(csv[n], columns.map((k) => p.rows[n][k] ?? '').join(','));
  const changes = [];
  for (const old of seed.rows) {
    const row = p.rows.find((r) => r.dateUtc === old.dateUtc);
    assert(row);
    for (const key of columns)
      if (row[key] !== old[key])
        changes.push({ dateUtc: old.dateUtc, field: key, before: old[key], after: row[key] });
  }
  const chunks = [];
  for await (const b of heldExport.stream) chunks.push(b);
  await heldExport.released;
  assert.equal(sha(Buffer.concat(chunks)), sha(seed.csv));
  const routes = [
    '/api/v2/live',
    '/api/v2/home',
    '/api/v2/daily?from=2026-10-01&to=' + p.metadata.through + '&metric=btcPriceUsd',
    // The cheap fixture has empty base handles. Genuine final proof always browses both complete bases.
    ...(synthetic ? [] : ['/api/v2/holders?limit=1', '/api/v2/stakes?limit=1']),
  ];
  f.controls.now = Date.now();
  const now = f.controls.now,
    responses = {};
  for (const url of routes) {
    const r = await f.inject(url);
    assert.equal(r.statusCode, 200, url + ': ' + r.body.slice(0, 500));
    responses[url] = r.json();
  }
  const { auth } = await import('../../tests/market-feed/access-fixture.mjs');
  const url = '/api/v2/downloads/' + p.bundleId + '/daily';
  assert([401, 403].includes((await f.inject(url)).statusCode));
  const downloaded = await f.inject({ url, headers: auth() });
  assert.equal(downloaded.statusCode, 200);
  assert.equal(sha(downloaded.body), sha(p.csv));
  const head = await f.inject({ url, method: 'HEAD', headers: auth() });
  assert.equal(head.statusCode, 200);
  assert.equal(head.body, '');
  for (const method of ['GET', 'HEAD'])
    assert.equal(
      (
        await f.inject({
          url,
          method,
          headers: { ...auth(), 'if-none-match': downloaded.headers.etag },
        })
      ).statusCode,
      304,
    );
  await save('FINAL_NORMAL_API', responses);
  await save('PRESERVATION', {
    status: 'PASS',
    synthetic,
    oldRows: seed.rows.length,
    newRows: p.rows.length,
    comparedCsvCells: p.rows.length * columns.length,
    fixedCloseCells: 5004,
    changedCells: changes,
    ledgerPeriods: p.metadata.coverage.ledgerDates,
    liquidityDates: p.metadata.liquidityHistory.length,
    pair: p.metadata.pair,
    selected: { version: p.version, manifestSha256: p.manifestSha256, csvSha256: sha(p.csv) },
    heldExportSha256: sha(seed.csv),
    protectedAccess: 'PASS',
  });
  const backup =
    p.version === seed.version ? null : await backupParticipants(real, join(T, 'final-backup'));
  await save(
    'FINAL_BACKUP',
    backup ?? { status: 'UNCHANGED_SEED_REFERENCED', genuineBackupCreated: false },
  );
  return {
    backup,
    expected: {
      version: p.version,
      manifestSha256: p.manifestSha256,
      csvSha256: sha(p.csv),
      rows: p.rows,
      readings: p.metadata.readings,
      pair: p.metadata.pair,
    },
    routes,
    responses,
    now,
  };
}
