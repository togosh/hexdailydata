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
failure. An ineligible run/resume also exits 1 without changing the saved operation:
use run only for a prepared operation, and resume only for an eligible started one.
Only `status=complete` with `phase=complete` means the declared interval
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

Pinned replay balance reads use sequential pages of at most ten calls through the
same RPC client and attempt gate. The complete deterministic sample remains at most
32 addresses, in its original order and at one canonical block hash; all pages from
both sources must succeed before a day close can be accepted. For 32 addresses,
10+10+10+2 requires four HTTP batches per source instead of 30+2's two, while logical
balance reads remain 32 per source, excluding retries. Generic state/daily-data calls
keep their existing batch defaults. Deadlines, retries, charges and terminal rules
are unchanged; failed pages do not trigger smaller fallback pages or a source switch.
Size-sensitive injected tests establish request shaping and failure behavior only.
The real timeout's cause and this mitigation's live efficacy remain unmeasured.

Declared endpoints have distinct IDs, endpoint aliases and URLs. Operator names may
be unknown (null), as in retained source history. Two known names must differ ignoring
case. Two declared endpoints do not establish independently verified operators;
unknown operators remain declared-unverified with correlation unknown. Admission
still requires exact equality of the complete retained provider metadata.

Work-budget pauses never insert full account audits. Replay stops at every declared
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
after the previous audited checkpoint is durably recorded. Every completed non-final
declared milestone takes the existing clean-pause finalization path, preserving its
complete comparison/result files until the next eligible resume. Seal those files
before resuming; the final milestone completes normally without an extra pause.
Deadline, cancellation, save or cleanup failures still block. Current milestone evidence
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

## Reconstruction clock domains

Reconstruction alone uses `ReconstructionClock`, once per operator/host process.
Expiry is the larger of raw UTC and an epoch anchor plus monotonic elapsed time.
A forward wall jump rebases that anchor; a later correction cannot return spent
time. Bigint nanoseconds retain sub-millisecond progress. ProviderBudget and the
physical attempt gate use a separate continuous monotonic axis for rolling windows,
spacing, quarantine and cooldowns. All caps, retries and timeout lengths remain
unchanged. Ordinary API, sync and canary `realClock` behavior is unchanged.

HTTP-date Retry-After is converted from raw wall UTC into a minimum elapsed delay;
numeric Retry-After is already a delay. Reconstruction persists an outstanding
cooldown duration and conservatively reimposes that entire duration on a fresh
process, clearing it only after the elapsed wait finishes. This can wait longer
after a restart. Existing worker cooldown files are also honored. Restart never
compares unrelated monotonic origins: raw UTC must be at least the saved effective
high-water, and the original start/deadline and counters remain fixed.

Invalid/unsafe wall samples, monotonic regression, overflow and failed continuity
stop work. A directly injected effective `Clock` still rejects any backward value.
Clock witnesses retain only first/last anomaly and count, with phase/checkpoint,
segment, raw sample type/value, prior effective time and monotonic delta. Request
times identify their ceiling domain and retain raw observations separately.
Terminal clock failure can still persist settled charges and the exact acknowledged
or explicitly uncertain SQL state. Its end time and remaining duration are unknown,
rather than a new reading from the failed clock. Failure-marker behavior is retained
when storage cannot persist the record. Diagnostics never replace the primary cause.

This is not a trusted-time oracle. Both clocks can lose observable elapsed time in
a suspended VM. Keep the machine awake; no sleep/reboot/crash continuity, OS clock
repair or known NTP/Windows/WSL cause is claimed. The historical failing sample and
rollback magnitude were not recorded.

## Owner-terminal coordinator

An explicitly authorized host power-loss recovery procedure is documented in
[interrupted replay recovery](reconstruction-recovery.md). It establishes a distinct
recovery boundary; ordinary collect/resume rules below are unchanged.

`node scripts/operator/reconstruction-job.mjs help` describes the maintained
foreground coordinator. It adapts the saved supervisor/collect/continue loop;
`reconstruction-collect.mjs` and `reconstruction-seal.mjs` are the promoted existing
collector and seal implementation. Collection remains the continuation gate. No
service, scheduler, autostart, detached mode or permanently waiting AI is involved.

A future separately prepared and authorized operation supplies an explicit owned
environment, scope JSON and distinct output directory, all under this repository's
`.local/` or `artifacts/`. Scope version1 binds `run`, `project`, `instance`, `release`,
`reviewedCommit`, `planDigest`, `approvalSha256`, `overrideSha256`, `override` (local
YAML filename), `databaseVolume`, `stateVolume` and `quotaVolume`. The environment
already contains `input/plan.json`, `input/approval.json`, `environment.json` and
`compose.env`. The coordinator validates those bindings and existing authority;
it never prepares an image, plan, root or approval. Keep private inputs out of source
and evidence archives. This offline task supplies no real scope or executable grant.

The following is a **non-executable future PowerShell recipe**, with placeholders
that must be derived by a later authorized preparation:

