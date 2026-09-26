# Interrupted replay recovery

`scripts/operator/reconstruction-recover.mjs <environment> <scope.json> <output>`
is an explicit host maintenance action. It does not reconstruct, contact providers,
renew approval, or start the next segment. Real use requires a separate owner grant.
The immutable operator image, plan, schema, provider gates and ordinary collector
remain unchanged. See [normal operation](reconstruction.md).

## Supported boundary

Only nonterminal interrupted replay is supported: running state, unknown segment
ending, no pending request, no pending SQL, no active audit, and a normally sealed
immediate predecessor. The runtime can retain `phase=milestone-audited` during
subsequent replay; this is admitted only below the next milestone with no audit.
Audit/milestone-pending interruptions, missing seals, live/uncertain ownership,
expired authority, drift, corrupt records and exhausted allowances refuse.

SQL must equal the acknowledged control checkpoint. Retained SQL receipts must
link every intervening revision/header to the preceding sealed checkpoint. Current
totals, account/stake ownership, activation schedules, source binding and migration
checksums are verified with the existing inspection code. The canonical digest
includes table contents, schema/privileges and sequence state. Independent bounded
queries reject rows beyond the accepted checkpoint. This is local consistency,
not another provider audit.

## Evidence and ordering

The host takes an OS-backed exclusion on `.reconstruction-recovery.lock`. Its inode
is persistent and is never deleted. Windows uses an exclusive FileStream held by
a short PowerShell process; Linux uses flock. The holder's input pipe ties its
lifetime to the coordinator/recovery parent. Ordinary host coordination takes the
same exclusion. Concurrent recovery/coordination refuses.

Recovery requires boot and process observations proving the original ownership
predates the current boot, matching job lock/status identities, absent original
processes (or an explicitly observed post-boot PID reuse), absent exact operator,
and no running container using the exact database/state/quota volumes. No process
is killed to manufacture this proof. Unresolved observations refuse.

The create-once `recovery-NNNNN` directory contains:

- `seed.json`: exact original control, host, prior host-result, status and lock
  bytes; lock metadata; boot/process observations; original authority identities;
  and identities of the prior segment and milestone seals.
- `intent.json`: the read-only SQL proof, intended post-state/host bytes and hashes,
  recovery observation time, and explicitly null original native exit and ending.
- `manifest.json`: the special recovery class and hashes of seed and intent.

After seed capture, SQL proof runs under filesystem maintenance exclusions and all
five existing advisory locks. PostgreSQL starts directly with
`default_transaction_read_only=on`, without initdb, migrations or an application
writer. The helper uses a read-only worker connection for exclusions and an API
repeatable-read read-only snapshot. It retains these through control publication.
PostgreSQL startup/WAL recovery/checkpoint files may change; canonical SQL is never
written by recovery.

The order is intent, atomic control replacement, host replacement, recovery seal,
create-once coordinator result, status pointer, then exact stale-lock cleanup.
Only original stale lock bytes captured in the seed may be removed. Existing host
result/output and ordinary segment seals are not rewritten or fabricated.

Retries compare exact pre/post bytes, authority, prior seals and fresh SQL proof.
A partial recovery may finish only its original intent. Conflicts refuse. A fully
recovered retry verifies the same result without rewriting operation metadata.
A recovery interrupted before a complete seed leaves original metadata unchanged;
an unreadable/conflicting journal requires review, never automatic reset. If a
previous helper still owns a volume, retry refuses rather than killing/adopting it.

## Control and continuation

The special coordinator outcome is `RECOVERED_AFTER_POWER_LOSS`. Its native exit
and original ending remain unknown. Control becomes `paused` with that reason and
the fresh `canonicalAtPause` digest. Accepted checkpoint, counters, uncertain-attempt
charges, audited pin, milestone, roots, original start/deadline/high-water and
`pausedMs` are preserved. `segment.ended` and `lastEnded` are null. The original
last-ended value remains in the captured pre-state. Host pending becomes false;
its original segment count/start/deadline/high-water remain unchanged.

A later ordinary coordinator `resume` verifies the recovery manifest, authority
binding, exact control/host bytes and prior seals separately from normal collection.
An unclassified paused state with unknown ending still refuses. The existing runtime
then verifies SQL and the canonical digest, starts the next segment, and retains the
interrupted segment receipt with a null ending. Because `lastEnded` is null, neither
crash downtime nor the wait after recovery is added to clean `pausedMs`. Both still
consume the immutable whole-operation deadline. Restart quarantine remains unchanged.

No automatic resume follows recovery. A successful recovery does not add audit
credit or complete Task10/Task11. A second replay interruption after this special
boundary, active audit recovery, ordinary same-boot crash adoption, and physical
disk-corruption repair are outside this narrow procedure.

## Offline qualification

`node scripts/test-reconstruction.mjs --recovery-only` uses one fresh disposable
SQL project, actual writer/control code, synthetic transports, separate runtime
processes, the production recovery SQL helper, and injected boot observations.
It preserves the original source refusal witness, a six-commit interruption,
recovery faults, a native recovery-process exit/retry and next-segment continuation.
It never accesses a retained owner environment. Host authority/kernel-lock and
normal lifecycle regressions are in `tests/reconstruction/recovery.test.mjs` and
the existing reconstruction job/terminal tests. Synthetic boot evidence does not
constitute a physical Windows/Docker reboot qualification.
