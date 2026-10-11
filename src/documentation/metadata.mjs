// Current candidate contract. Retired provider selectors are not normal API variants.
export const groups = [
  {
    id: 'api-summary',
    title: 'Daily & latest',
    routes: ['home', 'daily', 'latest', 'markets', 'calculator'],
  },
  {
    id: 'api-stakes',
    title: 'Stakes & addresses',
    routes: ['stakes', 'stakeEvents', 'stake', 'holders', 'address', 'addressStakes'],
  },
  { id: 'api-charts', title: 'Schedule', routes: ['maturities'] },
  { id: 'api-downloads', title: 'Downloads', routes: ['downloads', 'download'] },
  { id: 'api-health', title: 'Status & health', routes: ['status', 'live', 'ready'] },
];
export const metadata = {
  home: [
    'Home overview',
    'Latest Daily context and independently aged latest readings.',
    'Uses the same admitted product as Daily and Live. A historical reference quote is never a live spot quote.',
  ],
  daily: [
    'Daily history',
    'One selected reporting-date dataset.',
    'UTC recorded snapshots, independently supported contract-day payouts and one primary historical reference price. Ordinary precise strings/nulls; no provider or dataset choice.',
  ],
  latest: [
    'Latest observations',
    'Latest qualified readings with their actual observation ages.',
    'Saved records remain stale; unqualified current feeds remain null. servedAtUtc is not an observation timestamp.',
  ],
  markets: [
    'Daily market projection',
    'Convenience alias of the same Daily service.',
    'Returns the same selected rows and values. The route has its own bound cursors; no competing price calculation.',
  ],
  stakes: [
    'Stake records',
    'Selected saved stake-start list with original relationships.',
    'Lexical source-ID order, optional owner address, no invented maturity/lifecycle or active-staker semantics.',
  ],
  holders: [
    'Holder records',
    'Selected saved holder-source rows.',
    'Preserves zero, absent and negative anomaly distinctions. Counts are source records, not people or a complete new target census.',
  ],
  stake: [
    'Stake detail',
    'Original selected saved record and source links.',
    'Reported fields, original decimals, discrepancy evidence and individual observation provenance remain.',
  ],
  address: [
    'Address summary',
    'Compatible selected holder balance and stake page.',
    'One internally selected pair per request. Missing is not zero; anomalies are not spendable balances.',
  ],
  addressStakes: [
    'Address stakes',
    'Same selected address/holder/stake projection.',
    'No caller-selected source or generation. Cursors restart when the product or access context changes.',
  ],
  calculator: [
    'Calculator inputs',
    'Raw protocol share rate and exact completed-ledger payout means from one admitted product.',
    'Raw globals word 2, never a reversed display ratio. The 1/30/365 windows preserve gaps and zero shares. Rate: 120-second fresh / 1800-second last-known policy. USD conversion separately requires same-generation HEX/USD no older than 300 seconds. Missing inputs remain unavailable.',
  ],
  stakeEvents: [
    'Stake activity',
    'Existing canonical event contract, backend not activated here.',
    'Unavailable in ordinary file-backed mode; access checks still run first. Legacy SQL requires its original API authority and continuation proof. No source records become raw events.',
  ],
  maturities: [
    'Maturity schedule',
    'Existing native schedule contract, backend not activated here.',
    'Returns structured 503 capability_unavailable in ordinary file-backed mode. Unknown source locked/maturity days are not inferred.',
  ],
  downloads: [
    'Complete export status',
    'Selected daily CSV implementation and release gate.',
    'Same authoritative projection as Daily. Public release/backend and data-rights qualification remain open.',
  ],
  download: [
    'Complete CSV',
    'Purchased-access protected selected daily file.',
    'Authorization precedes all file reads, HEAD and conditional responses. No static bulk file. Other legacy export families are not replaced with fabricated files.',
  ],
  status: [
    'System qualification',
    'Existing parked-indexer/system status.',
    'Production readiness remains false. Daily/Live include their own data coverage and ages.',
  ],
  live: [
    'Process liveness',
    'Process health only.',
    'This does not indicate fresh product data; use /api/v2/live for observations.',
  ],
  ready: [
    'Readiness',
    'Configured data dependency readiness.',
    'No provider call or acquisition.',
  ],
};
const migration =
  'source, view, series, generation, datasetVersion, holderDatasetVersion and old revision selectors are rejected with 400 selection_migrated. Omit them and restart pagination.';
