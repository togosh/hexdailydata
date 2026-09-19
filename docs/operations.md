# Operations and build access

## Environments

Local developer and integration environments are v2-only Docker Compose projects with
named volumes. Production is a single modest Linux server with the same release image
for API/worker plus PostgreSQL and optional Caddy. No Kubernetes/Redis/message broker.
Do not reuse old VPS paths, a host `hexstake` DB, or inherited credentials. Database
port is not published by default. The local HTTP port is 127.0.0.1:4320, avoiding v1.

Starter Compose is explicitly scaffold-only; task 08 writes/tests its production
profile. Health checks distinguish live process, usable DB/schema, catching up, and
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

Retention is current + prior + at most one build. Prior receives60s grace and a shared
reader advisory lease. New publication pauses when an active prior reader prevents
retirement. Each API service permits32 active readers, each at most120s; the deployment
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
