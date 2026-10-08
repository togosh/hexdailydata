import test from 'node:test';
import assert from 'node:assert/strict';
import { StakeEventsQuery, StakeEventsResponseSchema } from '../../src/contracts/stake-events.ts';
import { createApp } from '../../dist/api/app.js';
import { stakeActivityExamples } from '../../src/documentation/stake-events-examples.mjs';

// The composed product requires a paid key for events. These reader/response tests
// inject admission only; they do not establish account, entitlement or SQL success.
const headers = { authorization: 'Bearer lab_' + 'A'.repeat(43) };
const paidReads = { begin: async () => {}, close: async () => {} };

test('activity selection keeps exact int64/from, stake ID, normalized address and canonical limits', () => {
  assert.deepEqual(StakeEventsQuery.parse({}), { chain: 'pulsechain', fromBlock: '0', limit: 50 });
  assert.equal(
    StakeEventsQuery.parse({ fromBlock: '9223372036854775807' }).fromBlock,
    '9223372036854775807',
  );
  assert.equal(
    StakeEventsQuery.parse({ address: '0x' + 'AB'.repeat(20) }).address,
    '0x' + 'ab'.repeat(20),
  );
  for (const query of [
    { fromBlock: '9223372036854775808' },
    { fromBlock: '01' },
    { fromBlock: '-1' },
    { stakeId: '1099511627776' },
    { address: '0x' + '1'.repeat(40), stakeId: '1' },
    { limit: '01' },
    { limit: '1e2' },
    { limit: '101' },
    { limit: ['50', '50'] },
    { kind: 'cancelled' },
    { cursor: '' },
    { cursor: 'x'.repeat(2049) },
    { chain: 'ethereum' },
    { offset: '1' },
  ])
    assert.equal(StakeEventsQuery.safeParse(query).success, false, JSON.stringify(query));
});

test('actual app rejects malformed selection before read; normal GET/HEAD error envelope and unavailable dependency', async () => {
  let reads = 0;
  const app = createApp({
    paidReads,
    dependencies: {
      db: {
        read: async () => {
          reads++;
          throw Error('must not read');
        },
      },
    },
  });
  const unconfigured = createApp({ dependencies: {}, paidReads });
  try {
    for (const query of [
      'limit=50&limit=50',
      'fromBlock=01',
      'cursor=e30',
      'limit=',
      'unknown=1',
    ]) {
      const r = await app.inject({ url: '/api/v2/stake-events?' + query, headers });
      assert.equal(r.statusCode, 400);
      assert.equal(r.json().error.code, 'invalid_request');
      assert.equal(r.json().error.retryable, false);
    }
    assert.equal(reads, 0);
    for (const method of ['GET', 'HEAD']) {
      const r = await unconfigured.inject({ method, url: '/api/v2/stake-events', headers });
      assert.equal(r.statusCode, 503);
      assert.equal(r.headers['cache-control'], 'private, no-store');
      if (method === 'GET') assert.equal(r.json().error.code, 'not_initialized');
      else assert.equal(r.body, '');
    }
  } finally {
    await app.close();
    await unconfigured.close();
  }
});

test('application validates the new response; maximal schema fixture fits the route byte ceiling', async () => {
  const max = (2n ** 256n - 1n).toString(),
    example = structuredClone(stakeActivityExamples.lifecycle);
  const item = example.items[0];
  Object.assign(item, {
    eventId: 'x'.repeat(90),
    blockNumber: '9223372036854775807',
    stakeId: '1099511627775',
    transactionIndex: Number.MAX_SAFE_INTEGER,
    logIndex: Number.MAX_SAFE_INTEGER,
  });
  item.kind = 'stake_end';
  item.amounts = {
    principalHearts: max,
    stakeShares: max,
    payoutHearts: max,
    penaltyHearts: max,
    servedDays: 5555,
    previouslyUnlocked: false,
  };
  example.items = Array.from({ length: 100 }, () => structuredClone(item));
  example.nextCursor = 'x'.repeat(2048);
  example.scannedEvents = 200;
  StakeEventsResponseSchema.parse(example);
  assert.ok(Buffer.byteLength(JSON.stringify(example)) < 512 * 1024);
  const app = createApp({
    paidReads,
    dependencies: {
      db: {
        read: async () => ({
          ...example,
          items: [{ ...item, amounts: { ...item.amounts, principalHearts: '-1' } }],
        }),
      },
    },
  });
  try {
    const r = await app.inject({ url: '/api/v2/stake-events', headers });
    assert.equal(r.statusCode, 503);
    assert.equal(r.json().error.code, 'source_unavailable');
    assert.equal(r.json().error.retryable, true);
  } finally {
    await app.close();
  }
});
