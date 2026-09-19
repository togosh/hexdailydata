# Data model and retention

Task05 adds the compact overlays documented below. The Task02 mapping describes the
unchanged native row/undo contract; Task03's acquisition/seed/pruning mapping remains
in [sync and recovery contract](sync.md).

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
| history_source / history_daily | one current attributed HDS PulseChain selection/revision and up to10,000 compact source-day rows; independent of native chains/cursors/undo |

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
For the HDS overlay, market scope is PulseChain HEX only; pre-fork Ethereum prices are
excluded. Required inherited native protocol history and origin-chain1 remain intact.

## Source-reported PulseChain history (schema5)

Migration0005 adds `history_source` and `history_daily`; migrations0001–0004 are unchanged.
These tables have no native-chain foreign key and never seed `daily_stats`, balances,
stakes, events, market samples, current state, sync cursors or undo. One transaction
publishes the selected rows plus metadata/revision. Exact repeats do no writes;
replacement requires the current revision explicitly. Unchanged rows are not rewritten.
Only the current compact selection is retained, not full historical revision copies.

The input digest, mapping version, provenance, source-day/date bounds and exclusions
are explicit. Exact published number tokens, including exponents, are preserved as
strings; this preserves publication precision, not on-chain accuracy. Null, absent,
sentinel, negative/invalid, suspicious skeleton and available values remain distinct.
Only `pricePulseX` can supply the daily reference; UV/ETH/BTC/derived ROI fields are
excluded. Record coverage and price coverage are separate. See [history.md](history.md)
for the mapping, source limitations and first-supported-period interpretation.

Current logical seeds use format4/schema5 and include both archive tables, even when
empty, with separate normalization/selection validation. Older formats fail explicitly.
A valid native checkpoint is still required for seed export; a raw HDS file or archive-only
DB cannot become a native seed. A nonempty archive-only target rejects native seed import.
Encrypted schema5 backup/restore supports both archive-only and native-plus-archive state.
Archive values survive native forward sync/rewind independently of native undo.

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

## Frozen foundation definitions (Task01)

