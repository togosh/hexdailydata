# HEXDailyData v2

A small, read-only HEX data product: useful current numbers, complete stake history,
clear daily history, and straightforward CSVs. PulseChain first; shared Ethereum-era
history is explicitly identified. No wallet, account, or payment is needed.

**This download is an architecture and build starter, not a completed indexer.**
The included health server and pure domain helpers are executable. Synchronization,
seed import, the real API, and the React application are implementation tasks.
They must not be described as working until their task checks actually pass.

## Start here — owner / Codex

1. For a genuinely fresh start, extract this repository into a **new** folder, for
   example `C:\Code\HEXDailyData-v2`. If that workspace already exists, preserve it;
   do not re-extract a starter over it. Never extract into the old repository.
2. Keep the existing project at `C:\Code\HEXStakeExplorer-PulseChain` as source-only
   reference. It is not a runtime dependency and must not be changed or executed.
3. Open **only the new folder** in VS Code. Start a new Codex session; paste
   `START_CODEX.md`. The first session completes **task 01 only**.
4. Subsequent sessions use `node scripts/task.mjs next` to see eligible tasks and
   `node scripts/task.mjs 02` (substitute the task) for the next prompt.
5. Use the lean builder -> separate reviewer -> builder correction -> reviewer recheck
   loop in docs/build-plan.md. Mark a task passed only after its actual acceptance checks
   and independent review complete; then proceed using the single task-state file.
   No GitHub push, old-system migration, or production cutover is automatic.

Node **24 LTS** is the target runtime. The dependency-free starter checks also run
on Node 22.16+, but that is not the production target. Task 01 resolves and commits
one lockfile and exact tested image digests; this kit contains no fabricated lockfile.

```powershell
cd C:\Code\HEXDailyData-v2
node scripts/preflight.mjs
node scripts/test.mjs
node scripts/task.mjs next
```

`preflight` checks the new workspace and optionally reads the sibling Git HEAD.
It does not inspect credentials, run old scripts, access a database, or use providers.
Neither a preflight nor the small starter tests qualifies blockchain behavior.

## AI workflow update

This kit revision adds only two small instruction-only skills: `hdd-build` and
`hdd-review`. They are not product modules or an autonomous orchestration service.
The main Codex session builds; one separate reviewer reviews. If no subagent tool is
available, use a separate review session. Details and bounded correction rules are
in docs/build-plan.md. Extra agents consume extra work; do not spawn a team by default.

The UI direction and actual supplied-image locations are in docs/product.md. Five
primary references are available in the September 18 planner handoff, not embedded in
this scaffold. Their layout details do not block Task01; final aesthetics remain Task07.
BTC/ETH asset-price feeds are future-only, not a new requirement for this release.

## Bootstrap feasibility

Independent day-1 rebuild has a **2–7-day design target and 14-day acceptance ceiling**
for the agreed supported history on the declared hardware/provider/budget profile.
These are unproved targets, not a measured capability of this starter. Seed import is
separately measured and does not substitute for independent rebuild. Task 03 prepares
an early bounded capability/throughput check for separate owner approval; resolve
feasibility before extensive UI work, not only at final release. See the bulk-bootstrap
section in docs/architecture.md and the bootstrap timing contract in docs/testing.md.

## What is deliberately small

One npm package. One release image for API and worker. One PostgreSQL database.
Plain TypeScript modules, ordinary SQL migrations, React/Vite for the browser.
No Redis, Kafka, Kubernetes, generic plugin framework, historical snapshot archive,
or runtime checks of the hashes of hundreds of application source files.

```text
src/
  domain/        exact math, HEX lifecycle and definitions
  providers/     bounded read-only RPC and market adapters
  db/            connections, migrations and explicit queries
  services/      queries and application use cases
  api/           HTTP and static-site boundary
  worker/        bootstrap, incremental sync, metrics, exports, maintenance
  web/           React UI; presentation, not protocol arithmetic
  contracts/     shared API types and dataset/seed formats
migrations/      ordered SQL, one current schema
config/          public chain metadata and conservative default limits
scripts/         development and operator entry points
tests/          focused tests plus isolated integration/scale/browser suites
docs/           the few maintained design/operating documents
```

