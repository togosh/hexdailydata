# References and code-use ledger

Task03's source-use additions are recorded in [sync and recovery contract](sync.md).

## Evidence versus design

The owner's latest answers define v2 scope (product.md). Architecture, interfaces,
retention limits and task assignments in this kit are proposed v2 design, not a claim
that the old software implements them. Legacy reports inform risks but do not override
new decisions. No old evidence/DB/receipt/generation graph is shipped as a v2 runtime input.

The inspected source-only reference is the canonical `source/` tree supplied in
HDD-Retention-Archive-Readback-Result-v1.0.0.zip, source commit
`e1a9cc417501479358494d4d9312ccaf2429f622`. The exact old result ZIP SHA256 is
`c7c42e2b0618812a859863cd8622d9a15a903bcf26654d00451a63f6d9e36625`.
Its database/module code was NOT executed for the scaffold. No large v1 data is in this
kit. `config/reference-map.json` lists the specific inspected paths and byte hashes;
these are historical reference identifiers, not a new production integrity framework.

Read those files selectively from the sibling repository or `git show KNOWN_COMMIT:path`.
Do not recurse through old credentials, work/data, generated packages or deployment
scripts. Do not run the old test suite “for confidence”. If a newer reference commit
exists, record it; don't reset another coder's branch. If a needed file is absent,
report it and use public protocol documentation rather than inventing a source path.

### What we learned (not copied as requirements)

The previous product validated lifecycle data and did complete a normal native→market
pair. It also copied953,720 unchanged stake rows into one daily materialization, suffered
an initial Home request waterfall, relied on source/ownership-specific deployment
contracts, and needed repair around one-shot invocation result tracking. Its exact
archive preservation retained per-observation provenance and did not initially free
net storage. The new product therefore separates current/live/daily data, does not
require historical holder snapshots or exact old exports, uses short normal transactions,
and treats release/operations as one maintained product path.

Do not preserve a legacy quirk solely because a fixture expected it. Conversely, don't
simplify away protocol rounding, fork provenance, delayed daily ledger updates, pending
stake shares, good accounting, or provider coverage limitations.

## Protocol points inspected locally

- Chain369 HEX contract0x2b591e99afe9f32eaa6214f7b7629768c40eeb39; hearts/HEX10^8,
  shares/T-share10^12, launch epoch1575331200 (2019-12-03T00:00:00Z).
- Known common-state Ethereum boundary17,232,999; runtime SHA256 baseline
  331e6384b4acbab47e393ee5f85290cbdd8783be817b52643441c02bc0164511.
  Live validation must verify applicable chain/block/code, not trust this file alone.
- globalInfo order and dailyData packed widths are public-interface facts; functions
  inspected in packages/core/src. Current-day final payout is not a stored final day.
- The old calculator restricts some historical/claim scenarios. Do not claim those
  scenarios were proved by copying its current ordinary-stake formula.
- Old on-chain price code explicitly distinguishes PEG_ASSUMED quotes and an alternative
  externally anchored profile. Token lists and source capability are dated; qualify
  current addresses/factory/runtime/anchor behavior before production use.

## Primary technical references checked 2026-09-18

These are implementation sources, not authority for the owner's product choices.

1. Node release lifecycle: https://nodejs.org/en/about/previous-releases
   Target Node24LTS; pin a tested patch and image digest in task01.
2. Docker startup/health: https://docs.docker.com/compose/how-tos/startup-order/
   Process start is not dependency readiness; use real health checks.
3. Single-host Compose: https://docs.docker.com/compose/how-tos/production/
4. PostgreSQL17 isolation: https://www.postgresql.org/docs/17/transaction-iso.html
   Multi-statement consistent reads require the appropriate transaction, not assumption.
5. PostgreSQL17 locks: https://www.postgresql.org/docs/17/explicit-locking.html
6. PostgreSQL support lifecycle: https://www.postgresql.org/support/versioning/
   PostgreSQL17 selected as a supported stable target, not a claim it is newest.
7. Ethereum JSON-RPC: https://ethereum.org/developers/docs/apis/json-rpc/
   Explicit block parameters, logs and latest/safe/finalized semantics. PulseChain provider
   support is probed, not inferred from Ethereum's documentation.
8. Vite development/build: https://vite.dev/guide/
9. Codex project guidance: https://developers.openai.com/codex/guides/agents-md/
   Official page may redirect; project AGENTS.md is a small standing instruction.
10. Codex subagents: https://developers.openai.com/codex/subagents/
    Tool availability varies; the tasks also work sequentially.
11. Public HEX entry point: https://hex.com/
    Contract address is public; promotional statements are not our numerical oracle.

Attempts to retrieve the Etherscan code page and Vultr pricing were blocked by this
session's web access. No live verified-contract bytecode or current vendor quote was
retrieved here. Local source includes reference-source notes; task01/10 must establish
independent formula/source validation and actual pricing/availability where needed.
Do not treat an unverified third-party copy of Solidity as deployed-code identity.

## Reused-code ledger (fill during implementation)

For each reused module/function record: source file+commit, behavior retained, how it
was independently tested, relevant notice/license, new location. Interface facts and
mathematical definitions can be implemented clearly without shipping an entire old
runtime. The old repository's contract-reference notice says the explorer declared
license None; do not bundle that full Solidity source as if it had an open-source
redistribution grant. Keep this repository private initially; select a distribution
license only after owner/source-license review. Dependencies keep their notices.

## Task01 source-use ledger (2026-09-19)

Only selected source was read; no sibling modules/tests/scripts were executed or
imported. Sibling HEAD observed by preflight was
`c1a3ae455a6a6a935ef1ed0db7b25e263710ea64`; it was not modified or reset. All legacy
lookups below used reviewed baseline `e1a9cc417501479358494d4d9312ccaf2429f622`.

