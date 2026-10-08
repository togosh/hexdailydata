import { dataRoutes } from '../src/api/data-access.ts';
import { writeFileSync, readFileSync, mkdirSync } from 'node:fs';
import { z } from 'zod';
import { routes, jsonRevalidation } from '../src/api/routes.ts';
import { ApiErrorSchema } from '../src/contracts/api.ts';
import {
  groups,
  metadata,
  parameterDescription,
  essentials,
  rules,
} from '../src/documentation/metadata.mjs';
import {
  responseExamples,
  savedStakeExamples,
  savedHolderExamples,
  savedUpdateExamples,
  errors as errorExamples,
} from '../src/documentation/examples.mjs';

const schema = (value) => {
  const { $schema, ...result } = z.toJSONSchema(value, { io: 'input', target: 'draft-2020-12' });
  return result;
};

const productExamples = JSON.parse(
  readFileSync(new URL('../src/documentation/product-examples.json', import.meta.url)),
);
for (const id of ['daily', 'home', 'markets', 'latest', 'downloads'])
  responseExamples[id] = productExamples[id];
for (const id of ['stakes', 'stake', 'holders', 'address', 'addressStakes'])
  responseExamples[id] = { accepted: savedUpdateExamples.responses[id] };
function requestExamples(route) {
  const query = ['daily', 'markets'].includes(route.id)
    ? { from: '2020-01-01', to: '2020-01-31' }
    : {};
  const params =
    route.id === 'stake'
      ? { id: '83544' }
      : route.id.startsWith('address')
        ? { address: '0x' + '0'.repeat(36) + '0369' }
        : route.id === 'download'
          ? { bundle: '11111111-1111-4111-8111-111111111111', dataset: 'daily' }
          : {};
  route.query.parse(query);
  route.params.parse(params);
  const path = route.path.replace(/:([a-z]+)/g, (_, key) => encodeURIComponent(params[key]));
  return [
    {
      label: 'Normal request',
      path: path + (Object.keys(query).length ? '?' + new URLSearchParams(query) : ''),
      ...(route.id === 'download' ? { template: true } : {}),
    },
  ];
}

const paths = {};
const ids = routes.map((r) => r.id).sort();
if (
  JSON.stringify(ids) !== JSON.stringify(Object.keys(metadata).sort()) ||
  JSON.stringify(ids) !== JSON.stringify(groups.flatMap((g) => g.routes).sort())
)
  throw new Error('Documentation metadata must cover each route exactly once.');
