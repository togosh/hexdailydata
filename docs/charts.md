# Task07 Charts follow-through

The owner’s September21 frozen packet supersedes illustrative chart labels in the
older Chart02 reference. `/charts` is the thirteen-card dashboard: Featured (Price,
Payout), Staking (Rate, Total T-Shares, Staked HEX + %, Average Stake Length, Current
Stakers, Upcoming Maturities), Supply (Circulating vs Staked, USD T-Share Cost),
Activity (New vs Ended, Penalties), Adoption (Current Holders). Categories are All,
Price, Staking, Supply, Activity, Adoption. Desktop Featured cards are larger; mobile
uses one card per row. Existing shared navigation, footer and Address work remain.

Historical presets default to ALL retained records. Presets are anchored to the latest
available source-record/completed date, not today’s device date. No line combines HDS
and native data. Complete native coverage of the selected interval is preferred;
otherwise a useful HDS series is selected. Native-only incomplete coverage is labeled
partial. Missing fields/dates stay gaps; headline is the last supported point with its
actual date. Source-reported counts/penalties/share totals keep their HDS meaning.

| Chart | Archive only | Native only | Both, complete native interval |
|---|---|---|---|
| HEX Price | HDS reference | Unavailable | HDS reference |
| Payout per T-Share | HDS reported | Native materialized completed days | Native; HDS fallback for incomplete native range |
| T-Share Rate | HDS HEX/T-Share | Native completed-day raw rate conversion | Native; HDS fallback |
| Total T-Shares | HDS reported | Unavailable | HDS reported |
| Staked HEX + % Staked | HDS reported | Native locked principal including GA, existing percentage | Native; HDS fallback |
| Average Stake Length | HDS reported years/365 | Native accounted-principal weighted original days /365 | Native; HDS fallback |
| Current Stakers | HDS currentStakerCount | Native accounted-staker addresses, excludes GA-only | Native; HDS fallback |
| Upcoming Maturities | Unavailable | Indexed future unsettled stakes | Indexed future unsettled stakes |
| Circulating HEX vs Staked HEX | Both HDS series | Both native completed-day series | Native; HDS fallback |
| T-Share Cost USD | Exact same-record admitted HDS price × HDS rate | Unavailable | Same HDS derivation |
| New vs Ended Stakes | Unavailable | Native daily starts/ends | Native daily starts/ends |
| Daily Penalties | HDS reported | Native capped event penalties | Native; HDS fallback |
| Current HEX Holders | HDS currentHolders | Native positive-liquid addresses | Native; HDS fallback |

“Supported” above is conditional on each field being available. No sources means all
thirteen cards are unavailable. A missing price/rate makes derived cost unavailable on
that record. Historical-only data never becomes a live price or current-day payout.
No APY, forecasts, liquidity, correlation, market cap, 24h extrema/change badges or
post-fork eHEX were added. Total reported HEX is not renamed ERC20 totalSupply.

## Narrow reads

Three additive, read-only, PulseChain-only routes accept only the `chain` query:

- `/api/v2/charts/archive`: one archive metadata read and one bounded multi-field row
  scan in a repeatable-read transaction. Up to10,000 retained rows; revision and original
  import metadata accompany `{day,date,values}` rows. `day` is HDS sourceDay; date is
  sourceRecordDateUtc. Fixed `values` order: price, payoutPerTshareHEX, tshareRateHEX,
  totalTshares, stakedHEX, stakedHEXPercent, averageStakeLength, currentStakerCount,
  circulatingHEX, penaltiesHEX, currentHolders. Null stays null; published exponent
  tokens retain their significant digits. Full per-field statuses remain in `/daily`.
- `/api/v2/charts/native`: cutoff plus latest10,000 closed native daily rows and an
  explicit older-history `truncated` flag. Excludes current and future protocol days.
  Row day is contractDay, date is UTC protocol date, originChainId identifies inherited
  history. Values order: payout, rate, locked, percent, weighted original duration in
  days, stakers, circulating, holders, starts, ends, penalties. Amounts are decimal
  strings; pending payouts are null. Daily source-block details remain in `/daily`.
- `/api/v2/charts/maturities`: cutoff plus at most5,556 daily aggregates of unsettled
  stakes with `locked_day+staked_days > cutoff.contractDay`, using the existing maturity
  index and the same inclusion as the accepted export. Includes queued stakes; excludes
  GA/ended/cancelled and already mature open stakes. Raw hearts/shares/counts are strings.
  The client sums exact integers into at most60 equal day-width bins. Empty indexed
  schedule is a known zero; absent native index is unavailable. Ranges are90D/1Y/3Y/ALL.

All routes use existing API read authority, timeouts, admission limits,2MiB response
ceiling, runtime Zod validation and ETag revalidation. There is no storage, migration,
provider, background job or CSV change. Native `/daily` adds `activity` with exact
newStakes, endedStakes and penaltiesHex from existing accepted daily accumulators.

`/charts/detail` retains source/metric/custom dates/refresh/provenance and paginated
exact records. Dashboard range/metric links preselect it. Exact ALL history uses bounded
366-date reads; HDS pages retain their existing revision checks and native windows must
share the same cutoff or fail for restart. Custom range edits keep the existing366-date
limit. `/charts/maturities` provides source/unit/custom dates/refresh and exact scheduled
records. Lower dashboard sections mount on approach; native maturities load at that time.
One archive and one native-history request serve all historical cards, independent of
live price. The latest supported value is always labeled with its source date.

## Offline witness

`npm run build` then `npm run test:charts` creates a fresh run-named private SQL project,
uses ordinary synthetic archive/daily/maturity fixtures, drives the compiled application
in Chrome, captures affected pages only, and removes only owned containers/volumes.
It uses no HDS download or provider. Evidence is ignored under `artifacts/task-07/`.
The fixture has1,227 HDS records,1,228 native daily records and120 stake rows, with date,
price and metric gaps. It is a read/UI witness, not full-chain reconstruction or Task09
scale proof.11 fresh-context cold-mobile samples use the existing150ms/10Mbps/1.5Mbps,
4x CPU profile. Owner visual approval remains separate from implementation review.
