# Architecture

## One system, two processes, one database

```text
Browser --HTTPS--> API (also serves built web assets) --> PostgreSQL
                    |          |
                    |          +--> bounded address live-reader --> configured RPC
                    |
                    +--> compact cached Home response (NO request-time provider fanout)

Worker --> providers --> normalized events --> current projections + cursor (one transaction)
       --> 60s live metrics / limited price samples
       --> completed-day facts + immutable export bundle
       --> bounded maintenance / backup scheduling

Caddy is the optional production TLS/reverse-proxy edge. No Redis or message broker.
API and worker are commands in one tested image/release. Shared domain logic is pure.
```

The API uses a read-only DB role. The worker writes operational and data tables; a
separate migration role owns DDL. An API-requested address observation uses a bounded
in-memory cache, not arbitrary writes through a powerful DB role. Provider credentials
are supplied only to the processes that need them, never to browser JavaScript.

## Module boundaries

`domain` owns exact units, HEX day/timing, packed-field decoding, lifecycle rules,
completed payout math, current-day estimate math, ordinary stake quote/scenarios.
`providers` owns transport and block affinity, not SQL or publication.
`db` owns explicit SQL/transactions and migrations, not protocol policy.
`services` assembles typed responses, not network-framework behavior.
`worker` coordinates ingestion/derived work and their small durable checkpoints.
`api` validates requests, enforces limits and calls services. `web` renders DTOs.

No service locator or dependency-injection framework. Pass small adapter objects into
functions. Use one maintained DTO module plus runtime validation at HTTP/provider/seed
boundaries. No cross-process import of web source and no whole-source compatibility seal.
Data schema version and release compatibility are checked normally during deployment.

## Canonical incremental ingestion

1. Obtain a fixed accepted target from the configured chain's finality policy. Prefer
   `finalized` only after probing actual support/monotonicity. A confirmation-depth
   fallback is a separately documented `confirmed` mode, not called finalized.
2. Fetch only HEX contract event topics over adaptive bounded block ranges; include
   ERC-20 Transfer for current balances. Verify block identities, ordering, duplicate
   identity and payload consistency; a range error is not an empty range.
3. Apply the range acceptance policy below: compare the complete normalized event sets
   from two configured upstreams at the same block range, not just block hashes or
   total supply. Split ambiguous ranges; never accept an ambiguous single block.
4. Decode on the application side, outside a write transaction. At publication acquire
   the chain-writer lock and CAS the preceding cursor. Apply idempotent events,
   update ONLY changed stakes/accounts, update aggregates, and advance the cursor in
   the same transaction. No HTTP call runs inside that transaction.
5. Commit short transactions, emit progress, then continue. A crash before commit changes
   neither rows nor cursor; a lost acknowledgement is resolved by reading the cursor,
   not blindly replaying additive balance changes. Duplicate events cannot apply twice.
6. Split progress at day boundaries needed for exact daily counts/weighted aggregates.
   Capture the last block strictly before each UTC boundary. Indexing may proceed
   independently of delayed market data or delayed on-chain dailyData materialization.

Use a session-scoped advisory lock on the dedicated canonical writer connection plus
cursor CAS. Loss of the lock connection cancels that job; a new process cannot silently
continue using an unrelated pooled connection. Multiple configured processes must not
both believe they are the sole writer. Other independent cache jobs use scoped locks
and conditional newest-observation upserts, not the same global lock for every task.

A fresh range's raw transport can be retained briefly for diagnosis, but normal operation
stores normalized required evidence and a bounded recent transfer/reorg tail, not one
per-request directory forever. Provider/body hashes are useful at import boundaries;
they are not rechecked across all history on every web request.

## Native acceptance policy

Use one initial policy: **full-range source corroboration plus checkpoint state checks**.
It is provider-corroborated evidence, not a cryptographic proof that providers cannot
share an omission. Record upstream operator/lineage information when known; two URLs
on a known shared backend do not count as two independent upstreams. Unknown correlation
is disclosed in the source profile; never advertise it as proved independence.

