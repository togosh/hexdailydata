import type pg from "pg";
import { randomUUID } from "node:crypto";
export const RPC_RESERVATION = 4194304;
export type DailyPolicy = {
  combined: { calls: number; bytes: number };
  sources: readonly [{ identity: string; calls: number; bytes: number }, { identity: string; calls: number; bytes: number }];
};
export function validatePolicy(input: DailyPolicy): DailyPolicy {
  const limit = (v: any) => {
    if (!v || Object.keys(v).some(k => !["identity", "calls", "bytes"].includes(k)) ||
        !Number.isSafeInteger(v.calls) || v.calls < 1 || !Number.isSafeInteger(v.bytes) || v.bytes < 1)
      throw Error("INVALID_DAILY_POLICY");
    return { calls: v.calls, bytes: v.bytes };
  };
  if (!input || Object.keys(input).sort().join() !== "combined,sources" || !Array.isArray(input.sources) || input.sources.length !== 2)
    throw Error("INVALID_DAILY_POLICY");
  const combined = limit(input.combined);
  if (Object.keys(input.combined).sort().join() !== "bytes,calls") throw Error("INVALID_DAILY_POLICY");
  const sources = input.sources.map(s => {
    const limits = limit(s);
    if (typeof s.identity !== "string" || !/^[\x21-\x7e]{1,256}$/.test(s.identity)) throw Error("INVALID_SOURCE_IDENTITY");
    return { identity: s.identity, ...limits };
  }) as unknown as DailyPolicy["sources"];
  if (sources[0].identity === sources[1].identity) throw Error("DISTINCT_SOURCE_SLOTS_REQUIRED");
  return { combined, sources };
}
export class BudgetUnavailable extends Error {
  readonly budget: { state: string; day: string; nextEligible: string };
  constructor(reason: string, day: string, nextEligible: string) {
    super(reason); this.budget = { state: "unavailable", day, nextEligible };
  }
}
// Lock is always last: existing account/issuance -> stream -> tick -> budget.
// Install uses migration -> budget and never locks an account/stream/tick.
export async function budgetPolicy(q: pg.PoolClient) {
  await q.query("SELECT pg_advisory_xact_lock(733107,1)");
  const { rows: [schema] } = await q.query("SELECT to_regclass('public.payment_budget_policy') present");
  if (!schema.present) return null;
  const { rows: [row] } = await q.query("SELECT config FROM payment_budget_policy WHERE singleton");
  return row ? validatePolicy(row.config) : null;
}
export function bindSources(policy: DailyPolicy | null, identities?: readonly [string, string]) {
  if (!policy && identities) throw Error("DAILY_POLICY_REQUIRED");
  if (policy && (!identities || identities.some((v, i) => v !== policy.sources[i].identity) || identities.length !== 2))
    throw Error("DAILY_SOURCE_BINDING_REQUIRED");
}
async function window(q: pg.PoolClient) {
  const { rows: [r] } = await q.query(`SELECT payment_budget_now() instant, highest_day::text highest, highest_time FROM payment_budget_state WHERE singleton`);
  if (!r || !(r.instant instanceof Date) || !Number.isFinite(+r.instant)) throw Error("BUDGET_CLOCK_UNAVAILABLE");
  const day = r.instant.toISOString().slice(0, 10);
  const next = new Date(Date.parse(day + "T00:00:00Z") + 86400000).toISOString();
  if ((r.highest && day < r.highest) || (r.highest_time && +r.instant < +r.highest_time)) throw new BudgetUnavailable("DAILY_CLOCK_BEHIND", day, r.highest_time?.toISOString() ?? r.highest + "T00:00:00.000Z");
  return { day, next, instant: r.instant };
}
async function capacity(q: pg.PoolClient, policy: DailyPolicy, day: string, slots: number[]) {
  const { rows } = await q.query("SELECT slot,calls,bytes FROM payment_budget_day WHERE day=$1", [day]);
  for (const slot of [-1, ...slots]) {
    const count = slot === -1 ? slots.length : 1;
    const used = rows.find(r => r.slot === slot) ?? { calls: 0, bytes: 0 };
    const cap = slot === -1 ? policy.combined : policy.sources[slot];
    if (BigInt(used.calls) + BigInt(count) > BigInt(cap.calls) ||
        BigInt(used.bytes) + BigInt(count * RPC_RESERVATION) > BigInt(cap.bytes)) return false;
  }
  return true;
}
// Admission is a locked check, not a financial or future RPC reservation.
export async function invoiceBudget(q: pg.PoolClient) {
  const policy = await budgetPolicy(q);
  if (!policy) return;
  const w = await window(q);
  const { rows: [pending] } = await q.query("SELECT count(*)::int n FROM payment_budget_pending WHERE expires_at>$1 AND day>=$2::date-1", [w.instant,w.day]);
  if (pending.n > 4094 || !await capacity(q, policy, w.day, [0, 1])) throw new BudgetUnavailable("DAILY_BUDGET_EXHAUSTED", w.day, w.next);
}
export async function reserveBudget(q: pg.PoolClient, slot: number, identities?: readonly [string, string]) {
  if (slot !== 0 && slot !== 1) throw Error("INVALID_SOURCE_SLOT");
  const policy = await budgetPolicy(q);
  bindSources(policy, identities);
  if (!policy) return null;
  const w = await window(q);
  if (!await capacity(q, policy, w.day, [slot])) throw new BudgetUnavailable("DAILY_BUDGET_EXHAUSTED", w.day, w.next);
  // Retain 32 compact daily aggregates. At most 4096 pending settlements,
  // each valid for 60 seconds. Settled tokens are deleted, never reusable.
  await q.query("DELETE FROM payment_budget_pending WHERE expires_at<=$1 OR day<$2::date-1", [w.instant, w.day]);
  await q.query("DELETE FROM payment_budget_day WHERE day<$1::date-31", [w.day]);
  const { rows: [pending] } = await q.query("SELECT count(*)::int n FROM payment_budget_pending");
  if (pending.n >= 4096) throw new BudgetUnavailable("DAILY_SETTLEMENT_CAPACITY", w.day, w.next);
  await q.query("UPDATE payment_budget_state SET highest_day=$1,highest_time=$2 WHERE singleton", [w.day,w.instant]);
  for (const s of [-1, slot]) await q.query(`INSERT INTO payment_budget_day VALUES($1,$2,1,$3)
    ON CONFLICT(day,slot) DO UPDATE SET calls=payment_budget_day.calls+1,bytes=payment_budget_day.bytes+$3`, [w.day, s, RPC_RESERVATION]);
  const token = randomUUID();
  await q.query("INSERT INTO payment_budget_pending VALUES($1,$2,$3,$4,$5)", [token, w.day, slot, w.instant, new Date(+w.instant + 60000)]);
  return token;
}
// Caller owns the same transaction as its tick/stream byte correction. A false
// result means keep all conservative charges and discard response evidence.
export async function settleBudget(q: pg.PoolClient, token: string, size: number) {
  if (!Number.isSafeInteger(size) || size < 0 || size > RPC_RESERVATION) throw Error("INVALID_SETTLEMENT_BYTES");
  const policy = await budgetPolicy(q);
  if (!policy) return false;
  const { rows: [clock] } = await q.query("SELECT payment_budget_now() instant,highest_time FROM payment_budget_state WHERE singleton");
  const behind = clock.highest_time && +clock.instant < +clock.highest_time;
  const { rows: [r] } = await q.query(`DELETE FROM payment_budget_pending WHERE token=$1
    RETURNING day::text,slot,created_at<=$2 AND expires_at>$2 AND
    day>=(SELECT highest_day-1 FROM payment_budget_state WHERE singleton) valid`, [token,clock.instant]);
  await q.query("UPDATE payment_budget_state SET highest_time=greatest(highest_time,$1) WHERE singleton", [clock.instant]);
  if (behind) return false;
  if (!r || !r.valid) return false;
  const result = await q.query("UPDATE payment_budget_day SET bytes=bytes-$3 WHERE day=$1 AND slot IN(-1,$2) AND bytes>=$3", [r.day, r.slot, RPC_RESERVATION - size]);
  if (result.rowCount !== 2) throw Error("BUDGET_SETTLEMENT_STATE");
  return true;
}