const header = (description) => ({ description, schema: { type: 'string' } });
for (const route of routes) {
  const [summary, purpose, detail] = metadata[route.id];
  const sourceAddressOnly = ['address', 'addressStakes', 'stake'].includes(route.id);
  const revalidates =
    jsonRevalidation.has(route.id) || route.id === 'download' || sourceAddressOnly;
  const description =
    `${purpose}\n\n${detail}` +
    (dataRoutes.has(route.id)
      ? '\n\n' + essentials.errors + '\n\n' + essentials.access
      : route.id === 'download'
        ? '\n\n' + essentials.downloads
        : '\n\nPublic unmetered metadata. Authorization is ignored.');
  const security =
    route.id === 'stakeEvents' || route.id === 'download'
      ? [{ bearerKey: [] }]
      : dataRoutes.has(route.id)
        ? [{}, { bearerKey: [] }]
        : [];
  const headers = {
    'Content-Type': header(
      route.response
        ? 'application/json; charset=utf-8 on JSON responses.'
        : 'text/csv; charset=utf-8',
    ),
    'Cache-Control': header(
      route.id === 'download'
        ? 'private, no-store. Authorization is required before HEAD/304.'
        : revalidates
          ? sourceAddressOnly
            ? 'Public no-cache,must-revalidate; paid private,no-store.'
            : 'Public JSON: no-cache, must-revalidate. Paid JSON: private, no-store.'
          : 'no-store',
    ),
    'Content-Length': header(
      'Representation byte length on a successful GET/HEAD; HEAD sends no body.',
    ),
  };
  if (revalidates)
    headers.ETag = header('Representation identity; use If-None-Match for revalidation.');
  if (route.id === 'download')
    Object.assign(headers, {
      'Content-Disposition': header('attachment; filename="{dataset}-{bundle}.csv"'),
      'Accept-Ranges': header('none; Range is ignored and the complete representation is sent.'),
    });
  if (dataRoutes.has(route.id) || route.id === 'download')
    headers.Vary = header('Authorization, Cookie');
  const parameters = [];
  for (const [location, object] of [
    ['query', route.query],
    ['path', route.params],
  ]) {
    let json = schema(object);
    // The four additive saved-source query variants keep native validation intact.
    if (json.anyOf) {
      const variants = json.anyOf;
      const keys = [...new Set(variants.flatMap((v) => Object.keys(v.properties ?? {})))];
      json = {
        properties: Object.fromEntries(
          keys.map((key) => {
            const choices = variants.map((v) => v.properties?.[key]).filter(Boolean);
            const unique = [...new Map(choices.map((v) => [JSON.stringify(v), v])).values()];
            return [key, unique.length === 1 ? unique[0] : { anyOf: unique }];
          }),
        ),
        required: keys.filter((key) => variants.every((v) => (v.required ?? []).includes(key))),
      };
    }
    for (const [name, value] of Object.entries(json.properties ?? {}))
      parameters.push({
        name,
        in: location,
        required: location === 'path' || (json.required ?? []).includes(name),
        description: parameterDescription(route.id, name),
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
      headers,
    },
  };
  if (jsonRevalidation.has(route.id) || route.id === 'download' || sourceAddressOnly)
    responses[304] = {
      description:
        (sourceAddressOnly ? 'Saved subgraph variant only. ' : '') +
        'Available identity and unchanged representation. No body.',
    };
  if (route.response) {
    if (!responseExamples[route.id]) throw new Error(`Missing complete example: ${route.id}`);
    responses[200].content['application/json'].examples = Object.fromEntries(
      Object.entries(responseExamples[route.id]).map(([name, value]) => [
        name,
        {
          summary:
            name === 'accepted'
              ? 'Accepted historical local data; not live or deployed'
              : name === 'savedUpdate'
                ? 'Actual saved base-plus-observed-updates view — 6 October 2026, full B1 inventory unproved'
                : name === 'savedSubgraph' &&
                    ['holders', 'address', 'addressStakes'].includes(route.id)
                  ? 'Actual saved subgraph example — 5 October 2026, not live data'
                  : `Synthetic ${name} example — not live data`,
          value: route.response.parse(value),
        },
      ]),
    );
  }
  const errors = [400, 405, 429, 503];
  if (dataRoutes.has(route.id) || route.id === 'download') errors.push(401, 403);
  if (
    ['daily', 'stakes', 'stakeEvents', 'stake', 'holders', 'address', 'addressStakes'].includes(
      route.id,
    )
  )
    errors.push(409);
  if (route.id === 'download') errors.push(410);
  for (const code of errors.sort((a, b) => a - b))
    responses[code] = {
      description: {
        400: 'Invalid path/query/input bounds.',
        401: 'Supplied credential is invalid; no public or session fallback.',
        403: 'Paid selection requires active purchased authority; no fallback.',
        405: 'Method not allowed.',
        409:
          route.id === 'stakeEvents'
            ? 'Canonical continuation proof unavailable or changed; explicitly reset and replay.'
            : route.id === 'stake'
              ? 'Conflicting owner hint or incompatible observation.'
              : 'Incompatible/expired selection; restart with a consistent observation.',
        410: 'Immutable bundle retired; refresh the catalog.',
        429: 'Resource admission or provider quota reached; back off.',
        503: 'Required data/dependency unavailable; a retryable flag does not justify unlimited retries.',
      }[code],
      headers: {
        'Cache-Control': header('no-store'),
        ...(code === 429 ? { 'Retry-After': header('60 seconds') } : {}),
        ...(code === 405 ? { Allow: header('GET, HEAD') } : {}),
      },
      content: {
        'application/json': {
          schema: schema(ApiErrorSchema),
          examples: {
            synthetic: {
              summary: 'Synthetic error — not live data',
              value: ApiErrorSchema.parse({
                error:
                  code === 409 && route.id === 'stakeEvents'
                    ? {
                        code: 'reset_required',
                        message:
                          'Continuation proof is unavailable or changed; explicitly reset and replay.',
                        retryable: false,
                      }
                    : code === 409 && route.id === 'stake'
                      ? {
                          code: 'incompatible_owner',
                          message: 'Owner hint conflicts with indexed history.',
                          retryable: false,
                        }
                      : errorExamples[code],
                requestId: 'synthetic-doc-example',
              }),
            },
          },
        },
      },
    };
  paths[route.path.replace(/:([a-z]+)/g, '{$1}')] = {
    get: {
      operationId: route.id,
      security,
      summary,
      description,
      tags: [groups.find((g) => g.routes.includes(route.id)).title],
      parameters,
      responses,
      'x-rules': rules[route.id] ?? [],
      'x-requests': requestExamples(route),
    },
    head: {
      operationId: route.id + 'Head',
      security,
      summary: summary + ' headers',
      description:
        'Same validation and availability checks as GET, with no response body.\n\n' + description,
      tags: [groups.find((g) => g.routes.includes(route.id)).title],
      parameters,
      responses: Object.fromEntries(
        Object.entries(responses).map(([code, v]) => [
          code,
          { description: v.description, ...(v.headers ? { headers: v.headers } : {}) },
        ]),
      ),
    },
  };
}
const output =
  JSON.stringify(
    {
      openapi: '3.1.0',
      info: {
        title: 'HEXDailyData API reference',
        version: '2.1.0-unified-daily',
        description:
          'Read-only HEX data for apps, scripts and dashboards. The normal Daily/Live contract is version daily-product-1; provider/view selectors have retired. Accepted examples are saved historical data; other backend examples are labelled synthetic. No public deployment or current data claim.\n\n' +
          essentials.exact +
          '\n\n' +
          essentials.freshness +
          '\n\nCross-field day/chain/ratio/cursor/coverage refinements are also enforced at runtime; addresses normalize to lowercase. No production qualification implied.',
      },
      servers: [{ url: '/', description: 'Current origin; no hosted service is implied.' }],
      tags: groups.map((g) => ({ name: g.title })),
      paths,
      components: {
        securitySchemes: {
          bearerKey: {
            type: 'http',
            scheme: 'bearer',
            description:
              'Existing account API key in Authorization only. Complete CSV also accepts the actual same-origin account session.',
          },
        },
      },
      'x-essentials': essentials,
    },
    null,
    2,
  ) + '\n';
const catalog =
  JSON.stringify(
    groups.map((g) => ({
      ...g,
      routes: g.routes.map((id) => ({
        id,
        title: metadata[id][0],
        description: metadata[id][1],
        path: routes.find((r) => r.id === id).path.replace(/:([a-z]+)/g, '{$1}'),
      })),
    })),
    null,
    2,
  ) + '\n';
for (const [file, content] of [
  ['docs/openapi.json', output],
  ['src/web/api-catalog.json', catalog],
]) {
  if (process.argv.includes('--check')) {
    if (readFileSync(file, 'utf8') !== content) throw new Error(`${file} is out of date.`);
  } else {
    mkdirSync(file.substring(0, file.lastIndexOf('/')), { recursive: true });
    writeFileSync(file, content);
  }
}
console.log(
  `${routes.length} routes, ${routes.length * 2} operations; OpenAPI ${Buffer.byteLength(output)} bytes; catalog ${Buffer.byteLength(catalog)} bytes; all complete JSON/error examples validated`,
);
