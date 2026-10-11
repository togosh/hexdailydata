import assert from 'node:assert/strict';
import test from 'node:test';
import { readinessRoutes } from '../../scripts/unified-refresh/owner.mjs';
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
