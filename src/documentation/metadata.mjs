// Documentation metadata only. Runtime schemas remain authoritative.
export const groups = [
  {
    id: 'api-summary',
    title: 'Summary & daily data',
    routes: ['home', 'daily', 'markets', 'calculator'],
  },
  {
    id: 'api-stakes',
    title: 'Stakes & addresses',
    routes: ['stakes', 'stakeEvents', 'stake', 'holders', 'address', 'addressStakes'],
  },
  {
    id: 'api-charts',
    title: 'Charts',
    routes: ['nativeCharts', 'archiveCharts', 'maturities'],
  },
  {
    id: 'api-downloads',
    title: 'Downloads',
    routes: ['downloads', 'download'],
  },
  {
    id: 'api-health',
    title: 'Status & health',
    routes: ['status', 'live', 'ready'],
  },
];
export const metadata = {
  home: [
    'Home overview',
    'Summary with independently qualified price, share-rate and payout observations.',
    'Check each observation independently; unavailable values are null, not zero.',
  ],
  daily: [
    'Daily history',
    'Native daily rows, HDS history or explicitly selected saved contract ledger.',
    'Native, source-reported HDS and saved contract-ledger history are separate response variants.',
  ],
  markets: [
    'Daily markets',
    'Separate market sources, methods and interval coverage.',
    'Sampled ratios stay exact; missing intervals are null. USD peg/source-reported qualifications are not a USD guarantee.',
  ],
  calculator: [
    'Calculator inputs',
    'Qualified share rate and historical payout assumptions.',
    'Historical assumptions, not a server-side quote or promise of future returns.',
  ],
  stakes: [
    'Stake list',
    'Indexed stakes with address, lifecycle and bounded maturity/principal filters.',
    'Lifecycle filters differ from returned states. Maturity does not automatically end a stake.',
  ],
  stakeEvents: [
    'Stake activity',
    'Read stake lifecycle events since a saved, provable checkpoint.',
    'Proof-limited continuation over indexed PulseChain history, including inherited origin1 events. Not an immutable journal or exactly-once notification service.',
  ],
  stake: [
    'Stake detail',
    'Indexed stake and independently qualified recent observation.',
    'No indexed record is not proof of absence; recent discovery can be inconclusive.',
  ],
  holders: [
    'Holder rankings',
    'Liquid or staker ranking at a recorded daily cutoff.',
    'Ranking and current index can have different cutoffs; preserve rankAsOf and rankingDay.',
  ],
  address: [
    'Address summary',
    'Indexed summary with separately pinned live information.',
    'A partial live page is not a complete wallet inventory; missing data is not a zero balance.',
  ],
  addressStakes: [
    'Address stake page',
    'Address-result shape including its pinned live stake page.',
    'A partial live page is not a complete wallet inventory; missing data is not a zero balance.',
  ],
  nativeCharts: [
    'Native charts',
    'Fixed native-ledger series with cutoff and truncation.',
    'Fixed native-ledger columns; inspect cutoff, truncated and provenance.',
  ],
  archiveCharts: [
    'Source-reported charts',
    'Fixed HDS archive series with source provenance.',
    'Source-reported daily references, not a live quote or native-ledger qualification.',
  ],
  maturities: [
    'Scheduled maturities',
    'Principal, shares and counts by scheduled maturity day.',
    'Scheduled maturities are not forecasts of stake ends or rewards.',
  ],
  downloads: [
    'Download catalog',
    'Available immutable CSV bundles and their cutoffs.',
    'Select an available immutable bundle before requesting a CSV.',
  ],
  download: [
    'Download CSV',
    'A dataset from an available catalog-selected bundle.',
    'Template: replace the sample bundle ID with an available ID from the catalog.',
  ],
  status: [
    'Data status',
    'Service metadata, coverage and observation status.',
    'Offline qualification metadata, not certification of complete or current history.',
  ],
  live: [
    'Process liveness',
    'Whether the HTTP process is alive.',
    'Process liveness does not establish dataset or dependency readiness.',
  ],
  ready: [
    'Dependency readiness',
    'Whether the database readiness check succeeds.',
    'Dependency readiness does not establish coverage, freshness or provider qualification.',
  ],
};
export const rules = {
  stakeEvents: [
    'An active paid API key is required. Browser sessions alone do not authorize this resource.',
    'Save items and nextCursor atomically. The token is an unsigned client position, not authorization or proof of processing. Keep the same normalized selection, including fromBlock and limit.',
    'Follow empty pages until caughtUp. At most200 raw events are examined per page and100 matches returned; sparse filters can need many requests. A page pins cutoff; caughtUp always returns a progress token for the next check. HEAD has no body or token; If-None-Match never suppresses progress with304.',
    'On409 reset_required, explicitly reset and replay from your selected lower bound. Missing or changed instance, source or whole-boundary proof invalidates continuation, including after ordinary pruning. No wall-clock expiry does not mean indefinite validity; replay cannot retract outside notifications.',
    'eventId binds originChainId, blockHash and logIndex; retain source attribution and exact strings. Cancellation is stake_end. Historical principal/shares can be null; Good Accounting and a later end are lifecycle observations, not two payable rewards.',
  ],
  daily: [
    'Inclusive UTC range: ordered, at most 366 dates, from 2019-12-03 within contract days 0–65535.',
    'HDS requires source=hexdailystats and chain=pulsechain. Supply both afterSourceDay and revision from the returned continuation, or neither. Native requests reject both. Keep the original range; null continuation ends paging. HDS pages contain at most 64 rows; coverage describes the whole range. Restart changed revisions.',
  ],
  markets: [
    'Inclusive UTC range: ordered, at most 366 dates, from 2019-12-03 within contract days 0–65535. Keep market sources separate; do not sum overlapping intervals.',
  ],
  stakes: [
    'Maturity/principal selections require an active API key. Public global lists have five pages, maximum 50 rows/page; known-address lists retain maximum 100.',
    'Keep chain, filters and limit unchanged with nextCursor. Indexed cursors bind cutoff/revision and expire 60 seconds after the first page; null ends paging. Restart on 409.',
    'Maturity/principal filters require chain=pulsechain and explicit lifecycle=open. Supply both inclusive zero-based maturity days (0–65535), ordered, with to-from<366 (at most 366 days). The optional exact heart minimum requires this pair; omitted and 0 are equivalent. Numeric stake-ID order and broad open states (queued/open/mature_open) are unchanged; GA/ended/cancelled are excluded. Invalid combinations return 400. Threshold totals are a subset of global maturity totals.',
  ],
  holders: [
    'Public global lists have five pages, maximum 50 rows/page. Additional traversal requires an active API key and an explicit restart in paid mode.',
    'Keep chain, order and limit unchanged with nextCursor. Indexed cursors bind cutoff/revision/ranking and expire 60 seconds after the first page; null ends paging. Restart on 409.',
  ],
  address: [
    'Live cursors pin address/chain/limit and an at-block observation for at most 60 seconds. Inspect outcome, reason, expiresAt and enumerationComplete. live.offset is output, not a query argument. Restart on 409.',
  ],
  addressStakes: [
    'Live cursors pin address/chain/limit and an at-block observation for at most 60 seconds. Inspect outcome, reason, expiresAt and enumerationComplete. live.offset is output, not a query argument. Restart on 409.',
  ],
  stake: [
    'An optional address hint permits bounded recent discovery. Conflicting indexed ownership returns 409 incompatible_owner; inconclusive discovery may return 503 not_indexed.',
  ],
  calculator: [
    'Presets cover 1, 30 or 365 completed days and may be unavailable. Keep exact rational numerator/denominator strings.',
  ],
  nativeCharts: [
    'values order: payout, rate, locked, percent, duration, stakers, circulating, holders, starts, ends, penalties. Null means unavailable.',
  ],
  archiveCharts: [
    'values order: price, payoutPerTshareHEX, tshareRateHEX, totalTshares, stakedHEX, stakedHEXPercent, averageStakeLength, currentStakerCount, circulatingHEX, penaltiesHEX, currentHolders. Duration is reported years (365 days). Preserve signed/exponent tokens and provenance; do not splice source-reported prices into native/pre-fork series.',
  ],
  downloads: [
    'Bundle manifests retain independent native/daily/ranking/market cutoffs. Rebuilding, unavailable or retired is not an empty current export.',
  ],
  download: [
    'CSV success is a complete immutable file. Range is ignored. Use catalog dataset and bundle identity; refresh the catalog on 410.',
  ],
  status: ['productionReady remains false; qualification is offline_only_live_not_qualified.'],
};
const savedStakeRule = 'source=subgraph is an explicit PulseChain-only saved source variant at block 27720851 (2026-10-05T15:48:05Z), with refresh disabled. It retains reported decimal/packed tokens, source day labels and null links; these are not canonical lifecycle or maturity facts. Cursors bind source, dataset, owner, route, limit and lexical entity-ID order for 60 seconds. Canonical lifecycle/maturity/amount and recordState filters are rejected. Public browse and paid access limits still apply; absence means not present in this saved inventory.';
for (const id of ['stakes', 'stake', 'address', 'addressStakes']) rules[id].push(savedStakeRule);
rules.holders.push('source=subgraph selects the complete saved pulsechain/hex holder-source inventory at block 27720851, observed 2026-10-05T15:48:05Z. Only source-id-asc order is supported; liquid/staker ranking and balance filters are rejected. datasetVersion selects the HOLDER dataset. 664405 is represented-address/source-record coverage; 380242 is the source-positive-address count excluding zero address, not people or active stakers. Original decimal strings, zero balances and the negative zero-address anomaly are retained. No source sum is total supply. No new CSV route or live refresh.');
for (const id of ['address', 'addressStakes']) rules[id].push('Saved address responses compose compatible holder and stake snapshots only. datasetVersion remains the STAKE identity; holderDatasetVersion separately selects the HOLDER identity. Cursors bind both identities, route, address, ordering, limit and access authority. liquidBalance is source-reported HEX plus its original token, or null with explicit holder presence/anomaly/unavailability. Missing is not zero. Original negative bookkeeping tokens remain in holder.item without an ordinary spendable balance. Saved-only ETags include the complete combined representation; native behavior is unchanged.');
export const essentials = {
  exact:
    'Magnitudes, block numbers and stake IDs are exact decimal strings. Hearts are 10^-8 HEX; raw stakeShares are not T-shares. Use strings/BigInt for integers and exact decimal/rational handling for fractions, never Number/parseFloat. Contract days are zero-based numbers; displayDay = contractDay + 1. Dates and timestamps use UTC. Missing/null is not measured zero. HDS tokens can be signed or use exponents: preserve published text and availability rather than imposing the native decimal grammar.',
  freshness:
    'HTTP 200 does not imply that every component is fresh or available. Inspect status/value/asOf/observedAt, finality, cutoff, reason and coverage independently. Source time, observation time and protocol day differ. PulseChain serving history may contain Ethereum-origin facts before the fork; originChainId identifies provenance. The ethereum enum remains an archived chain selector, not a qualified post-fork eHEX service or a promise of available data. Native examples are synthetic; savedSubgraph examples retain their disclosed historical pin. Neither is a current observation or evidence of deployment.',
  indexed:
    'Indexed lists use opaque nextCursor, returned unchanged as cursor with the same chain, filters, order and limit. Default limit 50, range 1–100. Null ends pagination. The cursor binds cutoff/revision/ranking identity and expires 60 seconds after the first page. On 409 restart; never splice snapshots or replace a cursor with an offset.',
  hds: 'source=hexdailystats selects PulseChain-only source-reported history, not native ledger data. At most 64 records per page; coverage still describes the whole requested range. Pass both continuation.afterSourceDay and continuation.revision with the same date range; both or neither are required. No continuation fields are accepted on the native variant. Null continuation ends paging. Restart a changed revision; do not splice pages or mix reported prices into native/pre-fork series. Source record date does not prove a market-period boundary.',
  address:
    'Address results separate indexed history and pinned live observations. Inspect outcome, reason, live.page.enumerationComplete and live.expiresAt. A partial page is not a complete wallet inventory. Pass live.page.nextCursor with the same address/chain/limit. The at-block observation expires within 60 seconds; restart on 409. live.offset reports progress but is not a query parameter. Missing indexed/live data does not imply a zero balance.',
  errors:
    'JSON without Authorization is bounded public browsing, including signed-in sessions. A supplied Bearer API key selects paid mode and never falls back. Stake activity, maturity/principal filters and traversal beyond five global-list pages require paid access. Successful paid 200/HEAD/304 pages count once in the original monthly allowance window; failures do not. Metadata, public requests and CSV are unmetered. Mutating methods are refused; 405 includes Allow. Bounded URL/header/input, process-wide admission and provider safeguards are not customer quotas or an unlimited-access promise. Honor Retry-After on 429; use bounded backoff for retryable 503. Restart incompatible pagination on 409. Errors use error.code/message/retryable and requestId. No arbitrary RPC/SQL passthrough. Cross-origin browser access is not configured by these docs.',
  downloads:
    'Start with the available catalog, then select its immutable bundle ID and dataset. Complete CSVs require current purchased access through a real account session or API key and are prebuilt snapshots, not arbitrary full historical holder queries or on-demand SQL. Independent native/daily/ranking/market cutoffs are in the bundle manifest. A rebuilding/unavailable/retired bundle is not a zero-row current export. CSV success is text/csv with attachment filename, exact Content-Length, ETag and private, no-store caching. Range is ignored (Accept-Ranges: none); the whole file is returned. 304 has no body; refresh the catalog on 410.',
  access: 'No Authorization selects public JSON even with a session. Public data shares a process-local 120 attempts/minute and 8 active requests per socket source, up to 2048 buckets. Proxy headers do not change identity. These are candidate bounds, not a distributed per-person guarantee. Commercial paid quotas remain unselected. Health, status, download catalog and samples are free. Complete CSV uses separate admission and stays available with active purchased access after JSON quota exhaustion.',
  caching:
    'Paid responses and denials use private, no-store and vary on Authorization/Cookie. ETags never bypass authorization; authorized paid 304 counts one read. Public mixed paths also vary on Authorization/Cookie. Use ETag with If-None-Match where supplied; an unchanged representation returns 304 with no body. JSON revalidation occurs after response construction, saving transfer rather than all query work. Inspect the response-header table for resource-specific caching. CSVs are immutable full files; Range is ignored.',
};
const parameters = {
  chain:
    'Serving chain. Ethereum is an archived selector, not qualified post-fork eHEX; charts and HDS require PulseChain.',
  from: 'Inclusive UTC start date; see the range rule below.',
  to: 'Inclusive UTC end date; see the range rule below.',
  limit: 'Maximum items on this page; keep unchanged with a cursor.',
  cursor:
    'Opaque returned token; pass unchanged with its original selection. Indexed and pinned-live contracts differ.',
  address:
    '0x-prefixed 40 hex digits, normalized lowercase. Path identifies owner; optional query filters or hints ownership.',
  lifecycle:
    'open: queued/active/mature-open; good_accounted: GA-unended; ended: settled/cancelled. Returned states have a wider vocabulary.',
  maturityFromDay:
    'Inclusive zero-based contract day 0–65535, digits only (no blanks/fractions); supply with maturityToDay. Requires PulseChain and lifecycle=open.',
  maturityToDay:
    'Inclusive zero-based contract day 0–65535; >= maturityFromDay and difference <366. Both bounds are required in maturity/principal filter mode.',
  minPrincipalHearts:
    'Inclusive exact principal minimum in hearts (100,000,000 hearts = 1 HEX); canonical uint256 string, max78 digits. Requires the maturity-day pair; omitted means0 in filtered mode.',
  order: 'Ranking order, bound to the cursor identity.',
  afterSourceDay: 'HDS continuation day; supply with revision. Not accepted for native history.',
  revision: 'Returned HDS revision UUID; supply with afterSourceDay.',
  datasetVersion: 'Contract-ledger only: returned dataset SHA-256. Hold across bounded windows; a changed selection returns 409. No HDS continuation fields are accepted.',
  id: 'Canonical unsigned stake ID, strictly below 2^40; no leading zero except 0.',
  bundle: 'Available catalog bundle UUID v4; syntactic validity does not imply availability.',
  dataset: 'Catalog dataset to download as CSV.',
};
export function parameterDescription(id, name) {
  if (name === 'generation') return 'Opt-in paired saved-source view: base pins both accepted 5 October inventories; the admitted generation selects base plus observed updates through 6 October. No full B1 inventory, deletion, reorg or live-freshness claim. Dataset selectors must agree with the pair.';
  if (id === 'holders') {
    if (name === 'source') return 'Omit for unchanged native ranking. subgraph selects saved source records only.';
    if (name === 'order') return 'Native: liquid/staker rank. Saved subgraph: source-id-asc only, never a financial rank.';
    if (name === 'datasetVersion') return 'Saved HOLDER dataset identity. Keep source, version, order and limit fixed across pages.';
  }
  if (['address', 'addressStakes'].includes(id) && name === 'holderDatasetVersion') return 'Optional saved HOLDER identity, separate from the stake datasetVersion. Incompatible versions or snapshots are rejected.';
  if (['address', 'addressStakes'].includes(id) && name === 'datasetVersion') return 'Saved STAKE dataset identity; never supply the holder identity here.';
  if (['stakes', 'stake', 'address', 'addressStakes'].includes(id)) {
    if (name === 'source') return 'Omit for unchanged native behavior. subgraph explicitly selects the saved pulsechain/hex inventory at block 27720851; no live refresh or canonical lifecycle inference.';
    if (name === 'datasetVersion') return 'Saved subgraph dataset identity. Keep it and the source/address/limit unchanged across pages; stale or incompatible cursors return 409.';
  }
  if (id === 'stakeEvents') {
    const activity = {
      chain:
        'PulseChain only; defaults to pulsechain. originChainId identifies inherited/native event origin.',
      fromBlock:
        'Inclusive nonnegative canonical decimal string, at most9223372036854775807; defaults to0 and is clamped to constructor coverage. Future lower bounds are invalid.',
      address: 'Optional owner address, normalized lowercase; cannot be combined with stakeId.',
      stakeId: 'Optional exact stake ID below2^40; cannot be combined with address.',
      kind: 'Optional stake_start, good_accounting or stake_end; cancellation remains stake_end.',
      limit: 'Canonical integer1–100, default50; keep unchanged with the cursor.',
      cursor:
        'Returned page/progress token, at most2048 characters; pass unchanged with the same selection. Valid only while canonical proof remains. No wall-clock expiry; reset_required means explicit replay.',
    };
    if (activity[name]) return activity[name];
  }
  if (name === 'source')
    return id === 'daily'
      ? 'Omit for native history; hexdailystats selects source-reported history. contract-ledger selects PulseChain-only saved exact daily storage observed at a fixed block, with original capture times, disabled refresh and explicit unavailable metadata.'
      : 'Optional market-source ID; omit for up to four separately described sources.';
  if (!parameters[name]) throw new Error('Missing parameter metadata: ' + id + '/' + name);
  return parameters[name];
}
