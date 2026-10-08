# Paid API lab — planner checkpoint inspection

## Disposition

**Accept as a useful, independently reviewed working foundation checkpoint.** Preserve
`b7bd2bfa85164f3ee31825f3779a867a378c6c44`. Do not represent this as the entire original
acceptance matrix passed, a production billing system, or a candidate already integrated
with HEXDailyData-v2. The next proposed scope is lab-only acceptance follow-through, not
provider selection or live payments. No main-project task status is changed by this note.

The supplied independent verdict is **PASS_FOR_LAB_SCOPE** on
`0022b16959fe8d404e9672e8b6ae501bb0385d56`, following initial review of
`e0b8892939d8ff571286924fd195d6459d62fbaa`. It reports two blocker fixes in ONE correction
round. The delivered commit is later and reported as documentation/source-manifest only.
No Git objects or full archive of0022b169 were supplied: ancestry and that final-delta
claim are reported, not independently reconstructed here.

## Actual input verification

| Archive | Bytes | Files | Expanded bytes | SHA-256 |
|---|---:|---:|---:|---|
| HEXDailyData-Paid-API-Lab-source.zip |123495|63|328994|7da3c90f1599cfb5a16e0a85094be7a554097208ae0d416769d2b61508f5177d|
| HEXDailyData-Paid-API-Lab-evidence.zip |330014|31|370989|60736c51d94e552f34a88fd88f64f8864f49d91eec0cb21f72c7904257bbd9c7|

Both match ARTIFACT_RECEIPTS.json and pass CRC checks. The source ZIP comment matches
b7bd2bfa. All62 SOURCE_FILES.json members match sizes/hashes; that manifest excludes only
itself. All30 evidence-manifest members match. The source contains11 parseable JSON
files; package metadata/dependencies/devDependencies/engine agree with the lockfile root.
This is static consistency, not a new dependency install, npm audit or supported-version
certification. The original32-file starter is also verified; comparison shows31added,
8changed,24unchanged,0removed. This does not measure code quality by file count.

The evidence ZIP has26 Windows-backslash entry names. I normalized them to slash names
only in a separate inspection copy, checked for collisions/traversal/symlinks, and verified
its manifest against those bytes. The original ZIP remains unchanged. Future packaging
should emit slash-separated paths; this is a portability cleanup, not a security failure
or reason to repack the old milestone. No unsafe path or duplicate member was observed.

Attached REPORT and REVIEW_RESULT match the source and evidence copies byte-for-byte.
The attached README differs by one CRLF on its final line; normalized text is identical.
No source/evidence path was inferred to exist on the owner's C: drive by this inspection.

## What the evidence actually shows

Builder tests.json records18 passing integration groups: real HTTP/SMTP/SQL core flow,
ownership, payments,20duplicate deliveries, economic identity, concurrent30+90 purchases,
missed callback, quota race, password reset, process-exit transaction recovery, calendar
fixtures, clock-after-lock fixes, Chromium journey and small performance run. controls.json
records4 additional focused control outcomes; these are groups, not an independently
recomputed total of all test assertions. Starter evidence reports20pass/1Windows
file-symlink privilege skip. No application tests were executed by this planner.

The same reviewer supplied initial and corrected JSON/log witnesses. Its original
cancellation test exposed debt incorrectly clearing; its original2.2-second account-lock
wait exposed admission after expiry. Corrected code stores collectible state per invoice,
derives account debt, and samples time after acquiring the customer lock. The recheck
shows old debt survives cancellation/unrelated payment and clears on payment of its own
invoice; the expiry-crossing request returnsACCESS_EXPIRED with stored quota0. The
recheck also records independent ownership/dedup/quota/reset/production-refusal checks.
This is stronger than a summary PASS alone, but not an external security audit. Individual
reviewer probe scripts under .local/reviewer were NOT packaged; results/logs/report are
available. Future evidence should include safe probe source rather than require a local
unavailable path to reconstruct it.

Measured builder performance:100 admitted private HTTP requests,4synthetic accounts,
concurrency1,one returned synthetic row,p50=6.578226ms,p95=9.259814ms,nine instrumentedSQL
statements including transaction boundaries. No provider/mail calls on that read path
per source/evidence. This is not600RPM capacity, a cold-start benchmark, whole main-app
cost or a customer service-level commitment.

