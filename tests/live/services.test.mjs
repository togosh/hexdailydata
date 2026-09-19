import test from 'node:test';
import assert from 'node:assert/strict';
import { PriceReader, priceProfileSchema } from '../../src/services/live/price.ts';
import { MetricsService } from '../../src/worker/metrics/service.ts';
import { readMetrics } from '../../src/worker/metrics/store.ts';
import { AddressService } from '../../src/services/live/address.ts';
import { ByteCache } from '../../src/services/live/cache.ts';
import { openAddressService } from '../../src/services/live/factory.ts';
import { AddressResultSchema } from '../../src/contracts/api.ts';
import { selectors, word } from '../../src/providers/abi.ts';
import { liveSelectors as s } from '../../src/providers/live-abi.ts';
import {
  fixture,
  profile,
  MemoryMetrics,
  emptyBaseline,
  signal,
  HEX,
  A,
  B,
  CODE_HASH,
  EPOCH,
  ManualClock,
  addr,
  hash,
} from './fixture.mjs';

function setup(options = {}) {
  const f = fixture(options),
    store = new MemoryMetrics();
  const rpc = f.rpc('primary'),
    other = f.rpc('secondary');
  const service = new MetricsService([rpc, other], CODE_HASH, new PriceReader(f.price, HEX), store);
  f.clock.time += 60000;
  return { f, store, rpc, other, service };
}
function addressSetup(options = {}) {
  const f = fixture(options);
  f.clock.time = Math.ceil((f.clock.time + 60000) / 10500) * 10500;
  const rpc = f.rpc('api', f.api),
    service = new AddressService(rpc, CODE_HASH, emptyBaseline);
  return { f, rpc, service };
}
test('metrics raw pin -> exact independent DTOs; reversed decimals and composed reserve route', async () => {
  for (const p of [
    profile(),
    profile({ reverse: true }),
    profile({ via: true }),
    profile({ reverse: true, via: true }),
  ]) {
    const { f, service } = setup({ price: p });
    const r = await service.tick(signal);
    assert.equal(r.price.value.usdPerHex, '25');
    assert.equal(r.price.value.valuation, 'peg_assumed');
    assert.equal(r.shareRate.value.hexPerTShareBeforeBonuses, '12345.6');
    assert.equal(r.todayPayoutEstimate.value.payoutHearts, '100000077');
    assert.equal(r.latestCompletedPayout.value.contractDay, 399);
    assert.equal(r.latestCompletedPayout.value.payoutHearts, '42');
    assert.equal(r.todayPayoutEstimate.finality, 'provisional');
    assert.equal(f.attempts.length, 4);
    assert.ok(f.attempts.every((x) => x.calls <= 30));
    assert.ok(r.price.notes.some((n) => n.includes('unknown')));
  }
});
test('startup metadata cached until bounded recheck; invalidation and same-block price conflict isolate components', async () => {
  const { f, service } = setup();
  assert.equal((await service.tick(signal)).price.status, 'fresh');
  const count = () => f.attempts.flatMap((a) => a.selectors).filter((x) => x === s.decimals).length;
  const initial = count();
  f.clock.time += 60000;
  await service.tick(signal);
  assert.equal(count(), initial);
  f.state.change = (rows, calls, id) =>
    rows.map((r, i) =>
      id === 'secondary' && calls[i].params[0]?.data === s.getReserves
        ? { ...r, result: '0x' + [1, 1, f.state.update].map(word).join('') }
        : r,
    );
  f.clock.time += 60000;
  const conflict = await service.tick(signal);
  assert.equal(conflict.price.value.usdPerHex, '25');
  assert.equal(conflict.price.status, 'stale');
  assert.equal(conflict.shareRate.status, 'fresh');
  f.state.change = null;
  f.clock.time += 3600000;
  await service.tick(signal);
  assert.ok(count() > initial);
});
test('price rejects low/zero depth, malformed data and wrong metadata, chain/code/block identities', async () => {
  const changes = [
    (r, c) =>
      c.params[0]?.data === s.getReserves
        ? { ...r, result: '0x' + [0, 1, 1].map(word).join('') }
        : r,
    (r, c) =>
      c.params[0]?.data === s.getReserves
        ? { ...r, result: '0x' + [1, 1, 1].map(word).join('') }
        : r,
    (r, c) => (c.params[0]?.data === s.getReserves ? { ...r, result: '0x00' } : r),
    (r, c) => (c.params[0]?.data === s.factory ? { ...r, result: '0x' + word(999) } : r),
    (r, c) => (c.params[0]?.data === s.token0 ? { ...r, result: '0x' + word(999) } : r),
    (r, c) => (c.params[0]?.data === s.decimals ? { ...r, result: '0x' + word(19) } : r),
    (r, c) => (c.method === 'eth_getCode' ? { ...r, result: '0x00' } : r),
    (r, c) => (c.method === 'eth_chainId' ? { ...r, result: '0x1' } : r),
    (r, c) =>
      c.method === 'eth_getBlockByNumber' ? { ...r, result: { ...r.result, hash: hash(999) } } : r,
  ];
  for (const mutate of changes) {
    const { f, service } = setup();
    f.state.change = (rows, calls, id) =>
      id === 'secondary' ? rows.map((r, i) => mutate(r, calls[i])) : rows;
    const r = await service.tick(signal);
    assert.equal(r.price.status, 'unavailable');
    assert.equal(r.shareRate.status, 'fresh');
  }
  assert.throws(() =>
    priceProfileSchema.parse({
      ...profile(),
      anchor: { token: addr(2), valuation: 'independent_anchor' },
    }),
  );
});
test('stalled block ages, old reserve activity stays dated, future source rejected, day transition and delayed ledger independent', async () => {
  const { f, store, service } = setup();
  let r = await service.tick(signal),
    first = r.price;
  f.state.stalled = Number(first.asOf.blockNumber);
  f.clock.time += 180000;
  r = await service.tick(signal);
  assert.equal(r.price.status, 'stale');
  assert.deepEqual(r.price.asOf, first.asOf);
  assert.notEqual(r.price.observedAt, first.observedAt);
  assert.equal(r.price.notes.at(-1), first.notes.at(-1));
  f.clock.time += 1801000;
  r = await readMetrics(store, 369, f.clock.now());
  assert.equal(r.price.status, 'unavailable');
  f.state.stalled = null;
  f.clock.time = EPOCH + 86400000 + 60000;
  r = await service.tick(signal);
  assert.equal(r.todayPayoutEstimate.value.contractDay, 401);
  assert.equal(r.todayPayoutEstimate.value.payoutHearts, '100000000');
  assert.equal(r.todayPayoutEstimate.value.stakeShares, '150');
  assert.equal(r.latestCompletedPayout.value.contractDay, 399);
  f.state.dayCount = 401;
  f.state.shares = 150n;
  f.state.nextShares = 0n;
  f.state.penalty = 0n;
  f.clock.time += 60000;
  r = await service.tick(signal);
  assert.equal(r.latestCompletedPayout.value.contractDay, 400);
  assert.equal(r.todayPayoutEstimate.value.payoutHearts, '100000000');
  f.clock.time += 86400000;
  assert.equal(
    (await readMetrics(store, 369, f.clock.now())).todayPayoutEstimate.status,
    'unavailable',
  );
  f.state.change = (rows, calls) =>
    rows.map((r, i) =>
      calls[i].method === 'eth_getBlockByNumber'
        ? {
            ...r,
            result: {
              ...r.result,
              timestamp: '0x' + BigInt(Math.floor(f.clock.now() / 1000) + 500).toString(16),
            },
          }
        : r,
    );
  assert.equal((await service.tick(signal)).shareRate.status, 'unavailable');
});
test('global/supply/ledger failures do not erase unrelated observations; missing profile and restart keep honest states', async () => {
  const { f, store, service, rpc, other } = setup();
  assert.equal((await readMetrics(store, 369, f.clock.now())).price.status, 'unavailable');
  await service.tick(signal);
  f.clock.time += 60000;
  f.state.change = (rows, calls) =>
    rows.map((r, i) =>
      calls[i].params[0]?.data === selectors.totalSupply ? { ...r, result: '0x' + word(0) } : r,
    );
  const r = await service.tick(signal);
  assert.equal(r.price.status, 'fresh');
  assert.equal(r.shareRate.status, 'fresh');
  assert.equal(r.todayPayoutEstimate.status, 'unavailable');
  const restart = new MetricsService([rpc, other], CODE_HASH, null, store);
  f.clock.time += 1801000;
  assert.equal((await readMetrics(restart.store, 369, f.clock.now())).price.status, 'unavailable');
  f.state.change = null;
  assert.equal((await restart.tick(signal)).price.reason, 'price_profile_unqualified');
  assert.equal(Object.keys(store.rows).length, 4);
});
test('cold zero/small/100 pages return actual pinned values inside two HTTP and 107 logical maximum', async () => {
  const measurements = [];
  for (const count of [0, 1, 3, 100, 101, 10000]) {
    const { f, rpc, service } = addressSetup();
    f.state.count = count;
    const before = f.clock.now(),
      r = await service.get(A, signal);
    assert.ok(['available', 'partial'].includes(r.outcome), JSON.stringify(r));
    assert.equal(r.live.page.items.length, Math.min(count, 100));
    assert.equal(r.live.page.enumerationComplete, count <= 100);
    assert.equal(r.live.balanceHearts, '9007199254740993123');
    AddressResultSchema.parse(r);
    assert.equal(rpc.counters.requests, 2);
    assert.equal(rpc.counters.logical, 7 + Math.min(count, 100));
    assert.ok(f.clock.now() - before < 10000);
    assert.equal(f.api.counters.logical, rpc.counters.logical);
    measurements.push({
      requested: 100,
      count,
      delivered: r.live.page.items.length,
      complete: r.live.page.enumerationComplete,
      http: rpc.counters.requests,
      logical: rpc.counters.logical,
      bytes: rpc.counters.bytes,
      virtualResponseMs: f.clock.now() - before,
    });
    const cached = await service.get(A, signal);
    assert.deepEqual(cached, r);
    assert.equal(rpc.counters.requests, 2);
  }
  console.log('ADDRESS_WORKLOAD ' + JSON.stringify(measurements));
});
test('continuations stay pinned, terminal page alone incomplete; address/tamper/expiry/restart/reorg cursor rejection', async () => {
  const { f, service } = addressSetup();
  f.state.count = 101;
  const first = await service.get(A, signal),
    cursor = first.live.page.nextCursor;
  const next = await service.get(A, signal, 100, cursor);
  assert.equal(next.outcome, 'partial');
  assert.equal(next.live.page.items.length, 1);
  assert.equal(next.live.page.nextCursor, null);
  assert.equal(next.live.page.enumerationComplete, false);
  assert.deepEqual(next.live.page.asOf, first.live.page.asOf);
  assert.equal((await service.get(B, signal, 100, cursor)).outcome, 'expired');
  assert.equal((await service.get(A, signal, 100, cursor + 'x')).outcome, 'expired');
  const restart = new AddressService(f.rpc('api', f.api), CODE_HASH, emptyBaseline);
  assert.equal((await restart.get(A, signal, 100, cursor)).outcome, 'expired');
  f.state.change = (rows, calls) =>
    rows.map((r, i) =>
      calls[i].method === 'eth_getBlockByNumber'
        ? { ...r, result: { ...r.result, hash: hash(999) } }
        : r,
    );
  assert.equal((await service.get(A, signal, 1, cursor)).outcome, 'expired');
  f.clock.time += 60001;
  assert.equal((await service.get(A, signal, 100, cursor)).outcome, 'expired');
});
test('swap deletion, unindexed starts, hint races, partial ID lookup and dated indexed fallback never imply false absence', async () => {
  const { f, service } = addressSetup();
  const first = await service.get(A, signal);
  assert.deepEqual(
    first.live.page.items.map((x) => x.stakeId),
    ['1', '2', '3'],
  );
  f.clock.time += 60001;
  f.state.count = 2;
  f.state.list = [3n, 4n];
  const next = await service.get(A, signal);
  assert.deepEqual(
    next.live.page.items.map((x) => x.stakeId),
    ['3', '4'],
  );
  assert.equal((await service.stake('999', signal)).outcome, 'indexing');
  f.clock.time = Math.ceil((f.clock.now() + 60001) / 10500) * 10500;
  f.state.hint = 1;
  const partial = await service.get(B, signal);
  assert.equal(partial.outcome, 'partial');
  assert.equal(partial.live.page.items.length, 1);
  assert.ok(partial.live.page.nextCursor);
  f.clock.time = Math.ceil((f.clock.now() + 60001) / 10500) * 10500;
  f.state.hint = 3;
  const shrunk = await service.get(B, signal);
  assert.equal(shrunk.outcome, 'available');
  assert.equal(shrunk.live.page.items.length, 2);
  f.clock.time = Math.ceil((f.clock.now() + 60001) / 10500) * 10500;
  f.state.count = 10000;
  f.state.hint = null;
  f.state.list = null;
  assert.equal((await service.stake('101', signal, A)).outcome, 'indexing');
});
test('byte cache eviction and separation; coalesced callers share work, one/last cancellation ownership', async () => {
  const cache = new ByteCache(600);
  cache.put('a', { v: 'x'.repeat(200) }, 100, 0);
  cache.put('b', { v: 'y'.repeat(200) }, 100, 0);
  assert.ok(cache.bytes <= 600);
  assert.equal(cache.get('a', 0), undefined);
  assert.equal(cache.evictions, 1);
  assert.equal(cache.get('b', 101), undefined);
  const { f, service, rpc } = addressSetup({ clock: new ManualClock() });
  const one = new AbortController(),
    two = new AbortController();
  const p1 = service.get(A, one.signal),
    p2 = service.get(A, two.signal);
  const denied = assert.rejects(p1);
  one.abort(new Error('one left'));
  await denied;
  const r = await f.clock.drive(p2);
  assert.equal(r.outcome, 'available');
  assert.equal(rpc.counters.requests, 2);
  assert.equal(service.counters.coalesced, 1);
  f.clock.time = Math.ceil(f.clock.now() / 10500) * 10500;
  const last = new AbortController();
  f.state.delay = async (s) =>
    new Promise((resolve, reject) =>
      s.addEventListener('abort', () => reject(s.reason), { once: true }),
    );
  const p3 = service.get(B, last.signal);
  await f.clock.advance(7000);
  const charged = rpc.counters.requests;
  const rejected = assert.rejects(p3);
  last.abort(new Error('last left'));
  await rejected;
  await f.clock.advance(10000);
  assert.equal(rpc.counters.requests, charged);
  assert.ok(charged > 2);
  assert.ok(service.counters.cancelled >= 1);
});
test('deadline/startup/cooldown admission and ten full pages report useful work plus overload without quota multiplication', async () => {
  const cold = fixture(),
    start = new AddressService(cold.rpc('api', cold.api), CODE_HASH, emptyBaseline);
  assert.equal((await start.get(A, signal)).outcome, 'quota');
  assert.equal(cold.attempts.length, 0);
  const { f, service, rpc } = addressSetup();
  f.state.count = 100;
  let success = 0,
    quota = 0;
  for (let i = 0; i < 10; i++) {
    f.clock.time = Math.ceil(f.clock.now() / 10500) * 10500;
    const r = await service.get(addr(100 + i), signal);
    if (r.live) success++;
    else if (r.outcome === 'quota') quota++;
  }
  assert.ok(success >= 1 && success <= 3);
  assert.ok(quota >= 7);
  assert.ok(rpc.counters.logical <= 360);
  assert.ok(rpc.counters.requests <= 12);
  console.log(
    'ADDRESS_OVERLOAD ' +
      JSON.stringify({ requestedPages: 10, pageSize: 100, success, quota, ...rpc.counters }),
  );
  f.clock.time += 60000;
  await f.store.extend(f.clock.now() + 120000);
  assert.equal((await service.get(addr(1000), signal)).outcome, 'quota');
  await assert.rejects(() => openAddressService({}), /disabled/);
});
