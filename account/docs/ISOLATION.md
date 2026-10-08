# Parallel lab isolation — simple enforceable boundaries

The main Codex may be writing and running containers now. Do NOT survey its state. Only
this lab's files, named resources and frozen supplied reference are in scope. Metadata
needed for Git initialization may check ancestor `.git` existence only; do not read it.

The setup writes `.local/lab.json` with UUID and `hddpaylab-<random>` project prefix.
It is nonsecret. Runtime secrets are later generated only within `.local/` and excluded
from archives. No DB URL inherited from shell/database environment, no `host.docker.internal`,
no main network, no published5432, no fallback to host PostgreSQL. Disable dynamic dotenv
search beyond explicit lab-local config. Apps must validate this lab's environment marker,
DBname/role/instance UUID and expected private network before any mutation/DDL.

Use PostgreSQL17, one app process with a tiny periodic job and a Mailpit-style local inbox.
A temporary migration/CLI/browser test container may replace rather than add to existing
lab allocations. Give each run a unique project ID and purpose/owner labels. Suggested
simultaneous allocation:DB0.75CPU/768MiB;app0.5CPU/512MiB;inbox0.125CPU/128MiB;
runner/browser0.625CPU/640MiB =2CPU/2GiB TOTAL. Adjust lower when sensible; any extra
reviewer target shares this total or runs after the builder's own lab target stops.
Do not claim a resource test at a cap you did not observe. Compilers/image-build/control
host overhead is separately disclosed and only one heavy job runs at a time.

Compose runtime networks internal:true, no second egress-enabled network. New named DB
volume, no external:true volumes, no host-root/main binds, no socket mount, no privilege
or host network. App may listen0.0.0.0 inside the private namespace; any published HTTP/UI
ports must be explicitly127.0.0.1 with unused/ephemeral host port. Inbox SMTP stays internal,
no relay or forwarding config/variables, bounded message retention. Source copies/mounts
come only from this lab; dependency build context excludes .local/work/.git and secrets.

Runtime outbound check: use a task-owned dummy egress-listener target on an unrelated
new network, and prove app/inbox/test namespaces cannot reach it or a host gateway.
No successful request to any external provider is needed for that proof. Also inspect
the actual configured networks/mounts/port bindings. Do not claim every same-user Windows
process is sandboxed. Installation-time allowed registry downloads are a separate phase.

API/SQL tests run under private runtime roles. Bootstrap/migrator authority is narrowly
scoped to a new DB and not supplied to ordinary requests. A wrong UUID/existing unrelated
DB/schema/volume is refused, not dropped to fit. Startup missing config fails closed.
Test connection denial with synthetic wrong lab target; never use an actual main target
as the negative test. Loopback web requests are permitted only to the recorded lab URL.

Public internet, main app/API/DB, SMTP providers, payment providers including sandboxes,
blockchain RPC, wallets, tunnels, provider keys and user browser profiles are NOT permitted.
The client has no CDN/remote fonts/analytics/service workers or live iframe checkout.
Use a fresh lab browser profile and synthetic accounts. Read-only docs/registry/image/
Playwright download access needed for setup is allowed and recorded, not payment access.

Cleanup is exact project/IDs and labeled task-owned resources only; no blanket prune,
stop-all, image eviction shared with main, permission change or alternate blocked deletion.
Restore test uses another NEW private target, not overwrite in-place main/prior data.
Leave only an explicit lab demo environment if requested by owner; otherwise stop runtime
resources and preserve source/evidence. Never silently assume demo is production-ready.
