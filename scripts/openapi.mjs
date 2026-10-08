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
import { responseExamples, savedStakeExamples, savedHolderExamples, savedUpdateExamples, errors as errorExamples } from '../src/documentation/examples.mjs';

const schema = (value) => {
  const { $schema, ...result } = z.toJSONSchema(value, { io: 'input', target: 'draft-2020-12' });
  return result;
};

function requestExamples(route) {
  const date = { from: '2023-05-16', to: '2023-05-16' },
    chain = { chain: 'pulsechain' };
  const query = ['live', 'ready', 'download'].includes(route.id)
    ? {}
    : { ...chain, ...(['daily', 'markets'].includes(route.id) ? date : {}) };
  const params =
    route.id === 'stake'
      ? { id: '123' }
      : route.id.startsWith('address')
        ? { address: '0x' + '1'.repeat(40) }
        : route.id === 'download'
          ? { bundle: '11111111-1111-4111-8111-111111111111', dataset: 'daily' }
          : {};
  const samples = [
    {
      label: route.id === 'daily' ? 'Native history' : 'GET example',
      query,
      params,
      variant: route.id === 'daily' ? 'native' : undefined,
    },
  ];
  if (route.id === 'daily')
    samples.push({
      label: 'Source-reported HDS',
      query: { ...query, source: 'hexdailystats' },
      params,
      variant: 'sourceReported',
    });
  if (route.id === 'stakes')
    samples.push({
      label: 'Synthetic maturity/5-HEX minimum example — not live data',
      query: {
        ...chain,
        lifecycle: 'open',
        limit: '3',
        maturityFromDay: '2001',
        maturityToDay: '2007',
        minPrincipalHearts: '500000000',
      },
      params,
    });
  if (['stakes', 'stake', 'address', 'addressStakes'].includes(route.id))
    samples.push({ label: 'Saved subgraph snapshot (opt-in)', query: { ...chain, ...savedStakeExamples.query[route.id] }, params: savedStakeExamples.params[route.id] ?? {}, variant: 'savedSubgraph' });
  if (route.id === 'holders') samples.push({ label: 'Saved holder snapshot (opt-in)', query: { ...chain, ...savedHolderExamples.query }, params: {}, variant: 'savedSubgraph' });
  if (savedUpdateExamples.responses[route.id]) samples.push({label:'Saved source update · 6 October 2026 (base plus observed updates)',query:savedUpdateExamples.query[route.id],params:savedUpdateExamples.params[route.id],variant:'savedUpdate'});
  return samples.map((sample) => {
    route.query.parse(sample.query);
    route.params.parse(sample.params);
    const path = route.path.replace(/:([a-z]+)/g, (_, name) =>
      encodeURIComponent(sample.params[name]),
    );
    const search = new URLSearchParams(sample.query).toString();
    return {
      label: sample.label,
      path: path + (search ? '?' + search : ''),
      ...(sample.variant ? { variant: sample.variant } : {}),
      ...(route.id === 'download' ? { template: true } : {}),
      ...(['stake', 'address', 'addressStakes'].includes(route.id)
        ? { note: sample.variant === 'savedUpdate' ? 'Actual base plus observed update example; fixed historical target, full B1 inventory unproved.' : sample.variant === 'savedSubgraph' ? 'Actual saved source example at the disclosed fixed block; not current data.' : 'Synthetic ID/address: replace with the record you need.' }
        : {}),
    };
  });
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
  const revalidates = jsonRevalidation.has(route.id) || route.id === 'download' || sourceAddressOnly;
  const description = `${purpose}\n\n${detail}` + (dataRoutes.has(route.id) ? '\n\n' + essentials.errors + '\n\n' + essentials.access : route.id === 'download' ? '\n\n' + essentials.downloads : '\n\nPublic unmetered metadata. Authorization is ignored.');
  const security = route.id === 'stakeEvents' || route.id === 'download' ? [{ bearerKey: [] }] : dataRoutes.has(route.id) ? [{}, { bearerKey: [] }] : [];
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
          ? (sourceAddressOnly ? 'Saved subgraph only: public no-cache, must-revalidate; paid private, no-store. Native address responses retain no-store.' : 'Public JSON: no-cache, must-revalidate. Paid JSON: private, no-store.')
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
  if (dataRoutes.has(route.id) || route.id === 'download') headers.Vary = header('Authorization, Cookie');
  const parameters = [];
  for (const [location, object] of [
    ['query', route.query],
    ['path', route.params],
  ]) {
    let json = schema(object);
    // The four additive saved-source query variants keep native validation intact.
    if (json.anyOf) {
      const variants = json.anyOf;
      const keys = [...new Set(variants.flatMap(v => Object.keys(v.properties ?? {})))];
      json = { properties: Object.fromEntries(keys.map(key => {
        const choices = variants.map(v => v.properties?.[key]).filter(Boolean);
        const unique = [...new Map(choices.map(v => [JSON.stringify(v), v])).values()];
        return [key, unique.length === 1 ? unique[0] : { anyOf: unique }];
      })), required: keys.filter(key => variants.every(v => (v.required ?? []).includes(key))) };
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
    responses[304] = { description: (sourceAddressOnly ? 'Saved subgraph variant only. ' : '') + 'Available identity and unchanged representation. No body.' };
  if (route.response) {
    if (!responseExamples[route.id]) throw new Error(`Missing complete example: ${route.id}`);
    responses[200].content['application/json'].examples = Object.fromEntries(
      Object.entries(responseExamples[route.id]).map(([name, value]) => [
        name,
        {
          summary: name === 'savedUpdate' ? 'Actual saved base-plus-observed-updates view — 6 October 2026, full B1 inventory unproved' : name === 'savedSubgraph' && ['holders', 'address', 'addressStakes'].includes(route.id) ? 'Actual saved subgraph example — 5 October 2026, not live data' : `Synthetic ${name} example — not live data`,
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
        version: '2.0.0',
        description:
          'Read-only HEX data for apps, scripts and dashboards. Native examples are synthetic; saved-source examples disclose their historical pin. No public deployment or current data claim.\n\n' +
          essentials.exact +
          '\n\n' +
          essentials.freshness +
          '\n\nCross-field day/chain/ratio/cursor/coverage refinements are also enforced at runtime; addresses normalize to lowercase. No production qualification implied.',
      },
      servers: [{ url: '/', description: 'Current origin; no hosted service is implied.' }],
      tags: groups.map((g) => ({ name: g.title })),
      paths,
      components: { securitySchemes: { bearerKey: { type: 'http', scheme: 'bearer', description: 'Existing account API key in Authorization only. Complete CSV also accepts the actual same-origin account session.' } } },
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
