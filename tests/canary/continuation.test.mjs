import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { dayBoundaryPlan } from './prefix-fixture.mjs';
import { canaryPlanSchema, pinnedAuditAdmissionSchema } from '../../dist/operator/canary-plan.js';
import { PrefixScope } from '../../dist/operator/canary-prefix.js';
import { topics } from '../../dist/providers/abi.js';
import { digest } from '../../dist/services/projections/input.js';
import { totalColumns } from '../../dist/services/projections/reduce.js';
import { A, B, hash } from '../sync/fixture.mjs';
process.env.HDD_V2_PROJECT = 'hexdailydata-v2-continuation-unit';
process.env.HDD_V2_DB_INSTANCE = '69be4d7d-207d-4236-bee2-6c9ec6b7f391';
const inventory = [
  { address: A, hearts: '900719925474099312345678' },
  { address: B, hearts: '0' },
];
function plan() {
  const p = dayBoundaryPlan('/synthetic');
  p.ranges = [{ chain: 1, from: '355', to: '1380' }];
  p.methods = ['eth_chainId', 'eth_getBlockByNumber', 'eth_getCode', 'eth_getLogs', 'eth_call'];
  p.phases = [
    {
      ...p.phases[0],
      kind: 'common-continue',
      admission: {
        volume: 'hexdailydata-v2-test_db_data',
        checkpoint: {
          number: '355',
          hash: hash(355),
          parentHash: hash(354),
          timestamp: '1575417263',
        },
        revision: '2',
        sourceBindingDigest: 'a'.repeat(64),
        counts: Object.fromEntries(
          Object.keys(pinnedAuditAdmissionSchema.shape.counts.shape).map((k) => [
            k,
            k === 'accounts' ? '2' : '0',
          ]),
        ),
        current: { contract_day: 0, ...Object.fromEntries(totalColumns.map((k) => [k, '0'])) },
      },
      inventoryDigest: digest(inventory),
      canonicalDigest: 'b'.repeat(64),
      priorSession: randomUUID(),
      priorStorageIdentity: '1:1',
      priorQuotaIdentity: '1:2',
      priorDispatchFloor: 0,
    },
  ];
  return canaryPlanSchema.parse(p);
}
test('continuation schema admits only explicit S<T bounded origin1 windows and a distinct immutable grant', () => {
  const p = plan();
  for (const mutate of [
    (p) => (p.phases[0].through = p.ranges[0].to = '355'),
    (p) => (p.phases[0].through = p.ranges[0].to = '354'),
    (p) => (p.phases[0].through = p.ranges[0].to = '3001'),
    (p) => (p.phases[0].priorSession = p.session),
    (p) => (p.phases[0].admission.counts.accounts = '0'),
    (p) => p.methods.push('eth_getTransactionReceipt'),
    (p) => (p.methods[4] = 'eth_getTransactionReceipt'),
    (p) => p.phases.push({ kind: 'metrics', purpose: 'TEST unexpected phase' }),
    (p) => (p.allowHeadObservation = false),
    (p) => (p.profile.commonHistory = 'ethereum'),
    (p) => (p.ranges[0].chain = 369),
    (p) => (p.ranges[0].from = '100'),
    ...Object.entries({
      milliseconds: 3600001,
      http: 601,
      logical: 12001,
      bytes: 268435457,
      responseBytes: 4194305,
    }).map(
      ([k, v]) =>
        (p) =>
          (p.caps[k] = v),
    ),
  ]) {
    const q = structuredClone(p);
    mutate(q);
    assert.equal(canaryPlanSchema.safeParse(q).success, false);
  }
  const q = structuredClone(p);
  q.profile.fork.parent.number = '20000';
  q.profile.fork.parent.hash = hash(20000);
  q.profile.fork.entry.number = '20001';
  q.profile.fork.entry.parentHash = hash(20000);
  q.profile.target.number = '20010';
  q.phases[0].finalityHeaders.minimum = '20010';
  q.ranges[0].to = q.phases[0].through = String(355 + 16384);
  assert(canaryPlanSchema.safeParse(q).success);
  q.ranges[0].to = q.phases[0].through = String(355 + 16385);
  assert(!canaryPlanSchema.safeParse(q).success);
});
test('continuation scope admits inherited inventory and validated new events, never old logs or external state pins', () => {
  const p = plan(),
    phase = p.phases[0],
    scope = new PrefixScope(p, phase, p.profile.ethereum[0].id, inventory);
  assert.throws(() => new PrefixScope(p, phase), /inventory/);
  assert.throws(() => new PrefixScope(p, phase, 'TEST', [inventory[0]]), /inventory/);
  const balance = (address, blockHash = hash(355)) => ({
    method: 'eth_call',
    params: [
      { to: p.profile.contract, data: '0x70a08231' + address.slice(2).padStart(64, '0') },
      { blockHash, requireCanonical: true },
    ],
  });
  const header = (n) => ({
    id: 1,
    method: 'eth_getBlockByNumber',
    params: ['0x' + BigInt(n).toString(16), false],
  });
  const observed = (h, transactions = []) => ({
    ...h,
    number: '0x' + BigInt(h.number).toString(16),
    timestamp: '0x' + BigInt(h.timestamp).toString(16),
    transactions,
  });
  assert.throws(() => scope.request(1, [balance(B)]), /unverified/);
  scope.response(
    [header(355)],
    JSON.stringify([{ id: 1, result: observed(phase.admission.checkpoint) }]),
  );
  scope.request(1, [balance(B)]);
  for (const [from, to] of [
    [354, 356],
    [355, 356],
    [356, 1381],
  ])
    assert.throws(
      () =>
        scope.request(1, [
          {
            method: 'eth_getLogs',
            params: [
              {
                address: p.profile.contract,
                fromBlock: '0x' + from.toString(16),
                toBlock: '0x' + to.toString(16),
                topics: [Object.values(topics)],
              },
            ],
          },
        ]),
      /outside scope/,
    );
  assert.throws(() => scope.request(369, [balance(B)]));
  assert.throws(() =>
    scope.request(1, [
      { method: 'eth_getTransactionReceipt', params: [p.profile.constructor.transactionHash] },
    ]),
  );
  assert.throws(
    () => scope.request(1, [{ method: 'eth_getCode', params: [p.profile.contract, '0xbb8'] }]),
    /outside/,
  );
  const final = { ...p.profile.target, number: '3011', hash: hash(3011), parentHash: hash(3010) };
  scope.response(
    [{ ...header(3011), params: ['finalized', false] }],
    JSON.stringify([{ id: 1, result: observed(final) }]),
  );
  scope.request(1, [header(3011)]);
  scope.response([header(3011)], JSON.stringify([{ id: 1, result: observed(final) }]));
  assert.throws(() => scope.request(1, [balance(B, final.hash)]), /unverified/);
  const address = '0x' + '33'.repeat(20);
  assert.throws(() => scope.request(1, [balance(address)]), /inventory/);
  const logs = {
    id: 2,
    method: 'eth_getLogs',
    params: [
      {
        address: p.profile.contract,
        fromBlock: '0x258',
        toBlock: '0x258',
        topics: [Object.values(topics)],
      },
    ],
  };
  const log = {
    address: p.profile.contract,
    blockNumber: '0x258',
    blockHash: hash(600),
    transactionIndex: '0x0',
    transactionHash: hash(60000),
    logIndex: '0x0',
    removed: false,
    topics: [
      '0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef',
      '0x' + A.slice(2).padStart(64, '0'),
      '0x' + address.slice(2).padStart(64, '0'),
    ],
    data: '0x' + '1'.padStart(64, '0'),
  };
  scope.request(1, [logs]);
  scope.response([logs], JSON.stringify([{ id: 2, result: [log] }]));
  scope.response(
    [header(600)],
    JSON.stringify([
      {
        id: 1,
        result: observed(
          { number: '600', hash: hash(600), parentHash: hash(599), timestamp: '1575500000' },
          [hash(60000)],
        ),
      },
    ]),
  );
  scope.request(1, [balance(address, hash(600))]);
});
