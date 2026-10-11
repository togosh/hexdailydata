# Unified refresh operation

The feature branch has one finite coordinator, `scripts/refresh-data.mjs`.
No arguments or status makes no provider calls. An explicit run requires a new,
reviewed, owner-authorized task root and its frozen preflight. A consumed root
cannot be resumed. No timer, scheduler or service is installed.

This coordinated operator takes the operation lock, then participant selection
lock, then product writer lock. Product-only commits update the product reference in the participant
selection without changing its generation. Participant commits start from the
immediately selected product. The existing journal and certificates validate
skipped mixed transitions. Requests retain one compatible immutable pair through
settlement; shared participant readers close only after all users release them.
Known-owner saved-intent recovery remains local. Unknown ownership stops writes.

The initial genuine combined seed contains 2,503 daily rows, 90 liquidity dates,
2,502 ledger periods and the participant view at block 27,750,329. Protocol inputs
come from the committed ledger's end and two exact trailing words. Subsequent
jobs derive inputs from preceding publications. Initial saved market/gas block
numbers are unavailable; their original observation times are retained. A later
successful job supplies its contextual block for that feed's next round.

The R1 schedule is market, gas, protocol, one participant window to 27,754,425,
then market, gas, protocol. One parent owns all physical requests, charges and
the absolute clock. Each child has an immutable clipped suballocation. Mandatory
controls and their smaller executable retry pools are reserved before dispatch.
Nominal byte ceilings overlap; earlier actual charges may prevent a later job.
This is an honest partial outcome, not permission to renew a budget. Exact known
closed retry exhaustion disables that feed; integrity, uncertain closure,
publication or global safety failure stops all dispatch.

The coordinator inventories only its owned task tree. Each job reserves 2.5 GiB.
Before participant writes it measures the serialized draft/update (maximum 256 MiB)
and reserves remaining copies, a 32 MiB index, 512 MiB for the bounded product
files and 512 MiB for later work. Product-only publication reserves 1 GiB.
Final backup/restore reserves four times the actual product/participant tree size
plus 64 MiB, covering the backup, restore, separate synthetic derivative and
package. Every guard checks the aggregate 8 GiB ceiling and 10 GiB free-space
floor (20 GiB admission). Child streaming writes keep their own conservative
charges. The compact paired catalog retains external B0/B1 read-only prerequisites.

Freshness is independent per feed and uses original observation times and the
accepted 300-second policies. Participant coverage is accepted base plus observed
updates, not a full target census. An old market quote can become stale while a
participant job runs. No BTC/ETH benchmark, deletion/reorg guarantee, physical
power-loss claim, SQL/payment qualification, continuous freshness, indefinite
operation or public release is implied. Main is unchanged; indexer PARKED.

Task results, frozen identities, original failed tests and the finite public
accounting are delivered in the unified-refresh-operation-r1 return. Future runs
require their own concrete bounded authority and unused roots; old trial commands
remain consumed.

The closed R1 trial qualified all seven jobs on 9 October 2026: 226 attempts,
two GraphQL retries, 1,360,314 charged bytes and 3,111 charged objects in 456.47
seconds. One already-running API adopted all seven selections. Participants
advanced to block 27,754,425; both protocol observations retained ledger end
2502. The final saved participant view contains 664,616 holder records and
954,921 stake starts. These are represented source records, not current protocol
population counts. Quotes, gas and protocol readings have separate observation
times and naturally become stale after this finite trial stops.

The genuine compact backup restored successfully. A separate synthetic derived
seed needs its first product publication before a participant-only transition;
that publication initializes the fresh root's market-storage metadata. The
failed participant-first fixture is retained, and the corrected synthetic
product/participant/product sequence passed without changing production guards.

The separate Operating Refresh R1 BTC/ETH-only trial did not rerun these feeds.
Its 16 scheduled slots used one paired API and unchanged 300-second ages. Five
fresh served measurements and three selections were observed before a local
capture-reference refusal at slot 6. Source sampling and served freshness remain
separate results; an empty ETH sample preserved the last-good pair. The finite
trial is PARTIAL and permanently closed. The operating-only WINDOW_n adapter
correction passed actual isolated storage tests; legacy ROUND_1..3 stays exact.
All quiet-feed values/times, participant generation and fixed closes passed
read-only preservation. The retained paired intent prevents final genuine
restore/access/preview qualification. No scheduler or public rerun was started.

The later scoped offline recovery removed that specific final-proof blocker by
proving ABORTED_BEFORE_PRODUCT and preserving the original failed intent/locks.
It did not complete slot 6, alter prices, change either pointer or run a provider.
Normal paired routes, protected CSV/HEAD/304, genuine compact backup/restore and
desktop/mobile views then passed. One admitted immutable-base handle set served
both the application and isolated restore; original writable roots were denied
during restore. Full five-file selected identity and all historical values remain
exact. This is recovery qualification, not a regrade of the consumed public trial
or a continuous-freshness guarantee. All owned resources closed.

