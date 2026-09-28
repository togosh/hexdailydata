import { z } from 'zod';
import { pinnedAuditAdmissionSchema } from './canary-plan.ts';
import { profileSchema, profileBinding } from '../worker/sync/profile.ts';
import { digest, uint } from '../services/projections/input.ts';

export const exact = z.number().int().nonnegative().safe();
export const sha = z.string().regex(/^[0-9a-f]{64}$/);
const path = z
  .string()
  .regex(/^\/[a-zA-Z0-9_-]+(?:\/[a-zA-Z0-9_-]+)*$/)
  .max(256);
const positive = exact.min(1);
export const segmentSchema = z.strictObject({
  milliseconds: positive.max(3600000),
  http: positive.max(600),
  logical: positive.max(12000),
  bytes: positive.min(8388608).max(268435456),
});
export const reconstructionPlanSchema = z
  .strictObject({
    version: z.literal(1),
    kind: z.literal('common-history-reconstruction'),
    auditOnly: z.literal(true).optional(),
    run: z.uuid(),
    release: z.string().regex(/^sha256:[0-9a-f]{64}$/),
    reviewedCommit: z.string().regex(/^[0-9a-f]{40}$/),
    project: z.string().regex(/^hexdailydata-v2-[a-z0-9-]+$/),
    instance: z.uuid(),
    storagePath: path,
    quotaPath: path,
    profile: profileSchema,
    origin: z.literal(1),
    transport: z.literal(369),
    endpoints: z.tuple([z.url(), z.url()]),
    admission: pinnedAuditAdmissionSchema,
    canonicalDigest: sha,
    inventoryDigest: sha,
    // Old state is never imported. These identities only exclude old/spent roots.
    excludedRootIdentities: z
      .array(z.string().regex(/^\d+:\d+$/))
      .min(2)
      .max(32),
    target: uint,
    milestones: z.array(uint).min(1).max(256),
    finalityHeaders: z.strictObject({ minimum: uint, maximum: uint }),
    methods: z.union([
      z.tuple([
        z.literal('eth_chainId'),
        z.literal('eth_getBlockByNumber'),
        z.literal('eth_getCode'),
        z.literal('eth_getLogs'),
        z.literal('eth_call'),
      ]),
      z.tuple([
        z.literal('eth_chainId'),
        z.literal('eth_getBlockByNumber'),
        z.literal('eth_getCode'),
        z.literal('eth_call'),
      ]),
    ]),
    caps: z.strictObject({
      milliseconds: positive.max(1209600000),
      http: positive,
      logical: positive,
      bytes: positive.min(8388608),
      responseBytes: z.literal(4194304),
    }),
    segment: segmentSchema,
    expiresAt: positive.nullable(),
    resumePolicy: z.literal('same-operation-clean-or-proven-quiescent'),
    cost: z.strictObject({
      policy: z.literal('no-paid-overage'),
      maximumUsd: z.literal(0),
      basis: z.string().min(12).max(400),
    }),
  })
  .superRefine((p, ctx) => {
    const bad = (message: string) => ctx.addIssue({ code: 'custom', message });
    if (
      p.storagePath === p.quotaPath ||
      p.storagePath.startsWith(p.quotaPath + '/') ||
      p.quotaPath.startsWith(p.storagePath + '/')
    )
      bad('Distinct non-nested operation roots required.');
    if (
      p.profile.commonHistory !== 'pulsechain' ||
      p.profile.policy.mode !== 'finalized' ||
      digest(profileBinding(p.profile, 1)) !== p.admission.sourceBindingDigest ||
      BigInt(p.admission.checkpoint.number) < BigInt(p.profile.constructor.checkpoint.number) ||
      BigInt(p.admission.counts.accounts) < 1n ||
      BigInt(p.admission.counts.accounts) > BigInt(Number.MAX_SAFE_INTEGER)
    )
      bad('Exact populated finalized origin1 / transport369 admission required.');
    if (p.auditOnly) {
      if (
        p.target !== p.admission.checkpoint.number ||
        p.milestones.length !== 1 ||
        p.milestones[0] !== p.target ||
        p.methods.length !== 4
      )
        bad('Audit-only requires exactly the admitted target and four read-only methods.');
    } else {
      if (p.methods.length !== 5) bad('Replay requires its existing five methods.');
      let previous = BigInt(p.admission.checkpoint.number);
      for (const milestone of p.milestones) {
        if (BigInt(milestone) <= previous || BigInt(milestone) > BigInt(p.target))
          bad('Milestones must be strictly forward and ordered within target.');
        previous = BigInt(milestone);
      }
    }
    if (p.milestones.at(-1) !== p.target || BigInt(p.target) > BigInt(p.profile.fork.parent.number))
      bad('Mandatory final audit at target, at/before common parent required.');
    if (
      BigInt(p.finalityHeaders.minimum) < BigInt(p.profile.target.number) ||
      BigInt(p.finalityHeaders.maximum) < BigInt(p.finalityHeaders.minimum) ||
      BigInt(p.finalityHeaders.maximum) > 100000000n
    )
      bad('Invalid finality observation corridor.');
    const pair = p.profile.ethereum;
    if (
      pair[0].id === pair[1].id ||
      (pair[0].operator !== null &&
        pair[0].operator.toLowerCase() === pair[1].operator?.toLowerCase()) ||
      pair[0].endpointEnv === pair[1].endpointEnv ||
      p.endpoints[0] === p.endpoints[1]
    )
      bad('Distinct declared sources required.');
    for (const url of p.endpoints) {
      const u = new URL(url);
      if (u.protocol !== 'https:' || u.username || u.password || u.search || u.hash)
        bad('Explicit nonsecret HTTPS endpoints required.');
    }
  });
export type ReconstructionPlan = z.infer<typeof reconstructionPlanSchema>;
export function reconstructionAuthority(
  p: ReconstructionPlan,
  approval: unknown,
  env: NodeJS.ProcessEnv,
) {
  z.strictObject({
    run: z.literal(p.run),
    planDigest: z.literal(digest(p)),
    release: z.literal(p.release),
    reviewedCommit: z.literal(p.reviewedCommit),
    instance: z.literal(p.instance),
    decision: z.literal('owner-approved-bounded-reconstruction'),
    resumePolicy: z.literal(p.resumePolicy),
  }).parse(approval);
  if (env.HDD_V2_RECONSTRUCTION_OPT_IN !== p.run || env.HDD_V2_ALLOW_LIVE_RPC !== 'true')
    throw Error('Reconstruction requires its own approval and opt-in.');
}
