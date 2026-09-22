import { createHash } from 'node:crypto';
import { readFile, stat } from 'node:fs/promises';
import { z } from 'zod';
import limits from '../../config/limits.json' with { type: 'json' };
import { profileSchema } from '../worker/sync/profile.ts';
import { priceProfileSchema, PriceReader } from '../services/live/price.ts';
import { address, headerSchema, uint } from '../services/projections/input.ts';

const name = z.string().regex(/^[a-zA-Z0-9_-]{1,80}$/);
const path = z
  .string()
  .regex(/^\/[a-zA-Z0-9_/-]+$/)
  .max(256);
const range = z.strictObject({
  chain: z.union([z.literal(1), z.literal(369)]),
  from: uint,
  to: uint,
});
const purpose = z.string().min(8).max(240);
const phase = z.discriminatedUnion('kind', [
  z.strictObject({
    kind: z.literal('capabilities'),
    purpose,
    chain: range.shape.chain,
    at: headerSchema,
  }),
  z.strictObject({
    kind: z.literal('probe'),
    purpose,
    chain: range.shape.chain,
    previous: headerSchema,
    to: uint,
  }),
  z.strictObject({ kind: z.literal('replay'), purpose, basis: z.literal('constructor-prefix') }),
  z.strictObject({
    kind: z.literal('common-prefix'),
    purpose,
    through: uint,
    finalityHeaders: z.strictObject({ minimum: uint, maximum: uint }),
    cadence: z.strictObject({
      rollingMilliseconds: z.literal(60000),
      http: z.literal(12),
      logical: z.literal(360),
      spacingMilliseconds: z.literal(2100),
      quarantineMilliseconds: z.literal(60000),
    }),
    endpoints: z.tuple([
      z.literal('https://rpc.pulsechain.com'),
      z.literal('https://rpc-pulsechain.g4mm4.io'),
    ]),
  }),
  z.strictObject({ kind: z.literal('metrics'), purpose }),
  z.strictObject({
    kind: z.literal('address'),
    purpose,
    address,
    pageSize: z.number().int().min(1).max(100),
  }),
]);
export const canaryPlanSchema = z
  .strictObject({
    version: z.literal(2),
    session: z.uuid(),
    release: z.string().regex(/^sha256:[0-9a-f]{64}$/),
    reviewedCommit: z.string().regex(/^[0-9a-f]{40}$/),
    project: z.string().regex(/^hexdailydata-v2-[a-z0-9-]+$/),
    instance: z.uuid(),
    storagePath: path,
    quotaPath: path,
    sessionPath: z.string().max(280),
    profile: profileSchema,
    price: priceProfileSchema.nullable(),
    identityStatus: z.literal('declared-unverified'),
    correlation: z.enum(['declared-distinct', 'unknown']),
    ranges: z.array(range).min(1).max(12),
    methods: z
      .array(
        z.enum([
          'eth_chainId',
          'eth_getBlockByNumber',
          'eth_getCode',
          'eth_getLogs',
          'eth_getTransactionReceipt',
          'eth_call',
        ]),
      )
      .min(1)
      .max(6),
    allowHeadObservation: z.boolean(),
    phases: z.array(phase).min(1).max(12),
    notConfigured: z.array(z.string().min(1).max(200)).max(12),
    cost: z.strictObject({
      policy: z.literal('no-paid-overage'),
      maximumUsd: z.literal(0),
      basis: z.string().min(12).max(400),
    }),
    caps: z.strictObject({
      milliseconds: z
        .number()
        .int()
        .min(1)
        .max(limits.liveCanary.maximumMinutes * 60000),
      http: z.number().int().min(1).max(limits.liveCanary.maximumHttpRequests),
      logical: z.number().int().min(1).max(limits.liveCanary.maximumLogicalRpcCalls),
      bytes: z.number().int().min(1).max(limits.liveCanary.maximumResponseBytes),
      responseBytes: z.number().int().min(1).max(limits.provider.maximumResponseBytes),
    }),
  })
  .superRefine((p, ctx) => {
    const bad = (message: string) => ctx.addIssue({ code: 'custom', message });
    if (
      p.storagePath === p.quotaPath ||
      p.sessionPath !== p.storagePath + '/canary.json' ||
      [p.storagePath, p.quotaPath].some((s) => s.includes('//') || s.endsWith('/'))
    )
      bad('Distinct normalized storage/quota roots and fixed canary.json required.');
    for (const r of p.ranges)
      if (BigInt(r.from) > BigInt(r.to)) bad('Invalid authorized interval.');
    for (const pair of [p.profile.ethereum, p.profile.pulsechain]) {
      if (
        pair[0].id === pair[1].id ||
        pair[0].endpointEnv === pair[1].endpointEnv ||
        (pair[0].operator !== null &&
          pair[0].operator.toLowerCase() === pair[1].operator?.toLowerCase())
      )
        bad('Independent source pair required.');
      for (const s of pair) {
        if (
          ![s.id, s.accountGroup, ...(s.operator ? [s.operator] : [])].every(
            (v) => name.safeParse(v).success,
          )
        )
          bad('Use nonsecret source aliases.');
        if (s.operator === null && p.correlation !== 'unknown')
          bad('Unknown operator correlation must be disclosed.');
      }
    }
    if (new Set([...p.profile.ethereum, ...p.profile.pulsechain].map((s) => s.id)).size !== 4)
      bad('Source IDs must include chain identity.');
    if (p.caps.bytes < p.caps.responseBytes * 2)
      bad('Reserve one response plus equal chunk headroom.');
    if (
      BigInt(p.profile.constructor.checkpoint.number) > BigInt(p.profile.fork.parent.number) ||
      BigInt(p.profile.fork.entry.number) !== BigInt(p.profile.fork.parent.number) + 1n ||
      p.profile.fork.entry.parentHash !== p.profile.fork.parent.hash ||
      BigInt(p.profile.target.number) < BigInt(p.profile.fork.entry.number)
    )
      bad('Constructor/fork/target declarations are inconsistent.');
    if (p.price) {
      try {
        new PriceReader(p.price, p.profile.contract);
      } catch {
        bad('Invalid price route.');
      }
      if (p.price.chain !== 369) bad('Probe price route must be PulseChain.');
    }
    const contains = (chain: number, n: string) =>
      p.ranges.some(
        (r) => r.chain === chain && BigInt(r.from) <= BigInt(n) && BigInt(n) <= BigInt(r.to),
      );
    for (const ph of p.phases) {
      if (ph.kind === 'common-prefix') {
        if (
          p.phases.length !== 1 ||
          p.price !== null ||
          !p.allowHeadObservation ||
          p.profile.commonHistory !== 'pulsechain' ||
          p.profile.policy.mode !== 'finalized' ||
          p.ranges.length !== 1 ||
          p.ranges[0]!.chain !== 1 ||
          p.ranges[0]!.from !== p.profile.constructor.checkpoint.number ||
          p.ranges[0]!.to !== ph.through ||
          BigInt(ph.through) < BigInt(p.profile.constructor.checkpoint.number) ||
          BigInt(ph.through) > BigInt(p.profile.fork.parent.number) ||
          BigInt(ph.through) - BigInt(p.profile.constructor.checkpoint.number) >= 16384n ||
          BigInt(ph.finalityHeaders.minimum) < BigInt(p.profile.target.number) ||
          BigInt(ph.finalityHeaders.maximum) < BigInt(ph.finalityHeaders.minimum) ||
          BigInt(ph.finalityHeaders.maximum) > 100000000n ||
          p.caps.milliseconds > 3600000 ||
          p.caps.http > 600 ||
          p.caps.logical > 12000 ||
          p.caps.bytes > 268435456 ||
          p.caps.responseBytes > 4194304
        )
          bad(
            'Common prefix requires one bounded origin1 interval, finalized headers and sync-only caps.',
          );
        for (let i = 0; i < 2; i++) {
          const alias = ['HDD_V2_PROVIDER_PULSE_OFFICIAL', 'HDD_V2_PROVIDER_PULSE_G4MM4'][i];
          if (
            p.profile.ethereum[i]!.endpointEnv !== alias ||
            p.profile.pulsechain[i]!.endpointEnv !== alias
          )
            bad('Common prefix requires the two declared public endpoint aliases.');
        }
      }
      if (ph.kind === 'capabilities' && !contains(ph.chain, ph.at.number))
        bad('Capability boundary outside ranges.');
      if (
        ph.kind === 'probe' &&
        (!contains(ph.chain, ph.previous.number) ||
          !contains(ph.chain, ph.to) ||
          BigInt(ph.to) <= BigInt(ph.previous.number) ||
          BigInt(ph.to) - BigInt(ph.previous.number) > 1048576n)
      )
        bad('Probe range invalid.');
      if (ph.kind === 'replay') {
        if (!p.allowHeadObservation)
          bad('Replay finality requires separately permitted head observation.');
        if (
          !p.ranges.some(
            (r) =>
              r.chain === 1 &&
              BigInt(r.from) <= BigInt(p.profile.constructor.checkpoint.number) &&
              BigInt(r.to) >= BigInt(p.profile.fork.parent.number),
          ) ||
          !p.ranges.some(
            (r) =>
              r.chain === 369 &&
              BigInt(r.from) <= BigInt(p.profile.fork.parent.number) &&
              BigInt(r.to) >= BigInt(p.profile.target.number),
          )
        )
          bad('Constructor-prefix replay requires continuous authorized coverage.');
      }
    }
    if (p.phases.filter((ph) => ph.kind === 'replay').length > 1)
      bad('Only one bounded replay phase is supported.');
  });
