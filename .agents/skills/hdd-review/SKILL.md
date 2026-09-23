---
name: hdd-review
description: Independently review a frozen HEXDailyData v2 task candidate, focusing on correctness, integration, realistic tests and simplicity. Use in a separate read-only reviewer context; not as an implementation writer or production operator.
---

# Independent reviewer

Use this in a DISTINCT agent/session from the builder. If you authored the candidate,
label your work self-review and do not claim independent approval. Read AGENTS.md,
the selected task/acceptance criteria, and relevant contracts. Inspect the base-to-
candidate diff and actual callers/tests before relying on the builder's summary.
A diff is your starting map, not the limit of necessary inspection.

Review correctness, real operating assumptions, missing failure paths and needless
complexity. Pay special attention when relevant to exact arithmetic, late materialized
days, source freshness, fork state, idempotent sync/checkpoints, partial publication,
bounded database growth, pagination and bootstrap/recovery. For UI, check actual images,
real populated states, keyboard/mobile behavior, truthful values and initial loading.
A hash/inventory check confirms bytes, not application correctness or UI quality.

Do not edit product code, contracts or task status. Run focused checks only in authorized
v2/disposable resources, with no v1 database/credentials/VPS/live provider access. State
which tests you ran and which evidence you only inspected. Prefer a high-value negative
or failure-path reproduction to rerunning every unchanged expensive suite.
For documentation-only workflow changes, check the actual instruction diff and its
consistency with owner scope and available tool semantics. Static review is sufficient
when executable behavior is unchanged; do not claim that waiting was runtime-tested.
Use AGENTS.md's waiting rules for any owned checks.

Return:
- Reviewed base/candidate commit, separate context yes/no, review scope and checks.
- Blocking findings with severity, file/line or function, impact, and concrete witness.
- Nonblocking suggestions separately, limited to useful changes within product goals.
- Untested surfaces and verdict: PASS, CHANGES_REQUIRED, or REVIEW_INCOMPLETE.

Do not invent bugs to appear critical or demand subjective style rewrites that add
complexity. Missing acceptance behavior is a blocker even if the builder's tests pass.
Do not certify production performance from a toy fixture. On a correction round,
verify findings closed and inspect the delta for regressions; reuse unchanged checks
with their reviewed commit recorded. An unresolved blocker means no PASS. After at
most two correction/recheck rounds, return the remaining issue and a useful handoff.
When subagent tools are unavailable, a separate manual Codex review session is valid;
a renamed role within the builder conversation is not a substitute.
