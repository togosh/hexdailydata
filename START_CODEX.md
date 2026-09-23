# Historical Task01 starter

This file preserves the original Task01 prompt below. For ongoing work, use AGENTS.md
and the newest owner-supplied task packet with the actual current checkout and evidence.
Do not execute this historical prompt's preflight/tests, Git initialization, dependency
selection or Task01 implementation unless a new owner task explicitly selects them.
Tasks01-09 remain accepted within their documented scopes; Task10/11 status comes from
the latest evidence and docs/progress.md. An old starter does not reopen accepted work.

---

Build HEXDailyData v2 in THIS new repository, not in the sibling legacy project.
Read AGENTS.md, README.md and `.agents/skills/hdd-build/SKILL.md`, then the task01
section and lean review loop in docs/build-plan.md. Read docs/product.md and the
architecture/data/interfaces sections needed to settle this foundation's contracts;
docs/reference.md is a targeted lookup map, not a request to ingest the old project.

Run `node scripts/preflight.mjs` and `node scripts/test.mjs` before edits.
This starter is not a completed product. Implement **task 01 only**: a clean runnable
TypeScript/React foundation, exact contracts and initial domain tests, one package
lock, isolated development environment, and README-backed setup.
If this new folder is not yet a Git repository, initialize its own local main branch
after preflight; do not add a remote or modify the sibling repository.
Resolve currently supported dependency versions and pin the tested lockfile/images.
Do not implement the full indexer or import the old architecture in this session.

The legacy source may be inspected selectively, never executed or used as a database.
Its latest known reviewed baseline is e1a9cc417501479358494d4d9312ccaf2429f622;
a newer sibling HEAD is informational, not permission to reset that repository.
Keep a small source-use ledger in docs/reference.md for logic actually reused.

You are the builder/integrator and sole source writer. After completing the candidate
and affected tests, request ONE separate read-only reviewer with
`.agents/skills/hdd-review/SKILL.md`. Give task/criteria/base/candidate/diff/evidence
paths, not the full build transcript. Wait; do not edit the candidate during review.
Fix supported in-scope findings yourself, rerun affected tests, and have that same
reviewer recheck the delta. One full review plus at most two correction/recheck rounds;
unresolved blockers remain blocked. No redundant fixer, smoother, or reviewer swarm.
If separate-agent tools are unavailable, return implementation-complete/review-pending
with a reviewer handoff; do not invent an independent PASS or mark the task passed.

UI mockup details do not block task01. docs/product.md identifies the actual supplied
primary images in the September 18 planner handoff; they are not embedded in this
scaffold and their final aesthetic selection remains Task07. Use the relevant originals
before claiming fidelity; do not ingest every image now. BTC/ETH asset-price tickers
are future-only; do not implement them or change the required Ethereum-era HEX history.

Finish task01's acceptance checks and normal in-scope fixes without new approval
prompts. Record actual tests, versions, review scope and limitations; commit locally.
Do not push, contact live providers, touch v1, or deploy. Return the code commit,
completed task, small report and a source-only ZIP (no data, secrets or node_modules).
Stop at the task boundary. Use normal names; no new permanent gate/recovery system.
