# Original A01–A20 acceptance coverage

Original [ACCEPTANCE.md](ACCEPTANCE.md) is unchanged. `E/` below means `evidence/followthrough-resumed/`. These are builder measurements unless marked reused. Original b7bd2bf/f96ac14 evidence and failed attempts are retained. The same separate reviewer passed the reviewed lab scope at eeefd1a7 after one resumed correction round. Coverage is bounded/partial, not an exhaustive FULL_PASS; each row states its measured/reused scope and remaining limit.

All new suites run sequentially with `$env:LAB_EVIDENCE_DIR='evidence/followthrough-resumed'`. `R suite [phase]` below means `node tools/followthrough-run.mjs suite [phase]`; `--worker-only` stops the owned app so only the manual worker runs. `--restart-first` performs an ordinary app restart, including resetting its memory limiter; it does not reset SQL data. See README for full commands. Never run suites concurrently.

| ID | Status | Command and demonstrated coverage / evidence | Bound |
|---|---|---|---|
| A01 | Implemented / measured | `node tools/runtime.mjs start`; E/start-01/isolation.json; integration/controls; restore target guard | Current private Docker runtime only; host control is not sandboxed |
| A02 | Implemented / measured | R integration; R auth samples --restart-first; E/auth-k3Yf4S/auth.json | Three timing pairs/route; 500 ms floor is not constant-time proof |
| A03 | Implemented / measured | R auth links/failure/browser --restart-first; E/auth-{7OYITU,zEy7Wd,LcFQI4}/auth.json | Fresh link required after ambiguous failure; other outstanding tokens keep library TTL |
| A04 | Implemented / measured | E/integration-7T7eMs/tests.json and recovery-LCIecD/restored.json | Internal PLS/card and independent fake-provider schema only |
| A05 | Implemented / measured | Integration + restored key/revocation/renewal and auth-browser separation | No production key operations qualification |
| A06 | Implemented / measured | R time; R payment; original 365/20+90 integration vectors | Exact seconds; no price oracle or public annual offer |
| A07 | Implemented / measured | E/time-6m2W7K/time.json; original last-unit race; restored quota state | Fixed UTC-minute, not rolling-minute; admitted downstream failures may consume usage |
| A08 | Implemented / measured | E/integration-7T7eMs/tests.json; E/payment-k9XxM1/payment.json | Delivery result history may say granted after later refund; current state remains refunded |
| A09 | Implemented / measured | Original child-process crash groups rerun; R starvation --worker-only; R reminders backoff --worker-only | Five transient attempts then visible review; no real-vendor recovery |
| A10 | Implemented / measured | R reminders state --worker-only; outage --worker-only --smtp-outage; retry | At-least-once email; no recall after acceptance/in-flight boundary; eight-attempt SMTP ceiling independently measured in reviewer/smtp-cap-OawRqI with SQL-advanced due times |
| A11 | Implemented / measured | R time + R payment calendar, paid/failed/cancel/reordered, refund-first and alternate-attempt SQL; reviewer/delta-FBuNPe | Explicit half-open calendar fixtures; annual public choice disabled |
| A12 | Implemented / measured | E/payment-k9XxM1/payment.json: six creation and four fulfillment races, debt/lock witnesses | Synthetic historical opposing invoices; no external charge/cancel occurred |
| A13 | Implemented / measured | Payment validation matrix and scoped-refund integration; refund/new-delivery status | Partial refund/dispute remains review; historical ambiguous events are not inferred/backfilled; no funds moved |
| A14 | Implemented / measured | R auth browser; restored two contexts; controls shared throttle and profile refusal | Small bounded browser/SQL fixture; no broad production audit |
| A15 | Implemented / measured | `node tools/restored-journey.mjs`: E/recovery-LCIecD; `node tools/refresh-lab.mjs`: populated copy migration | One owned PG instance; private auth-secret continuity; old mailed origins require fresh link |
| A16 | Implemented / measured | Integration + restored Chromium desktop/390×844, focus, errors, cleared key fields | Redacted screenshots visually inspected; no accessibility certification |
| A17 | Implemented / measured | E/integration-7T7eMs/performance.json: 100 admitted requests, p50 3.72/p95 4.34 ms, 9 queries | Four accounts/concurrency 1/one row; not 600 RPM/cold/transport capacity |
| A18 | Implemented / measured | R controls --restart-first; E/controls-uptjeR/controls.json | Compiled production/remote credentials refused; production activation absent |
| A19 | Implemented / measured | E/corrected-fresh-runtime.json: exact eeefd1a7 source-only setup/preflight/install/build/start/restored journey/stop; final archive canonical/CRC/byte checks in ARTIFACT_RECEIPTS.json | Final delivery changes metadata only; audit result is not comprehensive advisory qualification |
| A20 | Separate review / scoped PASS | E/reviewer/review-final.md; independent restored SQL/HTTP/browser, scheduler, ownership/reset, payment/expiry-lock and SMTP-cap; one correction round on eeefd1a7 | Other unchanged groups explicitly read/reused; bounded/partial original-matrix coverage, not exhaustive FULL_PASS |

`E/attempt-index-final.json` includes failures and corrections; the original index is retained. Source-only archive and same-reviewer scope are recorded in REPORT. No supported reviewed-scope blocker remains; historical ambiguity and the stated qualification limits remain. No main/legacy data or runtime was used. Production exclusions and actual versus virtual clock distinctions remain in REPORT and FOLLOWTHROUGH_RULES.