There are no task-named production folders. Tests and reports are not runtime inputs.

## What the release must do

- Fast bootstrap from a portable, independently checked v2 seed, **and** a resumable
  independent rebuild from configured historical RPC/data sources.
- Approximately 60-second **observation** refresh for price, current T-share rate,
  completed-day payout availability, and today's clearly labeled payout estimate.
- Live address balance and paginated on-chain stake-list observations, separate from
  the finalized index and daily ranks. Latest-block data is provisional, not final.
- Complete supported stake lifecycles and daily native history; no arbitrary old
  holder snapshots/ranks, no byte-for-byte legacy exports, no compatibility layer.
- A fast Home summary, price/payout/T-share metrics, charts, calculator, address/stake
  search, holder/ranking view, five standard downloads, and concise methodology.
- Automatic normal syncing, bounded retries, useful progress, restart-safe cursors,
  honest stale states, bounded temporary storage, tested backup/restore.
- All-in ongoing operating target **$50–60/month maximum**. Costs and performance
  require measurements before launch, not a promise based on the starter.

## Commands: present versus planned

**Available in the starter**:

```text
node scripts/preflight.mjs                  workspace-only safety check
node scripts/test.mjs                       starter unit/HTTP/plan checks
node scripts/task.mjs next                  eligible build tasks
node scripts/task.mjs 01                    emit a scoped Codex prompt
node --experimental-strip-types src/api/main.ts    scaffold health server only
```

The scaffold listens on loopback `127.0.0.1:4320`. Its `/health/ready` deliberately
returns 503. `/api/v2/status` explicitly says `scaffold`; it has no market numbers.

**Required finished interface** (implemented and README-tested in the indicated tasks):

```text
npm ci && npm run build                     01 — reproducible source build
npm run doctor                             01/08 — environment, capability, cost diagnostics
npm run db:migrate                         02 — explicit v2 database only
npm run bootstrap -- --seed FILE            03 — fresh v2 database, verified portable seed
npm run bootstrap -- --rebuild              03 — resumable independent supported history
npm run sync -- --once                      03 — bounded progress, no arbitrary date pinning
npm run sync -- --watch                     03/08 — ordinary unattended scheduler
npm run exports                            05 — current/prior immutable file bundles
npm run backup / npm run restore            08 — one verified off-host recovery copy
npm run verify                             09 — v2-only full release checks
npm run live:check -- --allow-network        10 — bounded explicitly configured live canary
```

Until a command is implemented it must fail clearly, not return a fake PASS.
The scaffold Compose files are development-only; task 08 supplies the tested production
profile. No existing VPS path or database is mounted by the starter.
The optional database is in `compose.database.yaml`; API-only startup needs no secret.
To experiment with the scaffold in Docker, `docker compose up --build api` serves only
its health endpoints. For an isolated database, first supply a NEW v2-only
`HDD_V2_POSTGRES_PASSWORD`, then use
`docker compose -f compose.yaml -f compose.database.yaml up -d`.
Neither command starts a real indexer or applies the draft migration.
Subagents must use distinct `-p` project names and host ports.

## Documentation map

- [Product decisions, scope and freshness](docs/product.md)
- [Architecture and sync/publication behavior](docs/architecture.md)
- [Database and history/retention contract](docs/data.md)
- [API, CSV, and live-value semantics](docs/interfaces.md)
- [Build tasks and parallel boundaries](docs/build-plan.md)
- [Operations, budget, live access and cutover](docs/operations.md)
- [Acceptance tests and realistic measurements](docs/testing.md)
- [Reference source map and primary external references](docs/reference.md)
- [Current progress](docs/progress.md)
- [What was actually checked in this starter](VALIDATION.md)

Update these documents instead of adding a new numbered runbook for every repair.
All future developers must be able to run the finished product without the old repo
or this chat. See [AGENTS.md](AGENTS.md) for the narrow coding boundaries.
