# Bounded common-history reconstruction

This offline-tested operator continues an explicitly admitted populated origin1
checkpoint using the declared PulseChain369 source pair. It uses the normal
`SyncEngine`, source validation, byte splitter, canonical writer and exact audit
comparisons. It does not initialize a constructor or native fork, export a seed,
publish data, or complete Task10. No live approval accompanies the example.

`node dist/operator/main.js reconstruct check <plan.json>` parses locally and
returns `NOT_AUTHORIZED`. It does not open SQL or construct a provider transport.
The other commands require Linux owned paths and the exact project, instance,
release, reviewed commit, storage and quota environment bindings:
`HDD_V2_PROJECT`, `HDD_V2_DB_INSTANCE`, `HDD_V2_RECONSTRUCTION_RELEASE`,
`HDD_V2_REVIEWED_COMMIT`, `HDD_V2_STORAGE_PATH`, `HDD_V2_PROVIDER_STATE`.

- `prepare <plan.json>` takes exclusions, checks the read-only admission, and creates
  one new operation record in empty, distinct storage/quota roots. Inputs belong
  outside those roots. Old canary files and excluded filesystem identities reject.
- `run <plan.json> <approval.json>` spends the original operation start and deadline.
- `resume <plan.json> <approval.json>` continues a clean pause, or a provably
  quiescent audit page/uniquely receipted SQL commit, within the same limits.
- `status <plan.json>` reads checked local state without SQL/providers. It exposes
  accepted and audited checkpoints, milestone/audit coverage, cumulative and segment
  counters, remaining allowances, original deadline, clean paused time and reason.

Future execution requires a distinct approval with exact `run`, `planDigest`,
`release`, `reviewedCommit`, `instance`, decision
`owner-approved-bounded-reconstruction`, and resume policy
`same-operation-clean-or-proven-quiescent`. The matching
`HDD_V2_RECONSTRUCTION_OPT_IN` and explicit `HDD_V2_ALLOW_LIVE_RPC=true` are also
required. Old canary approval, a resume flag, and check/prepare success grant no
authority. No real approval or retained-database command is included here.

The host supervisor is `scripts/operator/reconstruction-segment.mjs`. It accepts
an owned environment, its standalone operator override, `run|resume`, and optional
input filenames. It checks the existing audit host bindings (with reconstruction
run labels), persists one host record, inherits the earlier invocation clock, and
times/terminates its own child at the smaller original/segment deadline. It does
not schedule restarts. An uncertain host invocation blocks. The Docker control
surface remains on the host, never in an application container.

Exit 0 means command success; inspect `status` because check/prepare are not work
completion. Exit 3 is a clean segment pause. Exit 2 is a terminal operation block.
Exit 1 is malformed input, authority/admission failure before execution, or a host
failure. Only `status=complete` with `phase=complete` means the declared interval
and its mandatory final full paired audit completed; `fullTask10=PENDING` and
`productionReady=false` remain explicit.

Whole-run duration and HTTP/logical/charged-byte caps are finite explicit plan
values. Fourteen days is a schema ceiling, not permission or a throughput claim.
Every process is additionally bounded by at most one hour, 600 HTTP attempts,
12,000 logical calls and 256 MiB. Pauses, startup, retries and finalization consume
the original wall interval. A restart has a fresh full 60-second quarantine and
retains larger cooldowns. The unchanged sync rolling allowance is 12/360 per
minute, plus 2,100 ms spacing, a 15-second attempt deadline and at most three
retries. Every attempt is durably precharged; an incomplete response keeps at
least its 8 MiB reservation under the 4 MiB hard limit. Observed bytes are body
bytes, not network-wire traffic. The existing 2 MiB eligible log split is retained.

Operational pauses never insert full account audits. Replay stops at every declared
milestone and cannot advance until both sources finish the pinned full inventory,
including zeros. SQL inventory pages are at most 256; balance requests at most ten.
Only the current page's addresses enter audit transport scope. The original JSON
array inventory digest is computed as a stream without changing old digest semantics.

The snapshot is closed on pause. Resume reacquires filesystem/SQL exclusions and a
new read-only snapshot, checks instance/schema/profile/source/checkpoint/revision,
inventory and canonical digests, then validates the committed comparison prefix.
Matched pages are appended and fsynced before their cursor/commitment is saved. The
observer callback is never a success signal. A tail beyond the committed byte offset
is truncated and fsynced, even if it looks valid; that uncredited page may be fetched
again with a new charge. Committed pages are never silently skipped or credited twice.
Finalization repeats exact external aggregate/header checks and uses a separate fresh
canonical snapshot under retained exclusions. A finalization failure cannot PASS.

There is one small checksummed state file, one bounded atomic replacement, the latest
16 segment receipts plus cumulative counters, and one streamed comparison file for
the current/latest milestone. Starting the next audit reuses that evidence file only
after the previous audited checkpoint is durably recorded. Current milestone evidence
is proportional to its required comparisons, not replay segments or historical days.
No prior-attempt archive is read or rewritten per request. Attempt receipts go to
bounded per-invocation output; the host retains its latest output/result. Archive
external receipts if independent detail across an entire operation is required.

SQL and filesystem acknowledgement are separate. Before a writer commit the
controller saves the source-validated batch digest and exact previous/next checkpoint.
Restart accepts only the unique matching SQL receipt/revision/header, without
reapplying the events. Arbitrary drift, outstanding response reservations, corrupt
committed comparisons, failed saves, lost ownership and uncertain replay crash
windows return `BLOCKED_UNCERTAIN`/terminal failure. A replay crash lacking either a
clean pause digest or that pending accepted receipt blocks conservatively. Crashed
audit pages can resume after the full pin/prefix checks. Interrupted host supervision
is conservative too. No automatic repair, rewind, grant renewal or state conversion
is supplied. Clean paused milliseconds are measured; crash downtime is not inferred,
but it still consumes the immutable wall deadline.

On a terminal writer acknowledgement failure, finalization reconciles that same
receipt before releasing exclusions. A proven commit advances the reported accepted
checkpoint; a proven rollback retains its previous checkpoint. The original error
remains terminal. If SQL or exclusions cannot be verified, `acceptedSqlUncertain=true`
in run/status output identifies `accepted` as the last acknowledged checkpoint;
`pendingSql` retains the unresolved previous/next transition. Status does not open SQL
to resolve uncertainty, and a terminal operation cannot resume or dispatch again.

The synthetic example is intentionally unusable against real resources. Tests use
fresh internal-network PostgreSQL fixtures, fake JSON-RPC transports and controlled
clocks. Fake clock spans are not real uptime or provider throughput measurements.
Parent/fork/native audits, lineage, complete seed/rebuild equality, exports, real
provider admission, end-to-end duration/cost/storage qualification and Task11 remain
separate obligations requiring planner/owner action.
