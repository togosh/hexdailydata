# Paid API foundation — settled product and data rules

This is the first independent lab slice. The user's supplied branch and retrieved
MASTER_PLAN.md (September17, proposed) are the decision basis. New operational detail
below is a lab design, not a provider capability or merchant approval. No live money.

## Account and authentication

Email is username, password login, mandatory email verification, reset email. Use one
maintained auth library (start with Better Auth) and PostgreSQL. Canonical email rules
must be consistent, account IDs immutable, and legal name unnecessary. If the library
requires a display-name field, generate a neutral pseudonym rather than collect more PII.
No passkey, SIWE/wallet, OAuth or organizations in this slice. Email change can be deferred
or require complete verified ownership of both flows; never add a shortcut reset takeover.

Use the library's password/session cryptography; explicit reset-session revocation and
finite verification/reset tokens. Reject token reuse, overlong passwords, open redirects,
foreign origins/CSRF and unsafe Host/proxy values. Rate-limit login/reset/verification with
bounded storage and generic account-existence responses. Cookies HttpOnly/SameSite with
secure HTTPS-required production policy; loopback-only HTTP is a documented lab exception,
not a deployment recipe. No real auth data is sent beyond the isolated test inbox.

Choose a supported exact library version after checking current official docs/advisories.
The API-key plugin is a candidate, not a reason to inherit its per-key quota/expiry defaults
as our product policy. Keep those rules explicit and independently tested.

## API keys and local authorization

Key belongs to account, never email as FK. High-entropy cryptographic random secret,
shown once; store only a safe verifier plus public ID/prefix/label. No query-string keys,
localStorage secret persistence, mail delivery of keys, raw-key logs or downloadable key
inventory. Keys authenticate data access, not admin/dashboard sessions. Session cookies
alone must not accidentally impersonate an API key for paid programmatic endpoints.

Keep key revocation separate from paid-period expiry. Renewal preserves existing valid
keys; it cannot un-revoke a stolen key or enable a disabled account. Key creation/rotation
never creates a fresh quota balance. Cap active keys (fixture3/account); rotation shows
new key once and retires the selected old key through an explicit operation. Plugin
auto-expiry/deletion must not remove keys merely because the subscription is overdue.

`authorizeAndConsume(key, cost, now)` is a small service with actual PostgreSQL-backed
account-level usage, not a payment-provider call. Concurrent keys share one limit and
an atomic admission point. Define exact behavior at expiration and revocation races;
authorization cannot use a stale process cache indefinitely. Do not add Redis or an
external HTTP auth dependency in the initial lab. Return typed denied/retryAt/reason.

Fixture policy: one developer plan;100admitted protected requests per UTCday and a
separate30-per-fixed-UTC-minute transient burst bound. These are test constants, not business pricing
or limits. UTC windows do not reset upon purchase/renewal/rotation. Exact account-level
SQL day admission is the billing meter. Authentication/expired/quota denials are not
charged. Once admitted, a downstream error may consume that attempt; document this
simple rule rather than implement a refund saga. Distinct HTTP requests are distinct
usage even with duplicate caller request IDs. No permanent per-request address/IP logs.

Synthetic GET data must identify itself as synthetic and contain no real holder/wallet
info. The final main data handler and provider quotas remain untouched. Paid access
cannot grant extra upstream quota or promise rates beyond later measured capacity.

## Invoices, payments and grants

Store the invoice BEFORE returning any simulated checkout. The server owns account,
plan, duration, amount units/currency and mode; client fields cannot set paidUntil.
Prepaid choices: exactly30/90/365×86400seconds in UTC. Card monthly/annual is the verified
provider-period interval, not30/365days. Example prices are explicitly fixture values.
Native-PLS quantities are exact decimal-string integer base units; no JavaScript Number
loss. No main HEX price estimate used as a payment oracle. Do not collect PAN/CVV.

Use compact relational records such as account/auth-library tables, invoice, received
payment/event, entitlement grants, API-key verifier, account usage buckets and local
outbox. Merge entities where it remains clear; this is not a mandatory table count.
Use real unique constraints, parameterized SQL, transactions and row locking. DDL role
is separate from runtime. A credential naming a lab is not proof of target ownership:
actual DB metadata/UUID must agree before migrations or test resets.

