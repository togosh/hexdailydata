# Internal history field mapping

day is original currentDay; recordedAtUtc is original date. No shifting; no verified closing state. Nominal2019-12-03+day used only for consistency guards. Duplicate date conflicts reject the entire normalized day; field conflicts reject only that field.

No new public API or selector. Each metric is a precise numeric string or null.

| Input | Internal field | Unit | Decision and meaning |
|---|---|---|---|
| circulatingHEX | circulatingHEX | HEX | observation: Circulating amount reported by historical globalInfo. |
| stakedHEX | stakedHEX | HEX | observation: Locked principal reported by globalInfo, including good-accounted subset. |
| stakedHEXGA | stakedHEXGA | HEX | observation: Good-accounted locked-principal subset. |
| totalHEX | totalHEX | HEX | derived: Circulating plus locked total; not ERC20 totalSupply. |
| tshareRateHEX | tshareRateHEX | HEX/T-share | observation: Reported share-rate conversion; not raw shareRate. |
| totalTshares | totalTshares | T-share | observation: Shares from latest eligible source update; not a daily ledger denominator. |
| dailyPayoutHEX | dailyPayoutHEX | HEX | held: Reserved for a period-qualified payout. Unaligned historical source update remains in raw input. |
| payoutPerTshareHEX | payoutPerTshareHEX | HEX/T-share | held: Reserved for period-qualified payout ratio; immutable paired ledger remains preferred. |
| penaltiesHEX | estimatedPenaltiesHEX | HEX | held: Source estimate 2*(dailyPayoutHEX-(circulatingHEX+stakedHEX)*10000/100448995); not event penalties. Held because payout interval unaligned. |
| averageStakeLength | averageStakeLengthYears | 365-day years | observation: Principal-weighted original duration in source no-end/no-GA stake set; not remaining length. |
| stakedHEXPercent | stakedHEXPercent | percent | derived: Locked/(circulating+locked)*100; exact rational rounded half-up to 2 decimal places. |
| currentHolders | currentHolders | addresses | observation: Reported distinct source addresses with positive token balance, not people or canonical balance proof. |
| numberOfHolders | holderIndexMaximum | source index | observation: Maximum numeralIndex proxy; never a measured holder population. |
| currentStakerCount | unendedUnaccountedStakerAddresses | addresses | observation: Distinct source addresses with no linked end and no linked Good Accounting; not active/earning-staker proof. |
| totalStakerCount | historicalStakerAddresses | addresses | observation: Reported distinct stake-owner addresses over source starts. |
| circulatingSupplyChange | circulatingSupplyChange | HEX | observation: Signed reported difference from source-selected predecessor; no missing zero filled. |
| stakedSupplyChange | stakedSupplyChange | HEX | observation: Signed reported difference from source-selected predecessor; no missing zero filled. |
| stakedHEXGAChange | stakedHEXGAChange | HEX | observation: Signed reported difference from source-selected predecessor; no missing zero filled. |
| totalTsharesChange | totalTsharesChange | T-share | observation: Signed reported difference from source-selected predecessor; no missing zero filled. |
| currentHoldersChange | currentHoldersChange | addresses | observation: Signed reported difference from source-selected predecessor; no missing zero filled. |
| numberOfHoldersChange | holderIndexMaximumChange | source index | observation: Signed reported difference from source-selected predecessor; no missing zero filled. |
| currentStakerCountChange | unendedUnaccountedStakerAddressesChange | addresses | observation: Signed reported difference from source-selected predecessor; no missing zero filled. |
| totalStakerCountChange | historicalStakerAddressesChange | addresses | observation: Signed reported difference from source-selected predecessor; no missing zero filled. |
| tshareRateIncrease | tshareRateChangeHEX | HEX/T-share | observation: Signed reported difference from source-selected predecessor; no missing zero filled. |
| stakedHEXPercentChange | stakedHEXPercentChange | percentage points | derived: Difference of locally derived percentages across consecutive valid source days. |
| dailyMintedInflationTotal | netTotalSupplyChangeHEX | HEX | derived: Signed net circulating-plus-locked change across consecutive valid source days; not gross minting. |
| actualAPYRate | simpleAnnualizedPayoutRatePercent | percent/year | held: Source dailyPayoutHEX/stakedHEX*365.25*100 rounded2; not compounded or realized APY. Held because payout interval unaligned. |

## Price series

### pricePulseX → pulsechain-hex-reference-usd
reference; USD/HEX. Captured getPulseXPrice(HEX,day): tokenDayDatas.priceUSD, exact source-day-derived date, rounded8 by producer. Historical reference, not close/spot.
Existing conservative PulseX guards; days1734/1735/1768 excluded; numeric positive, nonskeleton, no copied UV equality, no date conflict/future day.
Exact market close, first trade and fork time unknown; no ROI/ATH/return splice.

### priceUV2 → ethereum-origin-v2-reference-usd
reference; USD/HEX. Saved getUniswapV2HEXDailyPrice/get_priceUV2 support reported tokenDayDatas.priceUSD; source helper nominal-day window [day-1 midnight,day midnight), rounded8.
Positive nonskeleton; reject equality with positive UV3 because captured later top-level caller copies UV3. End2022 is a deliberately early selection boundary, not a fork date.
Historic producer revision/token configuration not independently proved. The captured top-level V2 call is commented out; unequal values are not independent verification. May2023 fork-adjacent interval is not admitted.

### priceUV3 → ethereum-origin-v3-reference-usd
reference; USD/HEX. Saved getUniswapV3HEXDailyPrice/get_priceUV3: tokenDayDatas.priceUSD, nominal-day window [day-1 midnight,day midnight), rounded8.
Positive nonskeleton; duplicate agreement; no future date; end2022 intentionally stays outside unresolved2023 fork boundary.
Not verified close; source time and query window differ. Historical producer version unproved. No post-fork Ethereum product.

### priceUV1 → ethereum-origin-v1-reference-usd
held; USD/HEX. Saved V1 helper requests tokenPriceUSD of exchange0x05cde89ccfa0ada8c88d5a23caaa79ef129e7883 at earliest timestamp_gt argument.

Caller linking priceUV1 and its timestamp argument is absent. USD/helper mechanism alone does not bind the saved early row timing; retain154 positive originals without guessed AA/cutover.

### priceUV2UV3 → ethereum-origin-composite-reference-usd
held; USD/HEX. Later source composite weights V2/V3 with selected USDC liquidity or falls back V3.

Day1 positive quote predates captured component series; earliest mechanism/AA mapping unknown; V2 liquidity later0.1 placeholders. No early composite admission.

### priceBTC → bitcoin-benchmark-usd
held; USD/BTC (unqualified). Captured timed CoinGecko caller; called implementation/currency argument not saved.

Cannot infer USD or quote period; zeros unavailable.

### priceETH → ethereum-benchmark-usd
held; USD/ETH (unqualified). Captured timed CoinGecko caller; called implementation/currency argument not saved.

Cannot infer USD or quote period; zeros unavailable.

## Shared limits

Historical observations: HEXDailyStats / togosh. Producer source revision066d848c91a079af38f17b8e45693bf5d2f7aa2e, code MIT. Feed redistribution authority unresolved; internal staging only.

No day0 in HDS; day1/2 skeletons remain null.
No per-cell provenance wrappers; raw originals retained by immutable archive.
Daily ledger preferred but no unproved period alignment; ledger untouched.
No current prices, OHLC/returns, liquidity valuation, BTC/ETH USD or gas admitted.
2023 Ethereum-origin prices retained-only until boundary/provenance selection can be supported; no new on-chain replay prerequisite.
