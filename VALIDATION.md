# Starter validation — 2026-09-18

This is validation of an architecture/build kit and its small executable scaffold.
It is **not** a v2 implementation PASS, a live-sync proof, or production approval.
All eleven build tasks are initially pending.

## Actually run during preparation

- `node scripts/test.mjs`: **15 tests passed, zero failed** on Linux / Node 22.16.0.
  Seven pure exact-unit/day/freshness tests, seven workspace/task/contract guards,
  and one actual child-process HTTP smoke test. The HTTP test used an ephemeral
  loopback port, checked liveness, deliberate not-ready status, no invented Home data,
  read-only methods, and process shutdown. It used no database or public network.
- `tsc --noEmit -p tsconfig.json`: exit 0 using TypeScript 5.8.3. **Scope is only the
  included pure domain and shared API types.** No claim of a React or full app build.
- Workspace preflight, eligible-task listing and first-task prompt emission: exit 0.
  Task dependency rejection is tested. No Git repository or remote was created here.
- JSON configuration parsed; the seed manifest's Draft 2020-12 schema checked with
  Python jsonschema. One synthetic valid shape and five invalid shapes (including
  missing PulseChain lineage and a traversal path) behaved as expected. This is NOT
  the unimplemented streaming seed importer or supply/semantic validation.
- Both Compose YAML files parsed. **Docker build/start was not run**; these are
  development scaffolds, not qualified deployment files.
- Internal documentation links and the eleven task sections checked. Reference-map
  file hashes rechecked against the supplied source tree without executing it.
- Final ZIP member bytes, paths and CRC checked after packaging. Its SHA-256 is in
  the adjacent sidecar, not a self-referential runtime manifest.

## Not run / not supplied

Node 24 execution; dependency installation/lockfile resolution; PostgreSQL migration
or queries; live RPC or historical rebuild; real seed import; current-day estimate
implementation; full calculator/lifecycle implementation; React/Vite build/render;
Docker, Windows/WSL or VPS execution; performance/storage/cost benchmarks; backup,
restore, deployment, production cleanup or cutover. No independent reviewer agent was
available for this preparation; the design review here is a self-review.

Task 01 resolves the exact supported dependencies/images and starts the implemented
product. Tasks 02–11 establish the corresponding integration/live/owner proofs.
Unknown fork hashes and deployment coordinates are deliberately null reference fields,
not invented ready-to-run identities. No real seed or fictional download URL is shipped.

The Node 22 checks use its experimental type stripping and emit the expected warning.
The target remains Node 24 LTS. The SQL file is a **draft initial schema contract**;
parsing configuration or typechecking TypeScript does not prove SQL correctness.

Two construction issues (a missing initial directory and a missing migrations folder)
were corrected before packaging. They did not execute old code or affect real data.
The later consistency pass split the optional DB Compose file so API-only startup
needs no password, and made seed lineage requirements explicit. Affected starter
checks were rerun. None of these corrections is a claim of application completion.


## Workflow/UI instruction revision — September 18, 2026

This revision makes one builder + one separate reviewer + bounded correction/recheck
explicit, adds two instruction-only skill files, and records recovered UI direction.
The exact latest UI image attachments were not retrieved and are not bundled. It
explicitly defers BTC/ETH asset-price feeds without changing HEX history requirements.
No domain math, database migration, API/worker/web implementation, provider config,
dependency versions or task-state values were changed by this revision.

Revision checks actually run on Linux / Node 22.16.0:
- All 15 starter tests passed again, including the real ephemeral-loopback HTTP test.
- Eight update checks passed: exact allowed-file changes; unchanged application/SQL/
  configuration/test/deployment bodies; skill metadata; task prompt review instructions;
  prerequisite refusals; honest reviewer fallback; UI-image/future-scope limitations;
  internal documentation links. These are instruction/packaging checks, not AI-quality
  or context-usage measurements.
- New ZIP paths, member bytes, CRC and sidecar verified. The workspace marker now says
  starterVersion 1.1.0. No task is completed by this update.

The TypeScript/seed/YAML/reference checks in the original preparation section above
are retained evidence for unchanged files, not newly executed checks in this revision.
No actual independent reviewer/subagent, model-usage experiment, Docker/DB/bootstrap,
React/browser or VPS run was performed for this update. Review here was a self-review.
