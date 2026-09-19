# HEXDailyData v2

A read-only HEX data product, built in this new repository. PulseChain is the initial
serving chain; required shared Ethereum-era HEX history retains its original identity.

**Task 01 provides a runnable development foundation.** Fastify serves health/status
and the built React shell. Exact domain rules and runtime DTO validation are tested.
There is no indexer, real data, seed importer, provider access or production deployment.
The shell displays unavailable values. Final UI design and reference-image comparison
belong to Task07; this shell makes no visual-fidelity claim.

## Requirements

Use **Node 24.21.0** (the pinned, tested Node 24 LTS patch) with bundled npm 11.19.0.
The system Node on the initial Windows host was 22.14.0 and failed preflight; switch
runtimes before installing. `.nvmrc` records the tested version. No global setting or
runtime installation is required by the project.

Docker Desktop with Linux containers is optional for the local shell. The tested
container images are Node 24.21.0 and PostgreSQL 17.11, pinned by digest in
`deploy/Dockerfile` and `compose.database.yaml`. The database has no published host
port. No legacy database, folder, credentials or scripts are runtime dependencies.

## Fresh checkout

Run from this repository root, using Node 24:

```powershell
node --version
node scripts/preflight.mjs
npm ci
npm run typecheck
npm test
npm run build
npm run doctor
npm start
```

Open <http://127.0.0.1:4320>. `npm start` serves the compiled API and React assets.
Stop with Ctrl+C. A fresh source ZIP supports the same commands without Git or the
sibling repository. One root `package-lock.json` pins all tested dependencies.

For editing, use `npm run dev` and open <http://127.0.0.1:4321>. It starts the API on
4320 and Vite on 4321; Ctrl+C stops both. Vite proxies `/api` and `/health` to the API.
These fixed development ports must be free. Alternatively use `npm run dev:api` and
`npm run dev:web` in separate terminals. The compiled server supports
`HDD_V2_HTTP_PORT` and `HDD_V2_HTTP_HOST`; the combined dev proxy uses the default API
port. Host defaults to loopback. No `.env` file is loaded automatically; supply
variables in your shell or Compose environment. `.env.example` lists development options.

- `/health/live`: 200 while the API process can serve requests.
- `/health/ready`: 503 until data dependencies/schema are implemented and usable.
- `/api/v2/status`: validated development/uninitialized status; no fabricated metrics.
- `/api/v2/home`: 503 `not_implemented` (400 for invalid query parameters).
- Other unimplemented routes: 404; write methods: 405. Errors use the shared envelope.

`HDD_V2_MODE` defaults to `development`. Live mode or `HDD_V2_ALLOW_LIVE_RPC=true`
fails before listening. The foundation has no provider transport. `doctor` checks
local tooling/configuration only; capability and cost results remain unmeasured.

## Isolated containers

API-only development needs no database secret. In PowerShell:

```powershell
$env:HDD_V2_PROJECT = "hexdailydata-v2-dev-$([guid]::NewGuid().ToString('N').Substring(0,8))"
$env:HDD_V2_HOST_PORT = '4320'
docker compose up --build -d --wait api
```

Choose another free host port if needed. Compose requires an explicit project name;
use a new v2-specific name for each disposable run. Containers use their own project
network. The API runs as UID 1000 with a read-only filesystem, no Linux capabilities,
and no privilege escalation. This is a non-root application process, not a claim
that the Docker daemon itself runs rootless.

For an optional **new, disposable** database, set `HDD_V2_POSTGRES_PASSWORD` to a new
v2-only local password, then:

```powershell
docker compose -f compose.yaml -f compose.database.yaml up -d --wait
```

PostgreSQL runs as UID 999 and uses this project's new `db_data` volume. It does not
apply the draft migration or connect the API to SQL. Task02 qualifies schema/roles.
To remove only this disposable project's containers/network/volume, keep the same
`HDD_V2_PROJECT` value and run:

```powershell
docker compose -f compose.yaml -f compose.database.yaml down --volumes
```

Do not use that cleanup on data you intend to keep. Never use global prune or an old
project/volume name. Task08 owns production deployment and backup/restore.

## Checks

```powershell
npm run format:check
npm run typecheck
npm test
npm run build
npm run test:containers
npm run test:browser
```

Unit/domain/DTO/loopback tests are offline. The container check builds from the lockfile,
creates a random v2 project and password, checks real PostgreSQL identity, non-root
UIDs, health and built assets, then removes its own containers/network/volume/image.
Image/package downloads are allowed; no blockchain endpoints are accessed.

The browser check uses installed Google Chrome by default with a fresh temporary
browser profile. Set `HDD_V2_BROWSER_CHANNEL=chromium` and install Playwright Chromium
with `npx playwright install chromium` if Chrome is absent. Screenshots go to ignored
`artifacts/task-01/`. This verifies the shell, not Task07 aesthetics or populated data.
`npm run format` formats implementation files; untouched planning documents are excluded.

## Contracts and boundaries

`src/domain` is pure exact bigint arithmetic: units, UTC protocol days, lifecycle
settlement effects, inclusion sets and mean-of-daily-ratios payout presets. Definitions,
hand-worked vectors, presentation rounding and fork requirements are in
[docs/data.md](docs/data.md). Runtime Zod schemas and inferred public types live in
`src/contracts/api.ts`. [The DTO example](tests/fixtures/home.json) is synthetic test
input, never runtime data. The five CSV schemas remain in `src/contracts/datasets.json`.

One npm package, one API/worker image, one future PostgreSQL database. API and worker
are separate process entry points. No database/RPC adapter has been implemented.
Worker commands fail explicitly until their owning tasks are built.

## Continue one task at a time

Read [AGENTS.md](AGENTS.md), [product scope](docs/product.md), and the selected
[build task](docs/build-plan.md). `node scripts/task.mjs next` shows eligible work.
The main session writes code; one independent read-only reviewer checks the frozen
candidate using the bounded review loop. No push, deployment, live validation, or
next-task implementation is automatic.

See [progress](docs/progress.md) for reviewed commits and local report locations,
[reference ledger](docs/reference.md) for selectively reused definitions and licensing,
[architecture](docs/architecture.md), [API interfaces](docs/interfaces.md),
[testing](docs/testing.md), and [operations](docs/operations.md) for later-task contracts.
`VALIDATION.md` is the historical starter report, not evidence of the current build.
