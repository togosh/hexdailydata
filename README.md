# HEXDailyData v2

Read-only HEX data API, exact TypeScript domain calculations, PostgreSQL projections,
resumable acquisition, daily history and five immutable CSV downloads. Tasks01–06 are
accepted offline. Task08 adds the compiled operations path below. Task07 adds the mobile-first website, source-labeled charts, lookup, calculator and
download pages. Task09 integrated qualification remains pending. The HDS PulseChain integration adds an attributed
reported-history overlay; it is not a native seed or live source qualification. There is
no qualified native provider profile, deployed site or production-readiness claim.

## Prerequisites

- Node **24.21.0**, npm **11.19.0**; `.nvmrc` records the tested patch. No global install
  or Codex settings change is required. Use your already provisioned compatible runtime.
- Docker Engine/Desktop with Linux containers and Compose v2 supporting `!reset`.
  Pinned Node24.21.0/PostgreSQL17.11 images and the lockfile are used by the Dockerfile.
  Build needs legitimate npm/Debian/image registries; subsequent runtime is offline.
- Space for source+target during a restore drill, with **8GiB AND 20% free after working
  space**. Durable export/backup paths use Linux named volumes. Native Windows directory
  fsync/publication is unsupported. Windows can launch all commands below, including
  paths with spaces. Linux secret provisioning assumes the operator runs as UID/GID1000 (private directory700, role files640).
- A fresh environment. Never reuse v1, an existing database/volume, inherited passwords
  or a sibling repository. Nothing requires `.git`, planner files or prior `dist`.

## Start the compiled stack — Windows PowerShell

Run from this source directory. Quotes around the environment directory are intentional.

```powershell
node scripts/preflight.mjs
node scripts/operator/host.mjs init ".local/v2 environment" 4320
node scripts/operator/host.mjs build ".local/v2 environment"
node scripts/operator/host.mjs provision ".local/v2 environment"
node scripts/operator/host.mjs release ".local/v2 environment"
node scripts/operator/host.mjs compose ".local/v2 environment" run --rm -T operator status
```

## Start the compiled stack — Linux / single host

These local commands are also the supported later single-host layout. They do not
authorize access to a server, DNS, public TLS or deployment.

```sh
node scripts/preflight.mjs
node scripts/operator/host.mjs init '.local/v2 environment' 4320
node scripts/operator/host.mjs build '.local/v2 environment'
node scripts/operator/host.mjs provision '.local/v2 environment'
node scripts/operator/host.mjs release '.local/v2 environment'
node scripts/operator/host.mjs compose '.local/v2 environment' run --rm -T operator status
```

Open <http://127.0.0.1:4320>. Choose a different free port as `init`'s last argument.
`init` creates a unique project, instance UUID, four random role passwords and an input
directory. `build` creates one local release image. `provision` generates a private age
key, creates/checks owned volumes, initializes only their root ownership and applies
migrations1–5. Repeating `provision` preserves existing state. Keep this environment's
configuration and secrets; never rerun `init` to replace them.

`release` stops API+worker, runs the migration check and starts both from the same
immutable local image ID. Failure leaves API+worker stopped and the database retained.
It is a coordinated maintenance action, not a distributed atomic/zero-downtime upgrade.
The ordinary API/worker are UID1000/1001, read-only root, no capabilities/Docker socket. The
API gets only its API secret and read-only exports; DB remains private with no host port.
The API's ingress bridge permits loopback publishing; its provider access is disabled
and no endpoint/profile is supplied. Worker/database/operator use only an internal
network. This proves nonroot application containers, not a rootless Docker daemon.

The normal stack reserves DB1.25CPU/2.5GiB and API+worker each .25CPU/.5GiB, leaving
.25CPU/.5GiB for a one-shot operator/helper within2CPU/4GiB. Backups spawned inside the
worker share its limit. Do not start extra worker/API replicas or stack multiple heavy
operator jobs. The optional edge consumes .125CPU/128MiB; stop it during an additional
helper measurement to retain the same cap. Build/Docker control overhead is separate.

