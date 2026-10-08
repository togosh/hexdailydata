import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { routes, jsonRevalidation } from '../../src/api/routes.ts';
import {
  HomeResponseSchema,
  ApiErrorSchema,
  UIntStringSchema,
  DecimalStringSchema,
} from '../../src/contracts/api.ts';
import { DailyQuery, StakesQuery, HoldersQuery, AddressQuery } from '../../src/contracts/reads.ts';
import { tokenSchema } from '../../src/contracts/history.ts';
import { PageCursors } from '../../src/services/queries/cursor.ts';
import {
  endpointGroups,
  examples,
  exampleCode,
  homeExcerpt,
  errorExample,
  errorGuidance,
} from '../../src/web/api-guide.ts';
const fixture = JSON.parse(readFileSync(new URL('../fixtures/home.json', import.meta.url)));
const spec = JSON.parse(readFileSync(new URL('../../docs/openapi.json', import.meta.url)));
test('all documented endpoints and bounded request examples match runtime schemas and OpenAPI', () => {
  const listed = endpointGroups.flatMap((g) => g.routes.map(({ id, path }) => ({ id, path })));
  assert.equal(listed.length, 18);
  assert.deepEqual(
    listed.map((x) => x.path).sort(),
    routes.map((x) => x.path.replace(/:([a-z]+)/g, '{$1}')).sort(),
  );
  for (const { id, path } of listed) {
    assert.equal(routes.find((r) => r.id === id).path.replace(/:([a-z]+)/g, '{$1}'), path);
    const p = spec.paths[path.replace(/:([a-z]+)/g, '{$1}')];
    assert.ok(p.get && p.head);
  }
  for (const [id, path] of Object.entries(examples)) {
    const url = new URL(path, 'http://127.0.0.1:12345');
    const route = routes.find((r) => r.path === url.pathname);
    assert.ok(route, id);
    route.query.parse(Object.fromEntries(url.searchParams));
    assert.equal(url.searchParams.get('chain'), 'pulsechain');
    assert.ok(exampleCode(url.origin, 'cURL', id).endsWith(`'${url.href}'`));
    assert.ok(!exampleCode(url.origin, 'cURL', id).includes('\n+'));
  }
  assert.deepEqual(
    [...jsonRevalidation].sort(),
    [
      'home',
      'daily',
      'markets',
      'stakes',
      'holders',
      'calculator',
      'downloads',
      'archiveCharts',
      'nativeCharts',
      'maturities',
    ].sort(),
  );
  assert.deepEqual(
    errorGuidance.map((x) => x[0]),
    [401, 403, 400, 409, 429, 503, 410],
  );
  ApiErrorSchema.parse(errorExample);
});
test('indexed defaults/bounds and HDS continuation/range are distinct; expired cursors restart', () => {
  for (const schema of [StakesQuery, HoldersQuery, AddressQuery]) {
    assert.equal(schema.parse({}).limit, 50);
    assert.equal(schema.parse({ limit: '100' }).limit, 100);
    for (const q of [{ limit: '0' }, { limit: '101' }, { offset: '1' }])
      assert.equal(schema.safeParse(q).success, false);
  }
  for (const lifecycle of ['open', 'good_accounted', 'ended']) StakesQuery.parse({ lifecycle });
  for (const lifecycle of ['queued', 'mature_open', 'cancelled'])
    assert.equal(StakesQuery.safeParse({ lifecycle }).success, false);
  for (const order of ['liquid', 'staker']) HoldersQuery.parse({ order });
  const range = { chain: 'pulsechain', from: '2023-01-01', to: '2024-01-01' };
  DailyQuery.parse(range);
  assert.equal(DailyQuery.safeParse({ ...range, to: '2024-01-02' }).success, false);
  const q = {
    ...range,
    source: 'hexdailystats',
    afterSourceDay: '1255',
    revision: '11111111-1111-4111-8111-111111111111',
  };
  DailyQuery.parse(q);
  for (const bad of [
    { ...q, revision: undefined },
    { ...q, afterSourceDay: undefined },
    { ...q, source: undefined },
    { ...q, chain: 'ethereum' },
    { ...range, cursor: 'a.b' },
  ])
    assert.equal(DailyQuery.safeParse(bad).success, false);
  const cursors = new PageCursors(),
    value = cursors.encode('query', 'cutoff', 'key', 1000, 2000);
  assert.equal(cursors.decode(value, 'query', 1999).identity, 'cutoff');
  assert.throws(() => cursors.decode(value, 'query', 2000));
  assert.throws(() => cursors.decode(value, 'other', 1000));
  assert.match(
    readFileSync(new URL('../../src/worker/history/store.ts', import.meta.url), 'utf8'),
    /rows\.slice\(0, 64\)/,
  );
});
test('displayed excerpt equals a projection of a schema-valid synthetic response; zeros/exact tokens stay distinct', () => {
  const full = HomeResponseSchema.parse(fixture);
  assert.deepEqual(homeExcerpt, {
    live: Object.fromEntries(
      ['price', 'shareRate', 'latestCompletedPayout'].map((k) => [
        k,
        { status: full.live[k].status, value: full.live[k].value },
      ]),
    ),
  });
  const alternate = structuredClone(full);
  alternate.live.latestCompletedPayout.value.payoutHearts = '0';
  alternate.live.latestCompletedPayout.value.stakeShares = '9007199254740993';
  alternate.live.latestCompletedPayout.value.hexPerTShare = '0';
  const parsed = HomeResponseSchema.parse(alternate);
  assert.equal(parsed.live.price.value, null);
  assert.equal(parsed.live.latestCompletedPayout.value.payoutHearts, '0');
  assert.equal(UIntStringSchema.parse('9007199254740993'), '9007199254740993');
  assert.equal(tokenSchema.parse('-1.23e-40'), '-1.23e-40');
  assert.equal(DecimalStringSchema.safeParse('1e-40').success, false);
});
test('every JavaScript example runs with injected fetch and checks non-2xx before JSON', async () => {
  const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor;
  for (const id of Object.keys(examples)) {
    let calls = 0,
      logged;
    const body = id === 'home' ? fixture : { exact: '9007199254740993', zero: '0', missing: null };
    const code = exampleCode('http://127.0.0.1:12345', 'JavaScript', id);
    const run = new AsyncFunction('fetch', 'console', code);
    await run(
      async (url, options) => {
        calls++;
        assert.equal(String(url), 'http://127.0.0.1:12345' + examples[id]);
        assert.equal(options.headers.Accept, 'application/json');
        return { ok: true, json: async () => body };
      },
      { log: (v) => (logged = v) },
    );
    assert.equal(calls, 1);
    assert.deepEqual(logged, body);
    await assert.rejects(
      () =>
        run(
          async () => ({
            ok: false,
            status: 503,
            json: () => {
              throw new Error('Must not parse');
            },
          }),
          { log: () => assert.fail() },
        ),
      /HTTP 503/,
    );
  }
  assert.throws(() => exampleCode('file:///tmp', 'cURL'));
});
