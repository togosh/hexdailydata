import assert from 'node:assert/strict';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import {
  operatingPolicy,
  validatePriorProcessObservations as validate,
  verifyPriorOperatingSafety,
} from '../../scripts/unified-refresh/operating-authority.mjs';
const absent = { pid: 123, status: 'ABSENT' };
validate([123], [absent], 100);
validate([123], [{ pid: 123, status: 'PRESENT', startedAtUtc: '1970-01-01T00:02:00Z' }], 100);
const refuse = [
  [],
  [{ pid: 124, status: 'ABSENT' }],
  [{ pid: 123, status: 'UNKNOWN' }],
  [{ pid: 123, status: 'PRESENT', startedAtUtc: '1970-01-01T00:01:00Z' }],
  [{ pid: 123, status: 'PRESENT', startedAtUtc: 'invalid' }],
  [absent, absent],
];
for (const rows of refuse) assert.throws(() => validate([123], rows, 100));
const actual = await verifyPriorOperatingSafety();
await writeFile(
  join(operatingPolicy.root, 'evidence/PRIOR_OWNER_CHECKS.json'),
  JSON.stringify(
    {
      status: 'PASS',
      cases: 8,
      actual,
      externalRequests: 0,
      baseAdmissions: 0,
    },
    null,
    2,
  ) + '\n',
  { flag: 'wx' },
);
console.log(
  JSON.stringify({
    status: 'PASS',
    cases: 8,
    oldFiles: actual.checkedFiles,
    observations: actual.observations.length,
  }),
);