| Reference read | Retained behavior / new location | Independent check |
|---|---|---|
| `packages/core/src/hex-day.mjs`, `stake-semantics.mjs` | UTC day, launch lock floor, cancellation/auto-stake/GA distinctions; new implementation in `src/domain/day.ts`, `stake.ts` | Public protocol branches and literal timing/settlement vectors |
| `packages/calculator/src/data-inputs/payout.mjs` | Consecutive completed-window mean of exact daily ratios; new `src/domain/payout.ts` | Hand result 13/42 versus 3/10, gaps and zero denominator tests; legacy display rounding was not ported |
| Selected predicates in `apps/indexer/src/gate45/analytics.mjs` and boundary definitions in `semantics.mjs` | Weighted principal includes queued/open/mature-open and excludes GA/ended; explicit v2 sets in `stake.ts` and data.md | Hand-weighted 190/13 vector; contract start/unlock/end branches distinguish locked principal from payout shares; no SQL/orchestration copied |
| `packages/calculator/src/THIRD_PARTY_NOTICES.md` | Retained license caution | Explorer source declares no redistribution license |

The public Etherscan source page was successfully retrieved through HTTPS by
PowerShell on 2026-09-19 after the browser fetch returned 403. Relevant inspected
functions: `_stakeStart`, `stakeGoodAccounting`, `stakeEnd`, `_stakeUnlock`,
`_calcPayoutRewards`, `_stakeStartBonusHearts`, `dailyDataRange`, and historical
claim bounds. The ignored local report records retrieval hashes. Full Solidity and
HTML are excluded from the source ZIP; the explorer declares license None.
These are independently checked source semantics, not a Task10 deployed-bytecode
or fork identity check. All v2 lifecycle/metric code is newly written from these
rules; no old runtime, database model, provider gate or full Solidity source is shipped.
The repository remains private with no new distribution-license grant.

Dependency versions were resolved from the official npm registry and Node distribution
index; Docker digests came from the official Node/PostgreSQL registry manifests.
Node 24 LTS, Fastify 5 support and Vite requirements were checked against the official
[Node lifecycle](https://nodejs.org/en/about/previous-releases),
[Fastify LTS policy](https://fastify.dev/docs/latest/Reference/LTS/) and
[Vite guide](https://vite.dev/guide/). Exact installed versions are in package-lock.json
and the task report. Dependency notices stay with their installed packages; source ZIPs
exclude node_modules. No licensing review or production source qualification is claimed.

Task03 acquisition follow-through uses the existing v2 ABI definitions and synthetic raw
transport fixtures only. No additional v1 files, runtime, credentials or data were read.
Filtered-range corroboration replaces mandatory historical receipts; constructor identity
verification remains. The sparse range/seed contract is documented in sync.md.

## Task04 source-use ledger

Selected tracked files were read with `git show` at the same reference commit
`e1a9cc417501479358494d4d9312ccaf2429f622`: core `stake-list-decode.mjs`,
`global-info.mjs`, `hex-minimal-abi.mjs`, and current-price/onchain `math.mjs`,
`estimate.mjs`, `policy.mjs`. Retained interface facts: seven-word stake layout,
13-word globals, reserve units/orientation, peg assumptions and depth semantics.
New implementations live in providers/live-abi.ts, services/live/price.ts and
domain/current.ts; no legacy modules or policy identities are runtime dependencies.
No v1 code was executed/imported and no v1 data/credentials were accessed.

The preserved Task01 Solidity receipt was read for the current estimator's rules;
its bytes still match the previously recorded SHA256. Function/line references,
literal independently derived synthetic vectors and remaining proof limits are in
[live observations](live.md). Actual pinned historic-state verification and deployed
identity remain unperformed. The existing source/license cautions remain unchanged.


## Task05 reuse

Task05 reused v2 closeDay/applyPayout, canonical event timestamps, domain unit/ratio
helpers, source replay fixtures, shared quota scheduling and portable row codec. No v1
source file, application module, credentials or data was accessed for this task. Earlier
reference receipts and acquisition-correction evidence remain unchanged.

## Task07 ordinary-stake arithmetic and UI references

Read only the retained Task01 HEX.sol source (SHA256
78680f17586d87cb85cd30eb4666f6d250dd1d12e33e0e76f96844a639b0f7fc),
constants at724-734 and _stakeStart/_stakeStartBonusHearts at1515-1667.
No old application code was imported or executed; no new network source was fetched.
The full Solidity source remains excluded under the existing license caution.

New domain/calculator.ts implements the mathematical interface facts: 20% per364
extra days (denominator1820), extra-day cap3640, 10% size bonus capped at150million
HEX (denominator150quadrillion hearts), one combined bonus floor, then issuance floor
at raw shareRate/100000. Principal and shares must fit uint72; rate fits uint40.
Existing UTC timing is reused. New unit witnesses are literal results independently
calculated with Python Fraction from term and size fractions, never the TS helper.
For100000000001hearts/2days, combined bonus55011721 differs from separate floors
55011720; rate123456 yields81045078183shares. For15000000000000000hearts/3641days,
bonus31500000000000000 and37665241057542768shares. One-heart/cap neighbors,
3640/3641/5555, storage bounds and UTC rollover have separate tests. A2T-share,
21day scenario at13/42HEX/T-share/day yields13HEX, not12.6 from3/10.

The five PNGs in docs/ui-reference are unchanged owner-supplied planner handoff
references, used as developer documentation only. No font, logo crop or full prior
product engine is redistributed into browser assets.
