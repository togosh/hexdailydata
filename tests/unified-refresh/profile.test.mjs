import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';
import {
  validateProfile,
  unifiedAdmission,
  clipJob,
  counterKeys,
  profileId,
  profileTask,
} from '../../scripts/unified-refresh/profile.mjs';

const example = JSON.parse(
  await readFile(new URL('../../config/unified-refresh-offline.json', import.meta.url)),
);
test('finite five-family profile, explicit target and bounded slots', () => {
  const p = validateProfile(example);
  assert.equal(p.jobs.filter((j) => j.family === 'trade').length, 16);
  assert.equal(p.jobs.filter((j) => j.family === 'participants').length, 1);
  for (const change of [
    (p) => (p.mode = 'PUBLIC'),
    (p) => (p.jobs[0].tradeSlot = 2),
    (p) => (p.jobs[0].bounds.httpAttempts = 7),
    (p) => (p.jobs.find((j) => j.family === 'market').bounds.rpcAttempts = 57),
    (p) => (p.jobs.find((j) => j.family === 'participants').target = undefined),
    (p) => (p.jobs[0].deadline = p.parent.seconds),
    (p) => (p.jobs[0].bounds.controlGraphExtras = 1),
    (p) => (p.jobs[0].id = 'gas-1'),
  ]) {
    const p = structuredClone(example);
    change(p);
    assert.throws(() => validateProfile(p));
  }
});
test('new profile cannot become legacy/public authority', () => {
  assert.equal(unifiedAdmission({ task: 'HDD-UNIFIED-REFRESH-OPERATION-R1' }), false);
  const a = {
    unifiedProfileId: profileId,
    authorityTaskId: profileTask,
    synthetic: true,
    parentMode: 'OFFLINE_ONLY',
    parentProfileSha256: 'a'.repeat(64),
    family: 'trade',
    tradeSlot: 16,
    tradeProfileId: 'unified-single-pair-1',
    responseCookiePolicyId: 'ignore-response-cookies-no-replay-v1',
  };
  assert.equal(unifiedAdmission(a), true);
  for (const change of [
    (a) => (a.synthetic = false),
    (a) => (a.authorityTaskId = 'HDD-BTC-ETH-OPERATING-REFRESH-R2'),
    (a) => (a.parentMode = 'OWNER_AUTHORIZED_PUBLIC'),
    (a) => (a.tradeSlot = 17),
    (a) => (a.responseCookiePolicyId = null),
  ]) {
    const altered = { ...a };
    change(altered);
    assert.throws(() => unifiedAdmission(altered));
  }
});
test('remaining parent capacities and closure time reduce each next job', () => {
  const p = validateProfile(example),
    parent = { attempts: 0, ...Object.fromEntries(counterKeys.map((k) => [k, 0])) };
  parent.httpAttempts = p.parent.httpAttempts - 2;
  parent.httpExtras = p.parent.httpExtras;
  const clipped = clipJob(p, p.jobs[0], parent, 0);
  assert.equal(clipped.httpAttempts, 2);
  assert.equal(clipped.httpExtras, 0);
  assert.equal(clipJob(p, p.jobs[0], parent, p.jobs[0].deadline - 60), null);
  parent.httpAttempts = p.parent.httpAttempts;
  assert.equal(clipJob(p, p.jobs[0], parent, 0), null);
});