The recovery record compares14 tables after an actual dump/restore into a fresh guarded
database, then restarts the ORIGINAL app against the ORIGINAL DB. The separate SMTP
outage/retry test preserves access. The report accurately discloses no browser journey
against the restored database. The SQL dump command is not restricted to those14 tables;
`burst_bucket` and `used_link` are omitted from the equality list, NOT proven absent from
the dump. Both should be checked when the restored runtime is exercised next.

The mobile screenshot was visually inspected: it labels the site as a lab with no real
payments, synthetic access, shared quota, prepaid choices and masked keys. The desktop
screenshot's bytes were verified but not visually inspected. These are supplied captures,
not a new browser test by the planner.

Isolation receipts describe no default route, private SQL, no host gateway/socket,
separate runtime/provider roles and configured2CPU/2GiB combined DB/app/inbox/test runner.
Host compiler/image build/control overhead is explicitly separate and unmeasured. Cleanup
receipt reports zero active lab containers and retains private volumes/config/dumps and
source-only test extracts. No fresh host/Docker inspection occurred here. Do not delete
those through an alternate route after a platform denial, or touch any main-project job.

## Specific follow-through targets

These are source-informed tests to add within existing acceptance, not new production
features and not claims that this planner ran a new exploit.

**Restored application behavior — confirmed proof gap:** tools/recovery.mjs creates a
fresh target and validates rows but restarts the original configured app. Test the actual
restored configuration/DB identity, browser sign-in/reset, existing keys/usage/revocation,
reconciliation and outbox. Never weaken the boundary guard just to allow the restore.

**Reconciliation fairness — static risk:** src/worker.ts selects the oldest20
fake_provider records without a matching event, then catches failures without marking
backoff/review/attempt state. Construct20 permanently rejected records ahead of a valid
missed payment. As written, repeated selection can starve that later payment. Reproduce
through the actual worker/SQL; fix with the smallest bounded durable scheduling/review
behavior, not dropping invalid records or installing another queue platform.

**Order-independent payment state — additional witnesses:** src/billing.ts chooses
credit by payment_id and maintains collectible flags/status. Extend original card-race
coverage with stale failures, cancellations, distinct attempt IDs for a paid invoice,
refund then new paid-delivery IDs, and concurrent mixed-mode order/fulfillment. Do not
assume a new transport event represents new money or a new bill. Specify expected policy
before implementation; separate old-event audit state from current invoice/entitlement.

**Reminder and time boundaries — disclosed incomplete coverage:** src/worker.ts already
checks reminder obsolescence before SMTP, but overlapping renewal/refund, future gaps,
UTC quota rollover and exactly-after-lock boundaries need targeted tests. An email already
accepted by SMTP cannot be recalled; distinguish best-effort dispatch revalidation from
impossible exactly-once/retraction claims. No network inside a billing SQL transaction.

**Auth and cross-account tests — disclosed incomplete coverage:** main.ts/auth.ts include
library auth, local replay fences and throttling. Test existing-vs-nonexisting response
shapes, reset expiry/concurrency, stale sessions and browser isolation; investigate only
supported mismatches. No replacement auth framework or live email/provider adapter.

## Source read and execution boundary

Static reads: AGENTS.md; docs/PRODUCT_AND_DATA.md, ACCEPTANCE.md, INTEGRATION.md,
DEPENDENCIES.md; src/access.ts, auth.ts, billing.ts, worker.ts, schema.sql, db.ts,
config.ts; main.ts auth/billing/key/lifetime paths; tools/recovery.mjs; targeted integration
cases; package/lock/manifest metadata; source/report/review and evidence JSON/logs listed
above. The complete files were inventoried, not exhaustively audited line-by-line.

The builder's npm-audit result is historical evidence, not this planner's check of
current advisories. No new external vendor research was required for this checkpoint.
No uploaded code, installer, application, SQL, Docker or test harness was executed/imported.
No main repository, prior lab, v1, credential, provider sandbox, RPC, actual email,
payment, vendor account, Git remote or VPS was accessed. Only inspection and instruction
artifacts were written in the analysis filesystem.
