# Task03 acquisition and recovery contract

Migration 2 preserves migration 1 and adds `source_history` (one verified acquisition
start, source pair and finality policy per chain) and `recovery_pins` (at most four named
cutoffs per chain). These native tables travel in seed format2; Task04 updates storage
schemaVersion to3 and excludes disposable live_metrics from the archive. The manifest JSON
Schema is generated from the runtime Zod manifest; calculation version is `hex-native-1`.
Database identity, migration credentials and session locks never travel.

The constructor may have explicit zero supply and no mint logs. This is checked against
the deployment receipt and pinned contract fields; it is not a missing-input default.
The inspected HEX constructor sets share rate and claim/ledger initialization without
minting an ERC-20 balance. The older positive-supply fixture remains a synthetic case.

Acquisition compares two complete filtered HEX event sets, including Transfer, over an
explicit numeric from/to interval following the prior cursor. It checks raw ABI values,
canonical order/duplicates, bidirectional transaction identities, actual event header
number/hash/time and transaction-list membership. Known shared upstreams are rejected;
unknown correlation remains null. Equal omissions that evade supplied state checks are
outside this provider-corroborated policy's proof. No union, digest-only assertion or
single-source fallback is accepted. Only constructor verification requests receipts.

Each accepted interval is within one observed UTC day. Its headers are sparse actual
observations: the first/last and event blocks. Both sources also supply the prior cursor
header and, when a search clips the requested interval, the actual adjacent first block
of the next day. Checked binary brackets locate that pair; all lookups consume the sync
lane. The next commit closes the previous day using its real last block, pinned supply
and deterministic address samples. Activations, empty days, inherited fork ownership
and delayed payouts still use the existing reducers. A real timestamp jump can close
at most32 days at one boundary; a larger unresolved single-block jump pauses.

Range spans start at128 and can double to1,048,576 blocks, independent of the bounds on
2000 raw events,2048 verified observations,32 day transitions,1024 daily words and16MiB
RPC responses. Search takes at most20 midpoint calls per source/attempt. No array or
loop is allocated for skipped block numbers. Event-header RPC batches contain at most30
items. Transaction lists are checked then discarded; the2049-entry cache retains only
plain headers. Conflicting observations and changing range/previous/day boundaries
reject the attempt. Parent hashes are checked only for numerically adjacent observed
headers; agreement across gaps relies on corroborated canonical-range/finality evidence,
not invented parent links. Recovery promises retained checkpoint rewinds, not arbitrary
skipped block rewinds; a confirmed reorg without a retained checkpoint inside its
configured block window pauses. Decoding remains outside the writer transaction.

The durable acceptance policy is `filtered-range-sparse-v2`, with explicit range endpoints.
Seed format2 rejects format1 and unsupported old acceptance metadata instead of treating
old contiguous-header claims as sparse coverage. Schema2 and both existing migrations
are unchanged. Import checks monotonic sparse observations, adjacent parent links,
retained event/day-close/payout headers and every retained checkpoint restore. Ordinary
reads do not repeat that audit. All metadata, fences, search, retries, constructor and
reconciliation calls remain charged; fixed lane limits are unchanged. No real source
capability, throughput or full-history feasibility is qualified by this correction.

Pruning holds the canonical session lock and exclusive maintenance lock, deletes at
most32 accepted checkpoint batches older than seven replay days and below every pin,
preserves the current receipt and boundary header, and advances the floor atomically.
It suppresses undo capture for its own deletes. Rewind takes the maximum of the retained
floor and old checkpoint floor, preventing resurrection. A frozen Ethereum parent owns
its original tail; PulseChain never gets copied common-origin events or transfers.

Seed snapshots hold a shared maintenance lock before establishing a repeatable-read
snapshot. Files stream through128-row SQL cursors and strict tar/gzip framing. Import
has one empty-target transaction and fixed table/column lists, checks the exact compressed
bytes actually consumed, per-file counts/hashes and independent SQL totals, owners,
share schedules, raw/decoded events, cursor/day/lineage, receipt continuity and undo
identities. Extra user schemas and relations are refused even if the worker cannot
read them. Before publication, import restores every retained checkpoint inside a
rollback-only savepoint using the writer's bounded restore path. It checks exact SQL
totals, schedules, raw events, cursor/header/day and progress bounds at each boundary,
then rolls the entire audit back. This adds SQL/IO work proportional to the retained
checkpoints and state size; full-scale import time and WAL remain unqualified.
Numeric before-images never pass through JavaScript Number. The sequence
resumes beyond imported undo rows. Tuple-byte counters are physical metadata and are
recalculated on the destination; instance UUID and advisory locks stay local. Limits:
1MiB/row,8GiB/member,32GiB expanded,1000:1 compression and a64KiB manifest. Those are
safety bounds, not proof that a32GiB seed fits production. A trusted out-of-band digest
is still required: local invariants cannot authenticate a publisher or prove chain truth.

Native current/day semantics are compared exactly across rebuild/seed/forward and
pruned/unpruned fixtures at the same acquisition checkpoints. Payout observation blocks
can differ with different acquisition checkpoints, so tests hold these fixed. After
rewind, deliberate revision fencing and rebuilt receipt/undo identities may differ.
The public API remains uninitialized until qualified data and later serving integration.

Measurements distinguish transport wall time, quota waiting/cooldown, input guards,
decoding, awaited SQL and replay/coordination wall time (commit wall time minus guards
and awaited SQL). The last is not a CPU profiler. Seed export/import is measured;
standard dataset export is `NOT_IMPLEMENTED`. PostgreSQL tuple counters do not include
all physical indexes/TOAST/WAL; the isolated harness records those separately.

Task03 source-use: the mapped `hex-minimal-abi.mjs`, `stake-event-decode.mjs` and
`global-info.mjs` were read as text at the baseline identified in reference.md. No v1
code was executed/imported. Event layouts/emitters and the constructor were independently
checked against Task01's retained Etherscan source artifact. New `src/providers/abi.ts`
implements interface facts and derives topics/selectors with pinned `@noble/hashes`.
Literal topic/packed-integer vectors and raw transport + SQL fixtures exercise decoding.
No full Solidity source is included. A new web fetch of the Etherscan source returned403;
no live RPC, deployed-bytecode or fork qualification was performed.


## Task05 storage version

The supported logical seed is now format3/schema4; format2 is rejected. Native tables,
source-range validation, sparse/fork-parent rules and migrations1?3 are unchanged.
The fixed allowlist additionally contains rank_state/account_ranks and
market_sources/market_samples/market_daily. The strict empty target also requires
export_bundles empty. Disposable live metrics and file publication status are excluded.
The Task05 data mapping describes rank/market invalidation; rewind never rewrites
independently sourced venue history. Export and seed snapshots share the existing
prune lock. No provider method, canary allowance or deployment permission changed.
