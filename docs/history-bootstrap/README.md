# Internal historical bootstrap

This is an offline file bootstrap, not an application source selector or SQL import. Build with the composed host build using already provisioned matching locked dependencies. It performs no install:

```powershell
node build/composed.mjs
```

Then run the explicit internal command from this worktree. Use the exact saved paths from the task return's `INPUT_REFERENCES.json`:

```powershell
node scripts/history-bootstrap.mjs build --pulse 'PATH_TO_SAVED_03.body' --ethereum 'PATH_TO_SAVED_02.body' --ledger 'PATH_TO_ACCEPTED_daily-ledger.json' --name history-v2
```

The command verifies all three input SHA256s against `config/history-bootstrap.mapping.json`, normalizes losslessly, validates all files, and publishes only beneath this worktree's `artifacts/history-bootstrap/`. An exact deterministic repeat returns `changed:false`; changed input, damaged existing output, an existing publication lock or a name collision is refused. There is no replacement, cleanup, acquisition, default-API activation or database command. Failed publication preserves its staging/lock for inspection; choose no workaround or reset without investigating.

`daily.ndjson`/CSV use ordinary scalar numeric strings or null. `prices.ndjson`/CSV use separate series/day/recordedAtUtc/quoteUsd fields. `FIELD_MAPPING.json` is shared once, `IMPORT_RECEIPT.json` binds the exact source/method/output identities, and `EXCEPTIONS.ndjson` records only rejections/conflicts/remapped calculations. Raw input is retained in the exact external parity archive, not duplicated per table or committed to Git.

Validate a restored small package using the independently supplied manifest identity:

```powershell
node scripts/history-bootstrap.mjs verify --directory 'PATH_TO_RESTORED_BOOTSTRAP' --manifest 'SHA256_FROM_RESTORE_INDEX'
```

Source credits, method decisions, precise gaps and the future normal API seam are in FIELD_MAPPING.md, METHODS.md and PUBLIC_DAILY_HANDOFF.md. Existing native/default/old HDS compatibility and separate contract-ledger semantics remain unchanged. New bootstrap files are outside all web roots. Historical quotes never populate Home/current panels in this milestone.
