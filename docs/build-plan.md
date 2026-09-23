# Build plan

Build one reviewed task at a time. This is a sequence of useful milestones, not one giant prompt.
Each task owns ordinary in-scope repairs and ends with a local commit, concise report and explicit limitations.
Do not introduce a new runtime gate or task-named subsystem to mark a task complete.

## Dependencies and parallel work

```text
01 -> 02 -> 03 -> (04 and 05) -> 06 -> (07 and 08) -> 09 -> 10 -> 11
```

The dependency branches make 04/05 and 07/08 eligible after their shared predecessor;
they do not authorize additional implementation writers. The owner's current workflow
uses one builder/integrator, owning shared contracts, migrations, lockfile and integrated
checks, with one separate source-read-only reviewer. Work sequentially in the active
checkout and preserve newer work. Use only task-authorized isolated test resources.

A separate read-only reviewer checks each task's frozen integrated candidate, not
every file or local edit. Never keep a reviewer analyzing a moving checkout. The plan
does not require a particular subagent feature to exist.

## Bounded plan review (separate from code review)

Recommended once before committing the costly schema/sync design: one distinct plan
reviewer checks the owner's requirements, architecture, data/retention contract,
bootstrap cost model, task order and acceptance criteria. This can be a separate
ChatGPT conversation reading a small frozen document snapshot. It is not a standing
manager, a code author, or a runtime approval mechanism. Review significant design
changes later; do not add another full plan review for every small implementation task.

Require concrete section references, a failure/cost scenario, and the smallest useful
correction or measurement. Distinguish a contradiction from an unmeasured assumption.
The reviewer should actively remove unnecessary work; it must not manufacture findings,
add hypothetical platforms, or certify provider speed from prose. Same-model review
may share blind spots and is not empirical validation. The owner/primary planner
adjudicates accepted/rejected/deferred findings in the existing plan/progress, then
one focused delta recheck closes material revisions. Do not build a reviewer hierarchy.
Task01 and already-authorized nonconflicting work need not restart while this review
runs. No plan critique silently authorizes code changes, spending, or live access.

### Readiness disposition recorded September 19, 2026

The owner-supplied `HEXDailyData-v2-Independent-Readiness-Review.md` returns
**READY_TO_BUILD** for the amended design, with no new architecture blocker. The owner
has designated `HEXDailyData-v2 (2).zip` as the correct baseline (64 files, 203,045
expanded bytes; archive SHA-256
`fda0a63bc65c4ed2a7ef3fbec61af27f5c9c3b92879f30a8e60f4314428c8543`).
The planner inspected this baseline's amendment content; the separate final-source-
review archive itself was not supplied for a new byte-for-byte comparison. This is
source/design readiness, not proof of the Windows checkout, executed tests or runtime.

Start the existing Task01. Its exact vectors and Task02's state/rewind mapping below
carry forward the review's concrete cautions. The small instruction/reference delta
gets one focused check in the normal separate Task01 review, not another broad plan
review as a prerequisite. No implementation task is marked complete by this record.
Optional schema/topology simplifications remain in their owning tasks; feasibility,
installation and full-rebuild qualification retain their existing proof gates.

## Lean builder-reviewer loop

Default: **one builder/integrator + one separate reviewer**, not three full agents.
The main session builds; `.agents/skills/hdd-build/SKILL.md` defines that procedure.
`.agents/skills/hdd-review/SKILL.md` defines the read-only critic. Skills do not spawn
agents automatically; the builder explicitly requests a separate agent/context when
available. Otherwise the owner opens one separate review session with those instructions.

1. Read the task and relevant contracts, inspect only needed implementation/reference
   files, then write a short plan. Set baseline commit and acceptance scope.
2. Build and test. Fix normal local failures before handing work to the critic.
3. Commit a candidate, freeze its source, and supply task, acceptance criteria,
   base/candidate commits, changed paths, and evidence locations to one fresh reviewer.
