# Working agreements

This repository implements HEXDailyData v2. Start from the newest owner task packet
and actual current checkout/evidence. Read README.md, docs/product.md, the selected
build-plan task and relevant contracts as needed for that work. Preserve accepted
tasks and product decisions. Follow higher-priority platform/sandbox rules; do not
alter global Codex configuration to bypass them.

## Boundaries

- Write only this repository and explicitly task-owned temporary test resources.
- `../HEXStakeExplorer-PulseChain` is source reference ONLY. Read selected tracked
  files with `git show` or ordinary reads. Never run/import its application modules,
  scripts, package hooks, tests, database tools, deployments, or cleanup code. Never
  read its `.env`, credentials, dumps, or work/data without explicit data-import approval.
- Do not connect to the old PC database, Vultr VPS, `hexstake`, or any existing data
  volume. Do not change scheduled tasks, timers, credentials, Git remotes, or live sites.
- Use v2-specific Docker projects/databases/volumes with run-scoped test names. Do not
  mount the Docker socket or old data into application/test containers. No global prune.
- Tests are offline by default. Dependency downloads are allowed from their legitimate
  registries. Normal live validation remains Task 10. After Task 03's isolated basic
  sync works, a separate, explicitly owner-approved early throughput/capability canary
  may use the same Task 10 environment, method, request, time and cost limits described
  in docs/operations.md. Preparing its brief does not authorize running it, and it does
  not complete Task 10. No paid account creation, signature, wallet, send-transaction,
  contract deployment, or private-key handling.
- No GitHub push or production cutover without a separate explicit owner request.

## Keep it readable

One modular monolith; plain functions; constructor injection only where useful.
One backend language (TypeScript); no framework for hypothetical future features.
Domain code is pure and knows nothing about SQL, HTTP, Docker or this workspace.
No row-per-generation full copies, generic fact/provenance warehouse, permanent
request-body archive, or runtime source-file hash gate. Validate data at ingestion,
use typed state and small checkpoints; ordinary API reads do not redo a full audit.
Use normal names (`sync`, `export`, `repair-range`), not incident/date-coded subsystems.
No minified handwritten code. Comment invariants/tradeoffs, not obvious syntax.
No silent zeroes or fabricated live values. Never hide a missing path behind a mock.

## Numerical and historical correctness

Use bigint/integer database types for raw amounts; decimal strings on the wire.
Never use floating point for canonical token/share arithmetic. Chain, day convention,
source block, observation time, and finality must be explicit where relevant.
Current-day payout is an estimate. A 60-second poll cannot turn it into a final payout.
No arbitrary historical holder snapshots or legacy-format compatibility is required.
Do not conflate common Ethereum-era events with post-fork PulseChain events.

## Builder and independent reviewer

Use the main Codex session as the builder/integrator; it is the sole normal source
writer. Follow `.agents/skills/hdd-build/SKILL.md`. After an integrated candidate and
its affected tests are ready, request ONE separate read-only reviewer context using
`.agents/skills/hdd-review/SKILL.md`. A skill is a procedure, not a separate agent.
A role label in the same author conversation is not an independent review.

The reviewer receives the task, acceptance criteria, base/candidate commit IDs, changed
paths and test evidence locations; it reads actual code and relevant callers itself.
It does not receive a long persuasive builder narrative or need the old chat history.
Freeze source while it reviews. The builder makes corrections; the same reviewer
rechecks the diff and affected tests. Default: one full review plus at most two
correction/recheck rounds. Remaining blockers mean BLOCKED and a concise handoff,
not an automatic PASS or an endless critic loop. A major redesign requires a fresh
review and task re-scope; small corrections do not require a third reviewer.

If a separate agent is unavailable, finish safe in-scope work and a clearly labeled
self-review, then hand off to a separate reviewer session. Do not mark the task passed
until its independent review is actually complete. No new globally installed skills,
permission changes, paid services, or orchestration framework are required.

