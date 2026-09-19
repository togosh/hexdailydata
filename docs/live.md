# Task04 current observations

The worker runs one cooperative metrics job alongside native rebuild/watch, including
constructor/fork acquisition and the final audit. They share one worker ProviderBudget.
Metrics use a separate SQL connection and four fixed `(chain_id, metric)` keys, without
a canonical-writer lock or a foreign key requiring bootstrap to finish. There is one
active metric tick and at most one pending tick. Signals stop both jobs.
In watch mode a fatal native conflict pauses that stream without retries while metrics
continue; native progress retains its error until an operator stops/repairs the worker.
API address services own the other fixed lane and role lock through `openAddressService`; public
routes remain Task06. Default entry points still refuse unconfigured provider access.

## Payout rules and independent vectors

The retained Task01 explorer receipt, `artifacts/task-01/HEX.sol`, SHA256
`78680f17586d87cb85cd30eb4666f6d250dd1d12e33e0e76f96844a639b0f7fc`, was read
as text. It is a source-semantics receipt, not deployed-code or historic-state proof.
Relevant functions: `globalInfo` (line916), `allocatedSupply` (954),
`_dailyRoundCalc` (1222), `_dailyRoundCalcAndStore` (1259), `_dailyDataUpdate` (1269),
and claim/BPD constants (665–678). No full Solidity is shipped.

For currentDay and dailyDataCount both greater than352, the per-round base is
`floor((totalSupply + lockedHearts) * 10000 / 100448995)`.
Post-claim rounds do not increase cached allocated supply. The earliest pending
round consumes the accumulated stake penalty exactly once. Only after that round
does `_dailyDataUpdate` add nextStakeShares to active stakeShares. Thus today's
denominator includes next shares if at least one round is pending, and today's
numerator includes current penalties only when no round is pending. Historical claim
or BPD inputs are explicitly unsupported; the existing historical ledger is unchanged.
Bound/overflow violations and zero denominators are unavailable.

Literal synthetic vector derivations, independent of the helper:

| Inputs | Today's payout hearts / shares | Pending-round meaning |
|---|---|---|
| Supply1,004,489,950,000; locked0; active100; next50; penalty77; day=count=400 |100,000,077 /100|Supply is10000 times100448995, so base100,000,000; next shares not activated|
| Same; count399 |100,000,000 /150|Day399 gets100,000,077 /100; then50 shares activate|
| Same; count397 |100,000,000 /150|Day397 gets penalty; days398/399 and400 each have base100,000,000, without compounding|
| Supply100,448,995,000,100,459,039; penalty0 |10,000,000,000,010,000 /100|Supply is100448995×(10^12+1)+10044; remainder100440000 after multiplication by10000 is below denominator100448995|
| Supply0; locked10044; penalty3 |3 /100|Inflation rounds down to0, measured penalty remains3|

Latest completed payout comes from `dailyDataRange(count-1,count)` at the same pinned
block as globalInfo. UTC midnight never advances that count. The current estimate
uses observed protocol day, with an old-day estimate invalidated on transition or
expiry; no transaction is sent. All observations are provisional, even when their
underlying daily ledger value is materialized. Presentation truncation is separate
from exact integer inputs and rational unit conversion.

## Small price route

An explicit optional `HDD_V2_METRICS_PROFILE` supplies two or three tokens, one factory,
one or two constant-product pools, and a HEX→anchor or HEX→wrapped→anchor route.
Token order, decimals, deployed SHA256 code identities, factory.getPair, pool factory,
token0/token1 and chain are verified at one block at startup and every configured
3600–86400 seconds. EIP-1898 canonical block-hash calls and numeric-header rechecks
preserve affinity. The second selected source corroborates reserves at that block;
any disagreement rejects the candidate. Distinct declared operators are disclosed;
unknown correlation stays unknown. This is not a guarantee against shared bad data.