4. Reviewer traces actual code and relevant call sites, challenges assumptions/tests,
   runs selected high-value checks in isolated resources when available, and reports
   actionable findings with impact, location and reproduction. Never require it to
   invent a defect; never allow green tests to substitute for source review.
5. Builder fixes supported findings; same reviewer checks the changes and plausible
   regressions. Default maximum is two corrective rounds after the first review. A
   remaining blocker stops the task for re-scoping, not repeated full reviews forever.
6. Run the appropriate final integrated checks, record exactly what was reviewed/tested,
   then make the compact task handoff. Any later code change needs a delta review.

Reviewer is not allowed to edit application source. It may create its own ignored
report or disposable test resources within the same safety boundaries. If separate
review is unavailable, record self-review honestly and leave task review pending.
No PASS from a simulated reviewer, no review stamps copied from an older commit.
Independent here means a distinct reviewing agent/context, not an external audit or
guarantee that another model cannot share the same blind spots.

### Spend effort on risk, not ceremonial roles

Suggested starting settings, not measured optimal costs: Medium builder for bounded
UI/docs/glue; High for exact HEX arithmetic, DB projections, sync/fork logic, exports,
backup/restore and cross-component integration. High reviewer for these correctness
boundaries; Medium can handle clearly low-risk presentation/documentation deltas.
Standard speed is fine. Do not maximize reasoning for every formatter or file listing.
Record effective settings only when the client exposes them; otherwise UNKNOWN.

### Keep context small without narrowing necessary inspection

- Start a new builder for the next meaningful task when useful, after the current task has a
  recorded result and its owned processes are settled. Reuse the builder for review
  corrections; do not create a fresh conversation merely to wait for a running job.
- Read AGENTS.md, selected task, relevant contracts, and short current progress first.
  Follow references as needed; do not paste the whole old repo/chat into every agent.
- Keep logs and long query plans in ignored artifacts/task-NN. Return counts, actual
  exits, relevant excerpts and paths; no thousands of success lines in the main chat.
- One task report and a brief entry in docs/progress.md are sufficient. A practical
  report target is roughly 500 words plus tables/paths, not an artificial information
  limit. Include all blockers and material limitations even if it needs more space.
- Reviewer inspects evidence and reruns focused reproductions, not every expensive
  suite the builder just ran. Rerun affected tests after fixes; broader final checks
  remain mandatory where the task defines them.
- Keep one builder/integrator and one separate source-read-only reviewer. Do not add
  specialist agents or recursively delegate; surface unresolved scope issues to the owner.
- Follow AGENTS.md's "Active tasks and long-running work" rules for retained-session
  completion waits, sparse fallback observations and mid-task owner messages. End
  finished helper work at clean boundaries; keep the same independent reviewer for
  correction rechecks rather than polling it or creating another review context.

These are workflow guidelines. They do not modify the product's runtime, its data
safety boundaries, or the acceptance tests below.

`config/tasks.json` is the dependency graph; `docs/progress.md` is the human summary.
Task status starts pending. `node scripts/task.mjs NN` prints its full instruction.
Only mark passed after the stated checks run; a scaffold test does not finish task01.

## 01 — Foundation and domain contract

**Depends on:** none  
**Outcome:** A reproducible TypeScript/React foundation, real dev health, exact public semantics and one lockfile.

**Implementation**
- Initialize a local Git main branch here if absent, without a remote. Resolve current supported dependencies, pin one tested lockfile and image digests; no fabricated integrity hashes.
- Read only the mapped legacy pure modules; document code actually ported and license/provenance limitations. Freeze payout/day/share-rate/weighted-length definitions and fork requirements.
- Use independently justified vectors for the launch lock-day floor, cancellation before versus end on lockedDay, GA followed by StakeEnd without double settlement, and auto-stake minimum-duration boundaries. Name queued/mature-open/good-accounted inclusion sets for each metric; do not port a v1 status helper as the sole oracle. Historical auto-stake coverage does not expand the ordinary-new-stake calculator UI.
- Replace scaffold-only HTTP with a small tested Fastify app factory and React/Vite shell; keep all unavailable data explicitly unavailable.
- Set up formatter/typecheck/unit scripts, runtime DTO validation, isolated project names, rootless container health, and README bootstrap of the development shell.

