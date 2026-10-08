# Unified daily and latest model

The candidate uses one small immutable file-backed product generation. Existing indexed holder/stake readers stay in place. SQL adds no benefit for approximately 2,500 daily rows and a few typed current readings, so no database fixture or migration is needed. This is a deliberate backing choice, not a claimed SQL qualification.

Each generation contains a fixed-schema daily table, typed latest readings inside collection metadata, one manifest/import receipt and sparse projection exceptions. A validated local pointer selects the complete generation atomically. Files stay outside web roots; admission checks hashes/schema/order once. Reads capture one admitted generation and use a date index, not a full data scan. One descriptor binds the coordinated holder/stake pair. A publication refuses mixed inputs, stale replacements and corrupt/incomplete files; explicit local rollback only selects an already admitted generation. No page visit performs acquisition.

Daily rows use UTC `dateUtc` and zero-based `contractDay` derived with the existing HEX epoch. Snapshot columns select the latest original `recordedAtUtc` on that date. Exact-timestamp conflicting fields become null; original legacy day is private projection evidence. `snapshotRecordedAtUtc` is a recorded observation time, not a verified close or measurement time. Empty calendar dates do not inherit observations. Changes are recalculated only between consecutive dates with both same-meaning values available.

Daily payout totals use the immutable ledger's own contract day/date. `payoutHearts`, `payoutStakeShares`, `dailyPayoutHEX` and `payoutPerTshareHEX` preserve its exact integer/rational calculation and documented 18-place half-up display; zero shares yield null rate. `totalTshares` remains a separate snapshot reading. Penalty/yield estimates that need simultaneous inputs remain null. Structural date rows may contain ledger values with null snapshots; this does not recover missing observations.

One `hexPriceUsd` is chosen on each admitted observation date: valid early V3 before V2 fallback, or admitted PulseChain price in its separate domain. Exact-timestamp conflicts do not select a winner. The value remains the original quote token and `priceRecordedAtUtc` its record time. `priceEra` marks Ethereum-origin versus PulseChain; metadata explains the conservative 2022 cap and unqualified 2023 gap. These are reference prices, never live quotes/closing prices or a joined return/ATH calculation. No excluded PulseChain quote is recovered from an alternative series.

The normal API exposes `/daily` (366-day range, at most 100 rows/page), `/live`, and bounded `/home` and `/markets/daily` projections of the same service. CSV uses the same selected rows and units behind existing complete-export authorization. Old source/view/series/generation/version selectors receive a migration error. Cursors bind the admitted product identity, route, semantic filters and access context; visitors cannot choose a version. Existing saved Search/address/stake detail is selected internally with its exact paired generation, original records and qualification disclosure.

Live has flat typed values and compact freshness groups. Saved holder/stake metadata uses both actual base/target times and remains `accepted_base_plus_observed_updates`, not a complete target census. Historical daily snapshots appear only as latest Daily context; they do not become live spot prices or current global values. Unqualified HEX/BTC/ETH/PLS USD, gas and liquidity readings remain null. `servedAt` is separate from observation times; stale group values never become fresh from republishing. Freshness thresholds are documented and tested per group.

The implemented future-input union supports market readings (asset, USD quote, spot observation time), chain gas (wei per gas and chain identity), and pool liquidity (chain/address/DEX/version with USD valuation). Unknown units/asset/quote/kind are refused. Two or three synthetic inputs test the boundary; no speculative provider adapter or actual feed qualification is implemented. Adding a field increments the product schema/method revision and extends this same projection, without copying the large base stores or introducing a public provider selector.

Publication is one-shot and local, not a scheduler. File fsync and atomic same-directory rename support interruption tests; Windows power-loss/directory durability and production deployment remain unqualified. Real account/payment/SQL operations, rights for public redistribution, earliest/fork history and ongoing feeds remain separate requirements.

The protocol/global extension is currently a nullable live share-rate/current-payout boundary, not an implemented feed. A later qualified observation will add a typed protocol variant with its exact units and observation time. The implemented synthetic examples cover BTC/USD spot, PulseChain gas and one pool valuation. HEX spot is live-only; it never populates the historical `hexPriceUsd` reference column. Daily BTC/ETH/PLS observations retain separate timestamps. Gas components share their gas observation time; a liquidity value retains pool identity in collection metadata/live output.

