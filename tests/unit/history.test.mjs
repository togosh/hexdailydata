import test from 'node:test';
import assert from 'node:assert/strict';
import { parseInput, inspectInput, normalize } from '../../src/worker/history/input.ts';
import { selection, rawRow, sample } from '../history/fixture.mjs';
import { csvLine } from '../../src/worker/exports/datasets.ts';
import { DailyQuery } from '../../src/contracts/reads.ts';

test('inspect inventories have explicit diagnostic bounds independently of the input cap', () => {
  const rows = Array.from({ length: 400 }, (_, i) => rawRow(1261 + i, { ['unmapped_' + i]: '1' }));
  const { inventory } = inspectInput(Buffer.from(JSON.stringify(rows)));
  assert.equal(inventory.keys.length, 256);
  assert.ok(inventory.keyCount > 400);
  assert.equal(inventory.inventoryTruncated, true);
  assert.ok(Buffer.byteLength(JSON.stringify(inventory)) < 65536);
});

test('lossless scalar mapping distinguishes source publication, gaps, sentinels, skeleton and signed change', () => {
  const bytes = sample(),
    result = inspectInput(bytes, selection(bytes)),
    byDay = new Map(result.rows.map((r) => [r.sourceDay, r]));
  assert.equal(result.metadata.summary.firstAvailablePrice.sourceDay, 1261);
  assert.equal(result.metadata.summary.prices, 2);
  assert.equal(byDay.get(1261).metrics.currentHolders.value, '9007199254740993');
  assert.equal(byDay.get(1261).referencePriceUsd.value, '1.2300e-40');
  assert.equal(
    byDay.get(1261).metrics.circulatingHEX.value,
    '900719925474099312345678.12345678901234567890123456789',
  );
  assert.equal(byDay.get(1261).metrics.currentHoldersChange.value, '-1');
  for (const [d, s] of [
    [1255, 'era_unproved'],
    [1258, 'null'],
    [1259, 'zero_price'],
    [1260, 'sentinel'],
    [1262, 'missing'],
    [1264, 'copied_price'],
    [1265, 'skeleton'],
  ]) {
    assert.equal(byDay.get(d).referencePriceUsd.availability, s);
    assert.equal(byDay.get(d).referencePriceUsd.value, null);
  }
  assert.equal(byDay.get(1259).metrics.penaltiesHEX.value, '0');
  assert.equal(byDay.get(1265).metrics.circulatingHEX.published, '0');
  assert.equal(byDay.get(1265).metrics.circulatingHEX.value, null);
  assert.equal(byDay.get(1261).marketPeriodUtc, null);
  assert.equal('priceUV2' in byDay.get(1261).metrics, false);
  assert.equal('roiMultiplierFromATL' in byDay.get(1261).metrics, false);
});
test('day/date relationship, delayed collection, incomplete periods and chain origin are independent', () => {
  const at = '2026-09-19T00:00:00.000Z';
  assert.equal(
    normalize(rawRow(1261, { date: '2023-05-18T02:00:00.000Z' }), at).dateRelationship,
    'delayed',
  );
  assert.equal(
    normalize(rawRow(1261, { date: '2023-05-18T02:00:00.000Z' }), at).marketPeriodUtc,
    null,
  );
  assert.equal(
    normalize(rawRow(1261, { date: '2024-01-01T00:00:00.000Z' }), at).referencePriceUsd
      .availability,
    'date_mismatch',
  );
  assert.equal(
    normalize(rawRow(1261), '2023-05-17T12:00:00.000Z').referencePriceUsd.availability,
    'future_period',
  );
  assert.throws(
    () => parseInput(Buffer.from(JSON.stringify([rawRow(1261, { chainId: 1 })]))),
    /chain/,
  );
  const r = rawRow(1261);
  delete r.pricePulseX;
  assert.throws(() => parseInput(Buffer.from(JSON.stringify([r]))), /PulseChain/);
});
test('bounded lossless parser rejects ambiguous keys, malformed data and conflicting selected identities', () => {
  for (const bad of [
    '[{"a":1,"a":1}]',
    '<html>error</html>',
    '{"error":"no"}',
    JSON.stringify([rawRow(1261, { date: '2023-02-30T00:00:00.000Z' })]),
    JSON.stringify([rawRow(1261, { circulatingHEX: 'NaN' })]),
    '['.repeat(6),
    JSON.stringify([rawRow(1261, { extra: 'a'.repeat(5000) })]),
    '[' + '0,'.repeat(10000) + '0]',
  ])
    assert.throws(() => {
      const b = Buffer.from(bad);
      inspectInput(b, selection(b));
    });
  const b = Buffer.from(JSON.stringify([rawRow(1261), rawRow(1261, { pricePulseX: '0.1' })]));
  assert.throws(() => inspectInput(b, selection(b)), /Conflicting duplicate/);
  const same = Buffer.from(JSON.stringify([rawRow(1261), rawRow(1261)]));
  assert.equal(inspectInput(same, selection(same)).identicalDuplicates, 1);
  assert.throws(() => inspectInput(same, selection(same, { sha256: '0'.repeat(64) })), /digest/);
});
test('reported query has explicit source/chain/range and revision-bound continuation; CSV preserves safe signed tokens', () => {
  const base = {
    chain: 'pulsechain',
    source: 'hexdailystats',
    from: '2023-05-11',
    to: '2023-05-20',
  };
  assert.equal(DailyQuery.safeParse(base).success, true);
  for (const q of [
    { ...base, source: 'unknown' },
    { ...base, chain: 'ethereum' },
    { ...base, to: '2024-05-20' },
    { ...base, afterSourceDay: 1261 },
  ])
    assert.equal(DailyQuery.safeParse(q).success, false);
  assert.equal(
    csvLine(['-1.23', '-1.23', '=bad', '1.00e-40'], new Set([0, 3])),
    "-1.23,'-1.23,'=bad,1.00e-40\n",
  );
  assert.equal(csvLine(['-1+BAD'], new Set([0])), "'-1+BAD\n");
});