## Active tasks and long-running work

Use the newest owner task packet and actual current evidence. An old starter or
prepared/unstarted report does not restart a completed task or supersede a later
result. Preserve newer checkout work; a reference ZIP is not a checkout reset.

- Launch an authorized long-running command once. Retain its process/tool-session
  handle and existing log/result paths, operation identity and deadline. Use the
  task's existing artifacts; no new persistent registry or watcher service.
- Prefer the available tool's completion notification or retained-session wait for
  that same command. A tool yield or wait timeout alone does not establish the child's
  state. Follow the actual tool's wait limits and cancellation semantics; never rerun
  the launch command just to discover whether the first invocation finished.
- Keep detailed output in the existing task log. Return the actual exit and a short
  result when it settles. Do not repeatedly fetch the whole growing log. A monitor
  read returning exit 0 proves only that the read succeeded; determine operation
  completion, clean pause or terminal failure from its own final result/state.
- If completion waiting is unavailable, use bounded, read-only observations of the
  owned job. For a safely supervised long job, default to about five minutes between
  observations, extending to ten while stable. This is an observation cadence, not
  an instruction to block the shell with a long sleep. Use shorter checks only for
  a concrete task deadline, failure concern, owner request or higher-priority rule.
  Resume the same tool session as required without an extra log read on every yield.
- Give updates for meaningful changes: start, phase/milestone, actionable failure,
  required decision and final result. Do not narrate every counter increment. If
  higher-priority instructions require more frequent communication, keep it brief;
  a message need not trigger another command or provider/SQL observation.
- Treat status questions and requests for less polling as steering the active task.
  Answer briefly, adjust observation, and continue owning the same job. An explicit
  stop/cancel or incompatible new objective changes that task. A chat interruption
  alone does not establish the child's state; use existing authorized local receipts
  to resolve it, and report UNKNOWN if they cannot. Do not assume success, cancellation
  or permission to launch a replacement after a lost tool session.

Waiting changes observation only. Preserve the task's supervision, lease, deadlines,
limits, evidence collection and explicit stop behavior. Do not bypass a guard, detach
an unsupervised operation or leave a job unowned to save context. Resume only where
the current task already authorizes it and its actual state is eligible; terminal
state and unused budget do not create a new grant. These rules also cover waiting
for the one separate reviewer: use its supported completion wait, not status loops.

## Tasks and evidence

Complete the requested task, its relevant tests, focused review, and in-scope fixes.
Do not automatically implement all remaining tasks. The owner uses one builder/
integrator as the sole implementation writer, including schema, contracts and
lockfile, with one separate source-read-only reviewer. Do not start extra writers.
The review loop and context budget are in docs/build-plan.md. Do not reread every
project document or rerun unrelated suites after a small patch. Deterministic checks
handle formatting/types; the critic prioritizes correctness, integration, realistic
failure/scale behavior, and unnecessary complexity. A mock is not a host proof.
Record actual commands/exits and untested surfaces in `artifacts/task-NN/` (ignored).
Keep only a short result entry in docs/progress.md and a normal source commit.
Do not carry bulky evidence, source tarballs or node_modules into production.
Reuse unchanged test evidence by commit where justified; do not skip affected tests.
Use the task's risk-appropriate final suite once after the last code change. No code
changes after review without reviewing the delta. Reports identify the reviewed code
commit; documentation-only status updates may be a separate explicit final commit.
Failures needed to explain a current result stay in that task's report, not a permanent
parallel runtime. Resource cleanup is scoped to resources created by the task.

## When to stop and ask

Ask about irreversible real-data changes, spending/credentials, production access,
product-scope changes, or an unresolved correctness boundary. Do not ask repeatedly
about normal in-scope code edits, disposable tests, formatting or fixing reviewer bugs.
Return a concise summary, commit, completed task, relevant measurements, limitations,
and the next eligible task. Existing v1 production remains untouched.