Current freshness thresholds are: saved pair 3,600 seconds, evaluated conservatively from the base while exposing both times; historical ledger observation 86,400 seconds; protocol/market/liquidity 300 seconds; gas 60 seconds. Freshness changes with the serving clock, without changing observation times. Daily history itself has no stale label. A served timestamp is never imported as an observation.

The selected table spans 2019-12-03 through 2026-10-07, 2,501 reporting dates. There are 2,500 dated source observations (including two launch skeletons), 2,498 ledger periods and 2,194 non-null reference prices. Structural dates and skeletons are not recovered statistics. Primary prices comprise 600 early V3 selections, 357 eligible early V2 selections and 1,237 PulseChain selections. Full per-field coverage and gaps are in FIELD_MAPPING.csv and metadata.json. The first price is 2020-05-19; 2023-01-01 through 2023-05-16 remains unqualified. Additional retained isolated price gaps are 2024-09-01, 2024-10-04 and 2025-06-07.

Normal daily requests return fixed full rows; optional metric/asset arguments bind display/selection context and cursor/ETag identity, rather than dropping other row fields. A maximum 366-day inclusive range and 100-row page applies. Out-of-domain ranges return only their intersection, or an empty collection; no extra rows are fabricated. Holder/stake global browsing retains the 50-row/five-page public bound. Only the global stake route accepts an address filter; address path routes reject conflicting query address fields.

`build` writes a validated immutable generation without selecting it. `select` publishes it with a guarded task-owned CURRENT.json; an in-process store holds one snapshot per request. An already running process is not silently reloaded by another process's CLI: restart/admit through the same maintained composition after local publication. There is no watcher or scheduler. Known validation refusals release their owned selection lock; interruption after a publication write begins retains its lock and the previous readable generation. Such uncertainty requires investigation, never automatic marker deletion. Rollback selects a previously admitted generation. Concurrent load/select is refused across asynchronous reads. CSV export returns defensive copies of immutable admitted bytes.

# Candidate contract migration

This feature branch intentionally changes the normal v2 candidate contract. Main/deployed behavior is unchanged. `daily-product-1` is the shared daily/latest schema revision.

| Path | Candidate behavior |
|---|---|
| /api/v2/daily | Selected UTC reporting rows; ordinary from/to; bounded cursor |
| /api/v2/live | Latest qualified groups with original ages; currently stale saved state and unavailable live feeds |
| /api/v2/home | Last Daily row and the same latest snapshot |
| /api/v2/markets/daily | Alias projection of the same daily rows and methods |
| /api/v2/stakes, /holders, /stakes/:id, /addresses/:address[/stakes] | Internally selected coordinated saved pair; indexed existing readers and original detail |
| /api/v2/downloads | Release-gated complete daily export catalog |
| /api/v2/downloads/:bundle/daily | Actual same-byte exporter behind original account/key entitlement; no anonymous bypass |
| /api/v2/charts/archive, /charts/native | Removed normal variants; 404 |
| /api/v2/stake-events, /calculator/inputs, /charts/maturities, /status | Existing native contracts retained; no fabricated replacement, unavailable native dependencies remain unqualified |
| /health/live, /health/ready | Process liveness / configured admitted product readiness |
| /daily, /charts, /charts/detail | Same daily controls and calculation policy |
| /live, /, /search, /address/:address, /stake/:id | Normal internal selection, no visitor provider/generation picker |

On API paths, legacy source/view/series/generation/datasetVersion/holderDatasetVersion/revision/afterSourceDay parameters receive HTTP 400 `selection_migrated`; there is no fallback to a different meaning. Legacy browser bookmarks clear only those selection parameters and their cursor; the old holder view maps to ordinary record-kind navigation. Only `history-selection` session storage is cleared; unrelated storage is preserved. Internal attribution, exact source detail and generation hashes are evidence, not user-selectable datasets.

Auth/metering is unchanged: invalid/revoked/duplicate supplied keys never become anonymous reads. Success GET/HEAD/304 settles the original hold, failure/cancellation releases it. CSV checks entitlement before opening data even for HEAD/304. Account/payment/SQL behavior was exercised through explicitly synthetic boundaries, not a real account database. Public CSV activation and commercial redistribution remain gated.
