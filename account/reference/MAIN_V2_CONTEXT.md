# Frozen v2 compatibility note — no executable dependency

Source physically inspected by planner: `HEXDailyData-v2-early-canary-source.zip` (468632bytes), SHA256
`14eecb0fbecf268cfd9c9f2356436347daa0546223669d5844ffa9df32b135a6`, reported source `72c0ac3352270b3371b24c43bed256d81494b1fc`.
This is an older fixed snapshot, not the current main checkout. A PulseChain HDS history
integration may be running in the main Codex window; the lab must not inspect/poll it.

Relevant source facts: one TypeScript/React/Fastify/PostgreSQL product; main API read-role
SQL; GET/HEAD/read-only data routes; separate native worker; exact numeric values as decimal
strings; default HTTPport4320. The auth/billing lab must allocate different ports/resources.
Current source-target Nodeengine `>=24.21.0 <25`. Versions are old snapshot
facts, not a requirement to copy its lockfile or claim installed compatibility. Lab Codex
resolves a supported Node24 stack and its own tested lockfile without using main modules.

Reference dependencies observed: Fastify5.12.5, pg8.23.0,
React19.3.0, Zod4.6.5. No dependency file is
copied as an executable prerequisite. Never call the main API in a lab test; return
synthetic data. Billing writes need a distinct role/connection on future integration,
not write permissions on native HEX read schemas. Performance/limits are not inherited.

The owner's latest direction is PulseChain HEX only for market history, with necessary
inherited protocol facts retained. Post-fork EthereumHEX product is out of scope; gas/
ETHUSD comparison intent is not a lab feature. No RPC is part of this experiment.

Inspected text/hash receipts (artifact boundary only, not per-request gates):
{
  "package.json": "530a3e103ae1575a6ad70b9ec10e62d8d52b8ae6f23dcb527144149e7dc1bd0f",
  "src/api/config.ts": "c9b3d95834c817cea86c8d3cfb700a09eff4355df16154bb94c24f7c0b07acf3",
  "src/api/main.ts": "b2ccede4678fe6f51a05e19ea26d3f98bac7fba835246bdbcf7e34c87861d521",
  "src/api/app.ts": "c6549a726525e55b735a823514232e2c501373ca29a656acbaa7d85a813c9ce2",
  "src/contracts/api.ts": "06d35e365f2d895a939276a5d7d7157abda29a651c67e5d8efe2be1d1f496d92",
  "src/contracts/reads.ts": "e21abb77460395a8bd1fdad1a783d877c0bed8dfa1512ab8e94284077b3033ea"
}