**Acceptance**
- Exact integer/day/share-rate/payout vectors and invalid-input tests pass independently.
- For the selected mean-of-daily-ratios preset definition, 15 days at 1/3 plus 15 at 2/7 gives exactly 13/42, not the ratio-of-sums 3/10. Missing days and zero denominators never become invented zero payouts. Preserve exact arithmetic before declared presentation rounding; expected values must not come from the helper under test. Record the reference used for frozen protocol definitions; an unresolved semantic mismatch blocks dependent Task02 work, not the remaining safe Task01 work.
- Fresh checkout install/build/test works; no old repo at runtime; live mode remains disabled.
- Runtime/DTO examples agree and pure domain has no SQL/HTTP/filesystem import.

**Return:** local commit, actual checks/versions and results, limitations, next eligible task.
Do not push/deploy or silently start the next task.

## 02 — Database and incremental projections

**Depends on:** 01  
**Outcome:** One minimal typed schema, role boundaries, atomic event-to-current-state projection and no daily full copies.

**Implementation**
- Refine and execute the draft initial migration against fresh PostgreSQL17; explicit read-only API and worker roles.
- Implement idempotent normalized event ingest, current stake/account updates, aggregate updates, cursor CAS, bounded before-images and duplicate-payload conflict detection.
- Implement the replay-time daily accumulators and ledger primitives now (counts, supply, weighted sums, starts/ends/penalties, payout identity/status); Task05 will reuse them, not add a second daily engine. Follow architecture.md's native acceptance policy; test constructor/fork initialization and cancelled-before-lock status.
- Support crash/restart and a single active canonical writer; keep API reads available during short commits.
- Document each durable accumulator/cursor/consumer cutoff's transaction, rewind and seed representation in docs/data.md, then test the real mapping. The draft undo whitelist and JSON progress column are not proof that checkpoints rewind correctly. Prefer synchronous daily reducers in the canonical commit, and shared completed-ranking metadata over date-only account rewrites; settle schema choices here without a new registry or pipeline.

**Acceptance**
- Real SQL proves duplicate replay applies balances once and crash/lost-ack is safe.
- At least one representative million-row query/size baseline exists, not a tiny fixture only.
- Schema/index list has documented query purposes; no generation_id prefix on every data row.

**Return:** local commit, actual checks/versions and results, limitations, next eligible task.
Do not push/deploy or silently start the next task.

## 03 — Bootstrap and continuous sync

**Depends on:** 02  
**Outcome:** A resumable independent rebuild and portable seed path feeding the same normal sync engine.

**Implementation**
- Implement read-only provider allowlist, adaptive ranges, timeouts/Retry-After/budgets, source capability/finality checks and progress.
- Implement common Ethereum-era acquisition, verify fork boundary/code and initialize PulseChain branch without double counting; mark missing inputs/coverage explicitly.
- Implement secure seed import/export with manifest hashes plus semantic validation, empty-target protection and independent rebuild comparison.
- Implement normal once/watch cursor recovery across multiple calendar days; bounded recent reorg undo and beyond-window stop. Default work remains offline.
- Follow architecture.md's bulk-bootstrap path: one ordered event replay with incremental projections/day summaries, multi-day protocol reads, cached headers, adaptive ranges and bounded provider pipeline. No full daily snapshot/publish/export loop or per-request whole-release scans.
- Implement the explicit native acceptance policy and fixed cross-process/lane budgets; no daily historical holder enumeration or silent verification downgrade. Commit daily reducer/consumer positions before checkpoint-based pruning; freeze the data.md coverage table with actual source capabilities/ranges before a live profile is admitted.
- Instrument provider waiting, local guards, replay, SQL, reconciliation, exports and storage separately. Design for 2–7 days / 14-day maximum independent rebuild on a declared profile.
- Prepare the early canary brief under operations.md (busy history, recent range, fork boundary, methods/limits/target). Ask for its separate owner approval after isolated sync works; do not execute it merely because this task is running. Task10's final qualification still follows09.

