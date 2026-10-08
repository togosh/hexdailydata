# Historical bootstrap methods and decisions

This is internal staging from reviewed historical observations, not a second public product. Original raw bodies stay byte-identical in the parity archive (SHA256 e7caf57981503f3321c4d9ef91d1144b276ad397a182b24b12e5bac5c4f3edde). HDS / togosh receives source credit; captured producer source is revision066d848c91a079af38f17b8e45693bf5d2f7aa2e under MIT. The producer revision used for each historical observation is not established. Commercial/public data redistribution authority remains unresolved once at dataset level.

## Dates and simple values

`day` is original currentDay, and `recordedAtUtc` is original date. Both remain independent of market bucket and daily close. No universal day shift, positional join, missing-day fill or pre-fork performance splice occurs. Day0 is absent; days1/2 retain null statistics. A conflicting duplicate timestamp rejects the whole normalized day; conflicting field tokens reject that field independently. Identical approved projections collapse. Equal numeric values with differing source token spellings are conservatively conflicts rather than arbitrary token winners. Missing and null are ordinary nulls in output; original distinctions remain in the immutable body. Signed changes may equal-1 legitimately; unsigned negative metrics and fractional counts are refused.

## Statistics

FIELD_MAPPING defines all27 exact input/target names and units.23 have available observations/calculations;4 remain null: dailyPayoutHEX, payoutPerTshareHEX, estimatedPenaltiesHEX and simpleAnnualizedPayoutRatePercent. The last two accurately name the captured formulas but depend on the unresolved payout period.

The captured payout helper selects the latest timestamp-ordered dailyDataUpdate with endDay<=currentDay, without returning beginDay into the daily record. totalTshares is the reported latest eligible update's shares/10^12, not a closing-state denominator. It stays a historical observation with this definition. Payout is source payout/10^8; its historical decimal may have producer float rounding. The already-qualified paired ledger at block27,720,851 remains preferred and untouched. Comparing candidate0/-1/-2 offsets is diagnostic arithmetic, not interval verification or permission to join. All2,498 ledger entries stay in their separate accepted dataset.

totalHEX is recomputed exactly as circulatingHEX+stakedHEX at the same observation. stakedHEXPercent is the exact fraction times100, half-up to2decimal places. Percent change uses differences of these2decimal observations; netTotalSupplyChangeHEX is exact total change only across consecutive valid source days. There is no subtraction over missing days. Recomputed differences from original published tokens are sparse exceptions; this does not repair originals. Existing native/API names remain unchanged.

holderIndexMaximum is the maximum numeralIndex proxy and its change is not new holders. currentHolders is the source's distinct positive-balance-address set, not people or canonical balance truth. Unended/unaccounted stake-owner counts do not assert earning/active stakes. averageStakeLengthYears uses principal-weighted original duration/365, not remaining duration. Source predecessor changes are retained as reported signed observations, not reinterpreted as events.

METHOD_CHECKS.json records exact Decimal arithmetic for early, normal, both duplicate groups and late observations, including discrepancies. These checks verify units/formulas against saved inputs, not historical on-chain correctness. Original producer Number/parseInt/toFixed precision is not retroactively recovered.

## Prices

PulseChain reference USD prices retain the accepted guard: positive, non-skeleton, credible date, no copied UV equality, conflicting duplicate refusal, day1734/1735/1768 exclusions and conservative2023-05-14 boundary. First admitted record is May17,2023; that is neither first trade nor fork/close proof.

Ethereum-origin V2/V3 prices are separate reference series ending December31,2022. This is a deliberately early selection cap away from the unresolved2023 boundary, not a claimed fork date. The captured helpers return tokenDayDatas.priceUSD; their nominal query window is [2019-12-03+day-1 midnight,2019-12-03+day midnight), with producer8decimal rounding. The saved record timestamp is retained; neither the row timestamp nor the helper convention proves the actual historical market bucket/close. V2's helper and caller exist, but this captured top-level revision instead assigns UV2=UV3. Equality is rejected; inequality does not prove independent production. Admitted historical observations remain source-reported reference quotes with that shared limitation, not independently verified exchange prices.

UV1 has154 positive early originals starting December17,2019. A saved helper requests exchange0x05cde89ccfa0ada8c88d5a23caaa79ef129e7883 tokenPriceUSD at earliest timestamp_gt a supplied argument, but the daily caller/time binding is missing. No AA mechanism or cutover is guessed. The early composite already has day1 values before its named components; later weighting includes questionable liquidity. Both are retained-only. The omitted2023 Ethereum-origin interval and earliest price periods remain requirements, not removed features. No post-fork eHEX series, returns, ATH/ROI or combined Ethereum/PulseChain performance is created.

BTC/ETH quote currencies remain unproved.0.1 liquidity placeholders and unknown-pool reserves do not become official liquidity, and gas has no observations. None populates Home/current panels. Future rights, origin/fork history, current feeds and ordinary daily-API activation remain explicit work.
