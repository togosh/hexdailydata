# API, datasets and live semantics

## Conventions

New public base path `/api/v2`. No legacy compatibility is required. JSON fields use
camelCase; CSV fields use snake_case and unit suffixes. Integer magnitudes, block
numbers and stake IDs are decimal strings; decimals are non-exponent strings. Day
numbers are bounded integers and use explicit `contractDay`/`displayDay` names.
Empty CSV cell means unavailable; zero means measured zero. UTC timestamps use ISO8601.

Every independently fresh component has `asOf`, `observedAt`, `status`, and where
appropriate `finality` and `method`. Do not duplicate a dataset-wide chain ID or
observation hash in every CSV row unless rows genuinely have different origins.
Error envelope: `{error:{code,message,retryable},requestId}`. Never SQL/stack/credentials.

## Routes (fixed initial public contract)

| Route | Behavior |
|---|---|
| GET /health/live | process is running; cheap, not a sync claim |
| GET /health/ready | API dependencies and schema usable; bounded query, no history audit |
| GET /api/v2/status | per-stream sync/coverage/freshness, no credentials or host paths |
| GET /api/v2/home?chain=pulsechain | compact daily headline + independent cached live metrics |
| GET /api/v2/daily?chain=pulsechain&from=YYYY-MM-DD&to=YYYY-MM-DD | chart/table daily facts; bounded date range |
| GET /api/v2/markets/daily?... | native market observation history with coverage/method |
| GET /api/v2/stakes?chain=pulsechain&address=0x...&cursor=... | indexed lifecycle/search; keyset pagination |
| GET /api/v2/stakes/:id?chain=pulsechain | known lifecycle and separately labeled recent-state observation |
| GET /api/v2/addresses/:address?chain=pulsechain | indexed baseline + current observation and completeness |
| GET /api/v2/addresses/:address/stakes?... | at-block live pages, explicit next cursor/completeness |
| GET /api/v2/holders?chain=pulsechain&cursor=... | last daily-ranked current list |
| GET /api/v2/calculator/inputs?chain=pulsechain | rate, completed payout presets, age and calculation version |
| GET /api/v2/downloads?chain=pulsechain | current/prior bundle manifests; no file hashing on request |
| GET /api/v2/downloads/:bundle/:dataset | immutable validated file streaming; named datasets only |

Use 400 for malformed values, 404 only for a genuinely unknown qualified object,
409 for expired/incompatible observation cursor, 429 for quota, 503 for an unavailable
live source with no acceptable prior value. Historical data gaps appear as explicit
coverage/status rather than fake values. Rate-limited live data may accompany a useful
stale indexed baseline in a 200 response with per-component unavailable status.

For static immutable exports, use ETag and max-age based on content hash. Current
manifests and Home have short revalidation. Never let a cached response lie about its
age: persist the source observation time and derive freshness at request/render time.
Old bundle URLs return 410 when retired; do not substitute current data under that URL.
On restore, missing/unverified bundle files are excluded from advertised downloads.
The catalog reports rebuilding/unavailable while other healthy API routes stay ready.
Rebuilt exports receive new immutable IDs and reflect their actual restored cutoff;
original IDs survive only when their exact files verify. Path parameters cannot choose
a filesystem path. No runtime SQL-query endpoint.

## Home DTO and loading behavior

The shared `src/contracts/api.ts` defines a discriminated observation type. A missing
value has `value:null`; a stale value retains its original source time. The Home DTO
has `daily`, `live.price`, `live.shareRate`, `live.todayPayoutEstimate`, and
`live.latestCompletedPayout`. Each is independent. Estimated values always carry their
method and assumption labels. Charts and catalog payloads are not nested in Home.

A single compact request should paint all available headlines, even when some parts
are unavailable. No “select generation -> overview -> four required requests -> price”
waterfall. Mount price and other metrics immediately. Chart fetches cannot reject the
headline result. Read-only API work is bounded; no provider call or full stake scan
on Home. Target Home JSON <=25KiB uncompressed and query p95<=250ms locally at scale;
first useful mobile metrics <=2s under the documented network/CPU profile.

