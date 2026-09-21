# Address mockup capability assessment

Assessed against source `3d99a58`, using the owner's new 1536x1024 annotated
Address Lookup desktop/mobile mockup. This replaces the earlier Address target;
see [reference status](ui-reference/README.md). No application changes or live
requests were made for this assessment. The owner requested missing capabilities
be reported before proceeding if the full mockup is not supported.

## Available with frontend work

- Reference composition, compact mobile rows, expandable address information,
  stake-detail links, copy address, and an explorer link.
- Address/stake search already works. Optional leading `#` support, a clear
  control, and session-only recent searches require UI implementation. No server
  search log or persistent visitor/address association is needed.
- Liquid balance and contract stake count at a pinned recent observation;
  indexed accounted principal and dated liquid/staker ranks.
- Current stake principal, shares, lock day, maturity day, good-accounting flag,
  and paging. Remaining days can be derived at the labeled observation day.
- An indexed two-part liquid/accounted-principal donut and exact combined
  principal amount can use the same indexed cutoff. This excludes good-accounted
  principal and accrued payouts, so it must not be labeled complete holdings.
- USD estimates can reuse an eligible existing HEX price, with independent price
  freshness and unavailable handling. They are not historical address valuations.

## Requires additional backend/API work

- The mockup's complete three-part donut and total locked HEX: the address summary
  does not expose aggregate good-accounted principal. The retained stake projection
  could supply an indexed aggregate; summing one live page is not a complete total.
- Whole-address state counts and filtered Current/Ended/Good-accounted tabs:
  lifecycle rows exist, but the API has no status filter or aggregate counts.
  Client filtering of one page would silently omit records from other pages.
- First stake day and latest stake activity: retained lifecycle data can support
  bounded summary queries, but these facts are not in the address response.
- Stake lifecycle activity can be built from retained events, but a paginated
  address activity endpoint, appropriate ordering/indexing and transaction links
  are not currently exposed by the API.

## Requires data coverage or a product definition beyond the present API

- 30D/90D/1Y/All address balance history and 24-hour balance changes: historical
  address snapshots are not retained. Global daily history cannot substitute.
- A complete transfer/claim activity feed and true last wallet activity: transfer
  retention is a bounded recent replay window, not a permanent wallet ledger.
  A full-history feed needs an explicit coverage/acquisition/retention design.
- Claimed Stakes is not a separate current lifecycle state. Define whether this
  means ended stakes with proceeds returned or historical claim-created stakes;
  neither can be treated as a third disjoint bucket without that definition.
- Camera scanning is feasible frontend work, but absent today; it needs QR
  decoding, camera permission, secure-context support and a manual-input fallback.

## Corrections needed in the illustrative data

The Active Stakes tile says41 but its subtext says12 active,18 ended,11 claimed;
the information card says53 total(41 active). These are not coherent totals.
Live liquid balance cannot be added to older indexed stake principal and presented
as one current total. Total Value(HEX) must distinguish principal holdings from
accrued payouts; HEX rank currently means liquid rank, not combined wealth rank.
Good-accounted principal is still locked until end; it is neither liquid nor part
of the existing accounted-principal field.

## Evidence inspected

- `src/contracts/api.ts`: IndexedAddressSchema, AddressResultSchema, LiveStakePageSchema.
- `src/contracts/reads.ts`: StakesQuery, StakeSchema, StakesResponseSchema.
- `src/services/live/baseline.ts`: actual address summary query.
- `src/services/queries/lists.ts`: indexed lifecycle and pagination queries.
- `src/web/Search.tsx`, `src/web/components.tsx`: current UI and search behavior.
- `docs/data.md`: lifecycle sets and seven-day recent transfer retention.
- `docs/interfaces.md`: endpoint inventory and address privacy/accuracy boundaries.

This is a read-only capability assessment, not an implementation or visual PASS.
No browser screenshots were regenerated because no page changed. No external
provider, v1 application, production resource, push or deployment was used.
