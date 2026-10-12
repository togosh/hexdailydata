# Ordinary saved-product serving

The ordinary API uses the explicitly configured, read-only file-backed product. It
opens no SQL connection, provider, account service, paid worker or publisher.
Missing or incompatible input fails startup with a bounded sanitized message.
Do not launch old operator/qualification commands to serve the website.

Use the existing locked Node 24.21.0 host dependencies. These build commands do
not install anything:

```powershell
node scripts/openapi.mjs
node node_modules/typescript/bin/tsc -p tsconfig.build.json
node scripts/build-samples.mjs
node node_modules/vite/bin/vite.js build
$env:HDD_V2_API_MODE = 'product'
$env:HDD_V2_PRODUCT_PROFILE = '<absolute local path to verified product profile>'
$env:HDD_V2_HTTP_HOST = '127.0.0.1'
$env:HDD_V2_HTTP_PORT = '4320'
node dist/api/main.js
```

The source API entry (`node src/api/main.ts`) uses the same dependency policy;
it does not serve the compiled website. `npm run build` is the same serving build
recipe, and `npm start` runs the compiled entry. An old ignored `dist` is not
updated merely by advancing Git. Build from the selected source before serving.

A profile is a strict JSON file of at most 16 KiB. Paths must be absolute local
paths, outside web roots. No URLs, UNC paths, parent traversal or extra properties.
It supplies `productRoot`, `participantRoot`, `overlayRoot`, `holdersRoot`,
`stakesRoot`, the retained `history`/`historyManifestSha256` and
`ledger`/`ledgerSha256` references, and the complete `pair` object. The initial
pair is the exact accepted B1 generation/family identities and observation times;
the paired registry then reads the compatible committed descendant. Never edit
these identities or counters to make a different dataset pass admission.

The source archive is **not a data backup**. Required external inputs are the
accepted immutable holder/stake bases, the admitted B1 overlay/index and the
compatible paired product/participant root. Historical/ledger references remain
part of the profile; serving uses the verified selected product rather than
rebuilding it at startup. Source consolidation opens none of those genuine files.
The profile creates no writer, data import or refresh service.

Normal pages share one selected view. Calculator reads raw globals word 2 and
exact completed-ledger payout words for 1/30/365-day rational means. Missing,
pending or zero-share periods remain unavailable. Raw rate policy is 120 seconds
fresh and at most 1,800 seconds last-known; HEX/USD conversion separately requires
the same product generation and an original source time within 300 seconds.
A hypothetical future price never renews the current quote. Stored data ages even
when no new selection occurs; an old saved deployment may show unavailable inputs.

Public lists keep the 50-row/five-page global bound. Known-address lookup remains
bounded and source-reported. Advanced filters return 400. Canonical events and
maturity schedules remain unavailable (access checks still precede event reads).
Complete CSV and paid reads fail closed without a qualified authorizer. The five
free sample CSVs are manifest-checked **SYNTHETIC SAMPLE / fixed partial fixture**
assets, served by finite routes outside the web root; they are not genuine history.

Accounts/payment remain inactive. `composePaidApp` still assumes
`dependencies.downloads.root`, which the product dependency bundle does not supply.
That separate integration needs qualification; it is not bypassed with a dummy
account or export root. Serving build, optional composed account/SQL asset build,
and native updater packaging are separate targets. Only the serving build is
qualified here. Existing account/runtime/transport source and SQL assets remain.

`HDD_V2_API_MODE=legacy-sql` is an explicit compatibility opt-in retaining the old
SQL dependency implementation and its private configuration guards. It is not the
ordinary product, does not make missing product routes work, and is not activated
or SQL-qualified by this task. Incidental DB/export/live-RPC configuration is
rejected in normal product mode. No automatic fallback is allowed.

Source consolidation is not launch readiness. HEX/liquidity queue/reserve scheduling,
current feed operation, required historical gaps, unsupported canonical features,
paid/SQL integration, data rights, production operation and deployment remain open.
Indexer and paid reconstruction remain PARKED. No perpetual scheduler is installed.


# Retained legacy operational design (inactive compatibility)

The following older SQL/operator material is retained history and design. It does not override the ordinary entry above or authorize execution.

# Operations and build access

## Environments

Local developer and integration environments are v2-only Docker Compose projects with
named volumes. Production is a single modest Linux server with the same release image
for API/worker plus PostgreSQL and optional Caddy. No Kubernetes/Redis/message broker.
Do not reuse old VPS paths, a host `hexstake` DB, or inherited credentials. Database
port is not published by default. The local HTTP port is 127.0.0.1:4320, avoiding v1.

The supported compiled Compose/release commands are in README. Health checks distinguish live process, usable DB/schema, catching up, and
fully caught up. Use dependency health checks and actual API readiness after startup,
not “container started” or transient systemd invocation IDs. One release command
updates both API and worker with a tested schema compatibility procedure.

## Configuration / secrets

Public chain metadata and limits are versioned JSON. Endpoint URLs, optional API tokens,
DB passwords and backup credentials come only from the v2 environment/secret files.
They never enter source, seed, browser bundle, report ZIP or logs. Distinct read-only
API, worker and migration credentials; revoke PUBLIC schema creation; SQL parameters
for values, fixed allowlists for identifiers. Plain query endpoint is out of scope.
Use generated secrets; samples contain placeholders, not reusable production passwords.
Never change existing host-wide PostgreSQL authentication to get a test passing.

Runtime identity is schema/calculation version plus a tested release image. Pin images
and dependencies at task01, review upgrades regularly; do not carry obsolete exact
patches indefinitely in the name of reproducibility. No source filename hashes as a
startup compatibility contract. Public protocol/fork/seed identities still are verified.

## Normal operation

`sync --watch` uses durable cursors and small job schedules. Restart catches up from
accepted progress, handles a calendar boundary naturally, and resumes bounded transient
failures. No daily owner grant, no manual per-date controller. A provider failure pauses
that stream, not the free website or unrelated native/market jobs. An operator can run
`doctor`, `status`, `sync --once`, `repair-range`, `exports`, `backup`, and `restore`.
Errors preserve primary causes and actionable context. Long work emits progress at
least every30s. Job results live in bounded DB records/logs, not systemctl properties.

