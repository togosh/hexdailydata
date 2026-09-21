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
