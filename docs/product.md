# Product contract

These decisions come from the owner's v2 answers in this conversation. They override
legacy product assumptions. Technical mechanisms below are design recommendations,
not descriptions of code already built.

## Audience and purpose

A quick daily/current check-in for HEX holders and stakers, plus clean reusable data
for independent analysis. On mobile show useful numbers quickly, not an empty shell
that waits for every chart and export lookup. Public pages are read-only and anonymous.
Use “HEX”, not “pHEX”, in the selected PulseChain context. Show chain identity clearly
without turning the header into a trading terminal.

## Initial release

Home; daily history/charts; current HEX price; current T-share rate; latest completed
payout and current-day payout estimate; ordinary-new-stake calculator; address/stake
lookup with live observations; holder/staker summaries and daily rankings; standard
CSV downloads; a compact methodology/glossary and public freshness/status page.

PulseChain is the actively indexed chain. Required Ethereum-era common native history
is included and labeled: inherited stake timing, shares, accounting and lifecycle remain
intact. Price/market history is PulseChain HEX only, beginning at the earliest supported
post-fork observation, with explicit gaps. There is no planned post-fork eHEX product
and no pre-fork Ethereum price seam. Deep pool inventories, complete per-pool history, generalized
portfolio tracking and every legacy endpoint are outside the initial release.

## Explicit nonrequirements

No arbitrary historical liquid-holder snapshots/rankings; no exact reproduction of
old generated CSV bytes; no support for legacy URL/JSON/CSV formats; no immutable
copy of every published full dataset. No copying the old schema to achieve “parity”.
No login, paid API, custom query sandbox, leagues or email reminders at launch.
ETH/USD and Ethereum/PulseChain gas comparisons are approved directions for separate
work; neither is implemented by the HDS archive. BTC feeds remain outside this task.
Do not add providers, credentials, UI placeholders or extra bootstrap requirements.
This exclusion does not remove required common Ethereum-era HEX history.
No fake demo values in a production response. No wallet/signing/trading functionality.

The HDS PulseChain overlay provides explicitly source-reported daily statistics and
daily reference prices through an opt-in daily API variant and local operator CSV.
Its source-record dates are not proven market-close times. It does not initialize native
state, satisfy native history completeness, make Home/calculator/live inputs ready,
or establish live source feasibility. Task09 and the launch feasibility condition remain open.

## Freshness is per component

| Component | Normal target | Meaning |
|---|---|---|
| Price | refresh observation every 60s | provisional sourced estimate, not executable trade |
| T-share rate | refresh observation every 60s | current contract raw share rate and HEX/T-share conversion |
| Latest completed payout | check availability every 60s | most recent fully materialized day, not necessarily yesterday |
| Today's payout | recompute every 60s | current-day estimate from a coherent current block; not final |
| Address liquid balance | live on demand; cache no more than 60s | `balanceOf` at a pinned recent block |
| On-chain address stakes | live paginated on demand; cache no more than 60s | `stakeCount`/`stakeLists` at the same pinned block |
| Native index | poll finalized target ~60s | canonical history/current projections can lag head due to finality |
| Global rankings/counts/weighted length | completed-day values acceptable | own day/block label, not mislabeled current |
| Full downloads | refreshed after accepted daily build | exact export block/time in manifest |

Polling cadence is not a freshness guarantee. Use observed block time, provider age,
and collection time separately. Default latest-observation freshness ≤120s, stale up
to 1800s, then unavailable; a stalled chain or old source remains stale even after a
successful poll. Display a subtle source/age label. Do not fabricate changing numbers
to make the site feel active. Live data is provisional; no mempool speculation.

An address page may show “balance now” next to “rank at yesterday's close”. This is
acceptable only when these are different labeled sections. A complete live stake list
must not be implied when just one page has been fetched. Newly created/ended stakes
must not be reported absent merely because the finalized index is behind.

## Mobile content hierarchy

Price first. Compact current T-share rate and today's estimated payout with a clear
“estimate” label. Nearby show latest completed payout with its day, percentage staked,
and HEX-weighted average stake duration. Keep date distinctions readable, not buried.
Keep the supply/staking group high in the mobile order rather than burying it below
secondary activity. One payout history chart; compact participation/activity sections
where useful. Downloads and Calculator are obvious; address search readily accessible.

No giant equal-weight padded cards, heavy gradients/glows, giant debug headers,
mandatory snapshot selector, or tooltip-only definitions. Dark first, readable light
mode if inexpensive. No circular info-icon clutter. A compact Methodology link is
better than paragraphs inside every metric card. Preserve accessibility and contrast.

