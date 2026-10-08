# Successful stored-read meter candidate

The account module exports `SuccessMeter`, `ReserveUncertain`, and a bounded SQL
transaction helper. `installMetering` applies the adjacent additive SQL only through
the guarded account migrator role. It is reapplicable; it does not rewrite keys,
grants, usage or the original schemas. The serving API source is untouched.

| Prior state | Operation | Result | Success units |
|---|---|---|---:|
| No receipt | Authenticated reserve with capacity | pending | 0 |
| pending, live | Server-finished200/304 settlement | success | +1 once |
| pending, live | Error / unfinished release | released | 0 |
| pending, expired | Any finalization / maintenance | expired | 0 |
| success | Repeated success or release | success | 0 additional |
| released / expired | Late success or release | Same terminal state | 0 |
| Missing / pruned / wrong account-day | Finalization | missing | 0 |

All capacity decisions and terminalization use the same customer-row lock as original
key mutations. Admission reuses the original key/account/grant checks and samples SQL
`clock_timestamp()` after locking. Settlement locks the customer without reauthorizing:
revocation, disablement, refund or grant expiry cannot strand an already-admitted hold.
Locks and connections end before analytics and response work.

Committed successes plus live holds cannot exceed the100/day fixture. Holds retain
their admission UTC day. At most8 live holds exist per account; the default lease is
60seconds. The existing30/minute bucket measures committed authenticated work attempts,
including quota/pending denials; release never refunds it. Invalid credentials and
cancelled transactions before admission retain the application's global attempt bounds.
The original `authorizeAndConsume` remains admission-counted for compatibility tests;
the success adapter never calls it.

The adapter requires actual outgoing response finish and final200/304. An onSend200
is preparation only. Server finish means handoff to the operating system, not client
receipt. Each HTTP retry gets a distinct random internal hold. Same-ID finalization is
idempotent; missing IDs are never inserted by settlement. No exactly-once delivery,
URL deduplication, caller idempotency-key protocol or monetary action is provided.

Abort destroys/retire-discards an acquired PostgreSQL connection. If cancelled while
waiting for a pooled connection, the caller stops promptly and any late lease is
destroyed without queries. The existing pool acquisition ceiling still bounds that
underlying pool wait. A decreasing monotonic budget spans pool/lock/query/commit work.
There is no fresh full timeout per query. A COMMIT racing cancellation is ambiguous:
resolve/release that same known ID, or allow expiry; do not start analytics.

Post-response terminalization uses at most two same-ID attempts within one2-second
budget. At most64 protected request/finalization tickets are retained per process.
New work is refused when full. Close admission, stop the HTTP app, and drain the adapter
before closing its account pool. No disk journal, background service or retry queue exists.

The account module also caps underlying work at 64 across meter instances in one
process. An aborted caller keeps that work slot until its unresolved pool acquisition
settles and the late lease is retired. Repeated abort/re-entry cannot accumulate
unbounded pool waiters. `pendingWork()` exposes the count. After admission closes,
`drain()` awaits those slots with a separate fixed 3-second bound and fails explicitly
on timeout. Adapter close drains both its tickets and this account work before the
pool is closed. These are two bounds on different lifecycle stages, not retry queues.

`maintain(limit, work)` is a callable bounded hook for later existing-worker wiring.
It expires old holds and deletes at most the explicit number of eligible terminal
receipts older than7days. It never deletes a live hold or changes aggregate usage.
Its deadline bounds SQL work as well as batch size. Maintenance must actually be called
for retention; this candidate does not start a worker. The90th committed success uses
the original deduplicated local outbox with completed-request wording; nothing sends mail.

Uncertainty deliberately favors undercount: a server-finished response without a
durable established success may expire uncharged. An acknowledged or later recovered
success COMMIT remains charged once, even after late close/release. A transport and a
database cannot be atomically committed by these hooks.

Before later production cutover, choose a clean allowance-period boundary or otherwise
separate legacy admission counters. Installing this schema does not convert old counts
to successes, refund them, reset them or qualify a live rollout.100/day,30/minute,8holds,
60seconds and7days are task fixture/technical bounds, not published prices or quotas.
