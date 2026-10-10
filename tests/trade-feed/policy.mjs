import assert from 'node:assert/strict';
import { readFile, writeFile, mkdir, mkdtemp } from 'node:fs/promises';
import { join } from 'node:path';
import {
  sampleTrades,
  qualifyMarkets,
  freshTradePair,
  decimalToken,
} from '../../dist/services/product-daily/trades.js';
import {
  applyMarketUpdate,
  mergeObservations,
  marketCheckpoints,
  marketEvidence,
  latestReadings,
  preserveMarketHistory,
  referenceOnlyAdvance,
  validateMarketHistory,
} from '../../dist/services/product-daily/market.js';
import { productFiles } from '../../dist/services/product-daily/project.js';
import { ProductDailyStore } from '../../dist/services/product-daily/store.js';
import {
  createMarketStorage,
  publishStoredMarket,
  verifyMarketReaderAdvance,
} from '../../dist/services/product-daily/storage.js';
import { sha } from '../../dist/services/source-update/generation.js';
const R = process.env.HDD_TASK_ROOT;
assert(R?.endsWith('btc-eth-current-reference-freshness-r2'));
const inputs = JSON.parse(await readFile(join(R, 'packet/INPUTS.json'))),
  cases = [];
async function check(name, fn) {
  await fn();
  cases.push(name);
}
const get = async (version) => {
  const p = join(R, 'reference/seed/real-backup/product', version);
  return {
    version,
    manifestSha256: sha(await readFile(join(p, 'MANIFEST.json'))),
    rows: (await readFile(join(p, 'daily.ndjson'), 'utf8')).trim().split('\n').map(JSON.parse),
    metadata: JSON.parse(await readFile(join(p, 'metadata.json'))),
    exceptions: (await readFile(join(p, 'exceptions.ndjson'), 'utf8'))
      .trim()
      .split('\n')
      .map(JSON.parse),
  };
};
const seed = await get(inputs.preserveAcceptedInputsAndExistingCells.closeProduct);
const now = Date.now(),
  second = Math.floor(now / 1000) - 10;
const tuple = (date, tid, price = '82500.123456789012345678901234567890') =>
  `{"date":"${date}","tid":${tid},"price":"${price}"}`;