## Price methodology

Use the tested v1 reserve-math knowledge selectively, not its acquisition machinery.
Resolve/verify a small allowlisted pool/anchor set at startup and on scheduled metadata
checks, not on every minute tick. Prefer current HEX/WPLS and supported anchor routes;
verify chain, factory, tokens, decimals, pool runtime and same-block reserve affinity.
Compare an independent provider at the same block under the shared request budget.

A reserve-ratio mark is an estimate, not a last-trade/executable quote/TWAP. A $1 stable
anchor is `peg_assumed`, never independently verified USD redemption. Relative agreement
among bridged stablecoins cannot prove a common peg. Keep a visible short methodology
label and detailed explanation. Reject zero/low-depth/large-conflict routes; keep a
properly aged last-good observation or unavailable. A pool's last reserve-update time
is different from when its unchanged state was read; do not fake activity.

Do not depend on an exhaustive all-pool inventory just to get a price every 60s.
Daily volume/liquidity comes only from supported venue observations and is labeled as
such; overlapping venues/tokens cannot be summed blindly. History before venue/source
coverage begins is a documented gap, not a zero. Never call a locally sampled daily
OHLC the exact all-trades OHLC; method and sample coverage are recorded.

## Payout and share-rate specifics

- `rawShareRate` comes from HEX global state. `hexPerTShareBeforeBonuses` is derived
  exactly with SHARE_RATE_SCALE=100000, 10^12 shares/T-share and 10^8 hearts/HEX.
- Latest completed payout identifies the actual contract day and the block at which
  the daily ledger entry was observed. It can remain unchanged for many polls.
- Today's estimate refers to the **current protocol day**, uses at-block globals and
  pending-daily-round handling, and explicitly excludes unknown future penalties or
  changes. It can move downward or upward; it is not a floor or guarantee.
- On a day transition, invalidation occurs by protocol day, not client timezone.
  At most one current-day estimate cache record exists. Unsupported/missing inputs
  show unavailable; latest completed payout remains visible independently.
- Current post-claim estimator must be independently checked against source rules and
  pinned historic known-state examples. Do not use 3.69%/365 as an exact daily formula.
  No call to a state-changing function is broadcast; no signer is present.

## Address privacy and accuracy

Do not persist visitor-to-address associations, raw address search logs, or contact
information. IP-based rate limiting is transient; redact paths/addresses in long-lived
access logs. Requests go to configured providers only; users cannot submit RPC URLs,
SQL, arbitrary method names, or arbitrary contract calldata.

Limit address length/format before I/O, cache/coalesce identical observations, and
apply the whole-application lane budgets in architecture.md/config/limits.json.
Each request's 4-HTTP/128-logical-call ceiling includes discovery, retries and any
corroboration; the 10-second deadline includes queue time. Denied/cancelled work must
not be silently queued again. Paginate large stake arrays and honor Retry-After. A live
balance for an address does not imply a current global holder rank. A provider outage
must not hide available verified indexed history; show its older block/date.

## Standard downloads

Five main datasets: **daily**, **stakes**, **holders**, **maturities**, **markets**.
`src/contracts/datasets.json` is the source of column names, units and required fields;
API/CSV tests and the data dictionary derive from it. Future advanced data can be a
separate documented product, not 70 mandatory columns in the standard stake CSV.

Daily and markets are append/correct-by-day history. Stakes and holders are a current
observation plus complete lifecycle fields where relevant, not every historical full
snapshot. Maturities is the current scheduled maturity distribution. A bundle manifest
contains its exact chain, current-index block, daily cutoff, market-source cutoff,
format/calculation versions, row counts, file sizes/hashes and coverage. Different
source cutoffs are permitted only when accurately labeled. Do not promise all files
are “as of midnight” if current-state export happened at a later indexed block.

Optional source event ID/technical fields belong in a separate technical export or
linked detail endpoint. Standard CSV amounts use explicit units and enough decimal
precision to preserve exact underlying values. Addresses/IDs are strings. Spreadsheet
formula injection must be neutralized for future free-text labels; native addresses
and exact numeric strings do not need to be turned into lossy floats.

