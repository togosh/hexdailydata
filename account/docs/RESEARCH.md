# Targeted current documentation — retrieved September19,2026

These are limited outside-context checks for the lab, distinct from the user's supplied
plan/research. No provider account, API request, sandbox/payment or vendor inquiry ran.
Do not spend the implementation window redoing a broad vendor-selection exercise.

## Authentication starting point

Better Auth documents email/password, verification/reset and configurable reset-session
revocation. Default behavior is not our chosen policy: enable and test the necessary
controls. Its documented Fastify integration is an available reference, not tested
compatibility with the lab's eventual lockfile. Resolve a maintained release and inspect
applicable advisories. A docs' current version label is not a pinned, tested dependency.

- https://better-auth.com/docs/authentication/email-password
- https://better-auth.com/docs/integrations/fastify

The API-key plugin supplies verification/key lifecycle primitives and per-key limiting
options. Keep the lab's account-level metering separate and do not expire/delete keys at
subscription expiry. Check actual installed plugin behavior; do not assume defaults meet
our renewal/revocation requirements. Avoid duplicate quota systems charging one request twice.

- https://better-auth.com/docs/plugins/api-key

OWASP's authentication and password-reset guidance supports generic errors, throttling,
secure tokens and recovery safeguards. Apply the library's tested controls; don't build
custom authentication cryptography. Loopback HTTP is lab-only.

- https://cheatsheetseries.owasp.org/cheatsheets/Authentication_Cheat_Sheet.html
- https://cheatsheetseries.owasp.org/cheatsheets/Forgot_Password_Cheat_Sheet.html

## Payment events: simulate the hard behavior, not undocumented vendor endpoints

Stripe documents raw-body signature verification, duplicate deliveries and non-guaranteed
ordering. Paddle documents at-least-once events and an event identity distinct from each
notification. These justify duplicate/reordered/missed-event tests; they do not prove
blunt.cash's API or any realPaddle/Stripe adapter in this lab. Durable receipt before
acknowledgement and local idempotent grants remain our implementation requirements.

- https://docs.stripe.com/webhooks
- https://developer.paddle.com/webhooks/about/how-webhooks-work/

The current Polar AUP includes restrictions for financial/trading/advisory services and
NFT/crypto assets. It does not explicitly approve this read-only HEX data API. Keep exact-
product eligibility pending; do not treat generic SaaS onboarding as permission, or
misdescribe the product to evade restrictions. This is a caution, not a legal ruling.

- https://polar.sh/legal/acceptable-use-policy

The retrieved September17MASTER_PLAN's conditional Paddle/Stripe and blunt.cashHOLD
remain the basis. No need to select a production provider to implement the common lab.

## Isolation and local mail

Docker Compose documents internal network isolation. Verify actual runtime topology and
host exposure; a separate VSCode window isn't a sandbox. Mailpit exposes optional relay/
forward functions: this lab must leave them off and deny runtime external egress.

- https://docs.docker.com/reference/compose-file/networks/
- https://mailpit.axllent.org/docs/configuration/runtime-options/
- https://mailpit.axllent.org/docs/configuration/smtp-relay/

Official install/docs commands do not authorize global installs, live CLI login, tunnels,
provider sandboxes, real emails or production operations. Follow AGENTS.md scope.
