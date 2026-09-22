# Acceptance and measurement

The Task09 sequence is `npm run test:integrated`, with a new directory selected by
`HDD_V2_INTEGRATED_EVIDENCE` inside `artifacts/task-09/` (a unique default is provided).
It reuses the sync/live fixtures, normal compiled release/operator commands and bounded
operations helper. DB1.25CPU/2.5GiB plus API, worker and at most one helper at.25CPU/.5GiB
each remain within2CPU/4GiB; browser/load generation, build and control are outside.
Use `node scripts/test-integrated.mjs --model-only` for the small raw replay witness,
or `--cycles=1 --mixed-smoke` for an explicitly incomplete setup/transport smoke.
Only the default30cycles runs full rollover, publication and ten-minute mixed traffic.
Use `--cycles=0 --mixed-only` for a focused mixed-load recheck on a newly built large
shape with actual raw forward replay; it does not repeat the thirty-day retention proof.
No live opt-in, provider credentials or HDS download is used. A retained, receipt-checked
HDS input is reused when present; otherwise the archive fixture is labeled synthetic.

The large SQL shape has reconciled current aggregates and actual forward raw replay,
but does not have valid historical raw provenance for a full-scale seed audit. The
small sync/history/operations suites own semantic seed and backup recovery. Preserve
this distinction when reporting timings. Worker samples include actual dispatch lanes,
file overlap and cgroup peaks; browser samples use fresh documents and disclosed SQL
warmth. Target misses and incomplete values remain visible in the final report.

Existing `test:ops`, history and lifecycle harnesses accept respectively
`HDD_V2_OPS_EVIDENCE`, `HDD_V2_HISTORY_EVIDENCE` and `HDD_V2_LIFECYCLE_EVIDENCE`; use new
directories inside `artifacts/`. Keep failed runs and use a fresh path for retries.
For the actual Windows Vite witness, launch `npm run dev` in a disposable source-only
copy named `HEXDailyData-v2-Task09-*`, then run
`node tests/browser/development.mjs <copy-path> artifacts/task-09/<new-run>` from the
builder checkout. Its reversible HMR edit is confined to that copy.

Tests protect product behavior, not a growing bureaucracy of source seals. Unit tests
are cheap and local; integration uses real PostgreSQL in fresh v2-only containers.
No host legacy database, source module execution, old scheduler, or broad old verify.
Mocked RPC failure tests, real SQL tests, actual Docker/host tests and live-provider
checks are separately labeled. Do not promote one into another.

## Required correctness cases

- Exact integer/decimal parsing, uint limits, shares/T-shares/HEX units, no exponent or
  lossy JSON numbers, denominator zero, input bounds, protocol rounding.
- Day zero/one convention, UTC boundary±1s, queued/ordinary/auto stakes,5555days,
  cancelled-before-lock, early/mature/late end, good accounting then end, no double
  penalty/reward, matured-open distinction, zero-share cases.
- DailyDataRange packed widths and globalInfo field order; unmaterialized prior day;
  current-day estimate after transition with pending rounds; early claim/Big-Pay-Day
  historical ledger, current-era estimator not misapplied to it.
- Fork imported active/matured/good-accounted/ended stakes, original chain identity,
  branch event overlaps, source-code identity, known boundary invariants.
- Transfer constructor/mint/burn/self-transfer, duplicate payload conflict, all balance
  changes applied once, negative balance/supply mismatch, huge integer correctness.
- Provider429/Retry-After, disconnected requests, slow response, truncated/empty/range-
  limited logs, wrong chain/block, two-provider disagreement and interrupted pagination.
- Transaction crash before commit, commit acknowledgement lost, resume with same
  cursor, concurrent worker exclusion, stale lease/cursor, cancel on lock connection
  loss. No remote HTTP inside SQL write transactions.
- Reorg inside supported window, beyond-window stop, bad checkpoint, clock movement,
  downtime across multiple days, pending market data not blocking native progress.
- Seed traversal/link/duplicate/size/decompression/schema/chain/version/hash failures;
  supply and lifecycle corruption; fresh empty import vs accidental existing DB target.
- Export crash at stream/hash/rename/pointer stages, an interrupted download and
  grace-period retirement; correct ETag/410. Retain exactly current+prior when idle.
- Live addresses with new unindexed stakes, end+swap index,0/1/100/10000stakes,
  pinned pagination, incomplete live observation, provider outage and no false not-found.
- No secrets in logs/public status/seed/browser; rate-limit amplification; path injection,
  numeric bounds, request cancellation; no raw-SQL or arbitrary-RPC public endpoint.

