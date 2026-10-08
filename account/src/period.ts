import { randomUUID } from "node:crypto";
import { calendarKind, calendarWindows, monthBoundary, type CalendarTerms } from "./calendar.js";
import type pg from "pg";
import { Denied, lockAccount } from "./db.js";
import { boundedTransaction, type Work } from "./metering.js";

export type PeriodTerms = {
  id: string;
  accountId: string;
  paymentId: string;
  mode: "card" | "pls" | "hex";
  start: Date;
  end: Date;
  activation: Date;
  plan: string;
  allowance: number;
  threshold: number;
  calendar?: CalendarTerms;
};
export const databaseTime = async (q: pg.PoolClient): Promise<Date> =>
  (await q.query("SELECT clock_timestamp() instant")).rows[0].instant;
const unavailable = () => new Denied("PERIOD_UNAVAILABLE", 503);
const conflict = () => new Denied("PERIOD_CONFLICT", 409);
const uuid = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;

// Internal only: caller owns the trusted credit/grant transaction. No payment proof
// or HTTP transport. Existing unannotated grants are NEVER converted to zero use.
export async function createPeriod(
  q: pg.PoolClient,
  t: PeriodTerms,
  clock = databaseTime,
) {
  if (
    !uuid.test(t.id) ||
    !t.accountId ||
    !t.paymentId ||
    !["pls", "card", "hex"].includes(t.mode) ||
    typeof t.plan !== "string" ||
    !t.plan ||
    t.plan.length > 100 ||
    !Number.isInteger(t.allowance) ||
    t.allowance < 1 ||
    t.allowance > 2147483647 ||
    !Number.isInteger(t.threshold) ||
    t.threshold < 1 ||
    t.threshold > t.allowance ||
    ![t.start, t.end, t.activation].every(
      (d) => d instanceof Date && Number.isFinite(+d),
    ) ||
    +t.start >= +t.end ||
    +t.activation >= +t.end ||
    ((t.mode === "pls" || t.mode === "hex") && !t.calendar &&
      (+t.end - +t.start !== 2592000000 || +t.start < +t.activation))
  )
    throw new Denied("INVALID_PERIOD", 400);
  if (t.calendar && (t.mode !== "hex" || ![1,12].includes(t.calendar.months) ||
    +t.start !== +monthBoundary(t.calendar.anchor,t.calendar.index) ||
    +t.end !== +monthBoundary(t.calendar.anchor,t.calendar.index+t.calendar.months) || +t.start < +t.activation))
    throw new Denied("INVALID_PERIOD",400);
  await lockAccount(q, t.accountId);
  const now = await clock(q);
  const {
    rows: [g],
  } = await q.query("SELECT * FROM grant_record WHERE id=$1 OR payment_id=$2", [
    t.id,
    t.paymentId,
  ]);
  if (g) {
    if (
      g.id !== t.id ||
      g.account_id !== t.accountId ||
      g.payment_id !== t.paymentId ||
      g.mode !== t.mode ||
      +g.starts_at !== +t.start ||
      +g.ends_at !== +t.end ||
      +g.activated_at !== +t.activation ||
      g.plan_revision !== t.plan ||
      g.allowance !== t.allowance ||
      g.reminder_threshold !== t.threshold ||
      g.term_kind !== (t.calendar ? calendarKind : "fixed30") ||
      (t.calendar && (+g.calendar_anchor !== +t.calendar.anchor || g.calendar_index !== t.calendar.index || g.calendar_months !== t.calendar.months))
    )
      throw conflict();
    return periodState(q, g, now);
  }
  const {
    rows: [c],
  } = await q.query(
    `SELECT c.account_id,i.account_id invoice_account,i.mode,p.refund_seen,c.fingerprint credit_fingerprint,p.fingerprint payment_fingerprint
    FROM credit c JOIN invoice i ON i.id=c.invoice_id JOIN payment_identity p ON p.payment_id=c.payment_id
    WHERE c.payment_id=$1`,
    [t.paymentId],
  );
  if (
    !c ||
    c.account_id !== t.accountId ||
    c.invoice_account !== t.accountId ||
    c.mode !== t.mode ||
    c.refund_seen ||
    c.credit_fingerprint !== c.payment_fingerprint ||
    +t.activation > +now ||
    +t.end <= +now
  )
    throw conflict();
  // Serialize all local term creation with admission/refund and reject contractual
  // overlap (even before activation) and a second unrefunded future successor.
  const { rows } = await q.query(
    `SELECT starts_at,ends_at,activated_at FROM grant_record
    WHERE account_id=$1 AND NOT refunded AND activated_at IS NOT NULL
    AND ends_at>least($2::timestamptz,$3::timestamptz)`,
    [t.accountId, t.start, now],
  );
  if (
    rows.some((r) => +r.starts_at < +t.end && +r.ends_at > +t.start) ||
    (+t.start > +now &&
      rows.some((r) => Math.max(+r.starts_at, +r.activated_at) > +now))
  )
    throw conflict();
  await q.query(
    `INSERT INTO grant_record(id,payment_id,account_id,mode,starts_at,ends_at,activated_at,plan_revision,allowance,reminder_threshold,term_kind,calendar_anchor,calendar_index,calendar_months)
    VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)`,
    [
      t.id,
      t.paymentId,
      t.accountId,
      t.mode,
      t.start,
      t.end,
      t.activation,
      t.plan,
      t.allowance,
      t.threshold,
      t.calendar ? calendarKind : "fixed30",t.calendar?.anchor ?? null,t.calendar?.index ?? null,t.calendar?.months ?? null,
    ],
  );
  if (t.calendar) {
    for (let i=0;i<t.calendar.months;i++) {
      const id=randomUUID();
      await q.query(`INSERT INTO allowance_window(id,account_id,term_id,ordinal,starts_at,ends_at,allowance,threshold)
        VALUES($1,$2,$3,$4,$5,$6,$7,$8)`,[id,t.accountId,t.id,i,monthBoundary(t.calendar.anchor,t.calendar.index+i),monthBoundary(t.calendar.anchor,t.calendar.index+i+1),t.allowance,t.threshold]);
      await q.query("INSERT INTO window_usage(account_id,term_id,window_id,used) VALUES($1,$2,$3,0)",[t.accountId,t.id,id]);
    }
  } else await q.query(
    "INSERT INTO period_usage(account_id,period_id,used) VALUES($1,$2,0)",
    [t.accountId, t.id],
  );
  return periodState(
    q,
    (await q.query("SELECT * FROM grant_record WHERE id=$1", [t.id])).rows[0],
    now,
  );
}