There are finite query/RPC/total-job budgets, heartbeat/watchdog checks, and no hot loops.
Budget exhaustion records next retry and remains resumable; it does not require inventing
new source-bound permission files to continue ordinary work. Correctness failures stop
publication. Manual override cannot convert uncertain data to “verified”.

## Bounded canary operator

The compiled `canary check|prepare|status|run|resume` command wraps the existing services.
The schema is `src/operator/canary-plan.ts`; `config/canary.example.json` intentionally
lacks live inputs. Check only parses local files: no SQL or transport construction.
Prepare requires a new empty schema5 destination; it does not grant live permission.

Plan version2 includes the normalized shared-history mode in its digest; version1
plans/approvals cannot authorize changed transport meaning. Existing private plans and
spent sessions must be retained, not rewritten or reset. Range `chain` keys continue
to authorize the logical phase: origin1 ranges and its constructor receipt remain
origin1 permissions even when the serving network is369. Replay requires explicit
head-observation permission; no-head replay plans fail local check. Source acquisition
also enforces its constructor..parent fence. See [sync.md](sync.md#shared-history-transport-binding).

The immutable plan contains session UUID, reviewed source commit, release image SHA256,
new host project/DB UUID, normalized storage/quota roots and `<storage>/canary.json`;
the existing source profile (contract/code/constructor transaction, checkpoint and
explicit balances, fork parent/entry, finality and target); four chain-specific source
IDs with operators or null, account groups and endpoint environment references; exact
numeric ranges per chain; read-only methods; head-observation permission; phase purposes;
optional existing price profile; missing phases; a no-paid-overage cost basis and finite
aggregate/per-response limits. Declarations stay unverified until observed. Known same
operators are rejected case-insensitively; unknown correlation remains unknown.

The bounded ordered phase list supports:
- `capabilities {chain,at}`: code/header and corroborated EIP-1898 state.
- `probe {chain,previous,to}`: actual sparse acquisition without a SQL origin; records
  the actual day-clipped end and whether the whole requested interval was measured.
- One `replay {basis:"constructor-prefix"}`: actual SyncEngine from constructor through
  common/fork/target checkpoints, with normal audits. No implicit years-long setup.
- `metrics`: MetricsService and optional declared PriceReader; component failures remain
  explicit. `address {address,pageSize}`: AddressService with its4HTTP/128logical/10s cap.

Each entry also needs a nonempty `purpose`. An unavailable live replay prefix is omitted
and listed NOT_CONFIGURED. This runner does not import a seed; qualifying a separately
authorized compatible v2 seed would need separate scope. No v1 seed is supported.
Results are narrow observations, not blanket source qualification. Market files and
full exports/backups are not automatically rerun just to exercise every subsystem.

After a human approves the exact scope, a local record must contain exactly
`{session,planDigest,release,instance,decision:"owner-approved-bounded-canary"}`. Check
returns the normalized plan digest. Software cannot authenticate the owner's consent;
an example/generated file is not approval. Run/resume additionally require both the
session-specific opt-in and independent live-RPC opt-in. The normal host supplies its
built/current image ID as `HDD_V2_CANARY_RELEASE`. No runtime source-file hash gate exists.

One process holds stable Linux flock inodes in both roots through all transport/SQL
cleanup, existing API/worker role locks, canonical ownership and maintenance ownership.
Both chain writers are reserved before transport. Before fork initialization, parent
ownership passes to the child connection while the worker role and child lock fence
other operators/seed import. SQL ownership loss cancels the session. Prepare rejects
retained state and nonempty DBs; resume requires retained checksummed state, immutable
plan identity and matching filesystem inode identities. Cloning/restoring onto a new
volume does not create allowance or inherit permission. Deliberate privileged deletion
or rewriting is outside this accidental-execution guard. No schema was added.

The deadline starts at first authorized run and includes restart quarantine, queues,
cooldown, retries and local work. Invalid/rolled-back time fails closed. Before every
transport attempt, HTTP/logical charges and byte reservation are atomically replaced and
file/directory-fsynced. State is bounded to64KiB and checksummed for accidental corruption.
One transport slot covers both chains, aliases and roles; existing fixed lanes still
apply. The persistent lock inode is never unlinked. Ordinary public reads gain no session
logging or source scanning, and ordinary sync never needs per-day manual grants.

Each attempt reserves twice the selected response limit (at most32MiB:16MiB response
plus16MiB chunk headroom). Insufficient headroom stops early. HTTP/logical charges never
refund. A fully consumed body settles to actual application-observed bytes, including
429/5xx/invalid JSON; an interrupted or crash-uncertain body retains its full reservation.
`observedBytes` counts settled observed chunks; `chargedBytes` additionally covers unknown
spend. A crossing chunk is counted in full before abort, never trimmed to the ceiling or
retained for JSON parsing. An unusually large chunk may exceed even the reservation and
is reported honestly. Neither counter is an exact network/kernel bound: fetch/TLS/read-ahead
may have received additional bytes. The headroom is conservative, not a network guarantee.

Default upper ceilings remain60min/2500HTTP/20000logical/512MiB; reduce them when adequate.
The Task09 offline candidate uses42HTTP/900logical rolling-minute total and
address24/360,metrics6/180,sync12/360 shares. Its1400ms slots/100ms tolerance enforce
1300ms minimum dispatch separation; upstream cadence/terms/capability remain
NOT_ADMITTED/NOT_MEASURED. A2000ms upstream spacing requirement is incompatible until
separately admitted. Live opt-ins, old approval identities and spent sessions remain
unchanged; the2500HTTP whole-session ceiling still wins over42×60=2520 nominal attempts.
All code/header/constructor/fork/ledger/price/discovery/retry/split/final
audit requests count. Alias/account-group labels never create more quota. A cap is terminal.
Cancellation/failure can resume only the same session before its original deadline with
remaining credit. Completed phases stay completed. Interrupted replay reads the actual SQL
cursor; acquisition-only phases may repeat and all repeat attempts are charged. No automatic
extension, rotation or replacement session occurs. Exit2 indicates a bounded stop or
missing config; exit1 indicates rejected input/operation. The state retains the reason.

`npm run test:canary` after build exercises raw synthetic providers, real Linux process
crashes and new PostgreSQL. Virtual quota time is not provider throughput. All actual
live identity/coverage/cost/full-history qualification remains NOT_RUN. Unchanged scale
evidence may be reused by its reviewed source commit, with limits explicitly retained.

The explicit `common-prefix` canary phase is a single, non-resumable origin1 interval
of at most16,384 inclusive positions, separate from the unchanged profile fork/native target. Its
numeric `through` header is resolved and corroborated inside the session, followed by
constructor verification, `once(stopAt)` and the full prefix address audit. Only the
declared parent and bounded finalized/numeric identity headers are exceptions to the
prefix range; they cannot authorize code, logs or state. The plan binds the two public
PulseChain URLs and sync-only12HTTP/360logical per rolling minute,2100ms physical-start
spacing and60s quarantine. Prefix sublimits are60min/600HTTP/12000logical/256MiB,
with4MiB per response. Each plan retains its own signed range and caps; old approvals
and spent sessions gain no allowance. Ordinary global42/900 quotas remain unchanged.

For an independently reviewed, owner-approved new environment, use the compiled
`canary check` and provider-disabled `prepare` first. Invoke exactly once with
`node scripts/operator/canary-once.mjs <environment> <operator-only-override>`.
The wrapper reads `input/plan.json` and `input/approval.json`, exclusively creates
`invocation.json`, and carries its original start into the operator. It never resumes
or resets that receipt. `invocation-result.json` records actual host elapsed and any
deadline shutdown; an overrun cannot pass. Keep the operator/SQL volumes after stopping
for evidence. No full replay, native initialization or production readiness follows
from a prefix result.

The explicit `pinned-audit` phase admits a separately approved retained origin1
checkpoint. Its plan binds the existing instance/volume, exact header and revision,
source provenance, migration checksums, expected counts/totals, ordered whole-account
inventory digest and a newly observed canonical digest. It never initializes or
replays. Fresh-target modes still require their original empty targets. Prepare uses the
same retained admission without providers; run requires new state/quota ownership,
new approval and the one-shot supervisor. Resume and spent ledgers are refused.

This mode holds the existing role/maintenance and both canonical locks with read-only
worker connections, and uses an API-role repeatable-read read-only snapshot. Its
transaction-local idle timeout is bounded by the original invocation deadline;
global SQL/RPC timeouts are unchanged. A lost snapshot/lock fences each subsequent
dispatch. Both sources verify the fixed identity/code/header and one first-inventory
balance before the full ordered sweeps. SQL pages remain30; this terminal audit partitions
them into at most10 balance calls. Zero balances are included and duplicate singleton
checks do not increase full coverage. No automatic smaller-batch fallback exists.

Only chain identity, the one numeric header/code read and hash-pinned globalInfo,
totalSupply and admitted balanceOf arguments are authorized. Its caps are at most
60min/500HTTP/5000logical/128MiB, with the unchanged4MiB hard response limit and8MiB
incomplete charge,12/360 cadence,2100ms spacing and60s quarantine. The saved prior
dispatch floor remains a lower bound; a new quota directory does not erase known
cooldown. Bounded per-source progress and exact comparison evidence live only in
the new state directory. A fresh snapshot under retained locks compares all canonical
tables, schema and sequence evidence after provider work. Completion requires that
equality, full paired coverage, closure and final persistence within the original
deadline. Retain the DB and new spent evidence on success or failure; never rewrite
the earlier replay result. Full Task10 remains a separate pending qualification.

The explicit `common-continue` phase advances an exactly admitted populated origin1
checkpoint S to a fixed numeric T using the existing `SyncEngine.once(stopAt)`. It
continues database history under a separate one-shot grant; it cannot resume or reset
a spent allowance. It performs the same retained admission at prepare and again at
run under exclusion locks, then ends the admission snapshot before replay. Only the
origin1 canonical writer has write-capable SQL. Both sources verify S and corroborate
T within the invocation. No constructor/fork initialization or unbounded replay runs.

The future plan has one phase with `kind: "common-continue"`, `admission` containing
the observed volume/header/revision/source/counts/totals, `inventoryDigest`,
`canonicalDigest`, `priorSession`, `priorStorageIdentity`, `priorQuotaIdentity`,
`priorDispatchFloor`, numeric-string `through`, `finalityHeaders`, and the existing
fixed `cadence`/`endpoints`. Its sole origin1 range is S..T. Normal session/reviewed
commit/image/project/instance bindings and new state/quota paths are still required.
Those values must come from a later separately authorized preparation and review;
this description is not an executable approval or a selected live interval.

T must exceed S by at most16,384 blocks and remain at/before the declared common
parent. Methods are exactly chain identity, numbered headers, code, logs and eth_call;
constructor receipts are excluded. Logs are restricted to S+1..T; state/code pins to
S..T. Existing parent/finality exceptions authorize headers only. The full admitted
SQL inventory authorizes inherited accounts, with new accounts admitted by validated
logs/headers. Existing two-source agreement and the2MiB early log split remain under
the4MiB hard response limit. Caps are at most60min/600HTTP/12000logical/256MiB with
the unchanged8MiB incomplete charge, cadence, original deadlines and both disk floors.

After replay, save the actual accepted SQL cursor and replay progress independently
of audit success. Reconcile and audit every resulting account at the exact T hash
using the existing paired singleton probes and full ten-account batches. A fresh
read-only snapshot and canonical before/after evidence cover that audit; successful
replay is expected to differ from S. Audit failure keeps accepted replay and precise
partial coverage, never complete status. Failure after SQL commit may leave progress
counters behind; the admitted SQL checkpoint remains authoritative for any later
separately approved grant. Never repair and rerun the same invocation. Use the existing
`canary-once.mjs <new-environment> <retained-operator-only-override>` supervisor and
retained-volume graph checks only after a future explicit approval. The continuation
implementation is offline qualification; no real continuation is authorized by it.

New failed sessions may retain one optional `rpcDiagnostic` (at most8KiB), with source
alias, bounded request/ID facts, structural rejection, observed status/byte count and
SHA256. `streamComplete` describes transport observation, never acceptance; an incomplete
digest covers only observed chunks. The preview is a sanitized structural summary,
not a body archive. Provider prose is untrusted and never controls retry/splitting.
No successful result payloads, endpoint secrets, wallet arguments or error.data are
saved. `diagnosticPersistence:failed` means final evidence could only be returned/logged;
it does not claim durable storage. A prior session without the field has unavailable
diagnostics and gains no permission, reconstruction or allowance from this change.

## Cost target (planning envelope, not a vendor quote)

Owner maximum is **$50–60/month total** before monetization. Suggested allocation:
$30–40 compute+included disk, $3–5 off-host backup, $5–10 provider contingency, leaving
room for traffic/tax/other costs. These are budget envelopes, not retrieved Vultr prices.
No purchase/subscription is authorized. Task10/11 must calculate actual then-current
regional vendor/provider/backup/transfer costs and measured request/storage use.

Design/test for roughly2vCPU/4GiB RAM as a starting profile; exact present VPS capacity
is not assumed. Target <=25GiB steady native DB+current/prior exports at current scale,
excluding approved off-host backup; real history may require a revised measured budget.
A target is not a hard-coded claim or permission to drop needed history. Do not require
an Ethereum/PulseChain archive node on this budget. Independent rebuild can use suitable
remote historical providers, but must meet the declared 2–7-day target / 14-day ceiling
or report a failed feasibility/acceptance result. Do not promise free instant bootstrap.
One-time bootstrap provider charges are separate from the ongoing $50–60/month envelope;
identify them and obtain approval before any charge or limit increase. Do not hide
bootstrap spend by averaging it into another budget.

Measure request units as well as HTTP batches. A batched100-call HTTP request may still
cost100 provider credits. Cache metadata, coalesce visitors, update only new block ranges,
keep current metrics independent, and do not query every holder from two RPCs every day.
Test representative50 connected visitors and10 new address lookups/min under ONE
combined API/worker/PostgreSQL 2vCPU/4GiB envelope. Include cold distinct addresses,
bootstrap, metrics and exports together. Report achieved service, throttling and the
actual sustainable envelope; the conservative starter quotas may require an admitted
provider profile change or a disclosed lower load envelope, not a fabricated PASS. Unknown public-scale traffic is not “free”.
No automatic provider spend, plan upgrade or infinite cross-provider failover.

## Live validation permission

Task01–09: offline application tests only, except legitimate package/doc retrieval and
the explicitly approved early-canary exception below. Task10 retains the owner's
bounded read-only live-validation stage in the NEW isolated v2 environment using
endpoints explicitly supplied in v2 config. Defaults per session:
60 minutes, 2500 physical HTTP requests, 20000 logical RPC calls, 512MiB responses,
concurrency2, conservative per-provider cadence and Retry-After. Stop when ANY limit
is reached; record progress. Do not discover/copy old secrets or rotate providers to
circumvent a quota. Optional paid endpoints require user provision, no auto-signup.

Early feasibility exception: after Task03's isolated basic sync is working, prepare a
brief naming the candidate commit, v2-only destination, provider IDs/chain, exact block
ranges (busy historical, recent, and fork-boundary cases), methods and all limits. The
owner must explicitly approve that particular early canary BEFORE any provider request.
The default allowance above is an upper bound, not a requirement to consume it. Use a
smaller request/time cap where adequate. Keep all phases within the declared aggregate
limits; do not reset limits by spawning agents, restarting, splitting into sessions,
or looping the canary. Reaching a cap requires a report and a new explicit decision,
not automatic continuation. A docs patch or completed offline Task03 is not approval.

Use the coverage table in data.md and the fixed lane allocation in architecture.md.
Record both the absolute provider/quota lower bound for mandatory work and a measured
projection including validation, SQL/reconciliation, exports, retries/cooldowns and
competing live traffic. Missing mandatory capability or a defensible lower bound above
14 days rejects the profile. A projection above 14 days fails feasibility; one below
14 days only permits further qualification, never a full-bootstrap PASS. Market field
coverage/gaps and one-time spend are separate from native completeness.

Record a small observed/projected feasibility report at this checkpoint, before major
Task07 UI integration. It does not mark Task10 passed or permit a full live rebuild.
If live approval/providers are unavailable, report NOT_RUN; offline implementation can
continue where useful, but actual provider feasibility is not established.

Allowed RPC methods are chain identity, block/code/log reads and allowlisted eth_call
reads at explicit block references. No eth_send*, signing, wallet, transaction or
contract deployment. Browser UI never holds provider credentials. Tests use no mainnet
private key. Docker client access remains operator-side, not mounted into the app.

A short live canary cannot certify full history. Full independent rebuild and creation
of a public bootstrap seed require their own explicit start with displayed limits/cost
and actual comparison at a shared checkpoint. Reaching a budget is incomplete coverage,
not a successful full rebuild. No implicit perpetual job or VPS deployment authority.

## Backup and restore

Default: one verified encrypted off-host backup of v2 database state plus nonsecret
configuration/manifest metadata; credentials are provisioned separately. Keep the prior
good copy until its replacement verifies, then retire it. No nightly full copies
accumulating on the serving disk. Source history, replay accumulators and needed
recovery tails belong to the consistent backup/seed checkpoint.

Published CSV files are rebuildable and need not be included in the default backup.
On a fresh restore, reconcile the DB catalog with actual files BEFORE advertising any
download. Missing/invalid bundles are unavailable/retired; publish regenerated files
under new IDs from the restored checkpoint, never overwrite historical immutable IDs.
An old prior bundle that cannot be reconstructed is retired, not falsely recreated.
The data API can serve healthy Home/history/addresses while exports rebuild. Test
empty export storage, lost publication acknowledgements, restore/forward sync and
current/prior cleanup. A successful dump command alone is not a recovery test.

Planning default recovery-point objective: at most 24 hours of accepted DB observations
lost after total host/disk loss, including locally captured market data. This is a
cost-conscious daily-backup target, NOT zero loss or an assertion that market readings
can always be reacquired. Monitor the age of the last verified backup; exceeding 24h
is degraded backup health, not a green RPO. Task08 implements/tests it; the owner-facing
production handoff states this tradeoff. A tighter RPO requires an explicit choice and
measured backup/journal cost, not a new always-on replication platform by default.
After restore, disclose any unrecoverable market interval; native replay cannot fill it.

Routine code rollback uses a prior compatible image, not old data under new schema
assumptions. Destructive reset/restore needs target identity, space preflight and an
explicit maintenance command. Automatic startup never drops canonical data.

## Storage / maintenance

Normal growth must be in real lifecycle events, current unique stakes/accounts and
small daily observations—not full observations of unchanged rows. Two exported bundles
plus one bounded temporary build maximum; scratch cleanup is reference-aware. Maintain
free-space reserve based on measured job peak plus margin (initial conservative minimum
8GiB AND20% of volume before heavy bootstrap/export/restore), not the old fixed32GiB
regardless of dataset size. Check disk and WAL/temp high-water, not logical row bytes
alone. Low space pauses writes gracefully and keeps API read service available.

No ordinary operation should require taking the API offline just to delete an old
expanded dataset. Vacuum/autovacuum is configured and measured. Rewrites, unusual
reindexing or large migrations are separate maintenance with actual space estimates.
Never delete source events merely to pass a budget, and never claim net savings by
omitting the new archive, temporary copy, indexes, WAL or backup.

## Production cutover (not authorized by this build kit)

1. Build/qualify v2 in its own environment and stage a seed/rebuild without v1 mutation.
2. Compare selected checkpoint data, formulas, live semantics and fresh mobile renders.
3. Test current release install, reboot, restart, outage/catch-up, backup/restore,
   load, security, and growth. Budget and coverage limitations remain visible.
4. Only after owner approval, deploy to distinct v2 paths/volumes/ports or a new host.
   The old150GiB nearly full disk is not assumed able to hold both complete systems.
5. Configure domain/TLS and cut traffic with explicit rollback to still-running v1.
   Do not operate public login/email/billing over bare HTTP.
6. Observe at least one real daily transition and multiple healthy metric cycles;
   verify downloads and addresses from a cold browser.
7. Decommission old resources only under a separate reviewed data/backup checklist.

The v1 service may remain stale under its current disabled timers; this kit does not
manage that existing operational decision. Do not let v2 quietly claim it maintains v1.

## Visitor privacy

Keep public address lookup anonymous. Access logs use route templates rather than
full wallet-address URLs or request bodies; do not join IP addresses to queried wallets.
Use short-lived IP-based rate-limit state only where needed, with a documented expiry.
No analytics/advertising tracker is required for launch. Seed, backup and diagnostics
must exclude visitor request caches. Future reminders require separate explicit consent;
the basic app must not silently become an address-to-contact database.


## Task05 local publication and recovery limits

Use an explicitly owned export root with its .hdd-exports marker. The worker owns one
global builder advisory lock. A repeatable-read SQL cursor snapshot shares the existing
snapshot/prune protection; it does not hold the canonical writer through file I/O.
Statements are bounded to120s; a build to30min/4GiB. Files stream in bounded buffers,
are independently hashed, synced, and renamed on the same filesystem. Both directory
sync acknowledgements are mandatory. Only then does the DB transaction switch slots.
Lost commit acknowledgement is resolved against that same UUID. Unadvertised orphans
are cleaned before another build; cleanup only enumerates fixed member names inside
ordinary owned UUID/work directories and refuses symlinks, hardlinks and unknown files.

Retention is current + prior + at most one build. Prior receives60s grace from its atomic
slot transition (published_at records the current slot's start), and a shared
reader advisory lease. New publication pauses when an active prior reader prevents
retirement. Each API service reserves at most32 pending/active readers before connection
setup, releasing admission after failed opens or stream cleanup; each stream lasts at
most120s. The deployment
contract remains one API process. Retired IDs admit no new readers. Prior remains
published until its replacement is durable; its exclusive retirement lease prevents
new readers during that build. After commit, retired files are removed. Cleanup failure
leaves bounded orphan work and blocks further publication until safe cleanup succeeds.

At startup verify hashes for the bounded current/prior bundles before downloads become
available. A worker marks missing/corrupt bundles unavailable; a read-only API excludes
them. DB-only restore rebuilds from the actual restored checkpoint under NEW UUIDs.
Exact old files may retain IDs only after digest verification. Other healthy SQL/API
reads remain independent. Real directory fsync is tested on Linux; unsupported Windows
acknowledgement is an explicit publication failure, not a successful durability claim.
This is Task05's service recovery boundary, not Task08's production backup tooling.


## Task08 supported offline operations path

README is the fresh-install authority. One app image contains compiled API, worker and
operator entrypoints, migrations, runtime dependencies/config, pg_dump17 and age.
Images/lockfile remain pinned; pg-copy-streams is the small added dependency required
to import bounded PostgreSQL COPY streams without executing archive SQL. No schema
migration was needed for Task08. The later HDS overlay adds migration5 and seed format4/schema5, preserving migrations1-4 and native semantics.

The application connects only to db/hexdailydata_v2 with its explicit instance UUID.
Database roles remain separated. Initialization alone reads bootstrap credentials;
API gets API only, worker gets worker and its backup identity, migration gets migrator.
The operator maintenance service gets worker/API and the backup identity; it does not
have DDL/admin authority. Provider state is a distinct persistent mount: both roles read both files, each UID writes only its own cooldown;
API export storage is read-only. No runtime source/test/planner tree or Docker socket.
Use secret files or explicit environment values, never both for a DB role. No dotenv,
old-secret discovery or source credential defaults. Status does not echo their values.

PostgreSQL snapshot export plus pg_dump --snapshot makes the metadata and dump coherent.
The existing shared4243 snapshot lock prevents pruning during the dump; ordinary writers
and API reads remain available. A separate4250 maintenance session lock coordinates jobs.
[Linux flock locks](https://man7.org/linux/man-pages/man2/flock.2.html) on persistent files in staging and destination remain held by the
maintenance process through cleanup, even if its DB connection dies. Connection loss
aborts the job; another process cannot reuse fixed paths before their owner finishes.
Never delete the small .maintenance.lock files: they keep stable lock inodes. Local
Linux flock semantics are required; unqualified network filesystems are unsupported.
A dump includes all hdd data except the installed
migration registry, which remains owned by the destination release. It excludes identity
schema/roles/passwords, generated CSVs, source, provider endpoints and all filesystem caches.
The manifest allowlists source UUID, release, schema/calculation, capture time, cutoffs,
known provider cooldown, dump length and hash. No environment/command is taken from it.

Standard ustar+gzip is encrypted with age using a separately provisioned X25519 identity.
The private POSIX destination must support durable files, directory fsync and atomic
same-directory rename. Object-store sync folders lacking these semantics are unsupported.
Source tools: [pg_dump17](https://www.postgresql.org/docs/17/app-pgdump.html),
[PostgreSQL restore warning](https://www.postgresql.org/docs/17/app-pgrestore.html),
[age](https://github.com/FiloSottile/age). Source SQL is never executed during restore:
only current-schema allowlisted COPY table/column data goes through pg-copy-streams.
Expected SHA256/source/destination IDs are operator input, not archive-selected targets.
Current projections and daily/market invariants are checked before atomic acceptance.
A backup is not an arbitrary untrusted SQL import authorization. Full seed/raw-event and
retained rewind audits are separately exercised on the genuine small replay fixture;
the volume-scale synthetic shape is not advertised as a full-scale seed audit.

Backup maximum ciphertext, packed file and SQL member is8GiB each (fail closed, do not
truncate). A single fixed private staging directory may contain SQL plus compressed
archive during creation, then only the decrypted verification archive. At destination,
current.age survives until candidate.age authenticates, parses and matches the snapshot
manifest/dump hash. Destination bytes are hashed and read back. Rename replaces the
single accepted ciphertext; the receipt is atomically replaced afterwards. A crash in
between yields an unverified/degraded receipt, not a fabricated newer healthy timestamp.
A subsequent backup may replace that already verified ciphertext. Failed candidates
are overwritten on the next attempt under the lock; no archive-per-date retention.
Key loss is unrecoverable; keep recovery keys separately and test them in a new target.

Recheck working space against actual dump/packed sizes before packing and transfer.
Restore reserves four times the logical dump plus64MiB for measured index/WAL/temp
growth, then checks the reserve every16MiB of streamed input. The supported DB/state/
maintenance named volumes share Docker's data filesystem; independently mounted DB
storage requires separate free-space qualification. These checks retain the8GiB AND20%
floor and abort heavy work without replacing the verified backup.

A real mounted off-host destination can replace only the backup volume with a separately
provisioned POSIX mount owned by UID1001/group1000. Set a Compose override's backup volume driver
options to type=none, o=bind, device=the explicit mount path. Do not have volume-init
chmod/chown that mounted destination: override its volumes to omit backup, and provision
permissions beforehand. Verify the mount is actually off-host and supports the durability
semantics above before production. No such remote mount/account/host is used here;
local named-volume tests are an emulator, never off-host redundancy. Keep one destination
per source instance; a different source identity may not overwrite its accepted copy.

Restoring needs a new, empty, already migrated identified project and owned Linux paths.
It never drops schemas, installs archive functions, restores role grants or overwrites
identity. COPY import, reconciliation and checkpoint acceptance share one transaction.
Missing exports remain unavailable until existing publication services rebuild new IDs.
Native reads do not wait for their bytes. Old observations keep source/collection times.
The restore record names source provenance and the unknown local-market loss interval;
upstream native replay cannot fill it. Known cooldown is retained and at least one fresh
quota window is quarantined. Post-snapshot provider backoff is unknowable after total loss;
providers remain disabled until the operator separately provisions an authorized profile
and reconciles any known external cooldown. A restored manifest never enables providers.

The worker schedules normal backups without a host timer/service. A snapshot aged23h
triggers replacement, failures retry no more often than hourly, and age>24h degrades
backup protection. This is a24h planning default, not measured production RPO. A large
or stalled backup can miss it; capture time, verification time and restore drill evidence
are distinct. Native Home availability is independent of backup health. A daily backup
can lose up to24h of local market observations; production RPO/destination still need
owner acceptance. The existing30?40 compute+disk,3?5 backup,5?10 provider and remaining
traffic/tax budget allocations remain planning arithmetic within60USD, not vendor quotes
or an assumption that off-host storage/providers are free.

Release stops API and worker, checks migrations with the selected image, starts both and
checks readiness/image identity. Failed partial release stops both; DB is retained for a
corrected release or compatible rollback. It does not claim zero downtime, data downgrade,
container reboot equivalence to host reboot, automatic future-schema compatibility, or
Task06 support for new operator commands. Keep only current and needed previous image;
remove older explicitly identified task-owned images without global prune.

## Bounded local market refresh

`node scripts/market-refresh.mjs once|trial --profile FILE --output NEW_DIRECTORY
--preflight FILE` maintains the qualified fixed four-pool market method. No argument
means no requests. The reviewed binding identifies the new local data root, unused
session output, exact runtime and bounded authority. It is not a permanent scheduler
or permission to reuse a closed trial. See the market-refresh-job-r1 return's
OPERATING_NOTES.md, REQUEST_PLAN.md and original receipts for the tested command.

A single-writer lease precedes provider work. Captured-response/accounting checks
must pass before the small immutable generation is selected. The running API checks
its local pointer after access admission, at most once per second, validates a new
admitted generation, and keeps one generation per response. No handler calls a
provider or exposes publication. Unknown closure/publication retains locks; later
recovery needs investigation rather than deleting them or automatically retrying.

The finite local trial automatically delivered three observations within the existing
300-second freshness threshold. This is not continuous freshness or production
qualification. The unchanged 4,096-observation bound allows two objects per cycle;
the final ten-object generation has room for 2,043 more such cycles. Retention,
backup/recovery and explicit scheduling/release authority are required before
indefinite operation. Do not prune original evidence to hide that limit. Protocol,
holder/stake and daily data retain their separate old observation times; gas and
independent benchmark feeds remain unavailable. Main and the indexer are unchanged.

## Bounded market storage and offline recovery

The market-storage-recovery-r1 extension replaces the preceding short raw-window
horizon for NEW marked roots. Existing accepted roots remain read-only. Exact
successful updates are retained in hash-chained 16-record journal segments; serving
generations hold at most 512 recent objects plus one last observation per key/UTC
date. Whole update pairs rotate together. Daily checkpoints are bounded to 60,006
objects and the existing 10,000-day span. No observation becomes a verified close,
and restoring files does not refresh their times or the 300-second freshness rule.

Publication retains current, one distinct rollback and explicit pins; redundant
five-file generations are removed only with a rechecked identity/ownership plan.
In-memory API and CSV snapshots own independent bytes. Historical journal facts,
the original seed and uncertain work remain retained. There is no age-based unlock.
New capture reservations and settlements use immutable operation identities with
bounded direct lookups; a full audit is an explicit maintenance/restore action.

`node scripts/market-storage.mjs` prints read-only usage. The offline modes are
`inspect`, `plan-retention`, `apply-retention`, `plan-rollback`, `apply-rollback`,
`backup`, `restore`, and `reconcile-ack`; use the exact arguments shown by usage.
Apply modes require the current exact local plan. A backup goes to a new path and
refuses a manifest above restore's 4 MiB bound before destination creation. Restore
requires its SHA-256 and a new marked root. Missing acknowledgement is reconciled
only from complete pointer/journal/receipt evidence. Corrupt-current rollback keeps
the unresolved newer journal and blocks subsequent publication pending integrity
resolution. Unknown locks, orphan events or partial writes remain blocked.

Finite ceilings remain: 8 GiB, 100,000 entries, 10 GiB protected free space,
1,000,000 journal updates, 8,192 local-operation events, 16 retained generations
and 8 pins. New finite capture output reserves 1 GiB/8,192 entries; known complete
closure can settle to conservative actual charges, but unknown work keeps the full
reservation. Backups consume conservative additional allowance. Stop before a
ceiling; retention of full snapshots does not make historical storage constant.

Qualification is offline with virtual-clock data and process-interruption fixtures,
including a running loopback API and isolated restore. Physical power-loss and
indefinite unattended operation are unqualified. A native Windows rename refusal
was preserved as a stopped synthetic run with uncertainty retained. No retry or
force-unlock workaround is approved. Any future public trial needs a new build,
preflight and explicit finite authority; no old command or allowance is revived.

The BTC/ETH Operating Refresh R1 command is consumed:
`node tests/trade-feed/operating-owner.mjs run-reviewed` with HDD_TASK_ROOT set
to the original BTC/ETH R2 task root. Default invocation is offline. Do not rerun
it or remove session markers. It was a finite 16-slot trial, not a service.
Sequence 28 is the last successfully selected product. The failed sixth
publication retained participants/INTENT.json, participants/SELECTION.lock and
product/MARKET_REFRESH.lock; all owning processes have exited. Do not force
unlock or activate a copied generation. A separately scoped conservative
recovery must reconcile the intent and both pointers before further operation.
The return's quarantined selected files are evidence, not a qualified backup.

The later authorized offline recovery is now complete. The exact closed intent
was aborted before product commit, with original bytes retained in participant
root CLOSED_INTENT/CLOSED_LOCK/CLOSED_MARKET_REFRESH records and durable recovery
receipts. No active recovery/writer lock remains. Both CURRENT pointers, selected
five-file product and certificate stayed byte-identical; backup accounting alone
advanced the storage operation counter. The strict ordinary writer guard remains.

`scripts/trade-publication-recovery.mjs` exports the narrow hash-bound offline
settlement; it is not a generic unlock or provider entry. Default invocation of
`tests/trade-feed/recovery-owner.mjs` is offline. Its exact `recover-reviewed`
entry is consumed and must not be repeated. An interrupted recovery retains its
new exclusion lock and durable intent; neither PID age nor elapsed time permits
deletion. Active/unknown owners, changed pointers, pending work, journal drift,
hardlinks and destination collisions refuse settlement.

The offline-recovery-r1 return contains a genuine compact paired backup, verified
restore and exact read-only external-base references. Restore needs those bases
and a new destination; it does not create fresh observations or grant acquisition.
The saved sequence-28 quotes are stale. No scheduler or additional public run
was installed or started, and the original operating trial remains partial.

Operating Refresh R2's `node tests/trade-feed/operating-completion-owner.mjs
run-reviewed` entry is also consumed. Do not rerun it. Its session recorded all
16 fresh served pairs, then failed the oversized final IPC report check. Product
sequence 44 is selected coherently by both CURRENT files. The retained product
MARKET_REFRESH.lock must remain: this is committed work, not the narrowly
authorized abort-before-product case. No PID-age deletion, manual selection,
old recovery plan or copied backup may bypass it.

The R2-only compact-closure correction binds exact saved RESULT bytes and SHA256
without increasing the 32 KiB message bound. It passed focused offline tests;
the original run remains PARTIAL and its frozen evidence is unchanged. The R2
return's selected-files folder is quarantined inspection evidence, not a backup.
Normal backupStorage requires a quiescent root, so new backup/restore and final
application proof require an applicable separately reviewed committed-state
settlement authority. That future local recovery need not reacquire prices or
restart the consumed provider session. No continuous service is installed.

The later owner-authorized offline closure recovery has now settled that exact
sequence-44 completed state. `settleClosedOperatingCompletion` is separate from
the pre-product abort path: it requires the bound closed owner/session, all 16
committed publication records, exact journal/certificate and unchanged paired
pointers, with no pending work. The original market lock is preserved in a
collision-safe CLOSED_MARKET_REFRESH record with a durable recovery intent and
receipt. An interrupted settlement retains its own exclusion locks.

The exact `settle-completed-reviewed` entry is consumed; do not repeat it or
reuse its plan. No active recovery/writer lock remains. The selected five-file
product, certificate and both pointers stayed byte-identical. One ordinary
backup advanced only storage operation accounting. The new compact backup and
restore proof live under operating-refresh-r2/offline-closure-recovery-r1;
external bases remain read-only references. Its immediate rollback is sequence
43, not the separate original HDS rollback. Current saved quotes are stale.
The original public trial and partial archive are unchanged; no new acquisition
or permanent service was started.

Unified Refresh Integration R2 adds a finite **offline-only** five-feed profile
to the existing coordinator; see `docs/unified-refresh-operation.md` for plan,
fixture and saved-status commands. The two product-policy incompatibilities
documented there received an explicit narrow owner scope extension and correction;
the original failed fixtures are preserved. The real mixed synthetic schedule and
focused accounting/native-closure/refusal checks qualify offline behavior. Genuine
sequence 44 is read-only, no new bases or network are admitted, and this profile
does not authorize a public run or operating service.

Unified Refresh Public Qualification R2 subsequently consumed its distinct
owner-authorized parent session and closed PARTIAL after 162 attempts. The new
local candidate reached sequence 49 through five coherent publications; the
participant window was captured but not published because of a local auditor
retry-policy mismatch. The narrow saved-only correction and original failure
are both retained. Final preservation/access/compact restore passed, resources
closed, and no continuous freshness or recurring-operation approval is claimed.
The public command and marker are spent; see the dated result in
`docs/unified-refresh-operation.md` and the task's reviewed return.

Unified Refresh Public Qualification R3 is also consumed. Its first three GETs
qualified one BTC/ETH pair at sequence 51, but a local R3 completion-frame binding
defect stopped the parent before the other 22 jobs. The final source fixes that
binding; it does not authorize rerunning the command or completing the schedule.
The original partial accounting remains intact. Separate reviewed offline proof
established native closure and exact committed state, permitting only retirement
of the preserved, dead-owner task lock. No price or pointer changed in recovery.
One final compact backup/restore and normal access/preservation checks passed;
all real resources closed. The task-owned recovery/finalization entries are spent.
The selected prices retain their true source times and are stale at final review.

Unified Refresh Public Qualification R4 consumed its one reviewed session on
2026-10-11. All 23 jobs completed with matching compact native completion and
known automatic closure. The same API adopted 20 publications, sequence 51 to
71; empty ETH samples in trade slots 1, 7 and 14 retained the prior atomic pair.
The fixed participant frontier advanced to 27,762,617. Accounting: 279 physical
attempts (59 GraphQL, 172 RPC, 48 GET), seven GraphQL extras, 105,196,234 charged
bytes and 7,690 family-defined object units. The public parent closed in 1,505.123
seconds. No recovery, saved-only publication or second session was used.

The actual tested `node scripts/refresh-data.mjs public-qualification-r4` command
is now spent. Its task marker/accounting must not be reset or reused. One genuine
base admission was reused for readiness, serving and final compact restore;
preservation, protected access, held CSV and desktop/mobile checks passed, and
all owned resources closed. Final BTC/ETH and other current feeds were truthfully
stale after participant work; 15/16 post-trade measurements had fresh pairs.
Finite completion does not qualify continuous freshness or install a service.
See the R4 return for exact source, selected/rollback identities and limitations.

The finite repeatable operating entry is
`node scripts/refresh-data.mjs operating-public-qualification-r1`.
It requires its own unspent exact task marker, frozen-source review and a newly
loaded actual paired API. It cannot reuse R4 or any old grant. See
`docs/unified-refresh-operation.md` and the exact task packet for timing,
reservations, closure and task-owned restore limits. Do not install this entry
as a service or reuse it after terminal closure. Inspect the task return for
actual served ages and any partial outcome before considering later operation.

That qualification entry is now consumed. Its public result is PARTIAL after
43 charged attempts and one selected trade pair (sequence 72). Do not execute
it again. The retained UNKNOWN parent and pending charge are not a reusable
session or permission to remove its lock. Saved-only finalization may inspect
the exact committed selection under its separately reviewed task-local plan;
it never settles or reopens the public coordinator. A longer operating cadence
and reliable cross-family public progression remain unqualified.

The task's saved-only finalization is complete: normal API/access, preservation,
compact backup/restore and two previews passed without changing sequence 72.
The backup contains sequence 72 and immediate rollback 71 with exact external
base references. It does not include permission to resume the consumed owner.
All owned application/base handles closed; the protected parent record remains.

R2 provides the separately authorized one-use entry
`node scripts/refresh-data.mjs operating-public-qualification-r2`. It uses only
the verified clean sequence 72/71 backup in a new owned runtime. Its preflight
checks R1's unchanged evidence and confirms each recorded old PID is absent or
a demonstrably later process; lookup uncertainty stops admission. It never
settles R1 or removes its lock. The existing numerical limits remain unchanged.
Actual qualification belongs to the R2 result, not this command's availability.

R2 is now consumed and must not be run again. Its public owner stopped with
UNKNOWN accounting after 130 charged permits: 129 have physical closure and
parent settlement receipts; permit 130 retains its full 4,096-byte/two-object
charge. Seven paired publications completed through the running API. Market and
participant acquisition did not qualify. The original failure, lock and counters
remain unchanged. See the R2 return for any separately reviewed saved completion
and finalization; neither renews this authority or qualifies the full cadence.

The narrow corrected transport records a post-grant mandatory-reserve refusal
before any worker is called. It requires exact enclosing no-dispatch proof, keeps
the full charge, accepts no data, performs no retry and disables only that closed
feed. Other integrity or uncertain-closure failures still stop all dispatch.

R2 saved-only completion and finalization subsequently passed. The exact already
committed trade product was paired at sequence 80, with immediate rollback 79;
it was not fetched or published again. One compact backup/isolated restore,
normal access/preservation checks and two stale previews passed. Both genuine
base admissions and all owned application/browser handles are closed. The
operating parent remains UNKNOWN and consumed independently of this clean pair.


### Offline market scheduling correction

HEX/liquidity scheduling has a focused denied-network native qualification in
HDD-HEX-LIQUIDITY-SCHEDULING-R1. Parent-owned FIFO aging is shortened only by an
independently verified mandatory-control deadline; original worker and control
cutoffs remain strict. A known, fully charged no-dispatch market miss can defer
to a later configured slot. It cannot renew a job/session or clear an unknown
liability. Earlier trial outcomes and locks are unchanged.

The new configuration is OFFLINE_ONLY; no provider activation, genuine admission
or publication is part of this milestone. Public market freshness remains
unqualified. The task return contains one proposed finite follow-on profile,
requiring separate authority. No permanent service, deployment or paid activation.


### HEX/liquidity public qualification R1 preparation

The exact new four-family authority uses eight trade, two market, three gas and two protocol slots, an eight-minute start window and twenty-minute total window. Participants are disabled; graph admission96 is separate from actual graph48 and aggregate336. Source methods, closing reserves and freshness stay unchanged. Focused denied-network admission/native/worker/finalizer checks precede separate review and fresh paired readiness. Public outcome is not yet qualified; task evidence is kept in `hex-liquidity-public-qualification-r1`. No old session is reopened.