## Independent evidence

Reuse specific old tests as case discovery, not their infrastructure or sole expected
values. Use hand-computed literal vectors, deployed-interface facts and reviewed source
rules. For state-derived output compare independently acquired consistent block data.
Avoid both expected and actual values invoking the same helper. Document inherited
reference limitations; an old PASS is not proof of a changed path.

## Representative scale

Synthetic test target: >=1,000,000 stake lifecycle rows, realistic numeric widths,
>=500,000 address rows, representative source events and30simulated day cycles.
Include many unchanged stakes, actual mutations, daily closing transitions, failed
jobs,2-day market lag and catch-up, exports during reads, and restart recovery.
Use2CPU/4GiB memory constraint for the acceptance profile; record actual version,
hardware/runtime/cgroup limits. Repeat enough requests for p50/p95, not three reads.

Report heap/TOAST/index bytes separately, current/prior/temp CSV bytes, latest/short
cache sizes, WAL and temporary high-water, cumulative temp bytes labeled correctly,
RSS, request count/units, old-directory leftovers and total filesystem change. A row
count reduction alone is not storage success. Show baseline, zero-change cycles,
normal-change cycles, and end-of-retention steady shape. Required asymptotic bound:
no N_stakes×N_days archive/provenance table and no growing full SQL snapshots.

Provisional targets, to be measured and revised transparently if incompatible with
correct scope/budget: current-scale native DB+twoexports <=25GiB; no per-day GBs of
unchanged copies; keep working peaks within available volume with20%/8GiB reserve.
Daily updater normal case well below one day, and local projection part preferably
<5min at representative changes; provider acquisition cost/latency measured separately.
A target miss is a report/fix decision, never permission to remove required history.

## Bootstrap timing contract

Owner requirement: independent rebuilding from HEX day 1 should finish in days. Design
for **2–7 days** and require **no more than 14 days** on a stated hardware/provider
profile within the ongoing $50–60/month operating envelope. Identify any separately
approved one-time bootstrap charge. Neither a seed import nor a fast recent-day test
proves independent historical rebuild. Targets are not measurements.

Task03 prepares the smallest useful capability/throughput canary once basic isolated
sync works. Execute it only after the separate owner approval in operations.md; use
busy historical and recent periods plus the fork boundary, not just easy/empty ranges.
Report actual range coverage and unavailable capabilities. Before extensive UI work,
produce a go/no-go estimate including event density, limits, decode/SQL/export work,
reconciliation, required market coverage, and stated uncertainty/headroom. A prediction
over 14 days fails feasibility for that profile; change the work plan or seek an
explicit provider/budget decision, not a quiet weaker target or truncated history.

Required measurements: bytes; events/blocks/addresses; physical HTTP versus logical
RPC calls; per-method/host latency and failures; enforced cooldown; local guard/hash
work; decoding/replay; SQL; current-state reconciliation; exports; RSS; database/index/
WAL/scratch/export sizes and working peak; elapsed time and restart position. Report
stage wall times and overlaps rather than double-counting concurrent time. Do not
infer raw provider speed from a phase that includes local validation and persistence.

Task09 proves bulk behavior in realistic offline fixtures: no complete per-day snapshot
or historical-balance sweep, no request-count-proportional full-source hashing, bounded
working state, and exact required summaries/state under busy/fork/crash/retry cases.
These fixtures measure local capacity; they do not certify public source throughput.

Task10's separately started end-to-end rebuild establishes timing at a frozen target.
Start from an empty v2 target with declared warm caches/inputs, and distinguish truly
independent acquisition from seed/indexed-source assisted modes. Include supported
history, required summaries and current-state reconciliation, plus the first complete
standard exports/validation. Record start/end, coverage, budgets, time spent paused,
active time and total elapsed wall time. Do not omit rate-limit waiting or restart
costs to improve the headline. Full acceptance needs actual completion within 14 days;
extrapolation is only an early feasibility estimate. Missing historical market fields
remain explicitly unavailable and cannot be hidden behind native-ledger completeness.
Task11 discloses the resulting measured profile and limits. No scope reduction is
authorized merely because performance is difficult.

## Plan-review closure cases (implement in the owning tasks)

These extend existing tests, not a new approval framework:

- Tasks02–03: supply-preserving omitted A-to-B transfer; same corrupted response from
  correlated sources (do not assert the policy proves independence); different event
  sets with matching headers; wrong constructor/fork state; truncation/ambiguous single
  block and finalized disagreement. Compare every range under the selected policy.