async function periodState(q: pg.PoolClient, g: any, now: Date) {
  if (g.term_kind === calendarKind) {
    const c=await calendarWindows(q,g,now), w=c.window;
    if (+g.starts_at<=+now && +now<+g.ends_at && !w) throw unavailable();
    return {id:g.id,kind:calendarKind,start:g.starts_at,end:g.ends_at,activation:g.activated_at,
      plan:g.plan_revision,anchor:g.calendar_anchor,monthIndex:g.calendar_index,months:g.calendar_months,
      refunded:g.refunded,window:w,allowance:g.allowance,threshold:g.reminder_threshold,
      // Compatibility fields describe ONLY the current window. A queued term has no current balance.
      used:w?.used??0,held:w?.held??0,remaining:w?.remaining??0};
  }
  const {
    rows: [u],
  } = await q.query(
    `SELECT used,(SELECT count(*)::int FROM meter_receipt
    WHERE account_id=$1 AND period_id=$2 AND state='pending' AND expires_at>$3) held
    FROM period_usage WHERE account_id=$1 AND period_id=$2`,
    [g.account_id, g.id, now],
  );
  if (!u || u.used < 0 || u.used + u.held > g.allowance) throw unavailable();
  return {
    id: g.id,
    kind: "fixed30",anchor: null,monthIndex: null,months: null,
    window:{id:g.id,ordinal:0,start:g.starts_at,end:g.ends_at,allowance:g.allowance,threshold:g.reminder_threshold,used:u.used,held:u.held,remaining:g.allowance-u.used-u.held},
    start: g.starts_at,
    end: g.ends_at,
    activation: g.activated_at,
    plan: g.plan_revision,
    allowance: g.allowance,
    threshold: g.reminder_threshold,
    refunded: g.refunded,
    used: u.used,
    held: u.held,
    remaining: g.allowance - u.used - u.held,
  };
}

