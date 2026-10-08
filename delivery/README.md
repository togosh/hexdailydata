# Paid CSV delivery composition

This is an offline incremental candidate against serving388 and account106. It does not install over, migrate, or launch a production service.

## Files

- `serving.patch`: authorization seam before complete CSV openStream, private response caching, process-local download admission, static isolation, encapsulated account method allowlist, compact Downloads UI.
- `account.patch`: exports the accepted registrar's existing `authenticateSession` closure. Credential fencing and library session behavior are unchanged.
- `delivery/authorizer.mjs`: invokes accepted checkAccess, lockAccount, selectPeriods and shared session validation. No JSON reservation or settlement.
- `delivery/compose.mjs`: inject separately compiled account and serving modules, guarded pool/config, actual ExportService and read database. Register only explicit account routes; sample assets are independent of account storage.
- `delivery/samples/`: fixed one-row partial synthetic fixtures, original CSV schemas/formatter, hashes and raw fixture. No current/prior complete files are stored in the web root.

`composePaidApp` accepts `{serving:{createApp}, account:{registerAccountRoutes,checkAccess,boundedTransaction,lockAccount,selectPeriods,databaseTime}, config,pool,payments,dependencies:{db,downloads},webRoot,accountWebRoot}`. Normal use passes the accepted databaseTime; the finite lab injects a trusted private fixture clock sampled under the same customer lock. `payments` is the unchanged account HexPayments instance used for owned invoice display; this lab does not configure or execute payment collection/verification.

Build the existing account UI with Vite base `/account/`, retaining its existing API paths. Its static root is separate from the serving web root. `lab/runtime.mjs` is the tested explicit composition example; it is disposable fixture setup, not a production entrypoint.

## Boundaries

Bearer Authorization, when present, is authoritative; duplicated, malformed, revoked or unknown values fail401. Real session cookies use the shared getSession/fence/recheck path. Missing identities fail401; disabled/expired/future/refunded access fails403; storage or missing composition fails503. The accepted key schema has no separate TTL: key rotation/revocation and purchased-term expiry are checked on each request.

Current and prior complete files require access before opening, HEAD or conditional matching. Full responses use private,no-store and Vary Authorization,Cookie. An admitted transfer may complete after access expires; its next request is checked again. No-store does not recall a deliberately retained downloaded file.

Admission is per process: two in-flight downloads per account, sixty admitted attempts per minute, at most1024 resident account entries. The existing global32 export readers and120-second deadline remain unchanged. Release waits for ExportService's reader/SQL lease cleanup. There is no queue, distributed egress quota or billing debit.

Static roots are ordinary assets outside the actual export root. Startup inventories and request path checks reject links, hardlink aliases, root overlap and static CSV files. Keep deployed roots immutable as in this lab. Samples are served from a finite five-file allowlist, independent of bundles and account availability. Account startup failure leaves public data/sample serving available but disables account/complete delivery for that app lifetime; restart the composition after correcting storage.

Public JSON/page policy is unchanged. Broad paid REST, anonymous enumeration, real samples, capacity limits, commercial allowance/token amounts and production integration remain separate decisions.