The separate BTC/ETH Operating Refresh R2 trial acquired 33 responses and
published 16 genuine pairs from sequence 28 through 44. Every scheduled ordinary
Live check was fresh on one API, with 899.499 seconds between first and last
changed publications. Other-feed values and times were not renewed. The finite
milestone remains PARTIAL because the final collector report exceeded its IPC
frame bound; source success and measured serving do not waive closure safety.

An offline R2-only compact saved-result identity fixes that reporting defect and
passes composed acceptance/refusal tests. It has not been used for another public
run. The original report/charges stay unchanged. The retained MARKET_REFRESH.lock
protects completed state; the existing pre-product abort grant does not authorize
its retirement. Read-only preservation passes, while final backup/restore and
access/preview qualification remain blocked. No second trial, other-feed call,
new seed, scheduler, indexer or paid-reconstruction work followed.

The subsequent explicit owner continuation completed a separately reviewed
offline settlement of that exact committed state. Closed request, publication,
paired-pointer and journal evidence agreed; only the exact active lock name was
retired after preserving its bytes. Sequence 44 and all selected values/times
are unchanged. The remaining paired API/access, compact backup/restore and two
local previews passed with one shared base admission and zero provider calls.
The new held-export proof covers sequence 44, not the original discarded held
sequence 28. Saved prices now correctly read stale. The earlier public trial
keeps its original partial result; no continuous-operation claim follows.

## Finite five-feed offline profile (Integration R2)

The existing `scripts/refresh-data.mjs` accepts the versioned
`config/unified-refresh-offline.json` profile. This profile is OFFLINE ONLY;
it cannot satisfy any legacy or new public admission. No-argument, plan and
status commands make no requests or base admissions. No scheduler is installed.

```powershell
node scripts/refresh-data.mjs plan config/unified-refresh-offline.json
node scripts/refresh-data.mjs run-fixture 'C:\Code\HEXDailyData-Subgraph-First-Launch-Proof-R2\unified-refresh-integration-r2' mixed
node scripts/refresh-data.mjs status '<the new fixture root printed by run-fixture>'
```

`run-fixture` requires the task's verified synthetic template and exact small
saved contract-code fixture. It creates a new collision-free root for each
invocation and refuses reuse. Those inputs are in the return's fixture catalog;
neither genuine sequence 44 nor a production participant base is opened. The
unchanged real adapters, journal, certificates, paired publication and API are
used with small empty immutable bases and injected network-denied responses.
Compatibility counts in the fake base descriptor are fixture metadata, not
loaded records or population evidence.

Jobs have finite due offsets, deadlines, permitted lateness and smaller-than-
existing per-family ceilings. They derive each predecessor from the selected
pair. Only one native child and one physical transport slot exist. GET, GraphQL
and RPC liabilities reconcile separately into one parent. A missed job is
recorded, never queued for catch-up. A known closed exhausted feed is disabled;
unknown native/accounting/publication state stops the operation and retains its
exclusion. Closing messages bind the bounded saved result; the 32 KiB IPC limit
has not increased. Known-owner synthetic interruptions use only the existing
recovery contract after native closure is established.

Actual mixed testing exposed two pre-existing product-policy conflicts:

- The trade preservation guard freezes all pre-October-10 cells, including null
  payout cells that a separately qualified day-2502 ledger append needs to fill.
- Product writer and standalone reader global-time guards reject a separately
  advancing feed when another feed still has the newest observation timestamp.

The owner explicitly extended scope for the narrow `market.ts` and `store.ts`
correction, generated output and focused tests. Only previously null payout cells
inside a validated contiguous ledger append may fill. A certified independently
advancing feed may retain the global maximum observation time. Writer-step,
reader-ancestry, pairing, quiet/history, decoding and source-time guards remain.
`policy-payout` and `policy-clock` now exercise those real writer/reader paths and
their negative cases; original failing receipts remain in the task return.

The mixed fixture exercises 16 trade slots and all other families on one API,
crosses midnight and 300-second aging, performs two payout appends, transitions
the participant pair, skips a delayed job and rotates the actual journal. Held
exports remain exact, lagging readers adopt coherently, and normal Daily and
protected CSV agree. This is bounded synthetic qualification, not a provider
cadence, scale or permanent-service claim.

The `NEXT_PUBLIC_QUALIFICATION.md` in the return is a proposal only. A later
public scope must bind current targets, runtime, per-feed budgets, source times
and reviewed closure before execution. All old grants remain consumed. Saved
sequence 44, the completed offline recovery, main and parked work are unchanged.

## Bounded public qualification R2

`node scripts/refresh-data.mjs public-qualification-r2` is a separate exact grant
for `unified-refresh-public-qualification-r2`. Default, status, plan and the prior
offline profile remain network-free. The command requires the frozen source/input
plan and independent PASS, restores the compact sequence 44 pair once into this
task's new runtime, opens the real paired API from those bytes, and records fresh
readiness before exclusive public admission. It is not a reusable scheduler.