Each reserve ratio uses integer units; composed depth is the minimum output-side
depth converted into anchor units across the route. Zero/low depth, malformed state
and identity conflicts fail independently of contract metrics. Price-profile planning
failures, including a mismatched chain, are isolated too: native
metrics continue, while price retains its aged last good value or reports an invalid profile.
Only an explicitly peg-assumed $1 anchor is supported. It cannot award an independent USD
anchor label from pool agreement. Real route identities remain unqualified; tests use
synthetic metadata. Poll timestamp, pinned block timestamp and each pool's reserve
update seconds are distinct. Successful stalled-block polls do not renew source age.
Freshness is derived on read:120s fresh,1800s maximum retained age, future source invalid.

## Address pages and request accounting

One cold page uses a three-read discovery batch (chain, latest header, advisory
stakeCount). The count ONLY sizes the following pinned batch and is never returned.
The second batch contains numeric-header affinity, code, balanceOf, authoritative
stakeCount and up to100 stakeLists calls:107 total logical reads for a full cold page,
two physical attempts. This narrowly extends address batches to104 reads; ordinary
sync/metrics batches retain30. It is JSON-RPC batching, not an assumed multicall contract.

If discovery races a change, a smaller pinned count discards speculative indices
proved outside the authoritative count; failures within the count reject the page.
A larger count yields an honest partial page and continuation. No array index is an
identity. Index records, dated rank cutoff and live pages remain separate. Stake ID
lookup uses an indexed owner or caller-supplied address and one bounded page. A hint
conflicting with the indexed owner returns `incompatible_owner` before provider work.
Only an indexed owner's complete list supports `not_current_at_block`; an unindexed
ID absent from a supplied address remains `indexing`. Unknown or out-of-page IDs never
produce a definitive404. Optional event discovery
is not implemented. No all-address scan, arbitrary calldata or visitor history exists.

Cursors are authenticated opaque process-local tokens binding chain, address, header,
count, offset and original expiry. Restart, tampering, mismatched identity, canonical
affinity loss and60-second expiry are explicit. Each continuation is a new bounded
public request, within the original observation lifetime. Internal retries/alias
calls keep their original request deadline. `enumerationComplete` means this single
response contains the entire list (offset0 and item count equals the pinned count).
A terminal continuation remains partial: clients must retain all earlier pages to
assemble a complete list. No total principal or nearest maturity is inferred from a page.

Requests reserve4 HTTP/128 logical maximum before discovery; actual dispatch consumes
that reservation and completion releases unused capacity. Dispatch after cancellation
is not refunded. The queue-inclusive provider deadline is10s. Conservative admission
can reject earlier than theoretical lane capacity; it never raises12/360 address,
6/180 metrics or12/360 sync. API and worker retain disjoint2100ms slots and one HTTP
in flight per process. Identical callers share work without multiplying quota; the
last departing caller aborts it. Cache values are cloned, age limited and byte bounded.
The SQL baseline has its own date and is retained when live work fails.

## Storage and later work

Migration3 adds only `live_metrics`. Migrations1/2 are byte-preserved. Native seed
format2 now declares storage schemaVersion3; its fixed native table set intentionally
excludes disposable overlays. Import requires an empty schema3 destination including
empty live_metrics. Export preserves native state, never rebrands restored overlays
as fresh. Task04 introduces no minute sample history; Task05 owns market_samples and
its consumer-aware aggregation/retention as well as daily markets/CSV/ranks. No needed
samples are pruned by this task. Current observations never advance native cursors.

Canary remains PREPARED / NOT_RUN, launcher NOT_CONFIGURED. Future qualification must
include EIP-1898, the enlarged bounded address batch, preliminary latest count,
stakeCount/stakeLists/currentDay, selected reserve/metadata methods and code identities.
Steady metrics use four HTTP requests per successful tick (discovery, primary state,
materialized ledger, corroborating price), within the existing6/180 lane. Metadata
refresh increases logical work, not that request count for this small allowlist.
No live latency, route authenticity, actual historical-state, full mixed product scale
or14-day rebuild/cost feasibility is established by virtual-clock synthetic tests.