## Calculator

Pure shared domain code runs client-side for interactive scenarios. The API supplies
validated current rate and completed 1/30/365-day payout presets with actual available
window coverage. Do not invent missing historical days or average unavailable rows.
Ordinary stake quote uses protocol integer rounding. Optional future HEX price is a
clearly separate scenario. No interest guarantee, no transaction execution, no forced
start-date selector or unnecessary slider. Historical arbitrary-start calculators are
not required at launch. Good-accounted/ended values in explorer are not silently reused
as an ordinary new stake quote.

## Runtime DTO boundary

The runnable API serves health/status and configured read models. An unconfigured Home
returns503 without invented values. `src/contracts/api.ts` is the runtime Zod schema and inferred-type source for
block references, observations, Home, live stake pages and errors. JSON example:
`tests/fixtures/home.json` (synthetic, test-only; not imported into the application).
No source/explorer fixture is served as current data.

DTO validation rejects unsafe integer representations, negative/exponent decimals,
unknown fields, invalid UTC timestamps, mismatched display days, zero payout
share denominators, incompatible chain lineage and final labels on today's estimate.
Structural DTO validation is not proof of provider truth, source capability, canonical
finality or current freshness. Ingestion/services must derive those in their owning
tasks. A source block timestamp and collection timestamp remain separate; collection
cannot precede the source block. Each component is aged independently when served.
`mode: development` replaces the unused scaffold `demo` option; there is no fake-data
mode. Weighted duration is nullable when its accounted set is empty. All derived
payout displays use the exact-ratio/truncate-8 policy in data.md.


## Task05 implemented download service boundary

ExportService provides startup verification, catalog, openStream and worker build.
Catalog returns available/rebuilding with only validated public manifests; a UUID not
retained by the DB returns retired (HTTP410), an unverified or changed file
returns unavailable. Open streams expose immutable SHA-256 ETag/bytes and release
completion; callers own cancellation. API callers use the read-only SQL connection.
Task06 wires HTTP routes and read-only refresh after new publication.

Manifests carry format/calculation version, accepted current-index identity/finality,
actual rank identity plus completed-day label, native daily/payout cutoffs, per-source
market cutoffs/versions/method/qualification and interval contract, origins, exact
column units/order, rows/bytes/digests. Markets can have multiple source rows per day.
No endpoint, storage path or credential is exposed. Normal download/catalog reads
check protected file identity/stat metadata, not full content hashes. The address
baseline now includes nullable liquid/staker ranks with a separate rank asOf block.
Catalog bundles carry their explicit current/prior slot, ordered current first. The
unchanged Task07 shell still displays unavailable placeholders; API reads are implemented.

## Task06 implemented read behavior

The route table above is implemented in `src/api/routes.ts`; its schemas generate
`docs/openapi.json` through `npm run openapi` (`openapi:check` checks reproducibility).
All routes support GET and HEAD. Runtime cross-field invariants (day identity, positive
ratios, chain attribution, real ordered dates, authenticated cursor/cutoff compatibility)
remain stricter than JSON Schema can express; generation does not remove those checks.
Unknown query keys are rejected. Lower/uppercase hexadecimal address input is normalized.

| Query | Default / bounds / order |
|---|---|
| `chain` | `pulsechain`; only `pulsechain` and `ethereum` |
| Daily and markets `from`, `to` | Both required, inclusive real UTC dates; launch through day65535; ordered and at most366 days |
| Markets `source` | Optional declared source identifier; at most4 separate sources, source then day order |
| Stakes `address` | Optional exact address; stake ID ascending, no OFFSET |
| Stakes/holders/address `limit` | Default50, range1–100; live totals and returned page size stay separate |
| Holders `order` | `liquid` (default) or `staker`; stored unique ordinal rank then address; ties were resolved by the daily ranking worker |
| Indexed `cursor` | Signed version1, chain/filter/order/page-size/cutoff binding, 60s expiry from first page; changed sync revision/hash/rank identity returns409 |
| Live address `cursor` | Existing signed pinned block/address/offset/count observation; at most60s; restart invalidates it |
| Stake detail `address` | Optional owner hint for bounded recent discovery; a conflicting indexed owner returns409 |

