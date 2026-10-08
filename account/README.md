# Paid API foundation lab

This standalone experiment uses Node 24, Fastify, Better Auth, React, PostgreSQL 17 and a local Mailpit inbox. All identities use example.test. PLS/card events and API data are synthetic. No provider, wallet, RPC, external email, main database or production activation exists.

Follow-through: restored PostgreSQL/local SMTP/Chromium, reconciliation, payment races, authentication, quotas and reminders now have actual measured witnesses. See [REPORT.md](REPORT.md), [docs/ACCEPTANCE_STATUS.md](docs/ACCEPTANCE_STATUS.md) and the separate review. All simulations remain lab-only.

Use distinct evidence folders and run sequentially. Each follow-through attempt creates a new subdirectory and retains failures:

```powershell
$env:LAB_EVIDENCE_DIR='evidence/my-followthrough-run'
node tools/runtime.mjs start
node tools/restored-journey.mjs
node tools/followthrough-run.mjs starvation --worker-only
node tools/followthrough-run.mjs payment --restart-first
node tools/followthrough-run.mjs time
node tools/followthrough-run.mjs auth samples --restart-first
node tools/followthrough-run.mjs auth links --restart-first
node tools/followthrough-run.mjs auth failure --restart-first
node tools/followthrough-run.mjs auth browser --restart-first
node tools/followthrough-run.mjs reminders state --worker-only
node tools/followthrough-run.mjs reminders outage --worker-only --smtp-outage
node tools/followthrough-run.mjs reminders retry
node tools/followthrough-run.mjs reminders backoff --worker-only
node tools/followthrough-run.mjs integration --restart-first
node tools/followthrough-run.mjs controls --restart-first
node tools/runtime.mjs stop
Remove-Item Env:LAB_EVIDENCE_DIR
```

The source database is active before/after recovery; only a separate temporary app targets the restored database/origin. Auth secret continuity is retained privately. Never repoint the source config. Controls intentionally exhaust the auth limiter: wait for its minute window or restart only the owned app before another auth-heavy test. `tools/refresh-lab.mjs` upgrades a populated guarded copy first, then this run; `--code-only` rebuilds/replaces the owned app without schema work. Never use refresh on a main or retained unrelated database. Pending/review records and private dumps remain owned lab storage.


From this directory in PowerShell, with Node 24 and the already-running Docker Desktop:

```powershell
node tools/setup.mjs
npm ci --ignore-scripts
npm run build
npm run dev
```

`dev` creates a **new** isolated run and prints its app and inbox loopback URLs. It builds the local image, proves the network boundary, creates the new private database, verifies its identity, then migrates it. An occupied port is never obtained by stopping another process. If startup fails, preserve the error and use `npm run lab:stop` to remove only resources recorded for that run before retrying. Build downloads are installation activity; runtime has no outbound route.

The internal Docker network uses isolated gateway mode. Since this also prevents ordinary Docker host port forwarding, the lab runs a loopback-only control process that transports HTTP bytes using `docker exec` stdio. The containers have **no host gateway, host networking, Docker socket or privilege**. This transport is for the local lab, not deployment. Host build/control processes are not claimed to be sandboxed.

1. Open the printed app URL. Register member@example.test with a password of 12–128 characters.
2. Open the printed inbox URL, open “Verify lab email,” and follow the local link. Sign in.
3. Save a 30-day PLS fixture invoice. “Simulate purchase” persists an independent fake-provider record, verifies an internal HMAC envelope, and commits the credit and access grant together.
4. Create an API key. Copy it once; the dashboard masks it. Paste it into the protected synthetic GET form.
5. Save and simulate a 90-day PLS invoice. The same key works and its quota is unchanged by renewal. Revoke/rotate is explicit.

“Miss callback test” saves the provider event and lets the bounded worker reconcile it. Receipt delivery failure does not revoke access. Reset links also arrive in the local inbox. The monthly card fixture uses calendar boundaries, supports cancellation/failure/refund events through the lab endpoint, and blocks conflicting prepaid coverage. Annual/365-day choices are disabled by default. There are no real prices or offers.

Run the suites **sequentially**, against a fresh run:

```powershell
npm test
node tools/recovery.mjs
npm test -- controls
npm run test:starter
npm run lab:stop
```

`npm test` uses real HTTP, SMTP, PostgreSQL, child-process crash boundaries, and isolated Chromium. It writes redacted evidence under evidence/. It mutates only synthetic fixtures, including explicitly identified virtual-time cases. `recovery` stops/starts only the recorded app/inbox, stores a private dump under .local, and restores to a new guarded database in this run's private PostgreSQL instance. Do not run two suites or a reviewer suite concurrently.

`lab:stop` stops the loopback transport and removes exact labeled container/network IDs. Private lab DB volumes and .local secrets/dumps remain local for inspection; there is no prune or global cleanup. A subsequent `dev` starts a fresh run. Application restart/persistence is exercised by `recovery`, not by starting a fresh run.

Total runtime/test caps: DB 0.75 CPU/768 MiB; app 0.5/512; inbox 0.125/128; runner 0.625/640 = **2 CPU/2 GiB**. Image builds, TypeScript compilation and host control overhead are separate and not peak-profiled. No other project's resources are inspected or stopped.

See [REPORT.md](REPORT.md), [docs/INTEGRATION.md](docs/INTEGRATION.md) and [docs/DEPENDENCIES.md](docs/DEPENDENCIES.md). The original acceptance specification is retained in docs/ACCEPTANCE.md; individual measured coverage and gaps are reported separately, not implied by this README.
