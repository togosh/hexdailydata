import { METER_ROUTES } from "./meter-routes.js";
import { windowReminderKey } from "./calendar-reminders.js";
import { accountRecipient } from "./account-mail.js";
import type pg from "pg";
import { randomUUID } from "node:crypto";
import { checkAccess } from "./access.js";
import { selectPeriods, reminderKey } from "./period.js";
import { Denied } from "./db.js";

export type Hold = { id: string; accountId: string } & (
  { day: string; periodId?: never; windowId?: never } | { day?: never; periodId: string; windowId?: string }
);
export type Outcome =
  "pending" | "success" | "released" | "expired" | "missing";
export type Work = { signal?: AbortSignal; deadline?: number };
export class ReserveUncertain extends Error {
  constructor(public hold: Hold) {
    super("RESERVE_UNCERTAIN");
  }
}
const stop = () => new Error("METER_CANCELLED_OR_DEADLINE");

// Count underlying work, including pg acquisitions whose caller already aborted.
// Shared across meter instances in this process; no queue is created when full.
const ownedWork = new Set<Promise<void>>();
function ownWork() {
  if (ownedWork.size >= 64) throw Error("METER_WORK_LIMIT");
  let resolve!: () => void;
  const done = new Promise<void>((r) => {
    resolve = r;
  });
  ownedWork.add(done);
  return () => {
    ownedWork.delete(done);
    resolve();
  };
}
async function drainWork() {
  if (!ownedWork.size) return;
  let timer: ReturnType<typeof setTimeout>;
  try {
    await Promise.race([
      Promise.all([...ownedWork]),
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(Error("METER_DRAIN_DEADLINE")), 3000);
      }),
    ]);
  } finally {
    clearTimeout(timer!);
  }
}

// End the underlying connection on abort, not just the waiting Promise. A pool wait
// cannot be removed through pg's public API; any late lease is destroyed immediately.
export async function boundedTransaction<T>(
  pool: pg.Pool,
  work: Work,
  fn: (q: pg.PoolClient) => Promise<T>,
): Promise<T> {
  const releaseWork = ownWork();
  let acquisitionPending = false,
    callerFinished = false;
  const releaseIfDone = () => {
    if (callerFinished && !acquisitionPending) releaseWork();
  };
  const deadline = Math.min(
    work.deadline ?? Infinity,
    performance.now() + 5000,
  );
  const controller = new AbortController();
  const signal = work.signal
    ? AbortSignal.any([work.signal, controller.signal])
    : controller.signal;
  const timer = setTimeout(
    () => controller.abort(),
    Math.max(0, deadline - performance.now()),
  );
  let client: pg.PoolClient | undefined,
    retired = false;
  const check = () => {
    if (signal.aborted || performance.now() >= deadline) throw stop();
  };
  const retire = () => {
    if (client && !retired) {
      retired = true;
      client.release(true);
    }
  };
  try {
    check();
    client = await new Promise<pg.PoolClient>((resolve, reject) => {
      let settled = false;
      const aborted = () => {
        if (!settled) {
          settled = true;
          reject(stop());
        }
      };
      signal.addEventListener("abort", aborted, { once: true });
      acquisitionPending = true;
      Promise.resolve()
        .then(() => pool.connect())
        .then(
          (c) => {
            signal.removeEventListener("abort", aborted);
            if (settled || signal.aborted || performance.now() >= deadline) {
              c.release(true);
              if (!settled) reject(stop());
            } else {
              settled = true;
              resolve(c);
            }
            acquisitionPending = false;
            releaseIfDone();
          },
          (e) => {
            signal.removeEventListener("abort", aborted);
            if (!settled) {
              settled = true;
              reject(e);
            }
            acquisitionPending = false;
            releaseIfDone();
          },
        );
    });
    signal.addEventListener("abort", retire, { once: true });
    check();
    const raw = client;
    const q = new Proxy(raw, {
      get(target, key) {
        if (key === "query")
          return (...args: any[]) => {
            check();
            return (target.query as any).apply(target, args);
          };
        const value = Reflect.get(target, key);
        return typeof value === "function" ? value.bind(target) : value;
      },
    });
    await q.query("BEGIN");
    await q.query("SELECT set_config('statement_timeout',$1,true)", [
      String(Math.max(1, Math.floor(deadline - performance.now()))),
    ]);
    const result = await fn(q);
    check();
    await q.query("COMMIT");
    check();
    return result;
  } catch (e) {
    retire();
    throw e;
  } finally {
    clearTimeout(timer);
    signal.removeEventListener("abort", retire);
    if (client && !retired) client.release();
    callerFinished = true;
    releaseIfDone();
  }
}