**Acceptance**
- Fake transport + real SQL full sequence: rebuild -> seed -> fresh import -> forward sync equality at a fixed checkpoint.
- Truncation/fork/partial ranges/provider outage/reorg/crash/cancel/competing workers tested. Pruned/unpruned historical replay plus delayed daily consumer and seed import give the same daily/current results; age/byte pressure cannot discard protected input. See testing.md's plan-review closure cases.
- Progress reports actual phase and counters; no per-day manual grants; sample canary success not described as full rebuild.
- Offline regressions prove bounded checkpoints, no daily full-state publication during backfill, no request-count-proportional whole-runtime scans, and exact required daily/current results.
- Return the early capability/throughput approval brief and mark its live result NOT_RUN until observed. This task's isolated implementation/review result does not qualify live throughput or reset any later task's status. Resolve actual source feasibility before major Task07 work.

**Return:** local commit, actual checks/versions and results, limitations, next eligible task.
Do not push/deploy or silently start the next task.

## 04 — Current metrics and live address observations

**Depends on:** 03  
**Outcome:** Honest 60-second cached price/rate/payout observations and bounded live address/stake lookup.

**Implementation**
- Implement exact current post-claim payout estimator with pending round handling, independently checked rules and known-state vectors; keep completed payout separately.
- Implement small allowlisted on-chain price/anchor route with factory/code/token checks and honest peg_assumed or independent-anchor labeling.
- Implement cache/coalescing/rate budgets/stale fallback for balanceOf/stakeCount/stakeLists; at-block pages, swap indices, newly unindexed stakes.
- Separate current/estimated/finalized semantics and daily ranks; record source time rather than pretending each poll is a new market value.

**Acceptance**
- Virtual-clock60s jobs do not wait for bootstrap/daily jobs; budget exhaustion degrades clearly.
- Large address pagination/incomplete data/end+swap/outage/no-false-not-found tests pass, including 4-HTTP/128-logical per-request caps, queue deadline, cancellation and simultaneous API/worker lane exhaustion.
- No signer, write RPC, public arbitrary RPC or guarantee of today's final payout.

**Return:** local commit, actual checks/versions and results, limitations, next eligible task.
Do not push/deploy or silently start the next task.

## 05 — Daily history and clean downloads

**Depends on:** 03  
**Outcome:** Daily native/market observations and five clean bounded-retention download datasets.

**Implementation**
- Schedule/finalize/export the exact daily reducer and ledger primitives already owned by Tasks02–03; fill delayed materialized payout and independently lagging markets. No second daily arithmetic implementation or required transfer re-acquisition.
- Implement contract-driven five standard CSV formats and dataset-wide manifests; distinguish rounded ratios from exact base amounts.
- Stream a consistent snapshot, durably rename files, then atomically publish the DB current/prior pointer. Resolve lost acknowledgements by bundle ID. Missing restore files become unavailable and are regenerated only under new IDs; current+one prior retention has grace/open-reader handling.
- Prune only bounded temporary/transfer/sample/job classes, keep protocol history and required replay window; measure actual bytes.

**Acceptance**
- Daily transition/gap/late dailyData/market lag pass without global update blockage.
- All CSV values/counts/hash metadata agree with same-snapshot API fixtures, including cancelled-before-lock; no source paths exposed. File/DB crash stages and empty-export restore never advertise broken files or different content under an old ID.
- 30-day fixture no full-row-per-day archive and no more than2idle export bundles.

