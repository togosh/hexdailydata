import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, mkdirSync, copyFileSync, unlinkSync, rmdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { z } from 'zod';
import { routes, jsonRevalidation } from '../../src/api/routes.ts';
import { ApiErrorSchema } from '../../src/contracts/api.ts';
import { responseExamples } from '../../src/documentation/examples.mjs';
import { operationLink } from '../../src/web/api-guide.ts';
import { createApp } from '../../dist/api/app.js';
const doc = JSON.parse(readFileSync('docs/openapi.json'));
const catalog = JSON.parse(readFileSync('src/web/api-catalog.json'));
const schema = (value) => {
  const { $schema, ...rest } = z.toJSONSchema(value, { io: 'input', target: 'draft-2020-12' });
  return rest;
};
test('18 resources, 36 operations, all runtime parameter/response structures, complete examples and local refs', () => {
  assert.equal(doc.openapi, '3.1.0');
  assert.equal(Object.keys(doc.paths).length, 18);
  assert.deepEqual(
    doc.servers.map((s) => s.url),
    ['/'],
  );
  assert.deepEqual(
    catalog.flatMap((g) => g.routes.map((r) => r.id)).sort(),
    routes.map((r) => r.id).sort(),
  );
  for (const route of routes) {
    const path = route.path.replace(/:([a-z]+)/g, '{$1}'),
      resource = doc.paths[path];
    assert.deepEqual(Object.keys(resource), ['get', 'head']);
    for (const method of ['get', 'head']) {
      const op = resource[method];
      assert.equal(op.operationId, route.id + (method === 'head' ? 'Head' : ''));
      assert.ok(op.summary.trim() && op.description.trim() && op.tags.length === 1);
      const expected = [];
      for (const [location, validator] of [
        ['query', route.query],
        ['path', route.params],
      ]) {
        const json = schema(validator);
        for (const [name, value] of Object.entries(json.properties ?? {}))
          expected.push({
            name,
            in: location,
            required: location === 'path' || (json.required ?? []).includes(name),
            schema: value,
          });
      }
      assert.deepEqual(
        op.parameters.map(({ description, ...rest }) => {
          assert.ok(description.trim());
          return rest;
        }),
        expected,
      );
      for (const [status, response] of Object.entries(op.responses)) {
        if (method === 'head' || status === '304') {
          assert.equal(response.content, undefined);
          continue;
        }
        const media = status === '200' && !route.response ? 'text/csv' : 'application/json';
        const content = response.content[media];
        assert.ok(content);
        assert.deepEqual(
          content.schema,
          status === '200'
            ? route.response
              ? schema(route.response)
              : { type: 'string' }
            : schema(ApiErrorSchema),
        );
        if (media === 'application/json') {
          assert.ok(Object.keys(content.examples).length);
          for (const example of Object.values(content.examples)) {
            assert.match(example.summary, /Synthetic/);
            (status === '200' ? route.response : ApiErrorSchema).parse(example.value);
          }
        } else assert.equal(content.examples, undefined);
      }
      assert.equal(!!op.responses[304], jsonRevalidation.has(route.id) || route.id === 'download');
      assert.ok(op.responses[429].headers['Retry-After']);
      assert.ok(op.responses[405].headers.Allow);
    }
    assert.ok(operationLink(route.id).endsWith('/' + route.id));
  }
  const visit = (value) => {
    if (!value || typeof value !== 'object') return;
    if (value.$ref) {
      assert.ok(value.$ref.startsWith('#/'));
      let target = doc;
      for (const part of value.$ref.slice(2).split('/'))
        target = target[part.replaceAll('~1', '/').replaceAll('~0', '~')];
      assert.ok(target);
    }
    for (const child of Object.values(value)) visit(child);
  };
  visit(doc);
  assert.equal(Object.keys(responseExamples).length, 17);
  assert.equal(Object.keys(responseExamples.daily).length, 2);
  assert.equal(responseExamples.stakes.synthetic.items[0].principalHearts, '9007199254740993');
  assert.equal(responseExamples.address.partial.live, null);
  assert.equal(responseExamples.address.partial.indexed.liquidHearts, '0');
});
test('missing stable schema stays JSON404; app never falls back to HTML', async () => {
  const dir = resolve('dist/documentation-missing-schema');
  mkdirSync(dir);
  copyFileSync('dist/web/index.html', dir + '/index.html');
  const app = createApp({ webRoot: dir, dependencies: {} });
  try {
    for (const method of ['GET', 'HEAD']) {
      const r = await app.inject({ method, url: '/openapi.json' });
      assert.equal(r.statusCode, 404);
      assert.match(r.headers['content-type'], /json/);
      assert.equal(r.json().error.code, 'not_found');
    }
  } finally {
    await app.close();
    unlinkSync(dir + '/index.html');
    rmdirSync(dir);
  }
});
test('Docker recipe includes the new generation inputs without changing install/runtime policies', () => {
  const file = readFileSync('deploy/Dockerfile', 'utf8');
  for (const line of ['COPY src ./src', 'COPY scripts/openapi.mjs ./scripts/openapi.mjs'])
    assert.ok(file.includes(line));
  assert.ok(!file.includes('COPY tests/'));
  assert.deepEqual(
    readFileSync('src/documentation/home-example.json'),
    readFileSync('tests/fixtures/home.json'),
  );
  assert.match(file, /RUN npm ci\n/);
  assert.match(file, /RUN npm run build && npm prune --omit=dev/);
  assert.match(
    readFileSync('package.json', 'utf8'),
    /node scripts\/openapi.mjs && tsc -p tsconfig.build.json && vite build/,
  );
});
