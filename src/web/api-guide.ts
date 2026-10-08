import catalog from './api-catalog.json' with { type: 'json' };
export const endpointGroups = catalog;
export const operationLink = (id: string) => {
  const routeId = id.endsWith('Head') ? id.slice(0, -4) : id;
  const group = catalog.find((g) => g.routes.some((r) => r.id === routeId));
  if (!group) throw new Error('Unknown documentation operation');
  return `/api/reference#tag/${group.id}/${routeId}`;
};
export const examples = {
  home: '/api/v2/home?chain=pulsechain',
  daily: '/api/v2/daily?chain=pulsechain&from=2023-05-15&to=2023-05-16',
  stakes: '/api/v2/stakes?chain=pulsechain&lifecycle=open&limit=25',
  hds: '/api/v2/daily?chain=pulsechain&source=hexdailystats&from=2023-05-15&to=2023-05-16',
  catalog: '/api/v2/downloads?chain=pulsechain',
} as const;
export type ExampleId = keyof typeof examples;
export type ExampleLanguage = 'cURL' | 'JavaScript' | 'Python';
export function exampleCode(origin: string, language: ExampleLanguage, id: ExampleId = 'home') {
  return requestCode(origin, language, examples[id]);
}
export function requestCode(origin: string, language: ExampleLanguage, path: string, csv = false) {
  const base = new URL(origin);
  if (!['http:', 'https:'].includes(base.protocol)) throw new Error('An HTTP origin is required.');
  const url = new URL(path, base.origin).href;
  const accept = csv ? 'text/csv' : 'application/json';
  const paid = csv || path.startsWith('/api/v2/stake-events') || /maturityFromDay|minPrincipalHearts/.test(path);
  if (language === 'cURL')
    return `curl --fail-with-body --silent --show-error ${paid ? '--header "Authorization: Bearer $HDD_API_KEY" ' : ''}--header 'Accept: ${accept}' '${url.replaceAll("'", "'\\''")}'`;
  if (language === 'Python')
    return `import json${paid ? ", os" : ""}
from urllib.request import Request, urlopen

request = Request(${JSON.stringify(url)}, headers={"Accept": "${accept}"${paid ? ', "Authorization": "Bearer " + os.environ["HDD_API_KEY"]' : ''}})
with urlopen(request, timeout=15) as response:
    data = ${csv ? 'response.read().decode("utf-8")' : 'json.load(response)'}
# HTTP errors raise HTTPError; exact numeric strings remain strings.
print(${csv ? 'data' : 'json.dumps(data)'})`;
  return `const url = new URL(${JSON.stringify(path)}, ${JSON.stringify(base.origin)});
const response = await fetch(url, {
  headers: { Accept: '${accept}'${paid ? ", Authorization: 'Bearer ' + process.env.HDD_API_KEY" : ''} }
});
if (!response.ok) throw new Error('HTTP ' + response.status);
const data = await response.${csv ? 'text' : 'json'}();
// Keep exact numeric strings; check component status before use.
console.log(data);`;
}
// Projection of the archived schema-valid Home fixture, not a complete response.
export const homeExcerpt = {
  live: {
    price: { status: 'unavailable', value: null },
    shareRate: {
      status: 'fresh',
      value: { rawShareRate: '100001', hexPerTShareBeforeBonuses: '10000.1' },
    },
    latestCompletedPayout: {
      status: 'stale',
      value: {
        contractDay: 1000,
        displayDay: 1001,
        hexPerTShare: '0.33333333',
        payoutHearts: '1',
        stakeShares: '30000',
        kind: 'completed',
      },
    },
  },
} as const;
export const errorExample = {
  error: { code: 'invalid_request', message: 'Invalid request.', retryable: false },
  requestId: 'synthetic-example',
};
export const errorGuidance = [
  [401, 'Supplied key is invalid; never retry as public access.'],
  [403, 'An active API key is required for this selection. Restart pagination when changing access mode.'],
  [400, 'Malformed input: check paths, query fields and bounds.'],
  [
    409,
    'Incompatible or expired selection: restart pagination; do not splice observations or blindly retry the same cursor.',
  ],
  [429, 'Back off and honor Retry-After; admission limits are not customer quotas.'],
  [
    503,
    'Required data is unavailable. Check service state and use bounded retries when appropriate.',
  ],
  [410, 'Retired export: refresh the catalog and select an available bundle.'],
] as const;