- Tasks02–03/05: replay historical days with pruning enabled, a lagging daily consumer,
  crash/lost ack and seed export/import. Dates years before wall clock must not erase
  the replay tail. Pruned and unpruned runs give identical required daily/current data;
  byte pressure pauses before any protected input is removed. Include cancelled-before-
  lock lifecycle/CSV status; cancelled is distinct from ordinary ended.
- Tasks03/04/06/09: simultaneous cold address traffic, metrics, backfill and exports;
  assert combined physical/logical limits, queue bounds, per-request caps including
  retries/discovery, disconnect behavior and restart accounting. Metrics keep their
  reservation; address overload returns honest fallback/429/503, not hidden extra work.
- Tasks05/08: crash before/after file rename and DB publication, lost commit ack,
  missing files on clean restore, no reusing immutable IDs with different bytes, API
  available while downloads rebuild, delayed file readers, and current/prior cleanup.
  Verify backup age/RPO and explicit gaps for unrecoverable local market observations.

The early canary names required native/fork/market coverage separately (data.md), uses
this actual validation policy and combined quotas, and includes representative replay
plus SQL work. Missing mandatory capability or a mandatory-work/quota lower bound above
14 days rejects the profile. A sample-derived duration below 14 days remains uncertain;
Task10's complete timed rebuild, exports and validation remain the acceptance evidence.
No 100% reliability or provider-independence claim follows from a documentation patch.

## Browser performance

Use a clean390×844 Chromium profile, cache disabled, realistic>=1mrow API backing,
150ms RTT/10Mbps down/1.5Mbps up and4×CPU slowdown as a declared test profile.
At least11fresh documents for p50/p95. Measure **first useful headline data**, not just
DOMContentLoaded, plus complete chart time separately. Targets: headlines p95<=2s,
chart p95<=3.5s; warm repeat<=1s is useful but cannot replace first-visit acceptance.
No baseline serving warm caches while candidate starts cold, or tiny fake SQL fixture
presented as production timing. Also smoke-test currentSafari/Firefox behavior later.

Show price, rate and payout observation update cadence with a virtual clock; current-day
estimate has visible status; delayed charts/history/export catalogs do not gate Home.
No flash of fictitious numbers. Test errors, stale/disconnected state, reduced motion,
keyboard/screenreader basics,200%zoom, longaddresses and small viewport overflow.

## Fresh-developer proof

A reviewer uses ONLY a fresh clone, README, Docker/Node prerequisites and explicit v2
config. The old folder is absent. Run the sample/offline path, qualified seed import,
forward sync fixture, rebuild fixture, restart, backup restore, verify outputs. Actual
live full bootstrap remains separate if provider/real seed is unavailable. The commands
must say precisely which capabilities they tested. No implicit local cache, database,
secret, host UID, mount or prior runbook is allowed.

Test image build and actual nonroot container startup/healthchecks, network/service
names, volume ownership, credential delivery, shutdown and retry. A simulated systemd
call does not qualify these. Production actual DNS/TLS/reboot and provider budget are
recorded only when exercised in the later approved environment.

## Task result format

One ignored `artifacts/task-NN/report.md`: goal, code commit, changed components,
commands/exits, correctness/performance results, primary failures and fixes, resources
removed, remaining limitations, next task. Keep a short pointer/state in progress.md.
One focused independent reviewer where available; fix actual findings within the task.
Do not serialize a new source archive and hundreds of tiny receipts for every edit.
Package source+one small report for owner handoff only when needed; no databases/secrets.

For a task handoff, include a source-only ZIP of the committed new repository (for
example `git archive --format=zip`) and the small task report separately. Exclude
node_modules, credentials, databases, seeds and live response bodies. This is an
owner review artifact, never a runtime prerequisite. Do not add a packaging framework
that snapshots the entire workspace after every edit.

## Task03 acquisition follow-through witnesses

`tests/unit/acquisition.test.mjs` uses lazy monotone-timestamp raw fixtures to hold events
and day outcomes fixed as skipped distance and unrelated transaction density grow. It
records logical/physical method counts, bytes, observations and virtual quota time
separately from wall time. The old2B-header/2T-receipt floor is arithmetic, not a live
measurement. `tests/sync/acquisition.mjs` runs in the same combined2CPU/4GiB envelope:
raw policy/identity rejection with unchanged SQL/undo, exact sparse day closes and
activation/maturity/payout results, a separately provisioned sparse seed destination,
checkpoint rewind/replay, and a busy event range requiring bounded splitting. The
original raw rebuild/fork/seed/precision/pruning/recovery tests remain in the final suite.
Source physicalMethods counts HTTP attempts containing that method; mixed-method batches
can contribute to more than one method, so those counts must not be summed as total HTTP.

