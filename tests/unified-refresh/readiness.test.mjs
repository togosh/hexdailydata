import assert from 'node:assert/strict';
import test from 'node:test';
import { readinessRoutes, finalOrdinaryAdoption } from '../../scripts/unified-refresh/owner.mjs';
import { ProductQuery, ProductPageQuery } from '../../dist/contracts/product-daily.js';
test('genuine readiness uses the required bounded daily range', () => {
  assert.equal(ProductQuery.safeParse({ limit: '1' }).success, false);
  const routes = readinessRoutes('2026-10-10');
  for (const [i, path] of routes.entries()) {
    const query = Object.fromEntries(new URL(path, 'http://127.0.0.1').searchParams);
    assert.equal((i === 0 ? ProductQuery : ProductPageQuery).safeParse(query).success, true);
  }
  assert.match(routes[0], /from=2026-10-10&to=2026-10-10&limit=1$/);
  assert.throws(() => readinessRoutes('2026-10-10&source=other'));
});
test('final ordinary adoption waits one poll interval and refuses prolonged lag', async () => {
  let calls = 0,
    waits = 0;
  const receipts = [];
  const save = async (name, value) => receipts.push({ name, ...value });
  await finalOrdinaryAdoption(
    async () => ({ adoptionPending: ++calls === 1 }),
    save,
    async (ms) => {
      assert.equal(ms, 1050);
      waits++;
    },
  );
  assert.equal(calls, 2);
  assert.equal(waits, 1);
  assert.equal(receipts[0].status, 'PASS');
  calls = 0;
  waits = 0;
  await assert.rejects(
    () =>
      finalOrdinaryAdoption(
        async () => {
          calls++;
          return { adoptionPending: true };
        },
        save,
        async (ms) => {
          assert.equal(ms, 1050);
          waits++;
        },
      ),
    /ADOPTION_NOT_OBSERVED/,
  );
  assert.equal(calls, 5);
  assert.equal(waits, 4);
  assert.equal(receipts[1].status, 'FAIL');
});