const sample = (
  asset,
  tid = '900719925474099312345',
  date = second,
  price = asset === 'BTC' ? '82500.12' : '2499.98',
) => sampleTrades('[' + tuple(date, tid, price) + ']', asset, [], now).selected;
const pair = () => [sample('BTC'), sample('ETH')];
const update = (readings) => ({
  readings,
  liquidityHistory: [],
  receiptSha256: sha(JSON.stringify(readings)),
});
try {
  await check('exact markets/spot/USD and duplicate key rejection', () => {
    const rows = ['BTC', 'ETH'].map((a) => ({
      market_symbol: a.toLowerCase() + 'usd',
      base_currency: a,
      counter_currency: 'USD',
      trading: 'Enabled',
      market_type: 'SPOT',
    }));
    assert.equal(qualifyMarkets(JSON.stringify(rows)).selected.length, 2);
    assert.throws(() => qualifyMarkets(JSON.stringify([...rows, rows[0]])), /IDENTITY/);
    assert.throws(
      () => qualifyMarkets(JSON.stringify(rows.map((r) => ({ ...r, counter_currency: 'USDT' })))),
      /IDENTITY/,
    );
    assert.throws(
      () => sampleTrades('[{"date":1,"date":2,"tid":1,"price":"1"}]', 'BTC', [], now),
      /DUPLICATE/,
    );
  });
  await check(
    'lossless tuple, order-independent timestamp then numeric-ID tie and precision',
    () => {
      const entries = [
        tuple(second, '900719925474099312344', '1.234500'),
        tuple(second - 1, '999999999999999999999'),
        tuple(second, '900719925474099312345'),
      ];
      const a = sampleTrades('[' + entries.join(',') + ']', 'BTC', [], now),
        b = sampleTrades('[' + entries.reverse().join(',') + ']', 'BTC', [], now);
      assert.deepEqual(a.selected, b.selected);
      assert.equal(a.selected.tradeId, '900719925474099312345');
      assert.equal(a.selected.value, '82500.12345678901234567890123456789');
      assert.equal(a.newestSecondCandidates, 2);
      assert.equal(a.newestSecondDistinctPrices, 2);
      assert.equal(decimalToken('0001.234500e2'), '123.45');
      assert.equal(sampleTrades(tuple(second, '1'), 'BTC', [], now).shape, 'single-tuple');
    },
  );
  await check(
    'every reused identity conflicts independent of sort, including retained and changed time',
    () => {
      for (const list of [
        [tuple(second - 1, '1'), tuple(second, '1')],
        [tuple(second, '1'), tuple(second, '1', '1')],
      ]) {
        assert.throws(() => sampleTrades('[' + list.join(',') + ']', 'BTC', [], now), /IDENTITY/);
        assert.throws(
          () => sampleTrades('[' + list.reverse().join(',') + ']', 'BTC', [], now),
          /IDENTITY/,
        );
      }
      assert.throws(
        () => sampleTrades(tuple(second, '1'), 'BTC', [sample('BTC', '1', second - 1)], now),
        /IDENTITY/,
      );
      assert.throws(() => sampleTrades(tuple(second + 100, '1'), 'BTC', [], now), /FUTURE/);
      for (const body of [
        '{"error":"bad"}',
        '[{}]',
        '[{"date":"1.5","tid":1,"price":1}]',
        '[{"date":1,"tid":0,"price":1}]',
        '[{"date":1,"tid":1,"price":0}]',
      ])
        assert.throws(() => sampleTrades(body, 'BTC', [], now));
      assert.equal(sampleTrades('[]', 'ETH', [], now).selected, null);
    },
  );
  const refs = pair(),
    first = applyMarketUpdate(seed, update(refs));
  await check(
    'initial paired transition preserves all117641existing cells and every other feed',
    () => {
      assert.deepEqual(first.rows.slice(0, seed.rows.length), seed.rows);
      preserveMarketHistory(seed, first);
      assert.equal(first.metadata.coverage.ledgerDates, 2502);
      assert.deepEqual(first.metadata.pair, seed.metadata.pair);
      assert.deepEqual(first.metadata.benchmarkHistory, seed.metadata.benchmarkHistory);
      assert.deepEqual(
        first.metadata.readings.filter((r) => r.kind !== 'trade'),
        seed.metadata.readings.filter((r) => r.kind !== 'reference'),
      );
      assert.equal(first.rows.at(-1).dailyPayoutHEX, null);
      assert.equal(first.rows.at(-1).btcRecordedAtUtc, refs[0].observedAtUtc);
      for (const r of seed.metadata.readings.filter((r) => r.kind === 'reference'))
        assert(marketEvidence(first.metadata).some((n) => JSON.stringify(n) === JSON.stringify(r)));
    },
  );
  await check(
    'pair-only, no-op, held older ties, timestamp-first smaller ID and one unchanged asset',
    () => {
      assert.throws(() => applyMarketUpdate(seed, update([refs[0]])), /PAIRED/);
      assert.throws(
        () =>
          applyMarketUpdate(
            seed,
            update([refs[0], refs[1], seed.metadata.readings.find((r) => r.kind === 'gas')]),
          ),
        /PAIRED/,
      );
      assert.throws(() =>
        applyMarketUpdate(seed, update([{ ...refs[0], market: 'ethusd' }, refs[1]])),
      );
      assert.equal(applyMarketUpdate(first, update(refs)), first);
      assert.equal(
        applyMarketUpdate(
          first,
          update([sample('BTC', '999999999999999999999999', second - 1), refs[1]]),
        ),
        first,
      );
      const next = applyMarketUpdate(first, update([sample('BTC', '1', second + 1), refs[1]]));
      assert.equal(
        next.metadata.readings.find((r) => r.kind === 'trade' && r.asset === 'BTC').tradeId,
        '1',
      );
      const tied = applyMarketUpdate(
        first,
        update([sample('BTC', '900719925474099312346', second, '1.25'), refs[1]]),
      );
      assert.equal(tied.rows.at(-1).btcPriceUsd, '1.25');
      preserveMarketHistory(first, tied);
      const pairTime = [sample('BTC', '2', second - 20), sample('ETH', '3', second - 10)];
      assert(freshTradePair(pairTime, (second - 20 + 300) * 1000));
      assert(!freshTradePair(pairTime, (second - 20 + 300) * 1000 + 1));
    },
  );
  await check(
    'same-second checkpoint/recent replay ordering; metadata identity mutation refused',
    () => {
      const low = sample('BTC', '1', second, '1'),
        high = sample('BTC', '2', second, '2');
      for (const list of [
        [high, low],
        [low, high],
      ]) {
        assert.deepEqual(marketCheckpoints(list), [high]);
        assert.deepEqual(mergeObservations([], list), [high]);
        assert.deepEqual(latestReadings(list), [high]);
      }
      assert.throws(
        () =>
          marketCheckpoints([
            low,
            { ...low, observedAtUtc: new Date((second - 1) * 1000).toISOString() },
          ]),
        /IDENTITY/,
      );
      const compact = structuredClone(first);
      compact.metadata.marketStorage.checkpoints = marketCheckpoints(
        marketEvidence(first.metadata),
      );
      compact.metadata.observations = [];
      validateMarketHistory(compact.rows, compact.metadata);
      const tied = applyMarketUpdate(
        compact,
        update([sample('BTC', '900719925474099312346', second, '1.25'), refs[1]]),
      );
      validateMarketHistory(tied.rows, tied.metadata);
    },
  );
  await check('fixed-close guard reached by new kind in direct and replay paths', () => {
    const old = { ...refs[0], observedAtUtc: '2026-10-08T23:59:59.000Z' };
    assert.throws(() => applyMarketUpdate(seed, update([old, refs[1]])), /BENCHMARK_TIMED_OVERLAP/);
    const metadata = structuredClone(seed.metadata);
    delete metadata.marketStorage;
    metadata.observations = mergeObservations(marketEvidence(seed.metadata), [old]);
    metadata.readings = latestReadings(metadata.observations);
    assert.throws(() => validateMarketHistory(seed.rows, metadata), /BENCHMARK_TIMED_OVERLAP/);
  });
  await check('exact HDS22 to close23 reconstruction remains byte-identical', async () => {
    const hds = await get(inputs.preserveAcceptedInputsAndExistingCells.hdsRollback);
    const historyUpdate = JSON.parse(
      await readFile(join(R, 'reference/seed/data/HISTORY_UPDATE.json')),
    );
    const reconstructed = applyMarketUpdate(hds, historyUpdate),
      files = productFiles(reconstructed);
    assert.deepEqual(reconstructed.rows, seed.rows);
    assert.deepEqual(reconstructed.metadata, seed.metadata);
    assert.deepEqual(reconstructed.exceptions, seed.exceptions);
  });
  await check(
    'oracle same-round/later-round compatibility and reference advance below other clock',
    () => {
      const old = seed.metadata.readings.filter((r) => r.kind === 'reference');
      assert.equal(applyMarketUpdate(seed, update(old)), seed);
      const later = applyMarketUpdate(
        seed,
        update(old.map((r) => ({ ...r, roundId: String(BigInt(r.roundId) + 1n) }))),
      );
      assert.deepEqual(later.rows, seed.rows);
      assert.throws(
        () => applyMarketUpdate(seed, update(old.map((r) => ({ ...r, value: '1' })))),
        /ROUND/,
      );
      const gas = {
        ...seed.metadata.readings.find((r) => r.kind === 'gas'),
        observedAtUtc: new Date((second + 5) * 1000).toISOString(),
      };
      const quiet = applyMarketUpdate(seed, update([gas]));
      const out = applyMarketUpdate(quiet, update(refs));
      assert.equal(out.metadata.effectiveAtUtc, quiet.metadata.effectiveAtUtc);
      assert(referenceOnlyAdvance(quiet.metadata, out.metadata));
    },
  );
  await mkdir(join(R, 'fixtures'), { recursive: true });
  await check(
    'actual standalone writer/certificate/ordinary-reader adoption and held snapshot',
    async () => {
      const metadata = structuredClone(seed.metadata);
      metadata.observations = marketEvidence(metadata);
      delete metadata.marketStorage;
      const dir = join(await mkdtemp(join(R, 'fixtures/standalone-')), 'product');
      const store = await createMarketStorage(dir, productFiles({ ...seed, metadata }));
      const reader = new ProductDailyStore(dir, metadata.pair);
      await reader.load();
      const held = reader.capture();
      let lease = await store.acquireWriter();
      try {
        const result = await publishStoredMarket(store, lease, update(refs));
        await store.releaseWriter(lease);
        lease = null;
        await reader.refresh();
        assert.equal(reader.capture().version, result.selected.version);
        assert.equal(sha(held.csv), inputs.preserveAcceptedInputsAndExistingCells.closeCsvSha256);
        const live = reader.live(reader.capture(), now);
        assert.equal(live.btcPriceUsd, refs[0].value);
        assert.equal(live.freshness.BTC.observedAtUtc, refs[0].observedAtUtc);
        const stale = reader.live(reader.capture(), (second + 301) * 1000);
        assert.equal(stale.freshness.BTC.status, 'stale');
        const before = reader.capture().version;
        lease = await store.acquireWriter();
        await assert.rejects(
          publishStoredMarket(
            store,
            lease,
            update([sample('BTC', '8', second + 1), refs[1]]),
            () => {
              throw Error('synthetic before-commit refusal');
            },
          ),
          /refusal/,
        );
        const failedLease = lease;
        lease = null;
        await assert.rejects(store.releaseWriter(failedLease), /UNCERTAIN_LOCK_RETAINED/);
        await reader.refresh();
        assert.equal(reader.capture().version, before);
      } finally {
        if (lease) await store.releaseWriter(lease);
      }
    },
  );
  await writeFile(
    join(R, 'evidence/POLICY_TESTS.json'),
    JSON.stringify({ status: 'PASS', synthetic: true, externalRequests: 0, cases }, null, 2) + '\n',
  );
  console.log(JSON.stringify({ status: 'PASS', cases: cases.length }));
} catch (e) {
  await writeFile(
    join(R, 'evidence/POLICY_FAILURE_' + Date.now() + '.json'),
    JSON.stringify({ status: 'FAIL', cases, error: String(e), stack: e.stack }, null, 2) + '\n',
  );
  throw e;
}
