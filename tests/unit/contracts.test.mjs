import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  HomeResponseSchema,
  LiveStakePageSchema,
  UIntStringSchema,
  DecimalStringSchema,
  StatusResponseSchema,
  ApiErrorSchema,
} from '../../src/contracts/api.ts';
import { createApp } from '../../src/api/app.ts';
import { developmentConfig } from '../../src/api/config.ts';

const example = () => JSON.parse(readFileSync('tests/fixtures/home.json', 'utf8'));
test('published JSON example validates and round-trips without numeric coercion', () => {
  const home = example();
  assert.deepEqual(HomeResponseSchema.parse(home), home);
  assert.deepEqual(JSON.parse(JSON.stringify(HomeResponseSchema.parse(home))), home);
});
test('DTOs reject malformed amounts, days, chains and false final estimates', () => {
  for (const invalid of [1, 1n, '01', '-1', '1e8', 'NaN', ' 1', '0x1', '9'.repeat(79)]) {
    assert.equal(UIntStringSchema.safeParse(invalid).success, false);
  }
  for (const invalid of ['1e8', '-1', '1.', '.1', '00.1', '1,000', 'Infinity']) {
    assert.equal(DecimalStringSchema.safeParse(invalid).success, false);
  }
  for (const mutate of [
    (home) => {
      home.live.shareRate.value.rawShareRate = 'NaN';
    },
    (home) => {
      home.live.latestCompletedPayout.value.stakeShares = '0';
    },
    (home) => {
      home.live.latestCompletedPayout.value.displayDay = 1;
    },
    (home) => {
      home.live.latestCompletedPayout.value.kind = 'current_day_estimate';
    },
    (home) => {
      home.live.shareRate.asOf.blockNumber = 123;
    },
    (home) => {
      home.live.shareRate.observedAt = '2020-01-01T00:00:00Z';
    },
    (home) => {
      home.live.todayPayoutEstimate.finality = 'finalized';
    },
    (home) => {
      home.live.todayPayoutEstimate.value = 0;
    },
    (home) => {
      home.live.shareRate.asOf.chainId = 1;
    },
    (home) => {
      home.live.shareRate.asOf.blockTimestamp = '2026-02-30T00:00:00Z';
    },
    (home) => {
      home.internalPath = '/secret';
    },
  ]) {
    const home = example();
    mutate(home);
    assert.equal(HomeResponseSchema.safeParse(home).success, false);
  }
});
test('live stake page cannot claim completion while advertising another page', () => {
  const page = {
    address: '0x' + 'a'.repeat(40),
    asOf: example().live.shareRate.asOf,
    finality: 'provisional',
    observedAt: '2026-09-19T00:00:01Z',
    stakeCount: '0',
    items: [],
    nextCursor: null,
    enumerationComplete: true,
  };
  assert.equal(LiveStakePageSchema.safeParse(page).success, true);
  assert.equal(LiveStakePageSchema.safeParse({ ...page, nextCursor: 'next' }).success, false);
});
test('Fastify factory reports unavailable honestly, validates queries and returns safe errors', async (t) => {
  const app = createApp();
  t.after(() => app.close());
  const status = await app.inject('/api/v2/status');
  assert.equal(status.statusCode, 200);
  StatusResponseSchema.parse(status.json());
  assert.equal(status.headers['cache-control'], 'no-store');
  for (const [url, expected] of [
    ['/health/ready', 503],
    ['/api/v2/home', 503],
    ['/api/v2/home?chain=not-a-chain', 400],
    ['/api/v2/home?rpc=http://elsewhere', 400],
    ['/missing', 404],
  ]) {
    const response = await app.inject(url);
    assert.equal(response.statusCode, expected);
    ApiErrorSchema.parse(response.json());
    assert.doesNotMatch(response.body, /stack|node_modules|C:\\/);
  }
  const write = await app.inject({ method: 'POST', url: '/api/v2/status' });
  assert.equal(write.statusCode, 405);
  ApiErrorSchema.parse(write.json());
});
test('entry configuration rejects live enablement and malformed ports before listening', () => {
  assert.deepEqual(developmentConfig({}), { host: '127.0.0.1', port: 4320, mode: 'development' });
  for (const env of [
    { HDD_V2_MODE: 'live' },
    { HDD_V2_ALLOW_LIVE_RPC: 'true' },
    { HDD_V2_HTTP_PORT: '65536' },
    { HDD_V2_HTTP_PORT: '3e3' },
    { HDD_V2_HTTP_HOST: 'provider.example' },
  ]) {
    assert.throws(() => developmentConfig(env));
  }
});