**Return:** local commit, actual checks/versions and results, limitations, next eligible task.
Do not push/deploy or silently start the next task.

## 06 — Public API and fast Home summary

**Depends on:** 04, 05  
**Outcome:** A complete versioned read API with small fast Home and bounded database/provider work.

**Implementation**
- Implement all interfaces.md routes with validation, error/status semantics and keyset pagination.
- Precompute/read a compact Home summary; no historical descriptor validation loop, provider fanout or chart barrier.
- Implement current/dated/day responses, pinned export streaming, ETags/410 and short snapshot transactions where needed.
- Add API quotas/cancellation/redacted logging and a deterministic OpenAPI output from shared contracts.

**Acceptance**
- At-scale Home query p95<=250ms target and uncompressed JSON<=25KiB; failures do not become zero.
- Read role cannot mutate DB; request/path/SSRF/SQL/large-input abuse tested.
- All route/status examples and schema agree; no compatibility facade for unused v1 formats.

**Return:** local commit, actual checks/versions and results, limitations, next eligible task.
Do not push/deploy or silently start the next task.

## 07 — Minimal complete website

**Depends on:** 06  
**Outcome:** A usable mobile-first HEX product, not an empty fast-paint shell.

**Implementation**
- Read the owner-UI section in docs/product.md; use actual designated current mockup
  files, not remembered old screenshots. Missing images leave fidelity pending, not
  permission to invent a new target. Capture matching mobile/desktop viewports and
  separate measured visual/behavioral observations from owner aesthetic approval.
- Before extensive UI integration, read Task03's separately approved early feasibility report or seek the owner's explicit decision to continue despite unmeasured provider feasibility. No new automatic task or live request is authorized by this check.
- Implement Home hierarchy, independent headline/current data, lazy charts, date history and clean download page.
- Implement address/stake search, holder/daily ranking views, calculator/scenarios, methodology and public data-status.
- Prefer native HTML controls/CSS and limited dependencies; accessible keyboard,200%zoom,error/stale states and 390px layout.
- No wallets/auth/payments/future sandbox; preserve exact chain/day/value distinction and one coherent visual vocabulary.

**Acceptance**
- At least11fresh browser loads against representative backend, p95usefulmetrics<=2s target; chart measured separately.
- Rate/price/payout/stale/refresh behavior tested; no chart/catalog wait for headline or inaccessible overflow.
- Reviewer inspects screenshots against the named supplied references, checks useful
  initial data (not just skeleton paint), stale/error states and interactions. No
  unsupported numeric fidelity score or claim of owner approval. Missing reference
  images or unperformed visual checks remain explicit before task07 is passed.

**Return:** local commit, actual checks/versions and results, limitations, next eligible task.
Do not push/deploy or silently start the next task.

## 08 — Operations and self-hosting

**Depends on:** 06  
**Outcome:** README-driven startup, healthy restart, backup/restore and one supported release process.

**Implementation**
- Provide tested dev/prod Compose, rootless app, isolated DB networking/roles, config/secrets, Caddy TLS template and migration service.
- Implement doctor/status/once/watch/export/backup/restore/repair-range with target guards, scoped locks and useful errors.
- Validate normal automatic maintenance, old/new release compatibility, nonroot volume ownership and clean container start/stop.
- Implement/test the 24h backup-age/RPO planning default, missing-export recovery with API kept usable, and explicit unrecoverable market gaps. Keep one verified off-host copy plus its bounded replacement; no old VPS or actual deployment.

**Acceptance**
- A fresh reviewer follows README with old folder absent; demo/seed/rebuild/readiness states distinct.
- Actual isolated Compose restart/backup restore and forward sync pass; not simulated PID1 claims.
- No recurring required API outage or unbounded full DB copy; cost budget is plain documented arithmetic.

**Return:** local commit, actual checks/versions and results, limitations, next eligible task.
Do not push/deploy or silently start the next task.

## 09 — Integrated scale and release candidate