- Before committing each adaptive range, compare BOTH complete filtered HEX event sets,
  including Transfer: canonical ordering, count and a digest of chain/address, block
  hash, transaction hash/index, log index, topics and data. Reject removed logs at the
  accepted target, conflicting duplicates, out-of-range records and missing responses.
  Reuse verified headers; do not repeat a whole historical scan at every checkpoint.
  Explicit accepted numeric coverage follows the prior cursor even when observations
  are sparse. Retain real event/range/checkpoint headers; compare adjacent parent links
  where present, never pretend nonadjacent headers are directly linked. Checked bounded
  searches locate exact UTC last-before/first-after pairs. Grow block spans independently
  of event/header/byte/day/transaction limits; neither all-block header enumeration nor
  all-transaction receipts are mandatory under this policy.
- Compare range boundary hashes at the pinned accepted target. On a mismatch, provider
  limit, truncation hint or ambiguous result, bisect the range and compare again under
  the same finite job budget. Below a single block there is no smaller range: bounded
  transport retries may succeed, otherwise pause that stream with the unresolved block.
  Do not union disagreeing results, trust a short page, take a majority shortcut, or
  promote a one-source fallback to a completed canonical range.
- Each completed UTC day checks the replayed circulating/locked-supply accumulators
  against appropriate block-pinned contract fields. Corroborate these small calls and
  materialized dailyDataRange words with the second source. Check up to 32 distinct
  touched addresses per day using a deterministic sample at that day's close. This
  balance sample is a sanity check, NOT proof of all holder balances or log completeness.
- Deployment initialization uses verified code/receipt/constructor semantics, not an
  assumed zero state. Fork initialization checks both boundary identities, inherited
  stake state and supply. Seed import, fork initialization and the final bootstrap
  checkpoint each reconcile the full SQL balance sum and required stake aggregates;
  final bootstrap also compares every reconstructed current address balance to a
  qualified block-pinned source, plus a deterministic second-source sample. Account for
  this one-time work in timing/cost; do not do full holder enumeration per historical day.
- Cursor, range acceptance summary and replay-time daily accumulators commit together.
  Store compact counts/digests, source IDs and checkpoint versions in existing progress
  records; do not retain every HTTP response or a per-observation copy of every row.
  Unresolved finalized disagreement stops publication; last accepted data remains usable.

The source profile freezes finality mode and, for confirmed fallback, confirmation
count, maximum supported rollback window and chain boundary identities BEFORE that
mode is enabled. No universal guessed confirmation count or silent mode switch. The
approved early canary measures this actual policy, not a cheaper unvalidated path.
Tests include a supply-preserving omitted transfer, correlated omissions (which cannot
be claimed detected just because two sources agree), wrong constructor/fork state,
truncation, and finalized disagreement. Only receipt-level verification or a trusted
self-hosted source could support a stronger claim; neither is a new launch requirement.

## Bulk bootstrap without repeating daily publication

The independent rebuild target is 2–7 days, with a 14-day maximum acceptance duration
on the declared machine/provider profile. This is a target until measured end to end.
Use the same decoders and state-transition rules as normal sync, but a bulk work plan:

1. Freeze the supported chain/history coverage and target block identities. Acquire
   relevant filtered log ranges once; retry/split only for explicit errors or the
   documented completeness policy. Replay events in order through short resumable
   transactions. Keep day-boundary aggregates; do not run a full snapshot, validation
   sweep, ranking, and export job once per historical day.
2. Update only affected current projections while replaying. Reconcile the accepted
   target and generate complete current exports at the end/useful publication points,
   not a million-row full copy for every past date. Checkpoints record progress, not
   another complete state version. Historical backfill and live observation jobs share
   provider/resource budgets without letting the long backfill starve current metrics.
