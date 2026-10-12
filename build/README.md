# Explicit composed host build

From the repository root, with each package's matching locked
dependencies already present:

```text
node build/composed.mjs
node build/composed.mjs --check
node --test --test-concurrency=1 build/composed.test.mjs
```

The build invokes the local TypeScript and Vite binaries at the repository root and in `account`
sequentially. It verifies lock and installed inventory metadata, generates and
checks OpenAPI/catalog output against the existing accepted bytes, typechecks and
compiles both packages, selects `/account/` only for this composed UI build, and
copies/validates the five bounded synthetic CSV samples and their manifest for normal startup,
and copies eight account SQL assets beside compiled modules. Six are installer URL
targets. `schema.sql` and `upgrade.sql` are also copied for completeness; existing
migration scripts still use the retained `account/src` paths. Nothing executes SQL.

The standalone account package script and Vite configuration are unchanged.
Use a fresh source copy without `dist` for clean-build evidence. This script neither
installs dependencies nor starts the serving entry, paid service or worker.
`inputs.json` is a bounded check of the known composition seams; compilation checks
the transitive source graph. It is not a replacement for dependency installation
verification, full runtime integration or API tests.

## Serving recipe policy

`deploy/Dockerfile` takes only the public package manifest and exact lock
as npm installation inputs. It creates distinct empty user/global configuration
files and selects the public npm registry with audit/fund requests disabled.
No private or historical `.npmrc` is needed or reconstructed. Unknown old settings
(for example peer-dependency or install-link flags) are not assumed. Whether a
future clean Linux `npm ci` accepts this policy remains unverified until a separately
authorized container build. Images, versions, `npm ci` lifecycle behavior, pruning,
runtime user, tools, no-live defaults and startup command are unchanged.

The OpenAPI generator imports files under `src` and reads
`src/documentation/home-example.json`; its graph includes the datasets JSON and
contract/domain modules. `COPY src` covers these. The recipe now also copies
`scripts/openapi.mjs`. It generates `docs/openapi.json` before Vite reads it, so
the existing `.dockerignore` exclusion of `docs` and `tests` remains valid.

## Current deployment limitation

The retained Docker recipe has not yet been aligned with the new sample-copy script
and delivery sample inputs required by the normal build. Do not claim a container
build or deployment PASS from this host build. Container recipe correction and
qualification require a later scoped task. Paid composition still assumes
`dependencies.downloads.root`; this host compile does not qualify its runtime, SQL
or payments. The normal entry keeps those components inactive.

## Clean local serving candidate

`node build/release-candidate.mjs build PLAN.json` creates a new output directory
from an explicit public-source map and clean committed source. It uses the normal
OpenAPI, TypeScript, sample-copy and Vite implementations, with networking denied.
It does not read excluded npm/environment configuration, install packages, build
accounts or copy node_modules. Matching installed Windows host dependencies are
referenced by a local junction and inventoried against the exact lock.

The plan supplies absolute source/output/dependency/profile/map paths, source
commit/tree, map/profile SHA256 and the selected/rollback/participant data identity.
The output contains the compiled ordinary application, five checked synthetic
samples, OpenAPI, a RELEASE_MANIFEST and the same verification helper. The `_build`
subdirectory is retained build evidence, not a serving or return payload.

`node OUTPUT/release-candidate.mjs verify OUTPUT MANIFEST_SHA256 PROFILE` verifies
all serving files, source-map/host/dependency identities and the explicit profile
without opening large bases. `serve` adds bounded selection-header checks before
importing the ordinary compiled `dist/api/main.js`. Set HDD_V2_API_MODE=product,
HDD_V2_PRODUCT_PROFILE to that exact profile, HDD_V2_HTTP_HOST=127.0.0.1 and an
available HDD_V2_HTTP_PORT. No SQL/live/export environment is permitted. The
foreground process uses the existing signal-based close handler; Ctrl+C stops it.

This is an exact saved candidate, not an updater: a changed selected pair requires
an intentionally rebuilt/rebound candidate. Restoring the accepted compact backup
uses the unchanged maintained participant-refresh-backup helper in a new owned
root. External immutable bases remain read-only and are not part of the artifact.
Record actual admission/closure and verify the profile/data before serving.

The task return supplies the actual paths, hashes and tested owner commands.
Without its separately named installed dependencies and immutable data this is not
portable or self-contained. It does not qualify Docker/Linux, paid components,
provider operation, redistribution rights or launch readiness.