**Depends on:** 07, 08  
**Outcome:** Measured correctness, performance, storage and fresh-developer handoff for the full product.

**Implementation**
- Run the integrated million-stake/500kaddress/30day suite with API+worker+PostgreSQL under ONE combined2CPU4GiB envelope and the combined physical/logical quotas; include simultaneous backfill, cold distinct address traffic, metrics, exports, stagnant sources/outages/market lag.
- Measure heap/index/export/WAL/temp/RSS/requestunits and zero-change/evolving-cycle growth, not just key counts.
- Review security and documentation; run actual browser and backup recovery against the release image.
- Fix affected in-scope findings; produce one short release report, known gaps and reproducible commands.

**Acceptance**
- No Nstakes×Ndays duplication or uncontrolled archive growth; targets measured honestly.
- Cold Home, live-value and pagination tests pass; source/dependency licenses reviewed.
- No full-live-bootstrap or VPS claim yet; any earlier approved canary is labeled with its exact limited scope. Frozen release tested in a new clone.
- Busy historical/fork/recent bulk fixtures and per-stage cost reports meet testing.md; compare measured local capacity with the early provider estimate. Do not qualify days-scale bootstrap from synthetic throughput alone.

**Return:** local commit, actual checks/versions and results, limitations, next eligible task.
Do not push/deploy or silently start the next task.

## 10 — Bounded live validation and real bootstrap

**Depends on:** 09  
**Outcome:** Real-source capability and short-run evidence, then an explicitly started full bootstrap qualification.

**Implementation**
- Use only owner-configured endpoints and operations.md budgets in v2-only storage; no old DB/VPS/credentials.
- Verify chain/code/fork identity, history/log capabilities, live source agreement, daily ledger and current estimate observations.
- Reuse an explicitly approved Task03 early canary only to the extent its commit/provider/method/range evidence still applies; recheck changed relevant behavior within the live limits. No earlier canary marks Task10 passed.
- Run bounded live qualification and publish its scope; prepare a displayed full-rebuild budget/time/coverage plan. Stop with resumable state at an allowance boundary; never automatically promote canary limits into a full acquisition.
- When separately started with adequate limits, perform the full supported independent rebuild and seed cross-check at a fixed target, produce a real verified portable seed, and measure end-to-end time against testing.md's 2–7-day target / 14-day ceiling.

**Acceptance**
- 2500physical/20000logical/512MiB/60min default allowance honored; no spending or quota bypass.
- No simulation pass relabeled live/full; any missing historical market coverage explicit.
- Real seed/rebuild equality and current rates/balances measured before release-ready claim.
- Actual full independent completion, required coverage, first exports/validation, total elapsed/paused time, provider costs and peak storage are recorded. A projected duration or seed-assisted run is not a successful independent <=14-day rebuild.

**Return:** local commit, actual checks/versions and results, limitations, next eligible task.
Do not push/deploy or silently start the next task.

## 11 — Owner handoff and approved cutover

**Depends on:** 10  
**Outcome:** A complete developer/owner handoff and separately approved production transition.

**Implementation**
- Prepare a small source/release handoff, exact build versions, actual monthly cost and storage forecast, one deployment/rollback checklist.
- Document current source capabilities, remaining historical gaps, funded-provider needs and independent rebuild duration.
- Wait for explicit deployment approval; use separate host/path/volumes, never assume old150GiB disk can hold both.
- After approval observe actual TLS/reboot/startup, cold Home, normal daily boundary/live cycles and backup restore; only later decommissionv1 by separate approval.

**Acceptance**
- Another developer can operate it using README+docs without this chat or old source.
- Total ongoing cost<=owner ceiling or explicit owner decision; no hidden provider dependencies.
- Production-ready means actual-host checks observed, not only a local release pass.

**Return:** local commit, actual checks/versions and results, limitations, next eligible task.
Do not push or deploy without explicit owner authorization.