export const rules = Object.fromEntries(
  Object.keys(metadata).map((id) => [id, id === 'live' || id === 'ready' ? [] : [migration]]),
);
rules.daily.push(
  'Inclusive ordered range at most 366 UTC dates; limit 1–100, default100. Return nextCursor unchanged with the same filters. Dates outside the admitted domain return an empty/clipped page; no extrapolation.',
);
rules.markets.push(...rules.daily.slice(1));
for (const id of ['stakes', 'holders'])
  rules[id].push(
    'Public global browse: at most50 rows and five pages. Additional traversal requires a separately qualified paid backend, inactive in the ordinary entry. Advanced maturity/amount filters return 400; a key does not implement them. Known-address pages retain100-row bounds. No financial ranking.',
  );
rules.latest.push(
  'Freshness thresholds: markets/liquidity/protocol300s; gas60s; saved state3600s; historical ledger86400s. Groups keep separate times. HTTP revalidation includes current age/status.',
);
rules.download.push(
  'Complete CSV uses the same admitted daily rows. GET/HEAD/304 all require current purchased authority. Release remains gated without a qualified authorizer.',
);
export const essentials = {
  exact:
    'Amounts are precise numeric strings or null. Never convert authoritative magnitudes to binary floating point. Hearts are10^-8 HEX; payoutStakeShares are raw shares, distinct from snapshot totalTshares. Product contractDay is computed from dateUtc, not the legacy source index.',
  freshness:
    'Daily records describe history, not live freshness. Latest response groups carry original observedAtUtc/age/status. servedAtUtc is only response time. Saved base plus observed updates is not a complete current inventory.',
  indexed:
    'Opaque cursors bind route, product, selection and access context and expire after60seconds. Keep filters unchanged and restart on409; users do not choose a dataset version.',
  hds: 'Historical material is an internal bootstrap input, not a source selector or alternate product. Provider choices are retired. One selected Daily response preserves snapshot/ledger/reference-price meanings and explicit gaps.',
  address:
    'Address responses preserve original reported records and coherent paired holder/stake versions. Absence is not zero; negative bookkeeping anomalies are not ordinary balances.',
  errors:
    'A supplied invalid/revoked/duplicate API key never falls back to public access. Successful paid GET/HEAD/304 uses the original allowance hold; failures/cancellation release it. HTTP/input bounds and429backoff remain. No arbitrary SQL or RPC access.',
  downloads:
    'Complete daily CSV is the actual selected projection. Existing purchased-access authorization, private caching and reader admission remain. The ordinary entry does not activate account/payment services. Free /samples/*.csv files are bounded SYNTHETIC SAMPLE / fixed partial fixtures, not complete exports. Real account/payment backend and redistribution remain unqualified.',
  access:
    'No Authorization means bounded public JSON, even with a session. Public admission remains120requests/minute and8active per socket source. Complete CSV has separate authorization and is unmetered against JSON allowance.',
  caching:
    'Paid responses use private,no-store. Public JSON uses no-cache,must-revalidate. ETags and HEAD/304 never bypass authorization. Daily ETags bind selection/product/access; Live also changes with age/status.',
};
export function parameterDescription(id, name) {
  const descriptions = {
    chain:
      'Product chain; ordinary selected data uses PulseChain with labelled Ethereum-origin reference history.',
    from: 'Inclusive UTC reporting date.',
    to: 'Inclusive UTC reporting date; range maximum366days.',
    limit: 'Maximum page size; keep unchanged with cursor.',
    cursor: 'Opaque nextCursor; restart expired/incompatible pagination.',
    metric:
      'Metric of interest; typed full rows retain one shared value for API, Charts and CSV.',
    asset:
      'Optional metric context (HEX/BTC/ETH/PLS), not a provider or price-series selection.',
    address: 'Optional owner address, normalized lowercase.',
    order: 'source-id-asc only; no financial ranking.',
    id: 'Unsigned decimal stake ID below2^40.',
    bundle: 'Immutable selected-export UUID; syntactic validity does not establish authority.',
    dataset: 'Complete export family; only the selected daily export is qualified locally.',
    fromBlock: 'Original canonical event lower-bound semantics.',
    stakeId: 'Original canonical event stake identifier.',
    kind: 'Original canonical event kind filter.',
  };
  if (!descriptions[name]) throw Error('Missing parameter metadata: ' + id + '/' + name);
  return descriptions[name];
}
