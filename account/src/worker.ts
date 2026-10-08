import { calendarReminderValid } from "./calendar-reminders.js";
import { databaseTime } from "./period.js";
import { accountRecipient, mailRecipientValid, cleanAccountMail } from "./account-mail.js";
import { periodReminderValid } from "./period.js";
import type pg from "pg";
import nodemailer from "nodemailer";
import { processEvent, eventSchema } from "./billing.js";
import { Denied } from "./db.js";
// Export the existing cleanup for bounded caller-controlled integration/testing.
// Period aggregates are a different table and are deliberately retained.
export async function cleanupLegacy(p: pg.Pool) {
  await p.query(
    "delete from usage_bucket where day<current_date-7; delete from used_link where expires_at<now(); delete from outbox where delivered_at<now()-interval '7 days'",
  );
}
// Current connected component only. Future disjoint coverage cannot suppress expiry.
export async function coverage(p: pg.Pool) {
  const { rows } = await p.query(
    `select g.* from grant_record g where not g.refunded and g.ends_at>now() order by g.account_id,g.starts_at,g.ends_at`,
  );
  const now = Date.now(),
    found = new Map<string, any>();
  for (const g of rows) {
    const last = found.get(g.account_id);
    if (
      +g.starts_at <= (last ? +last.ends_at : now) &&
      (!last || +g.ends_at > +last.ends_at)
    )
      found.set(g.account_id, g);
  }
  for (const g of found.values()) g.email = await accountRecipient(p, g.account_id);
  return found;
}
export function worker(p: pg.Pool, options: { automatic?: boolean } = {}) {
  const smtp = nodemailer.createTransport({
    host: "inbox",
    port: 1025,
    ignoreTLS: true,
    connectionTimeout: 1500,
    socketTimeout: 1500,
  });
  let stopping = false,
    running: Promise<void> | undefined;
  const work = async () => {
    const { rows: events } = await p.query(
      `select r.event_id,r.payload,coalesce(a.attempts,0) attempts from fake_provider.record r left join reconcile_attempt a on a.event_id=r.event_id where not exists(select 1 from event e where e.id=r.event_id) and (a.event_id is null or (a.state='retry' and a.next_at<=now())) order by coalesce(a.next_at,r.created_at),r.created_at,r.event_id limit 20`,
    );
    for (const r of events) {
      if (stopping) break;
      let state = "done",
        reason: string | null = null;
      try {
        await processEvent(p, eventSchema.parse(r.payload));
      } catch (e) {
        reason =
          e instanceof Denied
            ? e.code
            : (e as Error).name === "ZodError"
              ? "INVALID_EVENT"
              : "TRANSIENT_FAILURE";
        state =
          reason !== "TRANSIENT_FAILURE" || r.attempts + 1 >= 5
            ? "needs_review"
            : "retry";
      }
      await p.query(
        `insert into reconcile_attempt(event_id,attempts,state,reason,next_at) values($1,1,$2,$3,now()+interval '1 second') on conflict(event_id) do update set attempts=reconcile_attempt.attempts+1,state=excluded.state,reason=excluded.reason,updated_at=now(),next_at=now()+least(300,power(2,reconcile_attempt.attempts)) * interval '1 second'`,
        [r.event_id, state, reason],
      );
    }
    if (stopping) return;
    for (const g of (await coverage(p)).values())
      if (g.term_kind !== "calendar-v1" && g.email && +g.ends_at < Date.now() + 3 * 86400000) {
        await p.query(
          `insert into outbox(id,dedup,recipient,subject,body) values(gen_random_uuid(),$1,$2,'Lab expiry reminder',$3) on conflict(dedup) do nothing`,
          [
            "expiry:" + g.id,
            g.email,
            "Your synthetic coverage ends " +
              g.ends_at.toISOString() +
              ". No automatic PLS debit.",
          ],
        );
      }
    await deliverOutbox(p, (message) => smtp.sendMail(message), () => stopping);
    await cleanupLegacy(p);
  };
  const tick = () => {
    if (stopping) return Promise.resolve();
    if (!running)
      running = work().finally(() => {
        running = undefined;
      });
    return running;
  };
  const timer =
    options.automatic === false
      ? undefined
      : setInterval(
          () => void tick().catch(() => console.error("WORKER_RETRY")),
          1000,
        );
  timer?.unref();
  return {
    tick,
    stop: async () => {
      stopping = true;
      if (timer) clearInterval(timer);
      try {
        await running;
      } finally {
        smtp.close();
      }
    },
  };
}

// Existing finite outbox loop, callable without starting payment reconciliation.
export async function deliverOutbox(p: pg.Pool, send: (message: {from:string;to:string;subject:string;text:string;messageId:string}) => Promise<unknown>, stopping=()=>false, clock=databaseTime) {
    if (stopping()) return;
    await cleanAccountMail(p);
    const { rows: mail } = await p.query(
      "select * from outbox where delivered_at is null and cancelled_at is null and attempts<8 and next_at<=now() order by next_at,id limit 10",
    );
    for (const m of mail) {
      if (stopping()) break;
      await p.query(
        "update outbox set attempts=attempts+1,next_at=now()+least(300,5*power(2,attempts))*interval '1 second' where id=$1",
        [m.id],
      );
      if (stopping()) break;
      let valid = true;
      if (m.dedup.startsWith("expiry:"))
        valid = [...(await coverage(p)).values()].some(
          (g) =>
            g.id === m.dedup.slice(7) && +g.ends_at < Date.now() + 3 * 86400000,
        );
      if (m.dedup.startsWith("period-quota:"))
        valid = await periodReminderValid(p, m.dedup, clock);
      if (m.dedup.startsWith("window-quota:") || m.dedup.startsWith("calendar-expiry:"))
        valid = await calendarReminderValid(p,m.dedup,clock);
      if (m.dedup.startsWith("quota:")) {
        const day = m.dedup.slice(-10),
          account = m.dedup.slice(6, -11);
        valid = !!(
          await p.query(
            "select 1 from usage_bucket where account_id=$1 and day=$2::date and day=current_date and units>=90",
            [account, day],
          )
        ).rowCount;
      }
      valid = valid && await mailRecipientValid(p, m);
      if (!valid) {
        await p.query(
          "update outbox set cancelled_at=now(),body='[obsolete reminder suppressed]' where id=$1",
          [m.id],
        );
        continue;
      }
      try {
        await send({
          from: "lab@example.test",
          to: m.recipient,
          subject: m.subject,
          text: m.body,
          messageId: `<${m.id}@example.test>`,
        });
        await p.query(
          "update outbox set delivered_at=now(),body='[delivered]',last_error=null where id=$1",
          [m.id],
        );
      } catch {
        await p.query(
          "update outbox set last_error='SMTP_RETRY_OR_REVIEW' where id=$1",
          [m.id],
        );
      }
    }
    await cleanAccountMail(p);
}
