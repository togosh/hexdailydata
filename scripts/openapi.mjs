import { writeFileSync, readFileSync } from 'node:fs';
import { z } from 'zod';
import { routes, jsonRevalidation } from '../src/api/routes.ts';
import { ApiErrorSchema } from '../src/contracts/api.ts';

const schema = (value) => {
  const { $schema, ...result } = z.toJSONSchema(value, { io: 'input', target: 'draft-2020-12' });
  return result;
};
const paths = {};
for (const route of routes) {
  const parameters = [];
  for (const [location, object] of [
    ['query', route.query],
    ['path', route.params],
  ]) {
    const json = schema(object);
    for (const [name, value] of Object.entries(json.properties ?? {}))
      parameters.push({
        name,
        in: location,
        required: location === 'path' || (json.required ?? []).includes(name),
        schema: value,
      });
  }
  const responses = {
    200: {
      description: route.response
        ? 'Validated response; availability and cutoffs are component-specific.'
        : 'Immutable CSV; Range is ignored and the full file is returned.',
      content: route.response
        ? { 'application/json': { schema: schema(route.response) } }
        : { 'text/csv': { schema: { type: 'string' } } },
    },
  };
  if (jsonRevalidation.has(route.id) || route.id === 'download')
    responses[304] = { description: 'Available identity and unchanged representation. No body.' };
  if (route.id === 'home')
    responses[200].content['application/json'].example = route.response.parse(
      JSON.parse(readFileSync('tests/fixtures/home.json', 'utf8')),
    );
  const errors = [400, 405, 429, 503];
  if (['daily', 'stakes', 'stake', 'holders', 'address', 'addressStakes'].includes(route.id))
    errors.push(409);
  if (route.id === 'download') errors.push(410);
  for (const code of errors.sort((a, b) => a - b))
    responses[code] = {
      description: 'Sanitized error. See interfaces.md for route semantics.',
      content: { 'application/json': { schema: schema(ApiErrorSchema) } },
    };
  paths[route.path.replace(/:([a-z]+)/g, '{$1}')] = {
    get: { operationId: route.id, parameters, responses },
    head: {
      operationId: route.id + 'Head',
      parameters,
      responses: Object.fromEntries(
        Object.entries(responses).map(([code, v]) => [code, { description: v.description }]),
      ),
    },
  };
}
const output =
  JSON.stringify(
    {
      openapi: '3.1.0',
      info: {
        title: 'HEXDailyData read API',
        version: '2.0.0',
        description:
          'Runtime Zod definitions. Cross-field day/chain/ratio/cursor/coverage refinements are additionally enforced in runtime tests; transforms normalize addresses. No production qualification implied.',
      },
      paths,
    },
    null,
    2,
  ) + '\n';
if (process.argv.includes('--check')) {
  if (readFileSync('docs/openapi.json', 'utf8') !== output)
    throw new Error('Generated OpenAPI is out of date.');
} else writeFileSync('docs/openapi.json', output);
console.log(`${routes.length} routes; deterministic OpenAPI ${Buffer.byteLength(output)} bytes`);
