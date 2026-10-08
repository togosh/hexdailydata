# Start the separate paid-API lab

**This is an updated starter and first implementation task, not a completed billing app.**
The active main project is `C:\Code\HEXDailyData-v2`; the earlier branch's description of
`HEXStakeExplorer-PulseChain` as the main repo is obsolete. Do not inspect or change either.

## WINDOWS — a new VS Code window, not SERVER PuTTY

Extract this ZIP under `C:\Code` into its own new directory:

`C:\Code\HEXDailyData-Paid-API-Lab-20260919`

Do not extract inside the active repo or overwrite a pre-existing lab. This dated directory
is separate from the earlier `HEXDailyData-Payments-Lab`. No older lab completion is known.
If this exact destination already has work, preserve it and use the new prompt as external
instructions after its builder inspects only that lab; do not overlay starter files.

Open the new directory in a separate VS Code window. Use **GPT-6 Astra / Extra High**;
your existing Fast selection may remain. Start one fresh lab-builder session and paste:

```text
Read CODEX_PROMPT.txt and implement the paid-API foundation experiment in THIS lab only.
The main HEXDailyData-v2 Codex session continues separately; do not inspect or change it.
Use the supplied scope, real isolated PostgreSQL and a local test inbox, synthetic
PLS/card events, and one genuinely separate read-only reviewer. Begin implementation
now; do not stop for provider selection or ask again about email/password.
No real payments, provider sandboxes, RPC, real email, main DB, push or deployment.
Return actual source, test/reviewer evidence, run instructions and remaining gaps.
```

Codex performs local setup; you do not need a manual dependency install, provider account,
wallet, email service or Docker restart. Keep an already running Docker Desktop untouched.
Setup can also be run by you, solely in the new directory:

```powershell
Set-Location -LiteralPath 'C:\Code\HEXDailyData-Paid-API-Lab-20260919'
node.exe .\tools\setup.mjs
if ($LASTEXITCODE -ne 0) { throw 'Setup stopped; preserve the folder and inspect the message.' }
```

The setup tool needs Node22.14+ and Git. It initializes only this independent Git repo,
uses a local placeholder commit identity without altering global Git settings, and writes
an ignored nonsecret lab identity. It does not install packages, run Docker, access any
DB, send email, query another repo, or read global credentials. Success is
`LAB_REPOSITORY_READY`; repeat setup is a preservation no-op, not a reset. See
`STARTER_VALIDATION.md` for checks actually run by the planner.

## Useful target for the available window

Build one real journey: register -> local verification mail -> login -> saved invoice ->
simulated verified PLS purchase -> access -> key -> protected synthetic endpoint -> renewal.
Then exercise genuine SQL duplicate/concurrency/restart safety and the simulated card
lifecycle. A narrow functioning slice is more useful than spending the window on another
vendor survey. Plan a progress checkpoint around30minutes and stop adding features around40
if that reflects the owner's remaining window. Do not call partial work PASS to meet a clock.

Email/password, automatic-card-period semantics, prepaid PLS30/90/365days, account quotas
and same-key renewal remain the selected direction. No passkeys/wallet-login detour.
365days and annual cards are test cases, not approved real year-long offers or prices.

Keep the main session running. The lab has its own DB/network/ports/secrets and modest
resource caps. Never kill another process to obtain a port, mount the Docker socket into
an app, or run a global Docker cleanup. Runtime denial of external network access must
be tested before application integration tests. Separate folders alone are not security.

## Return

One committed source-only ZIP, compact actual evidence ZIP, concise REPORT.md and a short
local demo guide, including the independent reviewer report or honestly REVIEW_PENDING.
No secrets, tokens, raw inbox, database volumes, node_modules or screenshots with live keys.
Do not merge into main automatically. Paid launch and vendor qualification remain later.
