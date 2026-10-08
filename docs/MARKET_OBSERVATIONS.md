# Bounded market observations

The normal Daily, Live and Home responses share one selected immutable generation. Public requests never call a provider. A finite external collector can produce a reviewed local `MarketUpdateSchema` input; `scripts/product-daily.mjs extend --profile <public-profile> --update <file>` builds an unselected generation. The existing explicit `select` command validates and publishes it. No scheduler or production activation is included.

The daily generation remains five small files. Optional internal `observations` and `liquidityHistory` arrays in metadata retain the market input history, bounded to 4,096 entries each. This is sufficient for the present proof and rejects overflow instead of discarding observations. A later update merges exact observations, rejects same-time conflicts and older replacements, and derives the latest group readings. Missing new groups keep their previous values and original timestamps. An identical update produces identical bytes.

Tracked liquidity identifies at most twelve physical HEX pools by address and PulseX version. Its set ID is derived from the sorted address/version list, and its exact aggregate must equal the sum of the same two-sided USD measure for those pools. This is a bounded contemporary cohort, not all HEX liquidity. RPC checks sample a bounded subset; source USD inputs are shared and are not independent oracle or stablecoin-backing verification.

One retained liquidity series has one fixed cohort. The reader rejects changed pool sets and mixed legacy single-pool/tracked-set histories. Historical buckets must precede an observation of their matching tracked set; a newer unrelated price or gas observation cannot qualify their dates.

Daily liquidity buckets retain the original UTC date. Their exact update times are unknown, so `liquidityRecordedAtUtc` is null; no synthetic midnight close is inserted. A directly observed current reading has its corroborated block timestamp. Missing or unqualified historical constituents leave the aggregate null. The same scalar rows supply Daily, CSV and the gap-aware Home chart.

Current HEX marginal spot is only a Live value. It never replaces existing historical HEX reference quotes. Publication additionally preserves all accepted non-market daily values, including ledger totals, snapshot statistics and original timestamps. Holder/stake dataset identities remain paired and unchanged; their freshness does not follow the market group.

Live market freshness remains 300 seconds from the actual observation, not import time. Old saved observations become stale naturally. The current feed proof does not establish all-pool history, verified daily closes, finality, reorg/deletion safety, continuing availability, independent USD valuation or commercial redistribution rights. The task's saved source/evidence return records actual qualified capabilities separately.

The previous single-pool typed input remains readable for compatibility. New tracked sets use their own bounded internal input variant, with a compact `trackedSet` summary on Live and ordinary precise scalar values. No visitor provider, source, era or generation selector is added. Existing authentication, metering, HEAD/304 behavior and protected complete CSV remain in front of the same handlers.
