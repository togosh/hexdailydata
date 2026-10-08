# Focused stake activity integration witness

Compile with `node --max-old-space-size=512 node_modules/typescript/bin/tsc -p tsconfig.build.json`.
Run `node --max-old-space-size=512 tests/stake-events/run.mjs` **only inside a newly
owned disposable SQL runner**, with PostgreSQL17, the existing role initialization,
generated HDD_V2 role credentials/instance and a writable `/evidence` directory.
The test installs the existing five migrations on that fresh database; it changes
and truncates synthetic fixture data. It is not a command for a retained database.

Use one bounded internal-only network, no published ports and no provider settings.
The runner and DB must use the task's .5CPU/768MiB and .5CPU/1280MiB limits; the test
verifies those cgroups. `HDD_V2_ALLOW_LIVE_RPC=false`. Runtime source mounts are read-only.
The host must enforce a600-second child timeout and remove its exact owned project
on every exit. No Docker daemon discovery or cleanup is performed by these test files.

The server imports compiled `createApp` and subclasses actual `ReadDatabase` only to
record queries and aborts. It supplies no live dependencies. The consumer is a finite
local atomic inbox example (30 requests, 5000 items), not an SDK or notification service.
Expected consumer exits17/18/19 demonstrate injected crash windows. All child processes
and database connections are settled before the outer disposable-project cleanup.

`LAB_PROTOTYPE_READER` optionally points to an independently extracted accepted reader
for lab parity. Normal maintained tests need no archive or path outside this repository.
The integration fixture is carried from the accepted continuity proof and uses the
canonical writer, constructor/fork initialization, rewind and prune implementations.
The accepted query-plan evidence is reused separately. Process-crash windows are
exercised here; host/filesystem power-loss durability remains unproven.