3. Retrieve supported protocol daily words in multi-day dailyDataRange calls. Those
   words are not a substitute for lifecycle/transfer events, holder counts, historical
   market observations, or the other independently defined daily statistics.
4. Cache required block headers by chain and verified block hash, use block-pinned
   calls, adaptive ranges, supported RPC batches and a bounded pipeline. Count both
   physical HTTP requests and logical RPC calls. Honor provider cadence, quota and
   Retry-After; do not use more endpoints or concurrency to evade limits.
5. Derive balances from the validated event/initial-state model and document efficient
   reconciliation at the fork and accepted checkpoints. Do not query every historical
   holder balance every day. Test constructor/mint/burn/self-transfer semantics and
   completeness checks. State the actual independent-provider coverage; never reduce
   verification silently to meet a speed target.
6. Keep native history, final current-state reconciliation, historical market coverage,
   and live on-demand readers distinct. Optional admitted indexed sources can accelerate
   import, but no single hosted subgraph or HEXDailyStats instance is the only independent
   rebuild path. Check real source capability; do not assume old endpoint availability.

Verify release integrity at controlled install/start boundaries with an appropriately
protected immutable release. Per-request checks are inexpensive lease/cancellation,
source-version, request-budget and cursor checks. No full application/dependency rehash,
recursive source walk, historical artifact sweep, or whole-database validation in a
provider dispatch callback. This is not permission to drop input/seed/block validation.

Measure provider latency/cooldown, local guard/hash work, decoding/replay, database work,
reconciliation and exports separately. Add a regression test showing that N requests
cannot cause N whole-release scans or N whole-state copies. The v1 94-minute acquisition
was one procedure, not a measured throughput limit for this bulk design. Early feasibility
and final timing acceptance are specified in docs/testing.md.

## Finality and reorganizations

The durable native index targets finalized data. Latest observations are disposable
provisional overlays and never advance the canonical cursor. Replacing a provisional
observation is cheap and cannot corrupt completed statistics.

Store recent block headers and bounded changed-row undo information for a documented
window (initial target 7 days of chain progress, measured for size). During historical
bootstrap this follows the validated replay cursor, not today's wall clock; pruning
also requires the consumer/recovery checkpoints specified in data.md. A detected mismatch within the
supported confirmed/reorg window rolls back changed rows in reverse order, invalidates
only affected daily/export/cache results, and replays the corrected suffix. Never
attempt to infer an undo from already overwritten fields. Enforce chronological cursor
and schema consistency. Finalized-checkpoint disagreement or a reorg outside the window
pauses publication with an actionable error; repair uses a verified backup/seed and
replay or an approved bounded rebuild, not silent deletion of canonical history.

Task 03 must prove the actual provider's finality behavior before live mode is qualified.
A configured source may lack archive calls or historical logs; doctor reports that
capability gap. No third-party explorer list is promoted to complete canonical history.

## Fork history without a daily snapshot forest

The known reference boundary is Ethereum block 17,232,999; this is a reference fact to
verify, not an unexamined magic constant. Common Ethereum-era events are indexed once
with their original chain IDs. The PulseChain projection starts from that fork state
and then applies only PulseChain's own suffix. No double-counting inherited transfers,
no resetting copied stakes' original dates, and no labeling old ended Ethereum stakes
as newly opened PulseChain stakes. Good-accounted-but-unended rows need explicit handling.

At launch a single PulseChain-serving projection is sufficient. It may contain one
projection row per historic stake with origin references, including closed pre-fork
stakes needed for history. This is bounded by real stakes, not number of days. Adding
Ethereum later creates its own necessary branch projection, not shared post-fork state.
Record the Ethereum boundary hash and the verified PulseChain entry block/hash in the
v2 chain definition when discovered. A seed carries these facts and coverage intervals.

## Daily data versus current observations

Completed-day payout is exact only when returned by the contract's materialized daily
ledger at an accepted block. UTC midnight does not by itself materialize that ledger.
Daily rows have independent payout status and observation block so delayed completion
is supported. Native daily facts do not wait for market acquisition.

