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
