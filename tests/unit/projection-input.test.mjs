import test from 'node:test';
import assert from 'node:assert/strict';
import { validateBatch, uint, total } from '../../src/services/projections/input.ts';
import { databaseConfig } from '../../src/db/connect.ts';
import { header, hash, CONTRACT, A, B } from '../sql/fixtures.mjs';
function input() {
  const h = header(101, 10),
    event = {
      originChainId: 1,
      contract: CONTRACT,
      blockNumber: h.number,
      blockHash: h.hash,
      blockTime: h.timestamp,
      transactionHash: hash(500),
      transactionIndex: 0,
      logIndex: 0,
      topics: [hash(999)],
      data: '0x',
      value: { kind: 'transfer', sender: A, recipient: B, hearts: '90071992547409931234567890' },
    };
  const content = {
    next: null,
    previous: header(100, 10, 99, 9),
    headers: [h],
    events: [event],
    closes: [],
    payouts: [],
  };
  return {
    chainId: 1,
    contract: CONTRACT,
    range: { fromBlock: h.number, toBlock: h.number },
    expected: { blockNumber: '100', blockHash: hash(100), revision: '0' },
    sources: [
      { id: 'one', operator: 'one', ...content },
      { id: 'two', operator: 'two', ...structuredClone(content) },
    ],
  };
}
test('normalized SQL boundary preserves integer strings and requires explicit v2 targets', () => {
  assert.equal(validateBatch(input()).events[0].value.hearts, '90071992547409931234567890');
  for (const value of [1, 1.5, '1.5', '-1', '01', '1e6', String(2n ** 256n)])
    assert.equal(uint.safeParse(value).success, false);
  assert.equal(
    total.parse(String((2n ** 256n - 1n) * 5555n * 9223372036854775807n)).length <= 102,
    true,
  );
  assert.throws(() => databaseConfig('worker', {}), /Explicit/);
});
test('range acceptance compares full source sets, raw payloads, parent identity and source lineage', () => {
  const omitted = input();
  omitted.sources[1].events = [];
  assert.throws(() => validateBatch(omitted), /disagreement/);
  const payload = input();
  payload.sources[1].events[0].data = '0x01';
  assert.throws(() => validateBatch(payload), /disagreement/);
  const parent = input();
  parent.sources.forEach((s) => (s.headers[0].parentHash = hash(99)));
  assert.throws(() => validateBatch(parent), /Noncontiguous/);
  const backend = input();
  backend.sources[1].operator = 'one';
  assert.throws(() => validateBatch(backend), /upstreams/);
  const duplicate = input();
  duplicate.sources.forEach((s) => s.events.push(structuredClone(s.events[0])));
  assert.equal(validateBatch(duplicate).events.length, 1);
  duplicate.sources.forEach((s) => (s.events[1].value.hearts = '1'));
  assert.throws(() => validateBatch(duplicate), /Conflicting/);
});
test('correlated identical omission is a documented limit, not a false completeness proof', () => {
  const omitted = input();
  omitted.sources.forEach((s) => {
    s.events = [];
    s.operator = null;
  });
  assert.equal(validateBatch(omitted).acceptance.eventCount, 0);
});
test('transaction hash and block/index identity are one-to-one while multiple logs remain valid', () => {
  const multi = input();
  multi.sources.forEach((s) => s.events.push({ ...structuredClone(s.events[0]), logIndex: 1 }));
  assert.equal(validateBatch(multi).events.length, 2);
  const distinct = structuredClone(multi);
  distinct.sources.forEach((s) => {
    s.events[1].transactionHash = hash(501);
    s.events[1].transactionIndex = 1;
  });
  assert.equal(validateBatch(distinct).events.length, 2);
  const twoIndexes = structuredClone(multi);
  twoIndexes.sources.forEach((s) => (s.events[1].transactionIndex = 1));
  assert.throws(() => validateBatch(twoIndexes), /transaction identity/);
  const twoHashes = structuredClone(multi);
  twoHashes.sources.forEach((s) => (s.events[1].transactionHash = hash(501)));
  assert.throws(() => validateBatch(twoHashes), /transaction identity/);
  const twoBlocks = structuredClone(multi);
  twoBlocks.sources.forEach((s) => {
    const h = header(102, 10, 101, 11);
    s.headers.push(h);
    Object.assign(s.events[1], {
      blockNumber: h.number,
      blockHash: h.hash,
      blockTime: h.timestamp,
      logIndex: 0,
    });
  });
  assert.throws(() => validateBatch(twoBlocks), /transaction identity/);
});
