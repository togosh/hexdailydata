import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  reconstructionPlanSchema,
  reconstructionAuthority,
} from '../../dist/operator/reconstruction-plan.js';
import { canaryPlanSchema } from '../../dist/operator/canary-plan.js';
import { digest } from '../../dist/services/projections/input.js';
import { dayBoundaryPlan } from '../canary/prefix-fixture.mjs';
import { ReconstructionAuditScope } from '../../dist/operator/reconstruction-audit.js';
const old = JSON.parse(readFileSync('config/reconstruction.synthetic.example.json'));
const audit = {
  ...old,
  auditOnly: true,
  target: old.admission.checkpoint.number,
  milestones: [old.admission.checkpoint.number],
  methods: old.methods.filter((m) => m !== 'eth_getLogs'),
};
test('explicit equal-target mode preserves absent-field serialization and authority', () => {
  const parsed = reconstructionPlanSchema.parse(old);
  assert(!Object.hasOwn(parsed, 'auditOnly'));
  assert.equal(digest(parsed), 'd269b8883d5955040c77cd14602a6d1e26d12a53220176f0e2ab34bb8573fc56');
  assert.equal(JSON.stringify(parsed), JSON.stringify(old));
  const approval = (p) => ({
    run: p.run,
    planDigest: digest(p),
    release: p.release,
    reviewedCommit: p.reviewedCommit,
    instance: p.instance,
    decision: 'owner-approved-bounded-reconstruction',
    resumePolicy: p.resumePolicy,
  });
  const env = { HDD_V2_RECONSTRUCTION_OPT_IN: old.run, HDD_V2_ALLOW_LIVE_RPC: 'true' };
  reconstructionAuthority(parsed, approval(parsed), env);
  const p = reconstructionPlanSchema.parse(audit);
  reconstructionAuthority(p, approval(p), env);
  assert.throws(() => reconstructionAuthority(p, approval(parsed), env));
  for (const change of [
    { auditOnly: false },
    { auditOnly: 'true' },
    { auditOnly: undefined },
    { target: '356', milestones: ['356'] },
    { target: '354', milestones: ['354'] },
    { milestones: [audit.target, audit.target] },
    { methods: old.methods },
    { methods: [...audit.methods, 'eth_sendTransaction'] },
    { origin: 369 },
    { transport: 1 },
    { storagePath: old.quotaPath },
    { caps: { ...old.caps, milliseconds: 1209600001 } },
    { admission: { ...old.admission, counts: { ...old.admission.counts, accounts: '0' } } },
    { profile: { ...old.profile, policy: { ...old.profile.policy, mode: 'latest' } } },
  ])
    assert.equal(
      reconstructionPlanSchema.safeParse({ ...audit, ...change }).success,
      false,
      JSON.stringify(change),
    );
});
test('legacy pinned audit still rejects 10037 accounts while new mode accepts them', () => {
  process.env.HDD_V2_PROJECT = old.project;
  process.env.HDD_V2_DB_INSTANCE = old.instance;
  const base = dayBoundaryPlan('/synthetic-only');
  const p = {
    ...base,
    allowHeadObservation: false,
    ranges: [{ chain: 1, from: audit.target, to: audit.target }],
    methods: audit.methods,
    caps: { ...base.caps, http: 500, logical: 5000, bytes: 134217728 },
    phases: [
      {
        kind: 'pinned-audit',
        purpose: 'Synthetic cap baseline',
        admission: old.admission,
        inventoryDigest: old.inventoryDigest,
        canonicalDigest: old.canonicalDigest,
        priorSession: '11111111-1111-4111-8111-111111111111',
        priorStorageIdentity: '1:1',
        priorQuotaIdentity: '1:2',
        priorDispatchFloor: 0,
        cadence: base.phases[0].cadence,
        endpoints: base.phases[0].endpoints,
      },
    ],
  };
  assert(canaryPlanSchema.safeParse(p).success);
  p.phases[0].admission = {
    ...p.phases[0].admission,
    counts: { ...old.admission.counts, accounts: '10037' },
  };
  assert(!canaryPlanSchema.safeParse(p).success);
  assert(
    reconstructionPlanSchema.safeParse({ ...audit, admission: p.phases[0].admission }).success,
  );
});
test('shared audit transport refuses logs, discovery and unscoped calls', () => {
  const scope = new ReconstructionAuditScope(audit.profile.contract, audit.admission.checkpoint);
  for (const calls of [
    [{ method: 'eth_getLogs', params: [{}] }],
    [{ method: 'eth_getBlockByNumber', params: ['latest', false] }],
    [
      {
        method: 'eth_call',
        params: [
          { to: audit.profile.contract, data: '0x18160ddd' },
          { blockHash: audit.admission.checkpoint.hash, requireCanonical: true },
        ],
      },
    ],
  ])
    assert.throws(() => scope.request(1, calls));
});
