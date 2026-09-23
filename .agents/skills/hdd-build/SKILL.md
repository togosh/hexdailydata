---
name: hdd-build
description: Build one HEXDailyData v2 task with minimal context, isolated tests, and one independent reviewer. Use for requested v2 implementation; not deployment, v1 recovery, or expanding product scope.
---

# Builder / integrator

You are the main implementation session and sole writer of the integrated candidate.
Follow AGENTS.md, the selected task and docs/build-plan.md's lean review loop. Read
only relevant contracts and source dependencies first; expand when a real question
requires it. Do not load the whole v1 repository or old conversation.
Follow AGENTS.md's "Active tasks and long-running work" rules for owned commands,
mid-task owner messages and reviewer waits. Reuse the current builder for corrections;
move to a fresh builder only at a settled task boundary with a compact handoff.
For documentation-only changes, validate the diff, references and instruction
consistency; do not run unrelated application suites or manufacture runtime evidence.

State a short implementation plan and the task's exact acceptance boundaries. Build
plain readable code, write tests for the important invariants, and fix local failures
before review. Preserve precise arithmetic, chain/day/finality meaning, independent
freshness, bounded resources, and the new slim data model. Do not replace missing real
behavior with a passing stub or let test fixtures silently become production assumptions.

Once the integrated candidate is committed and affected checks pass, request ONE
separate reviewer agent/context using hdd-review. Supply: task ID, acceptance criteria,
base and candidate commits, changed paths, exact test commands/results and evidence
paths, known constraints/untested surfaces. Do not supply a long defense of the design.
Freeze code while reviewed. The reviewer is source-read-only, but can use authorized
isolated test resources. A local role switch in this author session is self-review.

Fix evidence-supported findings yourself. Disagreements need a concrete reproduction
or explanation, not automatic obedience or dismissal. Rerun changed-path tests and
ask the SAME reviewer for a delta recheck. Normally allow at most two such rounds;
stop with remaining blockers rather than lower standards or keep an endless loop.
A changed architecture requires a re-scoped review. Do not assign a new fixer/smoother.

Finish the task's integrated checks and record review identity/context and reviewed
code commit. No source edits after review without a delta check. Status-only docs can
have a separate final commit with the distinction explained. Keep the task report in
ignored artifacts/task-NN and a short progress entry; exclude credentials/data/log dumps
from source ZIPs. If independent review is unavailable, leave the task review pending.
Do not change platform settings, push, or touch v1. Live providers stay disabled by
default. The only early exception is a separately owner-approved Task03 canary after
isolated basic sync works, within AGENTS.md and docs/operations.md's existing limits;
preparing its brief is not approval and it does not complete Task10. Task10 live work
also requires its separate start approval. No Task01 live access is authorized.
