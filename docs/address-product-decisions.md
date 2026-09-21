# Address page product decisions

## What a user is trying to answer

The page should let a user answer, quickly:

1. How much liquid HEX does this address currently have?
2. What staking position does it have (principal, T-shares, counts/ranks)?
3. What stakes are open / good-accounted / ended, and when do open stakes mature?
4. How fresh/complete is each value?

The page is a data profile, not a wallet tracker or trading terminal.

## Authoritative information hierarchy

### Primary cards
Prefer four concise cards:
- **Liquid HEX** — live/block-pinned when available.
- **Staked HEX** — complete accepted indexed stake-principal aggregate. If only a
  partial live page is available, do not call that partial sum the whole-address total.
- **T-Shares** — accepted indexed/accounted T-shares with its as-of label.
- **Next Maturity** — accepted indexed next maturity, with day/date where supported.

Stake count belongs in the summary/header and may also appear beside the stakes title.
Ranks belong in Address Summary rather than consuming a primary metric card.

### Address Summary
Show, when supported:
- address + copy
- current/open stake count (with exact definition)
- liquid rank
- staker or T-share rank, using the existing defined rank vocabulary
- first stake day/date
- next maturity
- compact freshness/cutoff label
- explorer link if a stable approved PulseChain explorer URL already exists in source/config

Do not invent an Address CSV action unless an actual address export exists.

### Stake list
Desktop: readable table.
Mobile: compact stake rows/cards; do not force the full desktop table horizontally.

Recommended lifecycle filters/tabs:
- **Open** — queued/active/mature-open as defined by the existing lifecycle model.
- **Good Accounted** — GA-unended records, because they are materially different from
  ordinary open earning stakes.
- **Ended** — settled/cancelled records, with cancelled clearly labelled rather than
  inventing a separate "claimed" category.

Use the repository's existing exact lifecycle definitions. Do not introduce a vague
"claimed stakes" status.

Useful row fields, where already supported:
- Stake ID
- principal HEX
- T-shares
- start day/date
- end/maturity day/date
- days left for open stakes
- lifecycle state

### Stake Activity
If added, call it **Stake Activity** or **Stake Lifecycle Activity**. It may show only
supported lifecycle events such as Start, Good Accounting, End and cancellation.
Do **not** claim complete transfer/claim history from the bounded transfer-retention path.
Each activity view must state its coverage if it is not complete.

### Search ergonomics
Allowed frontend additions:
- recent searches stored locally in the browser
- clear recent searches
- normalize `#12345` to stake ID `12345` where unambiguous
- copy address

QR/camera scanning is **deferred**. Do not add camera permissions in this scope.

## Explicitly do NOT implement from the conceptual mockup

- No address balance-history chart: arbitrary historical address balances are not retained.
- No 24-hour address balance/stake percentage changes or sparklines.
- No complete transfer/claim activity history.
- No post-fork eHEX product or Ethereum HEX data.
- No synthetic whole-address "current total value" formed by mixing live liquid balance
  with indexed stake values at another cutoff.

## Visual overview / donut rule

A composition visualization is optional, not required. It may be shown only if every
component comes from one coherent accepted cutoff/definition. Prefer an indexed staking
composition (for example open principal vs good-accounted principal) over mixing a live
balance with differently-aged stake data.

If a coherent composition is not available, omit the donut rather than fabricating one.

## Freshness / completeness presentation

Do not lead with long technical prose.

Use compact labels such as:
- `LIVE · block 17,992,807`
- `INDEXED · Sep 18`
- `20 / 41 live verified`

Put block/source/collection timestamps and the full partial-page explanation in a
collapsed **Data details** disclosure.

Never convert partial coverage into a complete total.

## Mobile order

1. compact search
2. compact freshness/source line
3. 2×2 primary metric grid
4. Address Summary
5. next-maturity / small maturity summary if useful
6. first 3–5 stake rows/cards + View all
7. optional Stake Activity
8. collapsed Data details

Keep the fixed mobile bottom navigation. Do not add a second large footer/navigation.
At the true end, only a very small utility footer (`Methodology · Data status · API`)
is needed if shared-shell work already provides it.

## Desktop order

1. title + compact search
2. small data-status line
3. four primary metrics
4. main two-column area: stake list (~65%) + Address Summary (~35%)
5. optional maturity summary / Stake Activity below

The page should resemble the supplied mockup in density, spacing, hierarchy, icons and
magenta/orange CTA treatment, while these data decisions override unsupported elements.