For the compiled development-mode Compose variant, keep the same isolated roles and
volumes and run this after provisioning. Providers stay disabled. Return to the normal
production-mode image pair with `host.mjs release`.

```sh
node scripts/operator/host.mjs compose '.local/v2 environment' -f compose.dev.yaml up -d --wait api worker
```

## Readiness and normal maintenance

- `/health/live`: process can respond. `/health/ready`: configured private schema5 is
  usable, including an empty install. Home returns503 until useful observations exist.
- `/api/v2/status`: independently aged native/metric/market progress. Production mode
  does **not** enable providers or change `productionReady:false`/live qualification.
- `operator doctor` and `operator status`: bounded read-only runtime/schema/path/reserve,
  publication metadata, backup age and restore-gap observations. Exit0 = DB and backup
  healthy with usable configured paths, exit2 = usable DB with backup/path degradation,
  exit3 = DB unavailable or unsupported runtime.
  They do not hash all archives or probe providers. A fresh empty install remains
  visibly uninitialized even if its empty database has a verified backup.
- With no source profile the worker stays in standby; it performs ordinary daily/export
  maintenance and bounded backup scheduling. It does not fabricate data or loop on RPC.
  Backup errors degrade backup health independently of native API reads.

```sh
node scripts/operator/host.mjs compose '.local/v2 environment' restart api worker
node scripts/operator/host.mjs compose '.local/v2 environment' logs --tail 30 api worker
node scripts/operator/host.mjs compose '.local/v2 environment' run --rm -T operator doctor
node scripts/operator/host.mjs compose '.local/v2 environment' run --rm -T operator exports
```

An empty export command fails explicitly. For data acquisition choose one interface:
**empty** (normal initial state), **synthetic demonstration** (the isolated test command
below), **seed** (an independently trusted seed plus explicit expectation), or **rebuild**
(an owner-provisioned source profile and separately authorized live access). No qualified
real seed download URL is supplied. A seed is not a recovery backup.

The release operator exposes `migrate`, `rebuild`, `sync --once`, `sync --watch`,
`repair-range <retained-block>`, `exports`, `seed-export <path>` and
`seed-import <path> <expectation.json>`. These call the same worker/services as development.
Use the `migrate` service for migration authority; operator has no migrator/admin secret.
Place trusted inputs in the environment's `input/` (mounted read-only at `/input`) and
write outputs to `/state`. On Linux, input files need group1000 read permission (mode640) and input directories mode750. For example:

```sh
node scripts/operator/host.mjs compose '.local/v2 environment' run --rm -T migrate
node scripts/operator/host.mjs compose '.local/v2 environment' run --rm -T operator seed-import /input/seed.tar.gz /input/seed-expectation.json
node scripts/operator/host.mjs compose '.local/v2 environment' run --rm -T operator seed-export /state/seed.tar.gz
```

The seed expectation contains the **destination** instance UUID, trusted SHA256,
contract, codeHash and checkpointHash; see [sync.md](docs/sync.md). Rebuild/sync/repair
require explicit `HDD_V2_SOURCE_PROFILE`, provider endpoint environment variables,
persistent `HDD_V2_PROVIDER_STATE`, `HDD_V2_STORAGE_PATH` and
`HDD_V2_ALLOW_LIVE_RPC=true`. The default Compose intentionally does not enable them.
Later authorized use needs an explicit reviewed Compose override for profile mounts,
secrets/environment and worker egress; never add a public fallback or reuse old secrets.
Ordinary source operation then uses durable progress across days without per-day grants.

