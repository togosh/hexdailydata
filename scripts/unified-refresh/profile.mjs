// Finite profile policy for the existing coordinator. This version is offline only.
import { z } from 'zod';
export const profileId = 'unified-five-feed-offline-1';
export const profileTask = 'HDD-UNIFIED-REFRESH-INTEGRATION-R2';
export const families = ['market', 'gas', 'protocol', 'participants', 'trade'];
export const counterKeys = [
  'graphAttempts',
  'rpcAttempts',
  'httpAttempts',
  'graphExtras',
  'rpcExtras',
  'httpExtras',
  'graphChargedBytes',
  'rpcChargedBytes',
  'httpChargedBytes',
  'chargedEntities',
];
const integer = z.number().int().nonnegative();
const counters = Object.fromEntries(counterKeys.map((k) => [k, integer]));
// Existing single-job ceilings; a profile may reduce, never enlarge them.
const MiB = 1024 ** 2;
const ceilings = {
  market: [24, 56, 0, 4, 0, 0, 2 * MiB, 2 * MiB, 0, 10000, 600, 1, 0],
  gas: [0, 24, 0, 0, 2, 0, 0, 6 * MiB, 0, 20000, 600, 0, 0],
  protocol: [0, 28, 0, 0, 4, 0, 0, 6 * MiB, 0, 10000, 600, 0, 0],
  participants: [552, 24, 0, 52, 4, 0, 60 * MiB, 2 * MiB, 0, 120000, 1800, 2, 0],
  trade: [0, 0, 6, 0, 0, 3, 0, 0, 6 * 2162688, 120000, 600, 0, 0],
};
const ceilingKeys = [...counterKeys, 'seconds', 'controlGraphExtras', 'controlRpcExtras'];
const allowance = z.strictObject({
  ...counters,
  seconds: z.number().int().min(90).max(1800),
  publication: z.number().int().min(30).max(180),
  controlGraphExtras: integer,
  controlRpcExtras: integer,
});
const job = z.strictObject({
  id: z.string().regex(/^(market|gas|protocol|participants|trade)-[1-9][0-9]?$/),
  family: z.enum(families),
  due: integer,
  deadline: integer,
  maximumStartLag: integer,
  enabled: z.boolean(),
  tradeSlot: z.number().int().min(1).max(16).optional(),
  target: z.number().int().positive().optional(),
  bounds: allowance,
});
const schema = z.strictObject({
  format: z.literal(profileId),
  mode: z.literal('OFFLINE_ONLY'),
  parent: z.strictObject({
    ...counters,
    seconds: z.number().int().min(600).max(7200),
    closingReserve: z.number().int().min(60).max(300),
    attempts: z.number().int().positive().max(1200),
    chargedBytes: z
      .number()
      .int()
      .positive()
      .max(256 * 1024 ** 2),
    extras: integer,
  }),
  jobs: z.array(job).min(1).max(64),
});
export function validateProfile(value) {
  const p = schema.parse(value),
    seen = new Set();
  let due = -1,
    slot = 0,
    participants = 0;
  for (const j of p.jobs) {
    if (
      seen.has(j.id) ||
      !j.id.startsWith(j.family + '-') ||
      j.due < due ||
      j.deadline <= j.due ||
      j.deadline > p.parent.seconds - p.parent.closingReserve ||
      j.maximumStartLag > j.deadline - j.due ||
      j.bounds.publication >= j.bounds.seconds
    )
      throw Error('FINITE_PROFILE_ORDER_OR_DEADLINE');
    seen.add(j.id);
    due = j.due;
    for (let i = 0; i < ceilingKeys.length; i++)
      if (j.bounds[ceilingKeys[i]] > ceilings[j.family][i])
        throw Error('EXISTING_FAMILY_CEILING:' + ceilingKeys[i]);
    for (const p of ['graph', 'rpc', 'http'])
      if (j.bounds[p + 'Extras'] > j.bounds[p + 'Attempts']) throw Error('RETRY_EXCEEDS_ATTEMPTS');
    if (
      j.bounds.controlGraphExtras > j.bounds.graphExtras ||
      j.bounds.controlRpcExtras > j.bounds.rpcExtras
    )
      throw Error('CONTROL_EXTRAS_EXCEED_TOTAL');
    if (j.family === 'trade') {
      if (
        j.tradeSlot !== ++slot ||
        j.target !== undefined ||
        j.bounds.httpAttempts > 6 ||
        j.bounds.httpExtras > 3 ||
        j.bounds.graphAttempts ||
        j.bounds.rpcAttempts
      )
        throw Error('FINITE_TRADE_SLOT');
    } else if (
      j.tradeSlot !== undefined ||
      j.bounds.httpAttempts ||
      j.bounds.httpExtras ||
      j.bounds.httpChargedBytes
    )
      throw Error('FINITE_FAMILY_PROTOCOL');
    if (j.family === 'participants') {
      if (++participants > 1 || (j.enabled && !j.target))
        throw Error('BOUNDED_PARTICIPANT_TARGET_REQUIRED');
    } else if (j.target !== undefined) throw Error('UNEXPECTED_PARTICIPANT_TARGET');
    for (const k of counterKeys)
      if (j.bounds[k] > p.parent[k]) throw Error('CHILD_EXCEEDS_PARENT:' + k);
  }
  if (
    p.parent.graphAttempts + p.parent.rpcAttempts + p.parent.httpAttempts > p.parent.attempts ||
    p.parent.graphChargedBytes + p.parent.rpcChargedBytes + p.parent.httpChargedBytes >
      p.parent.chargedBytes ||
    p.parent.graphExtras + p.parent.rpcExtras + p.parent.httpExtras > p.parent.extras
  )
    throw Error('PARENT_AGGREGATE_LIMIT');
  return p;
}
export function unifiedAdmission(a) {
  if (a.unifiedProfileId === undefined) return false;
  if (
    a.unifiedProfileId !== profileId ||
    a.authorityTaskId !== profileTask ||
    a.synthetic !== true ||
    a.parentMode !== 'OFFLINE_ONLY' ||
    !/^[a-f0-9]{64}$/.test(a.parentProfileSha256 ?? '')
  )
    throw Error('EXACT_OFFLINE_PROFILE_AUTHORITY');
  if (
    a.family === 'trade' &&
    (!Number.isInteger(a.tradeSlot) ||
      a.tradeSlot < 1 ||
      a.tradeSlot > 16 ||
      a.tradeProfileId !== 'unified-single-pair-1' ||
      a.responseCookiePolicyId !== 'ignore-response-cookies-no-replay-v1')
  )
    throw Error('EXACT_OFFLINE_TRADE_PROFILE');
  return true;
}
export function clipJob(profile, j, parent, elapsed) {
  const b = { ...j.bounds };
  for (const k of counterKeys) b[k] = Math.min(b[k], profile.parent[k] - parent[k]);
  b.controlGraphExtras = Math.min(b.controlGraphExtras, b.graphExtras);
  b.controlRpcExtras = Math.min(b.controlRpcExtras, b.rpcExtras);
  b.seconds = Math.min(
    b.seconds,
    j.deadline - elapsed,
    profile.parent.seconds - profile.parent.closingReserve - elapsed,
  );
  const attempts = b.graphAttempts + b.rpcAttempts + b.httpAttempts;
  if (
    counterKeys.some((k) => b[k] < 0) ||
    attempts < 1 ||
    parent.attempts + attempts > profile.parent.attempts ||
    b.seconds <= b.publication + 65
  )
    return null;
  return b;
}
