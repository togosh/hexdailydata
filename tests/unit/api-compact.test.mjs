import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  resources,
  selection,
  matchingResources,
  parameterFacts,
} from '../../src/web/api-reference.ts';
import { operationLink, requestCode } from '../../src/web/api-guide.ts';
import { routes } from '../../src/api/routes.ts';
import { createApp } from '../../dist/api/app.js';
import { responseExamples } from '../../src/documentation/examples.mjs';
const doc = JSON.parse(readFileSync('docs/openapi.json'));
test('human projection is exactly18 GET resources; old links, legacy aliases and unknown recovery', () => {
  assert.equal(resources.length, 18);
  assert.deepEqual(resources.map((r) => r.id).sort(), routes.map((r) => r.id).sort());
  for (const route of resources) {
    assert.equal(selection(operationLink(route.id).split('/api/reference')[1]).id, route.id);
    assert.equal(selection(operationLink(route.id) + 'Head').unknown, true);
    assert.equal(selection(`#tag/${route.group}/${route.id}Head`).id, route.id);
    assert.equal(operationLink(route.id + 'Head'), operationLink(route.id));
  }
  assert.deepEqual(selection('#tag/wrong/home'), { id: 'home', unknown: true });
  assert.equal(selection('').id, 'home');
  assert.equal(matchingResources('headers').length, 0);
  assert.equal(matchingResources('/api/v2/home')[0].id, 'home');
  assert.equal(matchingResources('Home overview')[0].id, 'home');
});
test('actual loopback data GET/HEAD preserve JSON, headers, validation and bodyless revalidation without SQL', async () => {
  const app = createApp({
    dependencies: {
      downloads: { catalog: async () => structuredClone(responseExamples.downloads.synthetic) },
    },
  });
  try {
    const base = await app.listen({ host: '127.0.0.1', port: 0 });
    for (const path of ['/health/live', '/api/v2/downloads?chain=pulsechain']) {
      const get = await fetch(base + path);
      assert.equal(get.status, 200);
      const body = await get.text();
      assert.ok(body.length);
      const head = await fetch(base + path, { method: 'HEAD' });
      assert.equal(head.status, 200);
      assert.equal(await head.text(), '');
      assert.equal(head.headers.get('content-type'), get.headers.get('content-type'));
      assert.equal(head.headers.get('content-length'), String(Buffer.byteLength(body)));
      if (get.headers.has('etag')) {
        assert.equal(head.headers.get('etag'), get.headers.get('etag'));
        const cached = await fetch(base + path, {
          method: 'HEAD',
          headers: { 'if-none-match': get.headers.get('etag') },
        });
        assert.equal(cached.status, 304);
        assert.equal(await cached.text(), '');
      }
    }
    const invalid = await fetch(base + '/api/v2/home?chain=invalid', { method: 'HEAD' });
    assert.equal(invalid.status, 400);
    assert.equal(await invalid.text(), '');
  } finally {
    await app.close();
  }
});
test('parameter facts preserve zero/default/enum/bounds/nullable alternatives without flattening', () => {
  assert.ok(
    parameterFacts({ type: 'integer', default: 0, minimum: 0, maximum: 100 }).includes(
      'Default: 0',
    ),
  );
  assert.ok(parameterFacts({ type: 'string' }).includes('No default'));
  const union = { anyOf: [{ type: 'string' }, { type: 'null' }] };
  const frozen = JSON.stringify(union);
  assert.ok(parameterFacts(union).includes('Alternatives: see exact parameter JSON'));
  assert.equal(JSON.stringify(union), frozen);
  for (const resource of Object.values(doc.paths))
    for (const p of resource.get.parameters) {
      const facts = parameterFacts(p.schema);
      for (const key of ['minimum', 'maximum', 'minLength', 'maxLength'])
        if (p.schema[key] !== undefined)
          assert.ok(facts.some((f) => f.endsWith(String(p.schema[key]))));
      if (p.schema.enum)
        for (const e of p.schema.enum) assert.ok(facts.some((f) => f.includes(JSON.stringify(e))));
    }
});
test('all generated requests parse actual path/query validators; JSON/CSV JS code preserves exact values and refuses HTTP errors', async () => {
  for (const route of routes) {
    const path = route.path.replace(/:([a-z]+)/g, '{$1}');
    const op = doc.paths[path].get;
    for (const sample of op['x-requests']) {
      const url = new URL(sample.path, 'http://127.0.0.1:1234');
      route.query.parse(Object.fromEntries(url.searchParams));
      const parts = url.pathname.split('/'),
        pattern = route.path.split('/');
      route.params.parse(
        Object.fromEntries(
          pattern.flatMap((p, i) => (p.startsWith(':') ? [[p.slice(1), parts[i]]] : [])),
        ),
      );
      if (sample.variant)
        assert.ok(op.responses[200].content['application/json'].examples[sample.variant]);
      for (const language of ['cURL', 'JavaScript', 'Python'])
        assert.ok(
          requestCode(url.origin, language, sample.path, route.id === 'download').includes(
            url.origin,
          ),
        );
      const text = requestCode(url.origin, 'JavaScript', sample.path, route.id === 'download');
      const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor;
      const execute = new AsyncFunction('fetch', 'console', text);
      const value =
        route.id === 'download'
          ? 'exact,9007199254740993\n'
          : { exact: '9007199254740993', missing: null };
      let logged;
      await execute(
        async (called) => {
          assert.equal(called.href, url.href);
          return { ok: true, json: async () => value, text: async () => value };
        },
        { log: (v) => (logged = v) },
      );
      assert.deepEqual(logged, value);
      await assert.rejects(
        () =>
          execute(async () => ({ ok: false, status: 503 }), {
            log() {
              throw new Error('must not log failed data');
            },
          }),
        /HTTP 503/,
      );
    }
  }
  assert.equal(doc.paths['/api/v2/daily'].get['x-requests'].length, 2);
  assert.equal(
    doc.paths['/api/v2/downloads/{bundle}/{dataset}'].get['x-requests'][0].template,
    true,
  );
});