Source profiles may explicitly set `commonHistory:"pulsechain"` to acquire origin1
constructor-to-parent history over network369. Both source tuples may reference the
same two physical PulseChain endpoints; native metrics/addresses remain369. The exact
constructor/parent/entry declarations are mandatory and remain unconfigured live.
See [the binding and remaining qualification](docs/sync.md#shared-history-transport-binding)
and the intentionally incomplete `config/source-profile.example.json`. Portable seeds
now require format5/schema5; older format4 seeds lack the required binding provenance.
This offline implementation does not authorize live source work.

## PulseChain reported history — isolated local input

`history` is a separate source-reported archive. It does not initialize native chains,
Home, calculator presets or the five standard downloads. Market prices are PulseChain
HEX only, post-fork, from admitted `pricePulseX` observations. Read [history.md](docs/history.md)
for exact field meanings, date uncertainty, missing values and the inspected snapshot.

Create/build/provision a **new** environment using the commands above, with a distinct
directory such as `.local/v2 history` and a free port. Leave the worker stopped. Place
the already acquired raw `hds-pulsechain.json` and its receipt in that environment's
`input/`. The single authorized download for this task has already been spent; do not
rerun it. For another explicitly authorized acquisition, the bounded downloader is
`node scripts/history-download.mjs <new-output.json>`; it has no retries or fallback URL.

Inspect first, then create `selection.json` from
`config/history-selection.example.json` **only if the file digest matches that example**.
For any other supplied snapshot, explicitly inspect and select its own digest, dates,
source days, provenance and exclusions. A supplied snapshot without a download receipt
uses `supplied-snapshot`, a truthful statement and its acquisition time. Synthetic fixtures
must say `synthetic-fixture`. No HDS download occurs during these operator commands:

```sh
node scripts/operator/host.mjs compose '.local/v2 history' run --rm -T operator history inspect /input/hds-pulsechain.json
node scripts/operator/host.mjs compose '.local/v2 history' run --rm -T operator history inspect /input/hds-pulsechain.json /input/selection.json /input/hds-pulsechain.json.receipt.json
```

Create `input/destination.json` with the actual new identities from this environment's
`environment.json`: `{ "project": "COPY_PROJECT", "instance": "COPY_INSTANCE_UUID",
"purpose": "new-isolated-history-test" }`. This is an explicit destination assertion,
not an authorization to use an existing database. Then:

```sh
node scripts/operator/host.mjs compose '.local/v2 history' run --rm -T operator history import /input/hds-pulsechain.json /input/selection.json /input/destination.json /input/hds-pulsechain.json.receipt.json
node scripts/operator/host.mjs compose '.local/v2 history' run --rm -T operator history export /state/pulsechain-history.csv
node scripts/operator/host.mjs compose '.local/v2 history' up -d --wait api
```

Query `/api/v2/daily?chain=pulsechain&source=hexdailystats&from=2023-05-11&to=2023-05-20`
on the chosen loopback port. Dates are source-record dates, not asserted market close.
Follow the explicit revision-bound continuation for ranges exceeding64 source records.
An exact import repeat returns `changed:false`; export requires a new filename. A
correction requires an inspected replacement selection and `--replace <current revision>`
at the end of the import command. It atomically replaces the entire selected view,
including removing rows outside the new range; there is no silent merge or replacement.
For supplied/synthetic provenance omit the receipt argument from inspect/import.

`npm run test:history` runs synthetic SQL/API/operator/seed/backup/forward/rewind acceptance
in newly named isolated resources. The task-only `-- --real` option also consumes the
already saved ignored task input (no download); it is not runnable from a source ZIP
without that separately retained snapshot. All outputs remain local. No live source,
Task07/09, canary, v1 or deployment qualification is implied.

## Bounded offline canary preparation

For bounded qualification use the separate compiled `operator canary` path described
in [operations.md](docs/operations.md#bounded-canary-operator). It shares existing
source/sync/live services and adds durable aggregate limits. It starts no worker jobs.
The supplied example intentionally reports `NOT_CONFIGURED`; it contains no source
identities or approval. These commands make no real provider requests:

```sh
npm run build
node dist/operator/main.js canary help
node dist/operator/main.js canary check config/canary.example.json
npm run test:canary
```

`check` exits2 for missing inputs and needs no DB. The test creates and removes only a
new internal Docker/PostgreSQL project, injecting raw fixture providers. For a later
complete plan, `init`, `build` and `provision` a **new** environment as above, leave
API/worker stopped, and put the plan in its `input/`:

```sh
node scripts/operator/host.mjs compose '.local/v2 canary' run --rm -T operator canary check /input/plan.json
node scripts/operator/host.mjs compose '.local/v2 canary' run --rm -T operator canary prepare /input/plan.json
node scripts/operator/host.mjs compose '.local/v2 canary' run --rm -T operator canary status /input/plan.json
```

Preparation requires an empty schema5 DB, matching project/UUID/image and Linux storage.
Only after separate owner approval may a reviewed Compose override supply endpoints,
operator egress, `HDD_V2_ALLOW_LIVE_RPC=true` and `HDD_V2_CANARY_OPT_IN=<session UUID>`,
then invoke `canary run /input/plan.json /input/owner-approval.json` or `canary resume`
with the same arguments. No override or approval is supplied. The default network is
internal. This qualification does not grant production or full-bootstrap permission.

## Encrypted backup and new-target restore

```sh
node scripts/operator/host.mjs compose '.local/v2 environment' run --rm -T operator backup
```

This uses pg_dump17, a consistent exported snapshot, gzip/ustar and age. The backup
destination holds `current.age`, its small `verified.json` receipt and at most one
`candidate.age`. Replacement is accepted after reading/decrypting/checksumming bytes at
the destination. Local staging is fixed and bounded. Restore is a separate proof.
The default named volume **emulates** an off-host destination; it is not redundancy.
An actual pre-provisioned durable mounted destination is described in
[operations.md](docs/operations.md), and remains unqualified here.

Keep the age identity separately from the encrypted recovery copy. Never put keys,
passwords, ciphertext or DB files into a source/evidence ZIP. The daily planning RPO is
24h, measured from the captured snapshot, not upload completion. A worker attempts a
replacement after23h (one-hour safety margin); failures retry no sooner than one hour.
More than24h is degraded. Up to24h of local market observations may be unrecoverable.
Production destination/RPO/cost need owner qualification and acceptance.

To restore, first create/build/provision another environment with a new project/UUID
and new role secrets using the startup steps. **Do not start its worker yet.** Copy your
trusted encrypted file to its `input/recovery.age`, and provision the recovery key as
`input/restore.key` (Linux owner1000/group1000, mode640). The new environment keeps its own normal
backup key. Create `input/expectation.json` with these explicit nonsecret values:

```json
{
  "sha256": "COPY_THE_TRUSTED_VERIFIED_RECEIPT_SHA256",
  "sourceInstance": "COPY_THE_BACKUP_SOURCE_UUID",
  "destinationInstance": "COPY_THE_NEW_ENVIRONMENT_UUID",
  "destinationProject": "COPY_THE_NEW_ENVIRONMENT_PROJECT"
}
```

```sh
node scripts/operator/host.mjs compose '.local/restored environment' run --rm -T -e HDD_V2_BACKUP_IDENTITY_FILE=/input/restore.key operator restore /input/recovery.age /input/expectation.json
node scripts/operator/host.mjs compose '.local/restored environment' up -d --wait api
node scripts/operator/host.mjs compose '.local/restored environment' run --rm -T operator status
node scripts/operator/host.mjs release '.local/restored environment'
```

Restore refuses a wrong identity, unrelated/nonempty schema, incompatible backup,
symlink/traversal path or bad integrity/key. There is no force/reset flag. Data import
and validation commit together into the existing schema; no archive SQL or old grants
execute. Destination identity/role secrets survive. Provider permissions are not restored;
known cooldown plus restart quarantine are retained. See the returned restore record for
the unknown market-observation gap. Restored live observations keep their old timestamps.

CSV bytes are excluded. Native reads can serve before downloads rebuild. Old missing
bundles remain unavailable; worker regeneration uses new IDs. The running API refreshes
publication verification independently, including retries after cancellation/failure.

## Update, rollback, edge and cleanup

For a source update run `build` then `release` against the same environment. The config
records the accepted image ID and one previous compatible ID. `rollback` selects that
previous image and reruns its migration compatibility check; it never downgrades data.
Only schema-compatible code rollback is supported. The release action retires only an older image labeled for its own project, without force; in-use images are retained and reported. Never use global prune.

```sh
node scripts/operator/host.mjs rollback '.local/v2 environment'
node scripts/operator/host.mjs compose '.local/v2 environment' -f compose.edge.yaml --profile edge up -d edge
```

The optional local Caddy edge serves <http://127.0.0.1:4322> with automatic HTTPS off and
no access logs. `deploy/Caddyfile.example` is the later public TLS template; actual
TLS/DNS/accounts/firewall/reboot are NOT_RUN. Public use requires separate authorization.

Stop without deleting data: `... compose '<environment>' stop`. For a **disposable**
environment only, inspect `environment.json` then pass its exact project name:

```sh
node scripts/operator/host.mjs destroy '.local/v2 environment' hexdailydata-v2-COPY_EXACT_PROJECT_SUFFIX
```

Cleanup refuses unknown volume ownership. It removes only that project's resources,
preserving source, configuration, secrets and evidence for deliberate separate handling.

## Development and offline witnesses

```sh
npm ci
npm run typecheck
npm test
npm run build
npm start
```

The local shell is at4320 and has no DB by default. `npm run dev` runs API4320/Vite4321;
no `.env` is loaded automatically. `npm run doctor` uses the compiled operator and
returns3 for an unconfigured DB. Linux containers provide the supported durable path.
Vite proxies `/api/v2` and `/health`; `/api.ts` is a browser module. A native-data503
does not prevent the Home shell or the direct `/learn` page from rendering.

From a fresh **source-only** directory, the following documented witness creates new
isolated environments, runs the exact startup/operator path above, injects a visibly
synthetic transport into the compiled worker only in the test helper, makes an encrypted
backup, restores into a new identity, compares exact forward checkpoints and removes its
own Docker resources. It needs only Node/Docker; image/package caches may be reused.
The release API/worker mount no test/source/planner folders. Its helper is a separate
bounded test process. Tests do not contact blockchain providers or v1.

```sh
node scripts/test-ops.mjs
node scripts/test-ops.mjs --scale
node scripts/test-ops-lifecycle.mjs
```

The scale variant reuses only the existing1M-stake/500k-account **shape** generator for
streaming backup/restore measurement. It is not valid source replay or a full-scale seed
audit; the small fixture separately audits retained recovery and exact forward replay.
Evidence is under ignored `artifacts/task-08/<run>/`; secrets/data there are not delivery
material. Keep failed runs as actual evidence, not just the successful receipts.

Affected checks: `npm run format:check`, `npm run typecheck`, `npm test`, `npm run build`,
`npm run openapi:check`, `npm run test:sync`, `npm run test:daily`, `npm run test:api`.
Existing focused switches/evidence are described in [testing.md](docs/testing.md).
`npm run test:integrated` runs the offline Task09 volume/rollover/mixed-traffic witness.
It uses new disposable resources, existing compiled operators and synthetic transports;
allow roughly an hour for30physical publications and their real reader grace periods.
Its raw evidence requires interpretation alongside the smaller correctness/recovery
suites; successful execution alone is not a release or live-provider qualification.
See [product](docs/product.md), [data](docs/data.md), [interfaces](docs/interfaces.md),
[live](docs/live.md), [operations](docs/operations.md) and [progress](docs/progress.md).