Use a separate `HDD_V2_SYNC_EVIDENCE` and `HDD_V2_SQL_EVIDENCE` directory below artifacts.
The original Task03 evidence and Task01 policy-blocked temporary folder remain untouched.
Task01 browser evidence at98ebf8c and Task02 million-row evidence at237aba7 remain reused;
no schema, index, ranking query or amount reducer changed. This is not full-history,
full seed-scale or real provider performance evidence.


## Task05 offline suite

npm run test:daily uses fresh private projects and actual PostgreSQL/files. Functional
cases cover populated schema3 migration, actual raw native replay, exact CSV decode,
rank interruption, raw market bars/samples, concurrent snapshots, publication hook
failures, SIGKILL at rename/commit boundaries, leases, symlinks, corruption, lag-aware
pruning,30 accepted daily cycles, portable daily state and new empty seed import.
A separate pg_dump data-only restore into a fresh target retains the catalog while
files are absent. Scale uses1,000,000 lifecycle rows/500,000 accounts, exact wide
amounts, actual ranking/query plans and five-file streaming with metric work and
reader overlap. Direct SQL scale construction is labeled synthetic, not acquisition.
All test commands/exits, failed probes/corrections and sampling limits remain in ignored
artifacts/task-05. Windows filesystem probing is separate; Linux PASS is not a Windows
or production durability claim. Canary/provider/history capability remains NOT_RUN.

## Task06 offline API evidence

`npm run test:api` uses `compose.sql.yaml` plus `compose.api-test.yaml` with a fresh
run-scoped project, PostgreSQL/API credentials and Linux volume. `HDD_V2_API_SCALE=1`
selects the representative million-stake/500000-account shape. No preexisting dataset
or v1 process is mounted. Source factory HTTP tests inject raw synthetic RPC into the
actual AddressService and SQL baseline. A separate actual compiled API container gets
only the read credential and a read-only export mount. Image restart is tested.

The measured runtime allocation is PostgreSQL1.5CPU/3GiB, test driver+synthetic worker+
source HTTP0.25CPU/512MiB, compiled API0.25CPU/512MiB. The compiled service is stopped
during the source mixed-load phase. Docker orchestration and image builds are host
control overhead outside those measurements. The driver performs no product ranking,
query, conversion or CSV work outside the declared container. Setup is synthetic SQL,
not an acquisition or live throughput qualification.

Raw101-sample Home data-query/HTTP/revalidation distributions, first request, EXPLAIN
ANALYZE BUFFERS, payload size, mixed HTTP/metric/export responses and resource milestones
are written to the selected ignored evidence directory. Warm database samples are not
cold-disk results; source factory connection setup is reported separately. Milestones
are not continuous peak disk measurements. Existing unchanged Task05 replay/seed/rank
and publication crash evidence is reused by reviewed commit, with affected live/export
paths rerun as recorded in the Task06 report. Windows publication fsync remains unsupported;
Linux publication and Windows read-only API behavior are distinct.

Cheap final checks: `npm run format:check`, `npm run typecheck`, `npm test`,
`npm run openapi:check`, `npm run build`, plus the affected API and export/live tests.
The existing browser-shell smoke has no Task07 visual-fidelity claim; Task06 evidence
uses its own output directory so original Task01 screenshots are preserved.

Mixed-load provider quotas use a paced synthetic clock and raw local JSON-RPC transport,
including injected price failures; SQL, HTTP, export and hashing elapsed times are real.
The actual MetricsService and AddressService share their existing worker/API lane limits.
SQL probes cover request cancellation and the client read deadline with the server
statement timeout disabled only inside a disposable test session. Large-download probes
exercise backpressure, disconnect, lock loss and explicit reader shutdown; they do not
claim a full120-second timeout observation.

## Task07 browser suite

Run npm run build then npm run test:web for a fresh private SQL project, actual
compiled API/assets, empty, retained HDS-only, then synthetic native+HDS journeys. The
optional -- --scale uses another new1M-stake/500k-account fixture, without large
exports/backups, and11fresh Chromium documents. Browser overhead runs on the host;
DB1.5CPU/3GiB, API.25CPU/512MiB and setup.25CPU/512MiB total2CPU/4GiB.
Raw source clocks are explicitly synthetic2026-09-19; browser navigation timing is
real. CDP applies150ms RTT/10Mbps down/1.5Mbps up/4xCPU, disables cache and verifies
observed loopback latency. Required Home values are price, percentage staked,
principal-weighted original duration and completed payout. Chart completion means
30nonempty native daily payout markers after the whole selected response validates.
Nearest-rank p95 uses ceil(n*.95)-1. Each metric is asserted against SQL/API fixtures.

