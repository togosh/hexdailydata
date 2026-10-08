# First lab acceptance — run real paths, not planned assertions

A completed local milestone has actual source/install/run, authenticated browser flow,
PostgreSQL grants/keys/usage, real local SMTP, and separate source-read-only review. The
list below defines grouped behavior, not an arbitrary passing-test count. One fixture
can cover several related assertions. Keep expensive suites sequential and bounded.

## Essential first slice

A01 Guarded startup: private labeled resources, wrong/missing lab target refused before
DDL, DB role limits and runtime no-egress, no host/main mounts, onlyloopback web ports.
Do not actually probe the main DB as a negative test.

A02 Real registration/verification/login/logout through HTTP and browser+local inbox.
Unverified account cannot buy or access protected API. Email enumeration/CSRF/redirect/
rate limits are tested, no reset/verification token returned from ordinary public JSON.
Passwords hashed by the selected auth library; test log redaction and no extra legal name.

A03 Reset via actual inbox link; expiry/single use, invalid token, session revocation,
wrong account and repeated replay. Reject a web request that tries to set emailVerified,
accountID, paidUntil or another user's invoice. Separate browser-cookie and API-key auth.

A04 Saved invoice -> signed internal simulation -> durable payment/grant -> same account
key -> useful labeled synthetic data. UI success page alone cannot activate access.
Browser closes after simulated payment; reconciliation still activates from independent
fake-provider records. No real wallet/card/RPC is involved.

A05 API key show-once, hash-only store, wrong key, expiry, revoke/rotate. Same key survives
renewal; revoked key remains revoked. Keys cannot administer accounts. Fresh key does not
reset account quota. Test no raw key in DB/read APIs/logs or screenshot after creation.

A06 Prepaid exact vectors30/90/365×86400;20remaining+90=110days. Before/exactly/after expiry.
Daylight-saving transitions cannot change seconds. Huge payment base-unit strings round
trip without Number loss; malformed/scientific/negative/oversized input refused. No real
USD/PLS oracle or assumption that excess payment buys time.

A07 Concurrent two-key last-quota race uses actual SQL; exactlyone succeeds whenone unit
remains. Successful renewal, key rotation, same request ID on new HTTP request and restart
do not refill current quota. Only admission charge rule documented in product spec applies.
UTC window transition, per-account isolation and denied requests consume no paid units.

A08 At least20concurrent identical payment deliveries ->one credit/grant. TwoeventIDs for
onepaymentID ->one credit. Conflicting payload under sameeventID refused; legitimate
pending->paid transition accepted once. Twodistinct purchases concurrently add exactly
sum duration and consistent intervals. Use unique constraints/row locks, not only Map.

A09 Kill/restart real child process before/after SQL commit and injected lost ack. Payment
and grant stay atomic. Retry obtains original activation interval. Independently stored
fake-provider status after missed webhook is reconciled once. Preserve original errors if
cleanup also fails. A caught in-memory exception is not process-crash proof.

A10 Real reminder/receipt outbox delivery to local inbox; failed SMTP then retry does not
lose paid access. Repeated reminder ticks don't send endlessly; early renewal suppresses
obsolete expiry reminders. UI displays account days/quota without relying on mail success.
No external SMTP forwarding, real recipient or provider activation.

## Complete the same milestone after the core works

A11 Fake-card actual period boundaries including31day month, February/leap/year; never
substitute30/365 blindly. Paid renewal,failed renewal,cancel-at-period-end and delayed/
reordered status events; unique period ownership, no duplicate grant/expired-period reset.
Old state cannot undo newer state, but distinct valid paid history is retained.

A12 Mixed-mode conflicts under order-creation AND fulfillment races: active auto-renew,
collectible failedcardinvoice, outstandingPLS invoice, late payment after switch. Clear
support/review state, no duplicate entitlement or unexpected automatic charge. This proves
only local policy; no external subscription was actually canceled/charged.

A13 Wrong-chain/asset/recipient/amount or partial/late/excess simulation records an explicit
non-granted state. Exact quoted fixture amount validates. Full refund only linked grant,
replay idempotent; unrelated future grants preserved. Partial refund/dispute manual review.
No real funds moved and no public tx hash used as account-recovery proof.

A14 Fresh independent browser account cannot read other user's keys/invoices/status by
substituting identifiers. Concurrent requests/session expiry have stable results. Rate
limiter memory and usage buckets are bounded; no URL query stores API keys/PII. Generic
sanitized failures, no test-secret fallthrough to production profile. Browser controls
cannot manufacture valid 'verified purchase' without the lab simulator authorization.

A15 Library migrations/database state survive restart and an actual small backup/restore
into another brand-new guarded lab DB, including grants,key verifiers,usage and pending
mail/reconciliation. Do not run main operator tools or read main backups. Fixture provider
record and app backup boundaries explained; no claim of real vendor/RPO recovery.

A16 Actual responsive dashboard smoke at390×844 and desktop, keyboard/focus and error states;
reg/login/local mail/invoice/key/protected call/revoke journey. Screenshots redacted, no real
user browser profile. No giant marketing redesign needed. Labels distinguish simulation,
prepaid vs autorenew, monthly vs30days, no all-data/live/production claims.

A17 Performance small but meaningful: >=100protected HTTP requests with local SQL-backed
key/entitlement/quota checks, report p50/p95 and query count, dataset/concurrency/cgroup
limits. Separate cold initialization from warm. Show no provider/mail call on authorized
read path. No arbitrary600RPMpromise; rejected/expired results not counted as useful data.
The main app's published performance is not this lab's measurement.

A18 Feature boundary test: compiled app with deployment mode/real-provider knobs refuses
or has simulator route absent; fake event never grants real access. No production adapter
built; library/SDK presence is not payment-verification proof. Test-only fallback cannot be
enabled by request parameters or user role in a hypothetical production configuration.

A19 Install/build/run from only this lab's source and tested lockfile, with main directory
absent from inputs. One concise reviewer README journey, not multiple redundant huge runs.
Record exact versions/audit/advisory caveats; resolve supported findings without replacing
the entire stack. New source-only archive excludes runtime state and verified secret markers.

A20 Separate reviewer inspects frozen code and runs high-value independent SQL/ownership/
replay/prod-refusal probes. Fixer is builder; same reviewer one/two delta rounds. Actual
PASS scope is lab-only; unavailable reviewer or tests are pending, not fabricated. Under
time pressure first return A01–A10 working plus honest remaining checklist rather than an
all-green status from stub commands. Record both real and simulated timing clearly.
