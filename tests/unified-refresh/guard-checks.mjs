import assert from 'node:assert/strict';
import {
  independentReadingAdvance,
  preserveMarketHistory,
} from '../../dist/services/product-daily/market.js';
import { verifyMarketCertificate } from '../../dist/services/product-daily/storage.js';
export async function checkGuardCorrections(root, before, after, kind) {
  preserveMarketHistory(before, after);
  await verifyMarketCertificate(root, after, before);
  const cases = [];
  function refused(name, mutate) {
    const next = structuredClone(after);
    mutate(next);
    assert.throws(() => preserveMarketHistory(before, next), undefined, name);
    cases.push(name);
  }
  refused(
    'fixed historical BTC close immutable',
    (n) => (n.rows.find((r) => r.dateUtc === '2026-10-08').btcPriceUsd = '1'),
  );
  refused(
    'fixed quote time immutable',
    (n) =>
      (n.rows.find((r) => r.dateUtc === '2026-10-08').btcRecordedAtUtc = '2026-10-08T00:00:00Z'),
  );
  refused(
    'unrelated historical statistic immutable',
    (n) => (n.rows.find((r) => r.contractDay === 2000).totalHEX = '1'),
  );
  refused(
    'already materialized payout immutable',
    (n) => (n.rows.find((r) => r.contractDay === 2501).payoutHearts = '1'),
  );
  if (kind === 'payout') {
    assert.equal(before.metadata.coverage.ledgerDates, 2502);
    assert.equal(after.metadata.coverage.ledgerDates, 2503);
    assert.equal(before.rows.find((r) => r.contractDay === 2502).payoutHearts, null);
    assert.notEqual(after.rows.find((r) => r.contractDay === 2502).payoutHearts, null);
    refused(
      'decoded new payout cannot be changed',
      (n) => (n.rows.find((r) => r.contractDay === 2502).payoutHearts = '1'),
    );
    refused('packed word must agree', (n) => (n.metadata.ledgerSegments.at(-1).words[0] = '1'));
    refused('coverage must agree', (n) => n.metadata.coverage.ledgerDates--);
    refused(
      'ledger boundary must agree',
      (n) => (n.metadata.readings.find((r) => r.kind === 'protocol').globalWords[4] = '2502'),
    );
    refused('old packed prefix immutable', (n) => (n.metadata.ledgerSegments[0].words[0] = '1'));
    cases.push('qualified null fill only in exact appended day');
  } else {
    assert.equal(before.metadata.effectiveAtUtc, after.metadata.effectiveAtUtc);
    assert(independentReadingAdvance(before.metadata, after.metadata));
    for (const [name, mutate] of [
      [
        'same reading is not an advance',
        (n) => (n.readings = structuredClone(before.metadata.readings)),
      ],
      ['pair change refused', (n) => (n.pair[Object.keys(n.pair)[0]] = '0'.repeat(64))],
      ['missing certification metadata refused', (n) => delete n.marketStorage],
      ['missing reading refused', (n) => n.readings.pop()],
      [
        'per-feed time regression refused',
        (n) => (n.readings.find((r) => r.kind === 'gas').observedAtUtc = '2020-01-01T00:00:00Z'),
      ],
      [
        'same-time value mutation refused',
        (n) => {
          n.readings = structuredClone(before.metadata.readings);
          n.readings.find((r) => r.kind === 'market').value = '1';
        },
      ],
    ]) {
      const next = structuredClone(after.metadata);
      mutate(next);
      assert.equal(independentReadingAdvance(before.metadata, next), false, name);
      cases.push(name);
    }
    const forged = structuredClone(after);
    forged.metadata.marketStorage.sequence += 3;
    await assert.rejects(verifyMarketCertificate(root, forged, before));
    cases.push('forged sequence/certificate refused by actual verifier');
  }
  return { status: 'PASS', kind, cases };
}
