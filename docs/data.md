# Data model and retention

## Storage principle

Store each required event once, one current stake/account projection, and one row per
useful daily observation. Do not store a full row for every unchanged stake on every
date. There is no generic facts/provenance archive and no per-generation schema.

The scaffold migration is an **initial schema contract**, not an applied production
migration. Task 02 may refine it with documented reasons and an isolated SQL test.
Use one `hdd` schema, ordinary versioned migrations, explicit queries, and only the
indexes demonstrated by real queries. Address and hash columns are BYTEA (20/32 bytes)
in SQL; lowercase 0x strings on the wire. Counts/block heights/stake IDs use integers;
raw token/share magnitudes use NUMERIC(78,0), never float. API big integers are strings.

## Tables / purpose

| Table | Purpose / growth |
|---|---|
| chains | verified public contract and lineage metadata; O(chains) |
| sync_state | accepted cursor, target/finality mode and useful job state; O(streams) |
| blocks_recent | short header window supporting reorg checks; bounded |
| events | compact canonical protocol events; real event growth, not publication growth |
| transfers_recent | short transfer replay/debug window; bounded after committed checkpoints |
| undo_recent | before-images only for changed rows in supported reorg window; bounded |
| stakes | one current lifecycle projection per (serving chain, stake ID); O(real stakes) |
| accounts | current balance and basic current stake totals per address; O(addresses) |
| daily_stats | canonical daily native facts and independent payout materialization status |
| market_daily | observed daily price/liquidity/volume only for supported sources/coverage |
| market_samples | compact short price observation window for 24h change and daily aggregation |
| live_metrics | latest validated observation by chain/metric; bounded key set |
| export_bundles / export_files | complete current and prior file manifests; bounded |
| job_runs | short operational history; retention by age/count |

No table of arbitrary historical holder balances or holder ranks. An account's zero
balance may remain if it is a stake owner or needed for uniqueness/first-seen metrics;
this grows by unique addresses, not days. A daily ranking is updated in place or kept
as one compact current rank relation, not a permanent sequence of full ranking copies.
Prefer one shared completed-ranking cutoff in existing checkpoint metadata, updating
rank values only when needed rather than rewriting every unchanged account's date.
Tasks02/05 must publish rank values and that cutoff as a consistently visible result;
an interrupted calculation leaves the previous complete result identifiable. Preserve
CSV/API as-of semantics. This is a schema preference to validate in the owning tasks,
not a pre-Task01 migration or permission for historical rank snapshots/new services.

## Canonical evidence versus projections

`events` retains original chain, block/hash, tx hash/index and log index plus the exact
packed event payload needed to re-decode and audit the stake lifecycle. Store decoded
fields only where useful for queries. Do not preserve full HTTP envelopes or every
ABI response alongside equivalent normalized state indefinitely.

Transfer replay feeds BOTH current balances and the required daily statistics before
anything is pruned. Tasks02–03 own the single shared replay-time reducers and ledger
primitives: holder/staker counts, circulating/locked amounts, weighted numerator and
denominator, starts/ends/penalties, and pending versus materialized payout identity.
Task05 schedules/finalizes/exports those results; it must not invent a second reducer
or require a new historical transfer acquisition to compute an agreed daily column.
For daily reducers already atomic with canonical replay, use the same commit position,
not a separately scheduled queue/consumer. Separate durable positions are for genuinely
delayed work such as payout materialization or market aggregation. Keep transactions
bounded and retain delayed-consumer protection and tests; simplify topology, not safety.

Before pruning exists, Task02 documents each durable accumulator and cutoff, its
commit/rewind behavior and seed representation here. Include cursor, progress and
consumer positions alongside data-row undo: the draft `undo_recent` relation whitelist
alone does not define their rollback. Prove the actual mapping with SQL/crash/seed tests
in the owning tasks; no new consumer registry or generic provenance framework is needed.

Prune a transfer/header/undo range only when all are true: acceptance is committed,
current projection AND required daily consumer checkpoints have passed it, the range
lies behind the supported rollback window measured from the validated replay cursor,
and no active seed/backup/export/recovery job needs it. During bootstrap a years-old
block is not eligible merely because today's clock is far ahead. Pending contract
payout materialization does not pin unrelated transfer history once daily accumulators
are durable. Likewise a market sample waits for its daily OHLC/coverage consumer.

Use compact per-consumer cutoffs and short job leases, not one reference per event.
Byte pressure pauses acquisition and reports the blocking cutoff; it never deletes
protected replay input. A seed includes daily accumulators, consumer positions, and the
needed recent window. Historical reducer changes after pruning require an explicit
upstream replay/seed rebuild; the local recent tail cannot reconstruct all old balances.
Historical provider availability is a capability requirement, not a local archive claim.

Use the deployment receipt and constructor events when bootstrapping from contract
creation; a missing initial mint cannot be assumed zero. Sum of current account balances
must reconcile to contract `totalSupply` at the same block, with zero-address mint/burn
semantics and self transfers handled correctly. Locked principal is not circulating
ERC-20 balance; derive allocated supply explicitly.

## Key semantics

- Display HEX day is contract zero-based day + 1; timestamps and daily boundaries UTC.
- Historical stake ID is paired with its serving chain; original event origin remains
  separately identifiable across the fork. No “new” copied stake or duplicate pre-fork
  event. Complete, good-accounted and cancelled states remain distinct.
- HEX staked percentage: contract locked hearts / (circulating hearts + contract locked
  hearts) ×100 for the stated block. Do not interchange this with an address union or
  with a different active-principal definition.
- Weighted average length: original staked duration weighted by principal over the
  clearly defined native accounted-stake set. Task 01 freezes inclusion of queued,
  mature-open and good-accounted states against the verified reference; do not silently
  swap remaining duration or median into this metric. Store numerator/denominator,
  compute presentation units explicitly (years = days/365).