These definitions are implemented in pure `src/domain` functions and checked with
literal vectors, not with a v1 status helper as the oracle. Protocol source is the
[Etherscan HEX source record](https://etherscan.io/address/0x2b591e99afe9f32eaa6214f7b7629768c40eeb39#code),
retrieved 2026-09-19; see reference.md for function names and limitations.

Contract days start at 2019-12-03T00:00:00Z (1575331200 seconds), use UTC intervals
[start, start+86400), and are zero based. Display day is contract day + 1. Supported
contract days are 0–65535; a new stake whose maturity exceeds that horizon is rejected.
A transaction on day d locks on max(d+1, 2), for 1–5555 days. Launch day 0 and day 1
therefore both lock on day 2; day 2 locks on day 3. Ordinary cancellation is strictly
before lockedDay. Ending on lockedDay serves zero days but is an early end subject to
protocol penalties, not a cancellation. Historical claim-created auto-stakes originate
on days 1–350, have at least 350 staked days, and cannot end before 350 served days.
This historical coverage does not add auto-stakes to the ordinary calculator UI.

`stakeGoodAccounting` is permitted only at/after maturity and only once. It removes
accounted shares and settles payout/penalty accounting, but leaves principal in the
contract locked-hearts total and does not pay the staker. A later StakeEnd repeats the
same payout/penalty fields, removes principal, and returns principal+payout minus the
capped penalty. It must not subtract shares or record payout/penalty a second time.
Raw event penalty remains in the settlement; daily realized penalty is capped at
principal+payout. Actual circulating-supply changes must follow Transfer events,
including penalty-beneficiary mints; do not treat these pure effects as a full supply
reducer. Task02 owns ordered event integration and replay/idempotence.

| Named set / metric | queued | open | mature-open | good-accounted | ended/cancelled |
|---|---|---|---|---|---|
| Contract locked principal; staked percentage | yes | yes | yes | yes | no |
| Accounted principal: weighted duration, holder accounted stake amount/count, active staker address count | yes | yes | yes | no | no |
| Accounted payout shares after day activation | no | yes | yes | no | no |
| Future scheduled maturities | yes | yes | no | no | no |

Active stakers means distinct owners with at least one accounted-principal position;
liquid holders means distinct addresses with a positive liquid balance. Good-accounted
principal is neither current accounted stake principal nor yet minted liquid balance.
Accounted sets are therefore not substitutes for contract locked supply. Weighted
length is sum(principal hearts × original staked days) / sum(principal hearts) over
accounted principal; it includes queued stakes consistently with the inspected legacy
metric's explicit predicates, while payout shares do not. No remaining-duration or
share weighting is substituted. No members yields unavailable (null), not zero.
Years, when displayed, divide the exact day ratio by 365.

Hand vectors in `tests/unit/protocol.test.mjs` use day-10 starts (lock 11): ending on
10 returns 100 hearts without penalty; on 11 a supplied 12-heart penalty returns 88.
GA on day 62 (maturity 21 plus the 14-day grace period plus 27 late days), with
principal 100 and payout 30, has penalty floor(130 ×27/700) = 5. It removes
50 accounted shares and no principal; ending on 70 returns 125 and removes 100 locked
hearts with no repeated settlement. Auto-stakes reject 349 served days and accept 350.
Weighted duration for 100 hearts ×10 days plus 300×30 plus a queued 900×10 is exactly
190/13 days; adding a good-accounted row changes neither numerator nor denominator.

Payout/T-share = payout hearts ×10^12 / (daily shares ×10^8). HEX/T-share before
bonuses = raw share rate ×10^12 / (100000 ×10^8). These are reduced bigint rational
values until presentation. Wire/display payout ratios truncate to at most 8 decimal
places, removing trailing zeros; this is not canonical settlement rounding. Raw
payout/share inputs are retained on the wire. Token principal uses exact 8-decimal
HEX conversion without rounding. No USD interpretation is attached to a share rate.

The 1/30/365-day preset is the arithmetic mean of exact daily payout/T-share ratios
for exactly N consecutive completed, materialized days ending at an explicit ledger
cutoff strictly before currentDay. Fifteen days with payout 1 heart/shares 30000 give
1/3 HEX/T-share each; fifteen with payout 2/shares 70000 give 2/7 each. Their mean is
(1/3+2/7)/2 = **13/42**, whereas summing payouts and shares first gives **3/10** and is
not this preset. Missing/pending days, missing amounts or zero shares yield unavailable;
a measured zero payout with positive shares is a valid zero. No gaps are averaged away.

Completed ledger payout is distinct from today's provisional estimate. Current-day
estimation and stake reward/penalty formulas beyond these settlement event semantics
remain Task04 and subsequent calculator integration; Task01 does not infer payout from
3.69%/365 or claim complete historical Big-Pay-Day reward calculation.

The fork contract remains architecture.md's nonoverlapping common Ethereum history
and PulseChain suffix. Boundary 17232999 is a reference, not runtime qualification.
Preserve original event chain/date and serving chain separately, including ended and
GA-but-unended inherited stakes. Task03 must verify boundary hashes, entry block, code,
constructor/fork state and source capabilities before enabling live operation.

## Task02 persisted checkpoint contract

Migration 1 is now executed on fresh private PostgreSQL17 targets. The table list
above describes the complete product plan; Task02 creates only `chains`, `sync_state`,
`current_state`, `accounts`, `stakes`, `share_schedule`, `daily_stats`, `events`,
`transfers_recent`, `blocks_recent`, `checkpoints_recent`, `undo_recent` and the migration
ledger. Market/cache/export/job tables remain later migrations. No runtime request
rechecks source files. Migration checksums apply only to explicit migration commands.

The SQL boundary accepts decimal strings, validates them, and uses bigint arithmetic.
`hdd.amount` is exact NUMERIC with scale zero and bounds 0..2^256-1. `hdd.total` is
scale-zero NUMERIC in [0,10^102); this covers (2^63-1) positions each of uint256 principal,
weighted by at most5555 days. Aggregate overflow stops the transaction. Unconstrained
NUMERIC plus explicit checks deliberately rejects fractional SQL inputs instead of
rounding them through a NUMERIC(p,0) cast. Counts, block numbers and stake IDs are
nonnegative signed BIGINT (at most2^63-1); days are bounded integers. No amounts pass
through JavaScript Number. Addresses/hashes use 20/32-byte BYTEA domains. Day sample
addresses are a bounded BYTEA array populated from the same validated address inputs.

The accepted-input boundary compares two complete **supplied** normalized event sets,
including raw topics/data and decoded values, plus explicit contiguous numeric coverage with sparse actual headers, day-close supply
and deterministic balance samples. Known shared operators are rejected; unknown source
correlation is recorded as null. Matching sources can share an omission: agreement is
not an independence or completeness proof. Task03 must provide complete acquisition,
correct ABI decoding, targeted constructor receipt/code identity, finality qualification and corroborated
pinned calls. Task02 has no provider transport and makes no live acceptance claim.

A commit contains at most2048 verified headers across an explicit interval of at most1,048,576 blocks,2000 supplied logs per source,32 day
boundaries and1024 materialized daily words. More work must be split into checkpoints.
DailyDataUpdate protocol logs are retained independently from pinned materialized words;
a delayed read may fill multiple earlier days without inventing a new protocol log.
One materialization per day per batch is permitted; equal later observations preserve
the first accepted identity, conflicting amounts fail. Current/future-day payout is
never materialized. Raw settlement penalty is stored on the stake; daily penalty is
capped at principal+payout and recorded once, at GA or first End. Transfers alone change
circulating supply. Claim logs have no extra mint effects beyond their Transfer and
StakeStart logs. No claim/BPD payout estimator is implemented here.

| Durable state | Owning transaction / position | Rewind | Seed format2 representation |
|---|---|---|---|
| Chain identity, constructor state, fork boundary | Explicit empty-chain initialization; two supplied states must agree; constructor sum and fork full SQL aggregate/owner/schedule audit | Initialization is the floor; cannot rewind behind it | chains plus referenced parent/entry identities in manifest |
| Current accounts and stake lifecycle | Native writer commit at sync block/hash | Exact changed-row before-images; newly inserted rows deleted | accounts, stakes |
| Current supply, locked/accounted principal, weighted numerator, active/queued shares, rate, holder/staker counts, in-day starts/ends/payout/penalty | current_state, same native commit; no asynchronous native consumer | Entire small accumulator row restored | current_state, including contract_day |
| At most32 lexicographically smallest touched addresses in the current day | current_state.sampled_addresses, same commit | Restored with accumulator | current_state; not a historical holder snapshot |
| Queued-share activation totals | share_schedule per activation day; starts/cancels update only that day; midnight consumes it | Updates/inserts/deletions restored | share_schedule |
| Daily native close and pending/materialized payout | daily_stats; native facts close strictly before UTC transition; both sources supply supply and sampled balance checks; materialized words carry a separate accepted observation block/hash | Affected day rows/owned payout fields restore via full exact prior row | daily_stats, including payout status and observation identity |
| Accepted cursor, finality, source IDs/digests, ranking cutoff | sync_state advanced with all native reducers and CAS | checkpoint.previous_sync restores fields; revision advances monotonically to fence stale writers | sync_state; manifest checkpoint repeats block/hash/time/finality/revision/rewindFloor |
| Recent headers/transfers and protocol evidence | Same commit; events keyed by original chain/block/log; receipt digest handles exact whole-batch retry | Inserts/changes restored in reverse order | blocks_recent, transfers_recent, events |
| Batch receipts and before-images | checkpoints_recent and undo_recent in same transaction | Reverse sequence per checkpoint; removed suffix receipts cascade only their own undo | Both tables; JSON numbers restored inside SQL, never JSON-parsed through Number |

Queued/open/mature-open are derived from explicit start/lock/term and the requested
current day; settled lifecycle is explicitly persisted as good_accounted/ended/cancelled.
Maturity changes no accounted sums; it needs no daily stake rewrite. Activation shifts
one day's scheduled share sum into active shares. Only changed accounts/stakes are
written. Ranking values and the shared ranking_day cutoff remain unavailable (null);
Task05 must publish values and that one cutoff in one transaction. No date-only account
rewrites occur. Native daily reducers have no separate delayed position because they
commit synchronously. Payout completion is independently represented per ledger day;
pending payout does not retain unrelated transfer history. Market consumers are not
implemented and must add their own explicit cutoff when introduced.

The writer owns one dedicated connection and session advisory lock (4242,chain).
Connection or lock loss invalidates it; callers must explicitly acquire a new writer.
Before retrying an uncertain commit, the writer looks for the exact batch digest at
the target checkpoint. It never reapplies additive changes merely because an ack was
lost. A conflicting duplicate fails. Unsupported partial/overlapping retries must be
rebuilt from the committed cursor. The SQL tests inject an after-COMMIT exception for
lost-ack coverage and separately terminate a real backend during an open transaction.

Rewind is allowed only in confirmed mode, to a retained checkpoint at/above rewind_floor
and within604800 seconds of validated chain progress. Finalized disagreement stops for
explicit repair. Before-images include deletes (for example consumed activation totals),
current accumulators, daily materialization and cursor acceptance. Revision is a fencing
token, so logical state/cursor equality after rewind excludes only its deliberately
increased value; replay uses that new revision. Sequence gaps from failed transactions
are harmless, not business progress. No delayed overlay jobs are wired in Task02;
future cache/export/market jobs must invalidate observations after the rewound cutoff
before publication, while preserving independently sourced unaffected market facts.

No pruning scheduler runs. Publication stops at4096 retained checkpoints,128 MiB of
measured undo tuple bytes, or256 MiB of measured recent header/transfer tuple bytes per
chain. These are logical tuple accounting limits, not physical database size guarantees
(indexes, TOAST overhead, WAL and dead tuples are measured separately). The initial
rewind_floor remains pinned until Task03 implements explicit safe retention advancement.
That operation must keep consumer/recovery/export pins, respect seven days of **replay**
time, delete only unneeded prefixes, and adjust receipts/counters atomically. Pressure
never silently deletes protected inputs. Initial fork copies are one necessary serving
projection; common-origin events are not copied. Full SQL reconciliation is performed
at initialization/audit checkpoints, not on each batch or public request.

The seed manifest's table allowlist now exactly matches implemented durable data and
checkpoint tables; migration ledger, instance identity, credentials and advisory locks
are excluded. SQL tests check this alignment and restore actual data/progress through
rewind. They are **not** a portable seed import/export proof; archive security, row codec
(including BYTEA/large NUMERIC), semantic import, pruning and rebuild/seed equality remain03.

### Query/index purposes

Every table's primary key supports point lookup/upsert or scoped ordered checkpoint
access: chain/current/sync by chain; accounts by chain/address; stakes by chain/stake;
daily and schedule by chain/day; original events/transfers by origin/block/log; recent
headers by chain/number; receipts by chain/revision; undo sequence for ordering. The
receipt unique(chain,block) index resolves lost acknowledgements and selects rewind
suffixes. `undo_checkpoint(chain,revision,sequence DESC)` supports bounded reverse undo.
`stakes_address(chain,address,stake_id)` supports keyset owner pages; `stakes_maturity`
supports future unsettled maturity ranges without changing mature rows;
`events_stake(origin_chain_id,stake_id,block_number,log_index)` supports lifecycle history.
There are no rank, generation, date-per-account or unused market/export indexes in v1.
The million-row harness saves real EXPLAIN(ANALYZE,BUFFERS) plans for these serving queries.

Fork initialization retains the parent boundary as the serving cursor/floor and copies
that state. The declared first native block is still unconsumed: its number/hash must
match the first ordinary native batch, which applies its events and any elapsed day
boundaries. The entry may be on a later day. A daily close whose last block is still
common history retains origin1. Once a serving fork exists, new parent commits/rewinds
are refused so they cannot invalidate inherited state/common event references. A future
independent Ethereum suffix needs an explicit task-owned extension; it is not enabled here.

Task03 acquisition follow-through: sparse headers are observations, not synthetic empty
blocks or evidence of parent linkage across skipped numbers. Each accepted range follows
the cursor exactly; both sources corroborate its actual endpoints and event sets. The
writer receives one observed UTC day per range; checked last-before/first-after searches
preserve exact close identities. See sync.md for bounds and seed format2 rejection rules.
No migration or canonical amount/reducer definition changed.


## Task05 daily overlays (original format3/schema4)

Migrations1?3 remain byte-for-byte unchanged. Migration4 adds account_ranks and
rank_state, market_sources/samples/daily and export_bundles. No canonical account,
stake, daily or before-image row changes shape. The export manifest is the compact
file catalog in one JSON value; there is no separate export_files or job_runs table.

Liquid and staker ranks are consecutive ordinals, amount descending then address
bytes ascending. Only positive liquid/accounted principal qualifies for that rank;
zero on the other side has a null rank. Holders include the union of those sets.
Accounted principal/count excludes GA, ended and cancelled and includes queued,
open and mature-open. Maturities use scheduledMaturity: queued/open only, strictly
future maturity day; mature-open and GA are excluded. Rank values and the shared
ranking_day commit together. ranking_day names the last completed protocol day;
rank_state records the actual accepted block/time, which may be later than midnight.
Current balances retain their separate current-index as-of. Identical ranks are not
rewritten merely to advance the shared cutoff. No historical rank copies are kept.

Daily CSV reads closeDay/applyPayout facts. Payout per T-share truncates to12dp,
weighted days and staked percentage to8dp. Undefined ratios are empty; a materialized
zero-share ledger remains materialized with an empty ratio. The post-claim current
estimator never supplies historical claim/BPD rows. Lifecycle timestamps join permanent
start/end events using the event origin and fork boundary, including inherited ended
and cancelled stakes; recent headers are not an export dependency.

Market source IDs are fixed public slugs, at most four per chain. A route ID hashes
its declared route/provider identity and carries peg_assumed; two providers at one
block corroborate reserves, not independently priced USD. Prices retain rational
numerator/denominator; CSV display truncates to24dp. Route samples reuse a successful
Task04 read and add no HTTP allowance. Source block time defines UTC minute/day;
pool reserve-update and collection time remain distinct. Same source/block is one
identity, including repeated polls. Equal prices at different block identities count
only the actually observed minute buckets. Sampled OHLC includes all accepted marks
in those buckets, not all trades. Volume/liquidity is empty for reserve samples.

The supported source-reported adapter accepts raw JSON {chain,source,bars:[...]},
at most1440 bars/2MiB per offline file. Each bar is {time,revision,open,high,low,close,
volume,liquidity}; time is an integer Unix UTC minute start, revision an integer
string, prices/optional USD fields decimal strings with at most24dp. Only closed
intervals are accepted. Its source profile fixes chain/source/fromDay/method; no
provider endpoint or supported live history window is configured. Volume sums only
source-reported nonoverlapping minute volumes; liquidity is the last observed estimate.

Daily observations are per(source,day), including explicit missing days. Complete
means all1440 minute intervals under that method, never all venues/trades. Partial
means fewer; outages/pretrading minutes are not forward-filled. Distinct sources
never silently merge. Late retained-interval revisions dirty only their affected day;
aggregation increments a source version only when the daily observation changes,
which makes the scheduler publish a NEW immutable bundle. A correction requiring
already retired minute inputs is explicitly refused; those inputs must be reacquired
under a separately implemented/qualified historical source contract, not invented.
Local samples lost after restore remain gaps. Offline fixture coverage is not live
market qualification. Missing source profiles are NOT_CONFIGURED.

market_sources records through_day, earliest dirty_day, source definition, logical
sample bytes and capture status. Each invocation processes at most31 days per source.
Pruning removes samples at least seven days behind the aggregated cutoff only when
no dirty day still needs them and the shared snapshot/prune lock is available. Pending
unaggregated observations survive nominal age. A64MiB logical sample limit per source
pauses capture with byte_pressure; it never deletes required input. Physical bytes,
indexes and WAL are separate measurements. This is a finite maximum256MiB logical
sample allocation per supported chain, not a claim about total physical disk.

A native rewind atomically clears ranks/cutoff, invalidates export availability and
removes the dependent native sample/daily suffix. Independent venue history survives.
Native daily facts still use exact original undo. Format4/schema5 retains the format3 ranks,
market daily facts, consumer progress and remaining required samples using the existing
exact SQL row codec. It excludes live_metrics and export_bundles; imports cannot
advertise nonexistent files or fresh old live observations. Older logical formats
are rejected. A seed semantic audit checks rank cutoff/range/density and market
metadata/coverage/bytes. Retained days outside the pending dirty suffix are reaggregated
with bounded cursors and compared to their stored observations, rejecting lost correction
markers before inputs can be pruned. These are ingestion checks, not ordinary serving queries.