type Options = {
  mode?: "daily" | "period";
  // Private constructor seams for short deterministic tests, never HTTP input.
  leaseMs?: number;
  clock?: (q: pg.PoolClient) => Promise<Date>;
};
export class SuccessMeter {
  pendingWork() {
    return ownedWork.size;
  }
  // Caller must close admission first. Fails explicitly if draining cannot finish.
  async drain() {
    await drainWork();
  }
  readonly leaseMs: number;
  readonly mode: "daily" | "period";
  private clock: (q: pg.PoolClient) => Promise<Date>;
  constructor(
    readonly pool: pg.Pool,
    options: Options = {},
  ) {
    this.mode = options.mode ?? "daily";
    this.leaseMs = options.leaseMs ?? 60000;
    if (
      !Number.isInteger(this.leaseMs) ||
      this.leaseMs < 1 ||
      this.leaseMs > 60000
    )
      throw Error("INVALID_LEASE");
    this.clock =
      options.clock ??
      (async (q) =>
        (await q.query("SELECT clock_timestamp() instant")).rows[0].instant);
  }
  private handle(h: Hold) {
    if (
      !/^[a-f0-9-]{36}$/.test(h.id) ||
      !h.accountId ||
      h.accountId.length > 100 ||
      (h.windowId !== undefined && (!h.periodId || !/^[a-f0-9-]{36}$/.test(h.windowId))) ||
      !(h.periodId
        ? h.day === undefined && /^[a-f0-9-]{36}$/.test(h.periodId)
        : h.periodId === undefined && /^\d{4}-\d{2}-\d{2}$/.test(h.day ?? ""))
    )
      throw Error("INVALID_HOLD");
  }
  async reserve(
    key: string,
    route: string,
    method: string,
    work: Work = {},
  ): Promise<Hold> {
    if (
      !(METER_ROUTES as readonly string[]).includes(route) ||
      !["GET", "HEAD"].includes(method)
    )
      throw Error("INVALID_SCOPE");
    let hold: Hold | undefined;
    let committing = false;
    try {
      const result = await boundedTransaction(this.pool, work, async (q) => {
        const { accountId, instant } = await checkAccess(
          q,
          key,
          () => this.clock(q),
          this.mode === "daily",
        );
        const period =
          this.mode === "period"
            ? (await selectPeriods(q, accountId, instant)).current
            : null;
        if (this.mode === "period" && !period)
          throw new Denied("PERIOD_ACCESS_EXPIRED", 403);
        const day = instant.toISOString().slice(0, 10),
          minute = new Date(Math.floor(+instant / 60000) * 60000);
        const {
          rows: [attempt],
        } = await q.query(
          `INSERT INTO burst_bucket(account_id,minute,units) VALUES($1,$2,1)
          ON CONFLICT(account_id) DO UPDATE SET minute=excluded.minute,
          units=CASE WHEN burst_bucket.minute=excluded.minute THEN burst_bucket.units+1 ELSE 1 END
          WHERE burst_bucket.minute<>excluded.minute OR burst_bucket.units<30 RETURNING units`,
          [accountId, minute],
        );
        if (!attempt) return { denied: "BURST_LIMIT" };
        await q.query(
          `UPDATE meter_receipt SET state='expired',terminal_at=$2,reason='expired'
          WHERE id IN (SELECT id FROM meter_receipt WHERE account_id=$1 AND state='pending' AND expires_at<=$2 ORDER BY expires_at,id LIMIT 8)`,
          [accountId, instant],
        );
        if (period) {
          const {
            rows: [n],
          } = await q.query(
            `SELECT count(*)::int pending FROM meter_receipt
            WHERE account_id=$1 AND state='pending' AND expires_at>$2`,
            [accountId, instant],
          );
          if (n.pending >= 8) return { denied: "PENDING_LIMIT" };
          if (period.used + period.held >= period.allowance)
            return { denied: "PERIOD_QUOTA" };
          hold = { id: randomUUID(), accountId, periodId: period.id, ...(period.kind === "calendar-v1" ? {windowId:period.window!.id} : {}) };
          await q.query(
            `INSERT INTO meter_receipt(id,account_id,period_id,created_at,expires_at,state,route,method,window_id)
            VALUES($1,$2,$3,$4,$5,'pending',$6,$7,$8)`,
            [
              hold.id,
              accountId,
              period.id,
              instant,
              new Date(+instant + this.leaseMs),
              route,
              method,
              hold.windowId ?? null,
            ],
          );
          committing = true;
          return { hold };
        }
        const {
          rows: [counts],
        } = await q.query(
          `SELECT
          (SELECT coalesce(sum(units),0)::int FROM usage_bucket WHERE account_id=$1 AND day=$2::date) used,
          count(*)::int pending,count(*) FILTER(WHERE day=$2::date)::int today
          FROM meter_receipt WHERE account_id=$1 AND state='pending' AND expires_at>$3`,
          [accountId, day, instant],
        );
        if (counts.pending >= 8) return { denied: "PENDING_LIMIT" };
        if (counts.used + counts.today >= 100) return { denied: "DAILY_QUOTA" };
        hold = { id: randomUUID(), accountId, day };
        await q.query(
          `INSERT INTO meter_receipt(id,account_id,day,created_at,expires_at,state,route,method)
          VALUES($1,$2,$3,$4,$5,'pending',$6,$7)`,
          [
            hold.id,
            accountId,
            day,
            instant,
            new Date(+instant + this.leaseMs),
            route,
            method,
          ],
        );
        committing = true;
        return { hold };
      });
      if (result.denied) throw new Denied(result.denied, 429);
      return result.hold!;
    } catch (e) {
      // Even a rollback-looking application error after COMMIT can be ambiguous.
      if (hold && committing) throw new ReserveUncertain(hold);
      throw e;
    }
  }
  async finalize(
    h: Hold,
    success: boolean,
    status: number | null,
    reason: "error" | "disconnect" | "uncertain" = "error",
    work: Work = {},
  ): Promise<Outcome> {
    this.handle(h);
    if (success && status !== 200 && status !== 304)
      throw Error("INELIGIBLE_SUCCESS");
    return boundedTransaction(this.pool, work, async (q) => {
      // Terminalization deliberately does not reauthorize a revoked/disabled customer.
      await q.query("SELECT id FROM customer WHERE id=$1 FOR UPDATE", [
        h.accountId,
      ]);
      const {
        rows: [r],
      } = await q.query(
        h.periodId
          ? "SELECT state,expires_at FROM meter_receipt WHERE id=$1 AND account_id=$2 AND period_id=$3 AND day IS NULL AND window_id IS NOT DISTINCT FROM $4::uuid"
          : "SELECT state,expires_at FROM meter_receipt WHERE id=$1 AND account_id=$2 AND day=$3::date AND period_id IS NULL",
        [h.id, h.accountId, h.periodId ?? h.day,...(h.periodId ? [h.windowId ?? null] : [])],
      );
      if (!r) return "missing";
      if (r.state !== "pending") return r.state as Outcome;
      const instant = await this.clock(q);
      const state: Outcome =
        +r.expires_at <= +instant
          ? "expired"
          : success
            ? "success"
            : "released";
      if (state === "success" && h.periodId) {
        const {
          rows: [u],
        } = await q.query(
          h.windowId ? `UPDATE window_usage u SET used=u.used+1 FROM allowance_window w
          WHERE u.account_id=$1 AND u.term_id=$2 AND u.window_id=$3
          AND (w.account_id,w.term_id,w.id)=(u.account_id,u.term_id,u.window_id)
          AND u.used<w.allowance RETURNING u.used,w.threshold reminder_threshold` :
          `UPDATE period_usage u SET used=u.used+1 FROM grant_record g
          WHERE u.account_id=$1 AND u.period_id=$2 AND g.id=u.period_id AND g.account_id=u.account_id
          AND g.allowance IS NOT NULL AND u.used<g.allowance RETURNING u.used,g.reminder_threshold`,
          [h.accountId, h.periodId,...(h.windowId ? [h.windowId] : [])],
        );
        if (!u) throw new Denied("PERIOD_UNAVAILABLE", 503);
        if (u.used === u.reminder_threshold)
          await q.query(
            `INSERT INTO outbox(id,dedup,recipient,subject,body)
          SELECT gen_random_uuid(),$2,$3,'Lab period quota reminder','Synthetic period usage threshold reached.'
          FROM "user" WHERE id=$1 AND $3::text IS NOT NULL ON CONFLICT(dedup) DO NOTHING`,
            [
              h.accountId,
              h.windowId ? windowReminderKey(h.accountId,h.periodId,h.windowId,u.reminder_threshold) : reminderKey(h.accountId, h.periodId, u.reminder_threshold),
              await accountRecipient(q, h.accountId),
            ],
          );
      }
      if (state === "success" && !h.periodId) {
        // An old day-bound receipt may outlive the purchase of a calendar term.
        // Only this already-admitted receipt can pass the legacy write guard.
        await q.query("SELECT set_config('app.settling_daily_receipt',$1,true)",[h.id]);
        const {
          rows: [u],
        } = await q.query(
          `INSERT INTO usage_bucket(account_id,day,units) VALUES($1,$2,1)
          ON CONFLICT(account_id,day) DO UPDATE SET units=usage_bucket.units+1 WHERE usage_bucket.units<100 RETURNING units`,
          [h.accountId, h.day],
        );
        if (!u) throw Error("SUCCESS_CAPACITY_INVARIANT");
        if (u.units === 90)
          await q.query(
            `INSERT INTO outbox(id,dedup,recipient,subject,body)
          SELECT gen_random_uuid(),$2,$3,'Lab quota reminder','90 of 100 synthetic API requests completed successfully in this UTC day.'
          FROM "user" WHERE id=$1 AND $3::text IS NOT NULL ON CONFLICT(dedup) DO NOTHING`,
            [h.accountId, "quota:" + h.accountId + ":" + h.day, await accountRecipient(q, h.accountId)],
          );
      }
      await q.query(
        "UPDATE meter_receipt SET state=$2,terminal_at=$3,status=$4,reason=$5 WHERE id=$1",
        [
          h.id,
          state,
          instant,
          status,
          state === "expired"
            ? "expired"
            : state === "success"
              ? "completed"
              : reason,
        ],
      );
      return state;
    });
  }
  async maintain(limit = 128, work: Work = {}) {
    if (!Number.isInteger(limit) || limit < 1 || limit > 128)
      throw Error("INVALID_MAINTENANCE_BOUND");
    const deadline = Math.min(
      work.deadline ?? Infinity,
      performance.now() + 5000,
    );
    const rows = await boundedTransaction(
      this.pool,
      { ...work, deadline },
      async (q) => {
        const now = await this.clock(q);
        return (
          await q.query(
            `SELECT id,account_id,day::text FROM meter_receipt WHERE
        (state='pending' AND expires_at<=$1) OR (state<>'pending' AND terminal_at<$1::timestamptz-interval '7 days')
        ORDER BY created_at,id LIMIT $2`,
            [now, limit],
          )
        ).rows;
      },
    );
    let expired = 0,
      deleted = 0;
    for (const r of rows)
      await boundedTransaction(this.pool, { ...work, deadline }, async (q) => {
        await q.query("SELECT id FROM customer WHERE id=$1 FOR UPDATE", [
          r.account_id,
        ]);
        const now = await this.clock(q);
        expired +=
          (
            await q.query(
              "UPDATE meter_receipt SET state='expired',terminal_at=$2,reason='expired' WHERE id=$1 AND state='pending' AND expires_at<=$2",
              [r.id, now],
            )
          ).rowCount ?? 0;
        deleted +=
          (
            await q.query(
              "DELETE FROM meter_receipt WHERE id=$1 AND state<>'pending' AND terminal_at<$2::timestamptz-interval '7 days'",
              [r.id, now],
            )
          ).rowCount ?? 0;
      });
    return { selected: rows.length, expired, deleted };
  }
}