- Payout per T-share: day payout hearts ×10^12 / day stake shares /10^8.
  Store exact payout and denominator; render using a documented decimal rule.
  A zero shares denominator yields unavailable, not infinity or zero payout.
- T-share rate: distinguish raw contract shareRate, HEX per T-share before bonuses,
  and a hypothetical stake's effective HEX/T-share after bonuses. Never label raw
  shareRate as a USD price.
- Calculator: ordinary new stake starting now, latest rate; 1–5555 days; LPB/BPB and
  protocol rounding exact. Future payout/HEX price inputs are scenarios, not guaranteed
  interest or a bank deposit. Do not label a simple annualized return “APY”.

## Retention defaults and physical growth

| Class | Default retention |
|---|---|
| Verified stake lifecycle, share-rate events, useful daily facts | all supported history |
| Current accounts/stakes | one projection |
| Recent headers/transfers/changed-row undo | 7 days behind validated replay progress, and only below every required consumer/recovery cutoff; byte cap pauses ingestion |
| Minute price observations | 7 days; aggregate verified daily OHLC/coverage before retiring |
| Latest live observation | overwrite the bounded current record |
| On-demand address cache | in memory ≤60s fresh, bounded LRU (64 MiB total) |
| Standard export bundles | current + one previous, plus one bounded in-progress bundle |
| Job/request diagnostic logs | 14 days and a byte cap; aggregate counters longer if small |
| Bootstrap scratch and failed temporary output | age/byte capped, resume-aware |
| Recovery backup | one verified off-host copy; replacement may coexist until verified |

A raw payload is not “unique history” merely because it was saved in a new folder.
No generic per-observation record pointing to every unchanged row is required.
Regular maintenance prunes only explicitly owned, nonreferenced materialized output;
it is part of normal worker operation, not a manual epoch/date script.

Deletion does not guarantee PostgreSQL releases bytes to the filesystem. Measure heap,
TOAST, indexes, files, WAL, temporary high-water and total free space separately. Use
normal vacuum/autovacuum for reuse; recurring full-table rewrites are not the operating
plan. Use time partitions only when measurements justify them (recent samples/tails
are candidates), not by default for every small table. Budget an emergency maintenance
operation separately. Source events and current/protected data are never pruned to
make an unmeasured capacity test pass.

Release acceptance: at least one million realistic stake rows, realistic balances and
event history, 30 simulated days including unchanged days, changing days, market lag,
failed exports and retries. Expanded storage must not grow O(all stakes ×days). Report
real bytes with and without indexes and backups. A zero-change day may add bounded
job/day/sample records, but no full SQL data clone. At most two complete export bundles
remain once the grace period expires. Targets are in testing.md, not fake measurements.

## Coverage to freeze in the Task03 source profile

This table is the scope; the canary brief fills actual ranges, sources, capabilities,
quotas, validation method and gaps. It is a section of the existing task report, not a
new registry/service. No measured provider coverage is supplied by this kit.

| Data | Requirement / honest gap behavior |
|---|---|
| Native lifecycle and required Transfer history | Complete supported deployment-to-frozen-target history, including initialization; an unresolved missing native range fails that profile |
| Shared Ethereum-era history and PulseChain suffix | Explicit boundary hashes/code/state and nonoverlapping ranges; no copied pre-fork events counted as new PulseChain activity |
| Native daily statistics / materialized payout | Required replay-time daily facts; contract payout can be pending until materialized, never invented |
| Live price / rate / current payout estimate / addresses | Required supported current methods with declared freshness and combined request costs; temporary outages remain explicit |
| Historical HEX market series | Declare the actual HEX/USD price intervals and per-field methods; pre-trading absence and other gaps must be explicit and admitted before calling that market coverage complete |
| Historical volume/liquidity and full-trade OHLC | Only when the chosen source supports them; optional/partial fields stay null and labeled, not a new exhaustive pool-history job |

Missing mandatory capability rejects the profile. Market gaps do not prevent native
index progress, but native completeness is not evidence of complete market coverage.
No BTC/ETH asset feeds, retrospective holder snapshots or legacy-format parity are added.

## Portable seed v1 (product is v2)

`seed.tar.gz` contains `seed.json` and only allowlisted per-table NDJSON files. This is a
new logical format, not a v1 PostgreSQL dump. The manifest describes version, chain/
contract/fork identities, cursor, source cutoffs, coverage/gaps, schema/calculation
versions, row counts, file hashes and declared uncompressed sizes.

Required data: canonical supported protocol history, current stake/account state,
daily facts, daily market observations/coverage, and compact checkpoints. Recent
reorg/transfer window is included if the cursor needs it. Do not include credentials,
locks, HTTP access logs, cached visitor queries, old generated files or v1 schemas.

Import only into an empty v2 target by default. Reject path traversal, symlinks,
hardlinks, duplicate/case-colliding paths, decompression bombs, unknown tables, unsafe
SQL, malformed amounts and wrong chain identities. Hash the stream; verify counts,
uniqueness, chain lineage, supply/aggregate invariants and expected contract references
before marking ready. A hash alone authenticates neither the seed publisher nor truth.
The trusted digest/identity arrives out of band or via a reviewed release record.

Seed publish must be tested by importing in a fresh project with the legacy folder
absent, then syncing forward and comparing with an independent rebuild at the same
checkpoint. The starter includes no real seed and no invented seed URL. Creating a
qualified real seed is an output of live qualification, not an invisible prerequisite.
An explicit v1 export-file translator may aid first migration, but no automatic access
to the old database is allowed; it is a separate owner-approved import, not the
independent-rebuild proof.