Examples: `/api/v2/daily?from=2021-01-04&to=2021-01-05`,
`/api/v2/holders?order=staker&limit=50`, `/api/v2/stakes?address=0x…&limit=50`.
The ellipsis is explanatory, not a valid address. Invalid date/chain/query returns400
`invalid_request`. A changed cursor returns409 `cursor_incompatible`. HTTP admission or
provider refusal without useful fallback returns429 `http_quota`/`provider_quota` and
`Retry-After: 60`. Required source failure returns503 `source_unavailable`. Unconfigured
or fully unusable Home returns503 `not_initialized`. Retired download IDs return410
`bundle_retired`; unverified or changed files return503. Errors always use the shared
sanitized envelope, e.g. `{"error":{"code":"cursor_incompatible","message":"Observation changed or expired; restart pagination.","retryable":false},"requestId":"req-1"}`.

A missing indexed stake is inconclusive: bounded recent discovery can return a useful
observed new stake, otherwise503 `not_indexed` or source/quota unavailable. An empty
owner hint does not establish global absence, so this implementation does not issue404
for an unknown stake merely from SQL or a user-supplied owner. Known indexed lifecycle
remains available with a separately unavailable recent overlay. No whale enumeration
or second provider allowance is used. Current balance and daily rank block cutoffs are
separate. No historical holder snapshots are implied.

Home performs one compact data statement after connection setup; current/daily/sync
and four metric records are bounded. Home does no provider work, file verification,
ranking, chart fetch or large-table count/sum. Source time, collection time and protocol
day are distinct. Every response ages live components again, including before304.
Estimates also expire on protocol-day change. An invalid price does not suppress a
qualified share rate. Daily historical rows retain their source chain/block/hash and
may have `blockTimestamp:null` after headers are pruned; a day boundary is never
invented as the exact block time. Retained lifecycle events supply stake timestamps.
A completed *live observation* can expire; `/daily` retains the exact completed ledger
fact and its original payout block. This is historical data, not today's estimate.

Daily responses report missing days explicitly and pending payout stays null. Market
sources are never summed: each has its method, qualification, accepted through-day and
dirty suffix. Previously aggregated rows within a dirty suffix are `pending_correction`
and excluded from accepted coverage. Market rationals remain exact strings. Calculator
presets are mean-of-daily-ratios for complete1/30/365 windows at the latest materialized
past-day cutoff, with actual range/count. Gaps, pending days and zero shares are unavailable.
API ratios truncate to8 decimals; CSV payout/share-rate precision remains12 and market
precision24. Raw integers and returned calculator rationals remain exact.

Small JSON responses use a hash of the bounded representation and `no-cache,
must-revalidate`; there is no server JSON cache extending a fresh label. Address/stake
responses use `no-store`; their service cache still preserves the original observation
and expiry. A304 is computed only after current aging/availability checks. CSVs use
strong `"sha256-…"` ETags, exact byte length, attachment disposition and `public,
max-age=31536000, immutable`. Conditional reads first open the protected available
identity. HEAD/304 destroy the unopened stream and await its lease release. Range is
ignored: the full200 representation is served and `Accept-Ranges: none` is declared.
Retired URLs never redirect to a current bundle.

Read requests have no body product. URL4096/header8192/cursor2048-character guards run
before data access. JSON is capped at2MiB (Home target25KiB). There are8 exclusive SQL
leases with no admission queue,5s connection setup,2s statement and3s lease bounds;
download advisory sessions are separate. General handlers have8s, address/stake paths
10s and downloads120s cancellation deadlines. Provider10s includes SQL/queue time and
still has4HTTP/128logical maximum; routes share one API budget/cache/cooldown owner.
The anonymous HTTP layer uses one transient global1200/min token bucket and64 active
requests, plus the existing32pending+active download slots. Forwarded IP headers have
no quota authority and no visitor/IP/address history is stored. Logs contain startup
state only, never request URLs, query text, provider/SQL errors, paths or credentials.
