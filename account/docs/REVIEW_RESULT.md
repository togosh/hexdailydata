# Same-reviewer correction review

**PASS_FOR_LAB_SCOPE** for frozen commit `0022b16959fe8d404e9672e8b6ae501bb0385d56`, reviewed against initial candidate `e0b8892939d8ff571286924fd195d6459d62fbaa`. One correction round, same independent source-read-only reviewer, no delegation. Initial findings and evidence remain unchanged in `review-initial.md`, `witness.json` and `clock.json`. Requested Astra / Extra High; actual effective model, effort and Fast settings remain **UNKNOWN** to the reviewer.

Both initially reproduced blockers are resolved in the independent delta witnesses:

- Card failure followed by cancellation retains collectible debt and refuses a PLS order. A different paid card period and its cancellation leave the older invoice collectible, keep account debt true, and still block PLS after the newer period ends. Payment of the original debt's own invoice clears that invoice and the aggregate debt.
- The identical real 2.2-second account-lock waiter now returns `ACCESS_EXPIRED` after crossing expiry, with SQL quota unchanged at zero. Expiry was `2026-09-19T23:58:53.448Z`; lock release/readout was `23:58:54.163Z`. Previously this witness admitted and charged one unit. Source inspection also confirms activation and invoice time are sampled after the lock; explicit virtual test dates are preserved.

No remaining supported blocker was found in the reviewed correction. This verdict accepts the disclosed local foundation scope, not the entire A01-A20 acceptance matrix or production readiness.

## Independently executed delta

Fresh run `hddpaylab-44125d0f4d11-fe33454e`: `node tools/runtime.mjs start`, own `node .local/reviewer/delta-launch.mjs`, own `node .local/reviewer/delta-launch.mjs clock`, then `node tools/runtime.mjs stop`. Original debt/clock witnesses were copied into reviewer scratch; original evidence was not overwritten. The new run repeated the independent SMTP/HTTP identities, payment/event immutability and eight-delivery dedup, account ownership, two-key last-unit HTTP race, reset/session/replay and compiled production refusal probes; all passed. Added cross-period debt/own-payment checks passed. Actual runner inspection recorded 0.625 CPU / 640 MiB, no privilege and only the owned isolated network. With core services, configured runtime cap was 2 CPU / 2 GiB; host build/control overhead was not peak-measured. Exact owned containers/networks were removed; private volume/config retained locally. No main/legacy or external provider resource was accessed.

Created a Git ZIP of the exact reviewed commit, extracted it into one new source-only temporary directory, ran that extraction's `node tools/setup.mjs` and `node tools/preflight.mjs`. Manifest verification and fresh repository initialization passed, setup reported `IMPLEMENTED_RUNTIME_NOT_STARTED`, and preflight observed Node `24.21.0`. No runtime or dependency install was attempted from this extraction, and no temporary-directory cleanup was attempted. ZIP SHA-256: `af6b4d909730e73c0681eedc238f653b385a44d930ceabdc66f72b31e3a6e6d6`. Evidence: `delta/archive-initialization.json`.

Frozen HEAD and clean Git status were verified before and after review. Other measured delta evidence is under `delta/{witness,clock,isolation,runner}.json` and corresponding witness logs.

## Read and reused, not independently rerun

Inspected the complete correction diff in `src/access.ts`, `src/billing.ts`, `src/schema.sql`, `tests/integration.mjs`, `tools/source-manifest.mjs`, `tools/lab.mjs`, report/integration documentation and initial-review preservation. Read the current archive/setup implementation and `.gitattributes`: the manifest now hashes normalized Git blobs through byte-preserving `gitBytes`, matching archived content. The metadata-only final setup change was included in the independently initialized archive.

Read `evidence/correction/{tests,controls,recovery,archive-initialization}.json` and regression implementations. Builder reported 18 passing integration groups, including actual 350 ms activation/expiry lock crossings, Chromium journey, SQL crash recovery and missed callback reconciliation, plus repeated backup/restore, SMTP outage/retry and controls. These broader runs were not repeated wholesale by the reviewer. Correction-run builder performance was p50 6.58 ms / p95 9.26 ms over 100 admitted requests, concurrency 1, nine instrumented SQL statements; no independent benchmark claim.

## Unchanged limitations

The original report's remaining acceptance work stays open: exhaustive auth enumeration/timing and reset expiry/concurrency; UTC rollover/burst; reminder races; full mixed-mode race and card calendar/failure matrix; independent browser ownership/session matrix; full browser journey against the restored DB; cold-start/desktop-transport performance. Initial broad source/evidence review and screenshots are documented separately in `review-initial.md`.

PLS/card and provider records are internal simulations. No real payment, wallet debit, vendor signature/finality, settlement, merchant eligibility, refunds, production auth operations, deployment or commercial offer is qualified. Subsequent documentation/manifest-only delivery commits must retain the reviewed application and tooling bytes and identify this reviewed commit separately from the final archive commit.
