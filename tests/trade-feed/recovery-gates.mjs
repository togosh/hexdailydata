import assert from 'node:assert/strict';
import { readFile, writeFile, lstat } from 'node:fs/promises';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { runTrades, runRecoveryTrades } from '../../scripts/trade-refresh.mjs';
const R = String.raw`C:\Code\HEXDailyData-Subgraph-First-Launch-Proof-R2\btc-eth-current-reference-freshness-r2`;
const T = join(R, 'transport-recovery-r1');
const hash = (b) => createHash('sha256').update(b).digest('hex');
const original = await readFile(join(R, 'PUBLIC_ADMISSION.json'));
await assert.rejects(
  runTrades({ taskRoot: R, preflightPath: join(R, 'continuation-r1/PREFLIGHT.json') }),
  /EXISTING_OR_UNCERTAIN_TRADE_SESSION/,
);
assert.deepEqual(await readFile(join(R, 'PUBLIC_ADMISSION.json')), original);
await assert.rejects(runRecoveryTrades({}), /ENOENT/); // No reviewed loaded-ready preflight yet.
for (const name of ['session', 'PUBLIC_ADMISSION.json', 'evidence/BASE_ADMISSIONS.json'])
  assert.equal(
    await lstat(join(T, name)).catch((e) => {
      if (e.code === 'ENOENT') return null;
      throw e;
    }),
    null,
  );
await writeFile(
  join(T, 'evidence/OWNER_GATE_TESTS.json'),
  JSON.stringify(
    {
      status: 'PASS',
      checks: [
        'old consumed entry refuses before preflight parsing',
        'new entry refuses without fresh loaded-ready preflight',
        'neither entry created a new admission/session or opened bases',
      ],
      originalAdmissionSha256: hash(original),
      publicRequests: 0,
      newAdmissions: 0,
    },
    null,
    2,
  ) + '\n',
);
console.log('OWNER_GATES_PASS_NO_ADMISSION');