Deduplicate both delivery identity `(test-provider,event-id)` and economic identity
`(test-provider,payment-id)` / subscription-period identity. Two different event IDs can
refer to one payment; only one grant. Same immutable event ID with changed meaningful
payload is a conflict, not silently ON CONFLICT DO NOTHING. Pending->paid are allowed
separate events of the same payment; changing recipient/account/amount is not.

For a NEW accepted prepaid purchase, under account serialization:
`start = max(actual first activation instant, end of existing compatible prepaid coverage)`
`end = start + purchased exact duration`.
Create the payment credit and grant atomically; retry returns the original interval.
Do not recompute the start on webhook redelivery, delayed mail, restart or lost commit ack.
A late valid payment after an expired quote is `needs_review` unless the immutable invoice
policy explicitly accepts it; no automatic extra duration from overpayment. Partial,
wrong chain/token/recipient/amount, expiry and excess have visible non-granted states.
This tests business input handling, not real chain verification/finality.

Examples (independent expected rules):20days remaining +90days =>110days left at that
activation time;100 concurrent identical deliveries =>one grant; distinct valid30+90
purchases =>120additional days exactly, regardless processing order. Half-open intervals
[start,end); at exactly end access is expired absent another valid covering grant.

## Card simulation and mixed payments

Internal fake-card adapter models a paid invoice/subscription period plus cancellation,
failed renewal and full refund. It must NOT be named a finished Stripe/Paddle/Polar API.
Record explicit period start/end from fixtures and a stable subscription/paid-period ID.
Do not shift every late card callback to receipt-time plus30days or overgrant a year.
Later product-approved service credits would be separate; not invented here.

Successful renewals add only the new paid period. Failed renewal grants no new time;
previously paid coverage remains until its end. Cancel-at-period-end does not immediately
delete already paid access. Out-of-order status events cannot undo a newer accepted state
or cause repeat grants. A verified older distinct paid period can be recorded without
rewriting newer subscription status; ordering timestamps alone do not identify payments.

Simplest mixed-mode rule: block buying PLS while card auto-renew is active or there is a
collectible past-due invoice. Likewise block a new auto-renew arrangement during an open
PLS invoice/prepaid overlap unless the switch is an explicitly safe future boundary.
Enforce at order creation AND fulfillment under concurrency. A late conflicting payment
is recorded for reconciliation/support, never silently discarded or granted double
coverage. This lab does not solve proration, automatic card cancellation at providers,
changeable plans, crypto spending approvals or customer-held currency balances.

Full-refund simulation references one payment/grant; invalidate its remaining coverage
without subtracting arbitrary days from unrelated grants or revoking all account keys.
Repeated refund is idempotent; future paid grants retain their actual intervals (possible
gaps must not be hidden by only a max paidUntil). Partial refunds/disputes become explicit
review states, not fabricated money movement. No actual refund transaction is authorized.

## Durable receipt, reconciliation, notifications

Acknowledge an authenticated synthetic callback only after durable receipt. A small SQL
inbox/job or same-transaction handler is enough; no queue service required. Use an internal
HMAC fixture envelope only as a test transport, never as a claim about vendor signatures.
Raw bytes are verified before parsing; bounded inputs; altered signatures rejected.
Production mode/credentials must reject these synthetic events outright.

Fake-provider authoritative records survive APP restart independently of the local grant
consumer (separate schema/tables and role are enough in the lab). Missed callback and
browser closure are recovered by bounded reconciliation through that adapter. No app-paid
record may be used circularly to prove that an external missing payment happened. Reconcile
unique purchase identity, not a public tx hash alone. Provider outage blocks new simulated
checkouts as appropriate, not existing local access.

Use one coalesced periodic worker in the app for reconciliation/mail/reminders. Local
outbox and inbox only, no external SMTP relay/forwarding. Receipt delivery failure cannot
roll back a committed purchase; retry messages idempotently where possible and disclose
mail at-least-once behavior. Verification/reset links have short TTL, no logs; pending mail
content is sensitive and excluded from artifacts. Renewal/quota reminder keys include the
current grant/window so duplicate ticks do not spam, and an extended period invalidates
old expiry reminders. Minimal dashboard always shows days and quota remaining.

## Pilot versus production

All durations can be tested; real365day/annual offers, prices, quotas, grace/refund terms,
payment valuation/finality, merchant eligibility, tax/receipt data, PLS settlement/refund
routes and vendor recovery are NOT approved. No assurances of zero-PII/noKYC. Optional
paid API never blocks or silently paywalls the main public stats/download launch.
