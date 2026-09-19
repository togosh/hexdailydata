# Task03 acquisition and recovery contract

Migration 2 preserves migration 1 and adds `source_history` (one verified acquisition
start, source pair and finality policy per chain) and `recovery_pins` (at most four named
cutoffs per chain). These tables travel in seed format 1/schema 2. The manifest JSON
Schema is generated from the runtime Zod manifest; calculation version is `hex-native-1`.
Database identity, migration credentials and session locks never travel.

The constructor may have explicit zero supply and no mint logs. This is checked against
the deployment receipt and pinned contract fields; it is not a missing-input default.
The inspected HEX constructor sets share rate and claim/ledger initialization without
minting an ERC-20 balance. The older positive-supply fixture remains a synthetic case.

Acquisition retains the accepted contiguous-header interface (2048 maximum; the engine
plans at most128). It stops checkpoints at observed UTC boundaries, gets up to1024
pending daily words at an explicit block hash, and uses the existing daily reducers.
Source receipts enumerate each header's transaction identities; their complete filtered
sets must match the full getLogs responses. All repeated, header, receipt, corroboration,
day-close and reconciliation calls consume the sync lane. This conservative profile
increases work; no real source capability or speed is claimed. The default profile has
no multicall transport: there is no uncharged inner work hidden in a logical call.

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