## UI direction and supplied reference status

The owner asked on September 18 to carry over the separate HEXStakeExplorer UI/mockup
branch. The principles below came from the recovered September 15-16 discussion;
original supplied images are now available at the handoff location documented below.
Availability is not final aesthetic approval or proof of implemented visual fidelity.

- HEXDailyStats-like clarity and scan density: useful compact numbers and grouped
  rows, not giant padded cards or a generic crypto trading dashboard.
- Current HEX price, percentage staked, HEX-weighted average stake length, and payout
  per T-share prominent. Apply the v2 current-rate/estimated-payout freshness contract
  above; do not label estimates as completed or final.
- Supply/staking should move higher on mobile, ahead of a secondary "Today in HEX"
  activity panel when that panel is included. Exact desktop arrangement is not frozen.
- Meaningful percentage changes matter when comparable observations and windows
  exist. Do not invent change arrows, use inconsistent windows, or treat zero/missing
  baselines as ordinary percentage changes. No additional provider scope is authorized.
- One useful payout/T-share chart and obvious Charts, Downloads, Calculator and Address
  Lookup navigation. Definitions/details are available without cluttering every card.

Older recovered calculator direction: compact start-now calculator, no required Start
Date block, duration slider or verbose proposed-start-rate section; use the latest
available share rate with an honest freshness label. Optional future-price scenarios
must remain simulations, not predictions. Later owner-supplied direction can refine it.

The September 18 planner handoff actually contains eight unchanged owner-supplied
PNGs: `HEXDailyData-v2-Planner-Handoff-2026-09-18.zip`, under
`HEXDailyData-v2-Planner-Handoff/ui/`. Task07 carries the five selected originals unchanged in docs/ui-reference/.
Use these five as the planner's proposed primary references; final aesthetic choices
remain Task07, not a new approval requirement for Task01:

| Page | Original filename |
|---|---|
| Home | HEXDailyData_Mockup_Home.png |
| Calculator | HEXDailyData_Mockup_StakeCalculator.png |
| Address | HEXDailyData_Mockup_Address02.png |
| Downloads | HEXDailyData_Mockup_Download02.png |
| Charts | HEXDailyData_Mockup_Chart02.png |

The selected originals are now available in docs/ui-reference/. They are not final
aesthetic approval; actual Task07 captures are recorded separately.

Product/data contracts override illustrative labels: do not add address-history
sparklines, historical holder snapshots, extra CSV/JSON products, arbitrary APY labels,
BTC/ETH asset-price panels or other unsupported fields to imitate an image. These
references do not authorize new providers. Backend work proceeds without a UI sign-off;
Task07 fidelity requires actual relevant originals and real browser captures, or an
explicit owner decision to accept a text-only brief instead.

## Future seams, not future implementation

Paid API: authenticate/rate-limit an existing service boundary; the public site is not
coupled to billing. Leagues: derive from clearly defined current/daily metrics, not
stored as another full database copy. Sandbox: future restricted query layer, never
arbitrary SQL on the production connection. Reminders: separate optional subscriptions,
explicit consent, minimal address/contact association, deletion support. Implement none
of these merely to demonstrate modularity. Calendar-file export is an optional later
privacy-friendly feature, not part of initial scope.

## Owner constraints

Ongoing total infrastructure/provider/backup budget ≤$60/month, ideally ≤$50. No new
purchases are authorized by this starter. Ordinary development and isolated tests are
authorized; task 10 permits bounded configured live read-only validation. The old VPS,
its database, code, credentials and scheduled jobs are never touched by this build.

## Task07 reference use and owner scheduling decision (2026-09-19)

The owner authorized offline UI implementation before source feasibility is measured.
The pre-UI checkpoint is deferred, NOT satisfied. Native acquisition, initialization,
live-source qualification and production proof remain required before launch.
Task08 remains accepted; Task09 may begin only after the returned Task07 result is accepted.

The five owner-supplied original PNGs recovered from the September18 planner handoff
are developer references in docs/ui-reference, not runtime assets. Home, Calculator,
Address02 and Download02 are1448?1086 composite canvases; Chart02 is682?2048.
Actual captures use390?844 and1440?1000 CSS viewports, dark theme, device scale1;
320px and200% layout checks are separate. These are not mockup CSS viewport claims.
Compact native metrics, navy panels and magenta accents retain the supplied hierarchy.
Unsupported APY, address history, sixth downloads and asset/gas panels are omitted.
Owner aesthetic acceptance remains pending independently of implementation review.