export type CanaryPlan = z.infer<typeof canaryPlanSchema>;
export function planDigest(plan: CanaryPlan) {
  return createHash('sha256').update(JSON.stringify(plan)).digest('hex');
}
export async function readCanaryJson(path: string) {
  if ((await stat(path)).size > 65536) throw new Error('Canary input exceeds 64KiB.');
  return JSON.parse(await readFile(path, 'utf8')) as unknown;
}
export function checkCanary(input: unknown) {
  const result = canaryPlanSchema.safeParse(input);
  return result.success
    ? {
        state: 'CONFIGURED_LOCALLY',
        digest: planDigest(result.data),
        liveIdentity: 'NOT_VERIFIED',
        authorization: 'NOT_GRANTED',
        missing: result.data.notConfigured,
      }
    : {
        state: 'NOT_CONFIGURED',
        missing: result.error.issues.map((i) => `${i.path.join('.') || 'plan'}: ${i.message}`),
      };
}
export function canaryAuthority(plan: CanaryPlan, approval: unknown, env: NodeJS.ProcessEnv) {
  const expected = z.strictObject({
    session: z.literal(plan.session),
    planDigest: z.literal(planDigest(plan)),
    release: z.literal(plan.release),
    instance: z.literal(plan.instance),
    decision: z.literal('owner-approved-bounded-canary'),
  });
  if (
    !expected.safeParse(approval).success ||
    env.HDD_V2_CANARY_OPT_IN !== plan.session ||
    env.HDD_V2_ALLOW_LIVE_RPC !== 'true'
  )
    throw new Error('Canary requires separate owner approval and session opt-in.');
}