The fixed profile has 16 independent three-GET trade jobs, two market/liquidity,
two gas, two protocol/payout, and one participant window ending at 27,758,521.
One parent owns every request and the 3,600-second clock including its 180-second
closing reserve. Native workers bind the same task/profile/nonce, frozen code,
parent pending reservation and child allowance. A consumed or uncertain marker
cannot be resumed. Missed slots remain skipped; source success, paired adoption,
served freshness and closure are reported separately. This sparse schedule does
not qualify continuous five-minute freshness for every feed.

The foreground owner reuses admitted immutable bases for final compact restore;
all writable roots are task-owned. Synthetic preflight uses empty base handles,
real publication/storage and denied networking. Genuine final proof additionally
browses the complete holder/stake stores. Actual source/public results and final
identities belong in the qualification return, not in an operator default.

### Actual R2 result: closed partial, 11 October 2026 UTC

The exact command above is now consumed. Do not rerun it: the task's
`PUBLIC_ADMISSION.json` and `session/PARENT_ACCOUNTING.json` record one closed
parent, 162 attempts (55 GraphQL, 98 RPC, 9 GET), eight GraphQL extras and
20,766,880 charged bytes. Five publications advanced the new candidate from
sequence 44 to 49 on the same API: one HEX/four-pool observation, one gas,
one protocol/two-period append and two BTC/ETH pairs. The first trade sample
had an empty ETH array and retained both previous prices/times. Sixteen later
scheduled jobs did not run after the terminal local audit failure.

The participant collector captured all 57 responses and closing controls, but
the auditor still applied the older two-extra ceiling to an authorized slow
data retry. Publication did not occur. The saved-only correction requires this
exact public admission, plan, root and window; it retains query identity,
recognized-error, closure, reservation, wait and ordinal checks. The unchanged
saved window now verifies, while historical policies still reject it under
their original bounds. This retrospective proof does not change the original
PARTIAL result or selected participant frontier 27,754,425.

Final selected product is `e345c1013a2179da15045535929c0bb33448f20e0cc0effe723090f7d17049c0`:
2,505 reporting rows, 2,504 ledger periods, 5,004 unchanged fixed closes and
90 unchanged historical liquidity dates. Final preservation/access, compact
backup and isolated restore passed with reused base handles. Two real previews
show stale quotes honestly; two fresh trade deliveries do not prove continuous
freshness. No recovery or post-session publication was performed. All owned
resources closed; main, original roots and parked work remain unchanged.

Use `REPORT.md`, `evidence/PER_JOB_RESULTS.json`, `evidence/PARENT_AUDIT.json`
and the exact source/return identities in the qualification return. Final
source includes the narrow saved-audit correction; the live run used commit
`c0ccf2e1f315c088d90a84f98fd2b451ceb27809`. A future application of the captured
unpublished participant window requires its own scoped offline integration;
another public qualification requires fresh authority.

### Authorized offline completion of the saved participant window

The owner subsequently authorized applying that saved window and one additional
compact backup/restore. The task-local continuation replayed the actual saved
auditor, bound the source/profile/proof, and independently reviewed the offline
harness before opening the immutable bases. Every selected before-value matched
the original draft. The maintained publisher committed one paired update and the
already-running API adopted it on an ordinary request; held records and the old
CSV stayed coherent. Reapplying the identical descriptor made no new commit.

The candidate is now sequence 50, product
`48a7a3c3c2f7ad9da2ab3c0e58f90ef4641584244d8904c3ddb125ae38b1153b`,
participant generation
`eec0148c07010189a290d39b151dc7c26df8e3b438fc141e722306819b32faf5`.
The participant frontier is 27,758,521, observed 2026-10-10T03:24:35Z.
The 1,329 holder changes comprise 35 new and 1,294 replaced rows; 98 stake
changes comprise 28 new starts and 70 updated parent records. The resulting
664,651 represented holder rows and 954,949 starts are not a current full census,
positive-balance holder count or inferred active-staker population.

All 117,735 Daily CSV cells and original quote times remain exact, including
5,004 fixed closes, 2,504 payout periods and 90 liquidity dates. Participant
publication does not renew other feed times. A new compact backup and isolated
restore passed with the existing admitted handles and prior writable roots denied.
The continuation used zero external requests, 20 local requests, 21,233,664
charged local bytes and one new base admission (three cumulative); all owned
resources closed. No recovery/unlock or new screenshot was needed.

The continuation return under `offline-participant-continuation-r1` contains the
reviewed task-owned one-use harness, exact saved update/proof, new backup and
receipts. Its command is consumed and is not a scheduler or public retry command.
The original public PARTIAL, unrun jobs, archives and charges remain unchanged.
This offline completion does not qualify continuous feed freshness or authorize
another public run. Main and all original data remain untouched.
