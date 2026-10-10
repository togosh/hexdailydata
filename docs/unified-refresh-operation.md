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
