# HDS PulseChain source-reported history

This is an attributed daily archive, not canonical reconstruction or evidence of complete
native history. Mapping `hds-pulsechain-record-date-1` keeps exact published numeric tokens
(including exponent spelling and precision beyond24 decimal places) in text-valued JSON.
The bounded `lossless-json` parser rejects duplicate keys before conversion. Input is at
most16MiB/10,000 rows,128 scalar fields/row, bounded strings/nesting, and16KiB normalized
SQL rows with separately bounded shared metadata. It never evaluates input as code.

## Source and date interpretation

The September19,2026 authorized snapshot has2,484 rows (source days1–2482, two repeated
days),4,829,074 bytes, SHA256
`cb314fca46c2beae121349a3b375c71874bb72b76caf3b32cf98724b9db18520`.
It was obtained with one identity-encoded HTTP200 GET from
<https://hexdailystats.com/fulldatapulsechain>, no redirect/retry. Raw bytes and the receipt
are retained outside Git under ignored task input. An operator must inspect a new file
and select its own digest, provenance, mapping and bounded interval before import.
The receipt and explicit supplied-snapshot provenance are operator trust inputs, not
cryptographic proof of the publisher or the truth of its statistics.

The [daily producer](https://raw.githubusercontent.com/togosh/hexdailystats/main/Handlers/DailyStatHandler.js)
assigns row date from protocol-observation data, while its
[PulseX query](https://raw.githubusercontent.com/togosh/hexdailystats/main/Services/TheGraph.js)
selects a market day independently and rounds through floating arithmetic. These current
sources do not establish every historical producer version. Adjacent actual records have
date = nominal epoch+sourceDay until September1,2024, then date = nominal day−1. Two source
days (1734/1735) even share the same timestamp with differing prices. Do not globally shift
dates to make this look canonical. The API's axis is `sourceRecordDateUtc`; original
`sourceDay`, `sourceDayToken` and `sourceDate` are retained. `marketPeriodUtc` stays null.
The date relationship is labeled same/previous/delayed/unproved; up to two days late is
permitted as a source-record observation, without moving an asserted market period.

Positive `pricePulseX` needs both nominal source date and recorded date on/after the
conservative May14,2023 boundary, an admitted date relationship, a past record date at
acquisition, and credible scalar/row shape. The boundary is a conservative exclusion
policy, not an exact launch/fork/first-trade timestamp. Future/current record dates,
missing/null/zero/negative/sentinel prices, skeletons, equality with a positive UV price,
and operator-selected ambiguous prices remain unavailable. UV values never supply a
fallback. Arbitrary hidden copying cannot be disproved by schema checks; attribution
and the declared provenance limitation remain visible. No interpolation, price predecessor
arithmetic, ATH/ATL/ROI, OHLC or minute upsampling is implemented.

The inspected selection is source days1255–2482 and recorded dates2023-05-11–2026-09-18:
1,227 records and1,218 available reference prices. Day1731's repeated mapped row is identical
and counted once. Both conflicting day1768 records are explicitly excluded. Days1734/1735
retain statistics but exclude their ambiguous prices. The first available reference is
day1261, recorded2023-05-17T00:01:45.000Z, publishedUSD0.01958399. This is the earliest
admitted source-record date, not a proven first market bucket or first-ever trade.
Leading/interior exclusions remain gaps. Pre1255 inherited rows stay in the raw file,
outside this selected overlay; native inherited-history support is unchanged.

## Field definitions and quality

`src/contracts/history.ts` is the allowlist and shared runtime field dictionary. All values
are explicitly source reported. `circulatingHEX`, `stakedHEX`, `stakedHEXGA`, `totalHEX`,
`dailyPayoutHEX` and `penaltiesHEX` have source HEX units, not raw hearts. `totalHEX` is
reported circulating plus locked supply, not automatically ERC20 totalSupply. `stakedHEXGA`
is a subset, not additional locked supply. `totalTshares` is T-shares, not a verified raw
denominator. `tshareRateHEX` and `payoutPerTshareHEX` use HEX/T-share. `averageStakeLength`
keeps the source's weighted original-duration years (365days), without relabeling it days.
`stakedHEXPercent` is a published percentage. Current/historical holder and staker address
counts remain four distinct fields, never inferred stake counts. Four explicitly signed
reported changes are retained; none is a calculated price return.

Each field has `published`, nullable `value`, and `availability`. Statistics can contain a
legitimate zero. Nonnegative metrics treat−1 as a source sentinel and other negatives as
unavailable; signed change−1 remains valid. Fractional counts and percentages above100 are
invalid. Four simultaneous zero core supply/share fields mark a suspicious skeleton:
tokens remain, values are unavailable. A single zero does not invalidate the row. A valid
price does not validate other statistics, and a missing price does not discard useful stats.
No materialization hash/status, exact raw denominator, active canonical set, or live label
is invented. Upstream floating rounding and historical counting methods remain unverified.

Unmapped fields are inventoried but not mirrored into storage: UV prices/liquidity,
priceBTC/ETH, pricePulseX_PLS/PLSX/INC, eHEX liquidity, priceChangePulseX, roiMultiplierFromATL,
market-cap/TVL/APY and other unapproved derived fields. `_id`/`__v` are ignored metadata.
Metric definitions are shared once per response, not repeated raw file payloads.

## Operator publication and recovery

Import is offline and needs explicit digest/source/mapping/range plus a matching newly
isolated destination project/instance. A bounded-download selection also needs its receipt.
An exact repeat returns the existing revision and writes nothing. A different selection
requires `--replace <current revision>`; it replaces the whole declared selection atomically,
including removal of rows outside that selection. Inspect the new range/exclusions first.
There is one compact current revision; obsolete full snapshots are not retained. Cancellation,
SQL failure and stale replacement revisions leave the previous accepted view intact.

API reads use repeatable-read SQL, bounded projections and64-row pages within366 dates.
The response includes whole-range missing record/price dates and a revision-bound continuation.
Native readiness, Home, calculator presets, market samples and five standard bundles are
independent. Local CSV includes each value, original numeric token and availability alongside
source/day/date basis/revision/units. New output files are exclusive; failure is an error and
may retain an incomplete local output for diagnosis. It never replaces an existing file.

Seeds require valid native state and use format4/schema5 with independent archive validation.
Schema5 encrypted backups can restore archive-only or native-plus-archive state into a new
empty target. Native seed import refuses a nonempty archive-only target. Archive rows are not
part of native undo and survive forward sync/rewind. Old seed/backup schema formats are refused;
there is no v1 compatibility translator. Live qualification and Task07/09 remain unperformed.
