import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import {
  operatingPolicy,
  priorProcessCommand,
  validatePriorProcessObservations,
  verifyPriorOperatingSafety,
} from '../../scripts/unified-refresh/operating-authority.mjs';
const command = priorProcessCommand([123]);
const run = (processResult, creationResult) =>
  JSON.parse(
    execFileSync(
      'powershell',
      [
        '-NoProfile',
        '-NonInteractive',
        '-Command',
        `function Get-Process { param($Id,$ErrorAction) ${processResult} }; function Get-CimInstance { param($ClassName,$Filter,$Property,$OperationTimeoutSec) if($ClassName -ne 'Win32_Process' -or $Filter -ne 'ProcessId = 123' -or $OperationTimeoutSec -ne 5){throw 'WRONG_LOCAL_QUERY'}; ${creationResult} }; ` +
          command,
      ],
      { encoding: 'utf8', timeout: 10000, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] },
    ),
  );
const nullStart = '[pscustomobject]@{StartTime=$null}';
const row = (pid, date) => `[pscustomobject]@{ProcessId=${pid};CreationDate=${date}}`;
const later = "[datetime]'1970-01-01T00:02:00Z'";
const fallback = run(nullStart, row(123, later));
validatePriorProcessObservations([123], fallback, 100);
assert.equal(fallback[0].observationMethod, 'local exact Win32_Process CreationDate');
const direct = run(`[pscustomobject]@{StartTime=${later}}`, "throw 'UNEXPECTED_FALLBACK'");
validatePriorProcessObservations([123], direct, 100);
for (const creation of [
  '',
  row(124, later),
  row(123, '$null'),
  row(123, "'invalid'"),
  row(123, later) + ';' + row(123, later),
  "throw 'UNAVAILABLE'",
])
  assert.throws(() => run(nullStart, creation));
assert.throws(() =>
  validatePriorProcessObservations(
    [123],
    run(nullStart, row(123, "[datetime]'1970-01-01T00:01:00Z'")),
    100,
  ),
);
assert.throws(() => priorProcessCommand([123, 123]));
assert.throws(() => priorProcessCommand(['123;bad']));
const actual = await verifyPriorOperatingSafety();
const receipt = {
  status: 'PASS',
  cases: 11,
  actual,
  networkRequests: 0,
  baseAdmissions: 0,
  proof:
    'Actual PowerShell observation command with local injected process results, then exact current prior-PID reads; no listener or owner execution.',
};
await writeFile(
  join(operatingPolicy.root, 'evidence/PRIOR_CREATION_CHECKS.json'),
  JSON.stringify(receipt, null, 2) + '\n',
  { flag: 'wx' },
);
console.log(
  JSON.stringify({
    status: receipt.status,
    cases: receipt.cases,
    networkRequests: 0,
    baseAdmissions: 0,
    reusedPids: [actual, ...[actual.additional, actual.third]].flatMap((x) =>
      x.observations.filter((p) => p.status === 'PRESENT'),
    ),
  }),
);