```text
cd <REVIEWED_REPOSITORY>
node scripts/operator/reconstruction-job.mjs run <OWNED_ENV> <SCOPE_JSON> <OUTPUT_DIR> --stop-at=<DECLARED_MILESTONE>
# In another ordinary owner terminal, one bounded local observation:
node scripts/operator/reconstruction-job.mjs status <OUTPUT_DIR>
# Request a clean pause after the currently owned segment is collected:
node scripts/operator/reconstruction-job.mjs pause <OUTPUT_DIR> <OPERATION_UUID>
# Only an eligible, explicitly clean pause may later be continued:
node scripts/operator/reconstruction-job.mjs resume <OWNED_ENV> <SCOPE_JSON> <OUTPUT_DIR>
```

The owner keeps the first PowerShell terminal open. No survival across terminal
closure, logout, sleep, reboot, Docker shutdown or the end of an AI turn is promised.
`status` reads a bounded durable record once, without a process/SQL/provider probe.
An unfinished saved running label is `OWNERSHIP_UNKNOWN`, even if its PID exists;
missing/corrupt evidence is `UNKNOWN`, never success. Current segment activity and
last collected accepted/audited pins are separate. Logs, native process receipts and
seals are create-once. After sealing, each full milestone has one archived evidence
set. Partial audits retain their partial classification.

Both environment and output roots have exclusive coordinator locks. A stale or
ambiguous lock refuses without deletion or restart. A fresh coordinator can resume
only after an explicit action and a recorded clean pause with verified seals,
unchanged authority, accounting and deadline. It cannot adopt a crashed/running
coordinator or terminal operation. Pause is checked at the next clean boundary;
terminal and uncertain outcomes win. `--stop-at` only stops after the named declared
milestone has its full paired audit and seal; it does not mutate the plan. SIGINT or
SIGTERM requests scoped emergency cancellation and yields terminal/uncertain status,
never a claimed clean pause. Cleanup verifies owned container identities and keeps
all data volumes and operation records.

A settled terminal clock failure may have unknown operator end times. Collection
requires the checked state and matching settled native/host records, preserves the
original null times and diagnostics, and never makes that terminal record resumable.
Completed comparisons still pass the full paired verifier; a partial prefix is sealed
with its partial label. A missing or corrupt audit remains collection uncertainty.
The compact return separates `currentSegment` from preceding `lastSettled` progress.
Current evidence is `UNVERIFIED` until collection succeeds, then `SEALED`; the reported
primary reason remains separate from collection/cleanup errors. Pending SQL makes the
ending accepted pin unknown and retains the last acknowledged pin and pending transition.
Neither sealed terminal evidence nor an acknowledged pin grants completion/audit credit.

Coordinator exit0 means `SCOPED_INTERVAL_COMPLETE` for that operation; exit3 means
a recorded clean coordinator pause, and exit2 means failure/terminal/uncertain.
Always inspect the result's native outcome and qualification fields. All commands
continue to report fullTask10=PENDING and productionReady=false. The spent operations
`777d194a-96c4-4e5a-923f-91ce8d2f3218` and
`3f79804f-60ce-423e-8dc9-359368fc2a6e` remain terminal. The owner did not send the prior
suggested first-milestone stop; this optional future flag does not rewrite that history.

### Sealed replay clock boundary

After a normal, verified replay seal, the host coordinator may wait without launching
work until **actual raw UTC** reaches the retained operator and host high-water values.
The wait is bounded by 5,000 monotonic milliseconds and the original effective deadline,
whichever is earlier. This is a wait budget, not a backward-time tolerance. A frozen,
invalid or regressing elapsed clock, exhausted wait, expiry or cancellation refuses.
After waiting, authority, ownership, control and seals are checked again. The runtime's
own raw continuity, SQL admission, cooldown and quarantine checks remain unchanged.

An already saved `STOPPED_UNCERTAIN` is still refused by ordinary `resume`. The narrow
owner-invoked form is:

```text
node scripts/operator/reconstruction-job.mjs resume <OWNED_ENV> <SCOPE_JSON> <OUTPUT_DIR> --stop-at=<DECLARED_MILESTONE> --readmit-clock-stop=<STOPPED_COORDINATOR_OWNER_UUID>
```

This requires the latest stopped coordinator's exact raw-high-water witness, an ordinary
complete replay seal, native exit3, matching paused host/operator/control and authority,
no audit or pending work, and no cleanup/cancellation uncertainty. Fresh raw UTC must
cover the retained host/operator and recorded coordinator effective maxima before
admission. Process-local monotonic origins are never compared across processes. All
normal locks and runtime SQL checks remain required; stale locks are never taken over.
The conservative implementation refuses other coordinator results, any prior readmission
receipt, or later admission/segment evidence. It cannot resume terminal/provider failures,
uncollected crashes, unsupported audit interruptions or arbitrary uncertain outcomes.

The new coordinator records `READMITTED_SEALED_CLOCK_BOUNDARY`, hashes of the original
failure and seal, and a create-once copy of the original status including its witness.
The old result and seal remain unchanged. An interruption before the next child settles
produces an honest uncertain result and cannot be retried through this option. Once the
next child seals normally, ordinary clean continuations apply. No allowance, deadline,
counter, audit credit, cooldown, plan, approval or runtime image is replaced. Source
qualification uses finite fake-clock/file/process fixtures; it is not a Docker/SQL or
live provider rehearsal and does not authorize an owner launch.