A 60-second metric job pins one recent block and reads globalInfo/currentDay/supply,
plus a small allowlisted pool/anchor set. It updates a bounded latest-metrics record.
Price can have a different source block only if its own metadata says so. The service
must not call yesterday's payout an exact current-day payout.

Current-day estimate is computed from protocol rules at that observed state, including
pending daily rounds/next stake shares/penalty allocation where relevant. Prefer a pure
well-tested replay of the public rules over state-changing calls. No transaction is
sent and no private key is required. At launch it must be qualified for the current
post-claim era; historical claim/Big-Pay-Day logic remains separately tested for daily
history and cannot be approximated with modern equations. Missing/unsupported inputs
produce unavailable, never a zero or yesterday's number relabeled “live”.

## Live address path

The finalized SQL projection gives a fast indexed baseline and known lifecycle history.
On demand the API reads `balanceOf`, `stakeCount` and bounded pages of `stakeLists` at
one pinned recent block. Requests share an in-flight promise and TTL cache by chain,
address, block/page, and metric—not by unauthenticated arbitrary RPC payload.

Stake-array indices change when a stake is removed (swap deletion); do not persist an
index as stake identity. Pagination is pinned to its block. All pages must be obtained
before asserting complete enumeration. Stale cursor/block errors are explicit. Cap
100 stakes/page, at most 4 physical HTTP attempts and 128 logical RPC calls per public
request, including block discovery, balance/count, stake reads, corroboration, retries
and ID discovery. The 10-second address deadline includes queue time. Smaller pages or
explicit partial/unavailable results are allowed when the provider cannot meet that
budget; do not exceed it to fill a page. Large addresses use continuation, not hidden
all-at-once reads. A contract multicall's constituent reads still count logically.

When an ID is not in the finalized index, an optional bounded recent StakeStart topic
lookup can discover its owner. If the needed gap exceeds the supported live-search
window, return indexing/unknown, not a conclusive not-found. Address-supplied live
lookup still works. A missing stake in one page is not proof it ended. Indexed history
and live current list are separately labeled until reconciled.

No global live rank is promised. Rank comes from the last completed-day ranking run.
Suppress an ended stake from current-live totals only after complete at-block evidence
or a verified end event. Never merge partial observations into an allegedly exact total.

## Scheduling, retries and progress

One worker process has small independent recurring jobs: canonical sync, current metrics,
daily aggregation, exports and maintenance. Use persisted cursors/status, not systemd
invocation IDs as business results. A long bootstrap cannot block the 60-second metric
job; bound CPU and DB work, share rate budgets, and schedule jobs cooperatively.

Transient transport/429 errors get bounded exponential backoff with jitter and
Retry-After. Budgets persist enough across restarts to prevent retry storms. An outage
can span days: checkpoints do not expire merely because the calendar date changed.
Correctness conflicts stop that stream and preserve the last accepted data. A small
operator `repair-range` command is generic and tested, not a new dated recovery script.

Status includes phase, cursor/target, rows/events completed, latest successful response,
next retry, request budget, last primary error, and timestamps. Emit progress at most
30-second intervals during long work; do not rewrite gigabytes of state per event.
Clean signal handling cancels I/O, rolls back in-flight SQL and releases locks. Secondary
cleanup errors never mask the original one.

## Whole-application provider budget

Keep the first deployment to ONE API and ONE worker. config/limits.json declares the
combined limit, not a separate full allowance for each process. Fixed, non-borrowing
lane shares avoid a new coordinator service: address reads belong to the API; metrics
and sync share the worker. All endpoints sharing an account/quota use the same quota
group; failover, retries, discovery and batching cannot reset charges. Unknown quota
sharing is grouped conservatively. No Redis, public queue service or unbounded fanout.