The small suite requires the separately retained approved input at
artifacts/task-pulsechain-history/input. It never downloads data. Inputs copy into
its own run directory, use the compiled importer and actual new destination UUID.
Missing original bytes fail the real-archive proof explicitly. Normal production
startup has no synthetic scenario switch; test-only server and setup live under tests.
Run outputs use new artifacts/task-07/web-* directories; automatic teardown targets
only that run's Compose project. Original evidence and blocked cleanup stay untouched.

## Task09 approved capacity follow-through

The offline profile is42HTTP/900logical per rolling60s, lanes address24/360,
metrics6/180 and sync12/360. The1400ms A,S,A,M,A,S,A epoch calendar has100ms
tolerance and1300ms minimum dispatch separation. Literal boundary tests retain
whole-job4HTTP/128logical reservation, original10s deadline and all protected limits.
`node tests/live/process.mjs artifacts/task-09/<new-owned-directory>` runs real
separate API/worker budget processes, shared persistent cooldown, real60s startup
and restart quarantine; synthetic work makes no network connection.

After build, `node tests/integration/payout.mjs` checks corrected large integer inputs
through the compiled raw decoder, PriceReader and MetricsService using virtual time.
`HDD_V2_INTEGRATED_EVIDENCE=artifacts/task-09/<new-run>` and
`node scripts/test-integrated.mjs --cycles=0 --mixed-only --capacity` select the
existing large mixed harness. `--capacity-smoke` stops after all-four-metric readiness
and is explicitly not capacity acceptance. Every invocation owns a fresh SQL fixture.

Capacity readiness includes startup/quarantine. The following ten real minutes have
100 distinct12000..12099 addresses every6s (20 zero-list,80 two-entry),50 paced
visitors, compiled API/worker, SQL, raw forward sync, publication and11 fresh mobile
documents. Arrival and completion buckets are separate; only exact, fresh, complete
current responses within the original10s count. A150s stagnant-source phase, recovery
and heavy pages follow with the same budgets. All four payouts/metrics are checked
against independent integer expectations; current payout remains provisional.

Application containers have only the internal Docker network. A byte-only localhost
docker-exec relay makes that network reachable to the Windows host browser without
an external application route; its in-container endpoint shares the API cgroup.
DB1.25CPU/2.5GiB plus API/worker/at most one helper each.25CPU/.5GiB is the combined
2CPU/4GiB envelope. Build/browser/load/control run outside it, with no product compute.
Small inherited SQL suites retain their separately reported2CPU/4GiB allocations.

The functional daily suite includes a real61s grace expiry followed by normal no-due
work on the same service, cursor, day and inputs, checking native/rank/bundle/file
identity and bounded metadata queries. The offline canary regression proves2500
session HTTP wins over42x60=2520; it does not run a live canary. Historical30-day and
backup measurements keep their original source/fixture identities and are not new
timing or space claims for the corrected monetary distribution. Full historical raw
provenance, large valid seed/rebuild, other platforms and live upstream admission
remain separately owned qualifications. Task10 never starts from a capacity result.

## Offline shared-history transport follow-through

After build, set `HDD_V2_SYNC_TEST_PHASE=shared` and
`HDD_V2_SYNC_EVIDENCE=artifacts/task-10/shared-history/<new-run>` then run
`node scripts/test-sync.mjs`. Three new internal PostgreSQL projects execute compiled
worker direct control, shared369-to1 rebuild/recovery, and seed import/forward. They
share only task-owned evidence files; every DB/volume has a new run-scoped name.
The synthetic raw fixture's lifecycle and exact large amounts remain independent
expected assertions. SQL comparison normalizes only the declared network binding,
its digests, the common endpoint aliases and physical tuple-byte counters. Events,
amounts, origins, day/payout state, schedules and raw before-images remain exact.

`tests/unit/shared-history.test.mjs` exercises malformed/large-integer declarations,
honest network IDs, origin decoding and pre-dispatch parent fences. The existing
`test:canary` adds compiled shared replay with reused endpoints, logical range isolation,
old approval rejection, no-head rejection and aggregate raw-call accounting. Its optional
`HDD_V2_CANARY_EVIDENCE` must remain under artifacts. The small SQL test invokes the same
compact binding/checkpoint validator used by backup restore, plus actual seed streaming
and every retained seed rollback. It does not repeat encrypted large-backup timings,
Task09 scale/browser/load measurements, or perform real RPC qualification.
