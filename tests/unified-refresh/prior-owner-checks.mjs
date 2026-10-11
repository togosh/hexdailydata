import assert from 'node:assert/strict';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import {
  operatingPolicy,
  validatePriorProcessObservations as validate,
  verifyPriorOperatingSafety,
  validatePriorUnstartedPermit,
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
const prior = operatingPolicy.additionalOldStateProtection;
const pending = { id: 130, bytes: 4096, objects: 2, requestPath: 'exact/request.json' };
const state = { status: 'UNKNOWN', pending };
const result = {
  failure: 'LimitReached: Combined mandatory controls/publication deadline reserve',
  accounting: {
    status: 'CLOSURE_OR_ACCOUNTING_UNKNOWN',
    pending: { requestPath: pending.requestPath, reservedBytes: 4096, reservedEntities: 2 },
  },
};
validatePriorUnstartedPermit(state, result, ['request.body', 'request.json'], prior);
for (const names of [
  [],
  ['request.body', 'request.json', 'PHYSICAL_STARTED.json'],
  ['request.body', 'request.json', 'transport.json'],
])
  assert.throws(() => validatePriorUnstartedPermit(state, result, names, prior));
assert.throws(() =>
  validatePriorUnstartedPermit(
    { ...state, status: 'CLOSED' },
    result,
    ['request.body', 'request.json'],
    prior,
  ),
);
assert.throws(() =>
  validatePriorUnstartedPermit(
    state,
    { ...result, failure: 'unknown' },
    ['request.body', 'request.json'],
    prior,
  ),
);
assert.throws(() =>
  validatePriorUnstartedPermit(
    { ...state, pending: { ...pending, bytes: 0 } },
    result,
    ['request.body', 'request.json'],
    prior,
  ),
);
assert.equal(actual.additional.pendingPermit, 130);
assert.equal(actual.additional.physicalReaps, 129);
await writeFile(
  join(operatingPolicy.root, 'evidence/PRIOR_OWNER_CHECKS.json'),
  JSON.stringify(
    {
      status: 'PASS',
      cases: 15,
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
    cases: 15,
    oldFiles: actual.checkedFiles,
    observations: actual.observations.length,
  }),
);