The starter ceiling is 30 HTTP attempts / 900 logical RPC calls per rolling minute:
address 12/360, metrics 6/180, sync (including reconciliation/market backfill) 12/360.
These are conservative defaults, NOT measured provider capacity or a throughput promise.
Task03's source profile may set measured values within explicitly approved limits and
cost, with lane sums no greater than the declared total. A canary's aggregate session
caps additionally apply and cannot be multiplied by the number of lanes/processes.

API and worker each have at most one in-flight provider HTTP request and 8 queued
items; the worker gives metrics priority over new sync dispatch. Coalesce redundant
metric ticks. Reserve worst-case public-request work before dispatch, then charge each
actual attempt. Do not retry past the caller/job deadline. Client disconnect cancels
unshared work; requests still needed by coalesced callers continue within their original
budget. Cancellation/timeout after dispatch does not refund possibly charged work.

Use one small limiter implementation with separate fixed lane state. Persist only
coarse nonvisitor quota/cooldown state where needed; an API restart without such state
starts conservatively (no fresh allowance until the previous 60-second window could
have expired), never with a free new burst. Drain old processes before replacement;
extra API/worker replicas are unsupported until shares are explicitly repartitioned.
Separate endpoints do not multiply the installed application's total allowance. A
provider requiring account-wide spacing must get disjoint API/worker dispatch slots
(or be owned by one process); separate local delay timers do not enforce that rule.

Queued live work that cannot meet its deadline is denied, not allowed to starve metrics.
Preserve usable indexed data with per-component unavailability; use existing 429/503
semantics where no useful response is possible. Task09 measures API + worker + PostgreSQL
under ONE combined CPU/RAM envelope during bootstrap, metrics, addresses and exports.

## Fast Home and consistent serving

`GET /api/v2/home` returns a compact precomputed daily headline and independent latest
metrics in one fast database read. It never walks historical publication chains, scans
all stakes, hashes exports, or waits for providers. Each component carries its own
as-of/finality/status. The UI mounts those metrics immediately; chart/history and
catalog requests load separately and never gate the initial headline data.

Canonical projection writes and cursor advance are atomic. Multi-query API services
use a short repeatable-read snapshot if consistency across queries is required. Across
separate endpoints return observation revisions; do not invent one global latest-time
when price, index, and daily data have different clocks.

The database's unique current export_bundles row is the publication authority; no
second filesystem 'latest' pointer. Under a bounded consistent read, stream a new UUID
bundle into a private temporary directory, hash/verify, fsync files and directory, then
rename to its immutable final directory on the same filesystem. Only AFTER files are
durable does one DB transaction publish file metadata and change current/prior states.
A crash before that transaction leaves unadvertised work; a lost commit acknowledgement
is resolved by reading that same UUID/state, not regenerating bytes under its identity.

Retain current + one prior export bundle plus one bounded build; these are files, not
SQL state clones. Cleanup removes only owned unreferenced output after checking the
publication state, active builder and download grace window. Missing/corrupt published
files are never served. Startup/restore verifies the bounded bundles once (not per
request); until then the download catalog says rebuilding/unavailable while Home and
other healthy API routes remain usable. Regenerate missing bundles with NEW UUIDs from
the actual restored checkpoint; never reuse an old immutable ID for different bytes.
Retire missing old IDs explicitly (410), including an unreconstructible prior bundle.
Exact original bytes may retain an ID only after verification against its saved hashes.
Open streams may finish while old names retire; test Windows/Unix behavior and grace.

## Recovery and modular extensions

Schema migrations follow expand/compatible-change/contract practice as needed. API and
worker move together as one release. Rollback of an application image is supported only
for compatible schema versions; database recovery uses a tested backup/replay path.
One prior CSV bundle is not a database backup. Do not promise arbitrary historic SQL
serving states, because the owner explicitly does not require them.

New chain adapters implement the same ingestion interface. Auth/entitlements can wrap
API services later. Leagues/query builders consume selected read models. Notifications
consume a separate optional subscription module. None needs a generic plugin bus now.