// Caller holds the customer lock and has already sampled trusted time.
export async function selectPeriods(
  q: pg.PoolClient,
  accountId: string,
  now: Date,
) {
  const { rows } = await q.query(
    `SELECT * FROM grant_record WHERE account_id=$1
    AND NOT refunded AND activated_at IS NOT NULL AND ends_at>$2 ORDER BY starts_at,id`,
    [accountId, now],
  );
  const current = rows.filter(
    (g) => Math.max(+g.starts_at, +g.activated_at) <= +now,
  );
  const future = rows.filter(
    (g) => Math.max(+g.starts_at, +g.activated_at) > +now,
  );
  if (
    current.length > 1 ||
    future.length > 1 ||
    rows.some((g, i) =>
      rows
        .slice(i + 1)
        .some((h) => +g.starts_at < +h.ends_at && +g.ends_at > +h.starts_at),
    )
  )
    throw conflict();
  const active = current[0] ? await periodState(q, current[0], now) : null;
  const next = future[0] ? await periodState(q, future[0], now) : null;
  let paidThrough = active?.end ?? null;
  if (active && next && Math.max(+next.start, +next.activation) === +active.end)
    paidThrough = next.end;
  const nextRefresh=active?.window && +active.window.end<+active.end ? active.window.end :
    active && next && +next.start===+active.end ? active.end : null;
  return { current: active, next, paidThrough, nextRefresh };
}

export async function periodSummary(
  pool: pg.Pool,
  accountId: string,
  clock = databaseTime,
  work: Work = {},
) {
  return boundedTransaction(pool, work, async (q) => {
    const {
      rows: [a],
    } = await q.query("SELECT disabled FROM customer WHERE id=$1 FOR UPDATE", [
      accountId,
    ]);
    if (!a) throw new Denied("ACCOUNT_DISABLED", 403);
    const now = await clock(q),
      state = await selectPeriods(q, accountId, now);
    return {
      asOf: now,
      access: !a.disabled && !!state.current,
      disabled: a.disabled,
      ...state,
    };
  });
}

export const reminderKey = (
  account: string,
  period: string,
  threshold: number,
) => "period-quota:" + JSON.stringify([account, period, threshold]);
export async function periodReminderValid(
  pool: pg.Pool,
  key: string,
  clock = databaseTime,
) {
  let value: unknown;
  try {
    value = JSON.parse(key.slice("period-quota:".length));
  } catch {
    return false;
  }
  if (
    !key.startsWith("period-quota:") ||
    !Array.isArray(value) ||
    value.length !== 3 ||
    typeof value[0] !== "string" ||
    typeof value[1] !== "string" ||
    !uuid.test(value[1]) ||
    !Number.isInteger(value[2])
  )
    return false;
  try {
    const s = await periodSummary(pool, value[0], clock);
    return (
      s.access &&
      s.current!.id === value[1] &&
      s.current!.threshold === value[2] &&
      s.current!.used >= value[2]
    );
  } catch (error) {
    // Missing accounts are obsolete. SQL/invariant failures must retry rather
    // than permanently cancelling a reminder as though it were stale.
    if (error instanceof Denied && error.code === "ACCOUNT_DISABLED")
      return false;
    throw error;
  }
}
