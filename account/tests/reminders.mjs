import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import {
  p,
  provider,
  sqlUser,
  payload,
  check,
  close,
  inbox,
  sleep,
} from "./fixture.mjs";
import { worker } from "../dist/server/worker.js";
import { createInvoice, processEvent } from "../dist/server/billing.js";
import { createKey, authorizeAndConsume } from "../dist/server/access.js";
const phase = process.argv[2] || "state",
  w = worker(p, { automatic: false });
async function pair(label, gap = false) {
  const u = await sqlUser(label),
    i = await createInvoice(p, u.id, "pls", 30, false);
  await processEvent(p, payload(i, u));
  const j = await createInvoice(p, u.id, "pls", 30, false);
  await processEvent(p, payload(j, u));
  await p.query(
    "update grant_record set starts_at=now()-interval '1 day',ends_at=now()+interval '1 day' where payment_id=$1",
    [i.id],
  );
  await p.query(
    `update grant_record set starts_at=(select ends_at from grant_record where payment_id=$2)+interval '${gap ? 1 : 0} day',ends_at=(select ends_at from grant_record where payment_id=$2)+interval '31 days' where payment_id=$1`,
    [j.id, i.id],
  );
  const g = (
    await p.query("select * from grant_record where payment_id=$1", [i.id])
  ).rows[0];
  return { u, i, j, g };
}
async function notice(f, dedup = "expiry:" + f.g.id) {
  const id = randomUUID();
  await p.query(
    "insert into outbox(id,dedup,recipient,subject,body,next_at) values($1,$2,$3,'Lab expiry reminder','Queued fixture',now()-interval '1 day')",
    [id, dedup, f.u.email],
  );
  return id;
}
const state = async (id) =>
  (
    await p.query(
      "select delivered_at,cancelled_at,attempts,last_error from outbox where id=$1",
      [id],
    )
  ).rows[0];
try {
  if (phase === "state") {
    await check(
      "early renewal suppresses obsolete expiry but a future gap does not suppress current expiry",
      async () => {
        const contiguous = await pair("mail-adjacent"),
          obsolete = await notice(contiguous);
        await w.tick();
        assert.ok((await state(obsolete)).cancelled_at);
        assert.equal((await state(obsolete)).delivered_at, null);
        const gap = await pair("mail-gap", true);
        await w.tick();
        await inbox(gap.u.email, "Lab expiry reminder");
        const row = (
          await p.query("select * from outbox where dedup=$1", [
            "expiry:" + gap.g.id,
          ])
        ).rows[0];
        assert.ok(row.delivered_at);
        const attempts = row.attempts;
        await w.tick();
        await w.tick();
        assert.equal((await state(row.id)).attempts, attempts);
        const refunded = await pair("mail-refund"),
          stale = await notice(refunded);
        await processEvent(p, {
          ...payload(refunded.i, refunded.u),
          eventId: randomUUID(),
          status: "refund",
        });
        await w.tick();
        assert.ok((await state(stale)).cancelled_at);
        return {
          adjacent: "suppressed",
          disjointFuture: "current expiry delivered once in these ticks",
          refundGap: "suppressed",
          emailGuarantee: "at least once",
        };
      },
      "reminders",
    );
    await check(
      "queued quota notification revalidates UTC window before SMTP",
      async () => {
        const u = await sqlUser("mail-quota");
        await p.query("insert into customer(id) values($1)", [u.id]);
        const {
          rows: [d],
        } = await p.query(
          "select (current_date-1)::text old,current_date::text today",
        );
        await p.query(
          "insert into usage_bucket values($1,current_date-1,90),($1,current_date,90)",
          [u.id],
        );
        const old = await notice({ u }, "quota:" + u.id + ":" + d.old),
          current = await notice({ u }, "quota:" + u.id + ":" + d.today);
        await w.tick();
        assert.ok((await state(old)).cancelled_at);
        assert.ok((await state(current)).delivered_at);
        return { oldWindow: "suppressed", currentWindow: "delivered" };
      },
      "reminders",
    );
    await check(
      "renewal during real outbox lock wait is revalidated; shutdown drains owned work",
      async () => {
        const u = await sqlUser("mail-race"),
          i = await createInvoice(p, u.id, "pls", 30, false);
        await processEvent(p, payload(i, u));
        await p.query(
          "update grant_record set ends_at=now()+interval '1 day' where payment_id=$1",
          [i.id],
        );
        const g = (
            await p.query("select * from grant_record where payment_id=$1", [
              i.id,
            ])
          ).rows[0],
          id = await notice({ u, g }),
          q = await p.connect();
        try {
          await q.query("begin");
          await q.query("select id from outbox where id=$1 for update", [id]);
          const tick = w.tick();
          let waited = false;
          for (let n = 0; n < 30; n++) {
            const r = await p.query(
              "select 1 from pg_stat_activity where datname=current_database() and usename=current_user and wait_event_type='Lock' and query like 'update outbox%' ",
            );
            if (r.rowCount) {
              waited = true;
              break;
            }
            await sleep(50);
          }
          assert.ok(waited);
          const next = await createInvoice(p, u.id, "pls", 30, false);
          await processEvent(p, payload(next, u));
          await q.query("commit");
          await tick;
          assert.ok((await state(id)).cancelled_at);
          const pending = await notice({ u }, "shutdown:" + randomUUID());
          await q.query("begin");
          await q.query("select id from outbox where id=$1 for update", [
            pending,
          ]);
          const active = w.tick();
          await sleep(150);
          let stopped = false;
          const stop = w.stop().then(() => (stopped = true));
          await sleep(100);
          assert.equal(stopped, false);
          await q.query("commit");
          await active;
          await stop;
          assert.equal(stopped, true);
          assert.equal((await state(pending)).delivered_at, null);
          return {
            actualRowLockWait: true,
            renewal: "obsolete notice suppressed after wait",
            shutdown:
              "waited for owned work; selected but unsent mail remains pending",
          };
        } finally {
          await q.query("rollback");
          q.release();
        }
      },
      "reminders",
    );
  } else if (phase === "outage")
    await check(
      "real local SMTP outage preserves grant and records retry",
      async () => {
        const u = await sqlUser("mail-outage"),
          i = await createInvoice(p, u.id, "pls", 30, false);
        await processEvent(p, payload(i, u));
        const k = await createKey(p, u.id, "outage");
        assert.equal((await authorizeAndConsume(p, k.secret)).remaining, 99);
        await w.tick();
        const m = (
          await p.query("select * from outbox where dedup=$1", [
            "receipt:" + i.id,
          ])
        ).rows[0];
        assert.ok(m.attempts >= 1);
        assert.equal(m.delivered_at, null);
        assert.equal(m.last_error, "SMTP_RETRY_OR_REVIEW");
        return {
          grant: "committed and usable",
          smtp: "actual owned inbox stopped",
          attempts: m.attempts,
          retryPersisted: true,
        };
      },
      "reminders",
    );
  else if (phase === "retry")
    await check(
      "actual source-app restart and inbox recovery deliver pending receipt at least once",
      async () => {
        const {
          rows: [m],
        } = await p.query(
          `select o.id,o.recipient from outbox o join "user" u on u.email=o.recipient where u.email like 'mail-outage-%' and o.dedup like 'receipt:%' order by o.next_at desc limit 1`,
        );
        assert.ok(m);
        for (let n = 0; n < 50; n++) {
          if ((await state(m.id)).delivered_at) break;
          await sleep(200);
        }
        assert.ok((await state(m.id)).delivered_at);
        assert.ok((await state(m.id)).attempts >= 2);
        await inbox(m.recipient, "LAB simulated purchase receipt");
        return { afterRestart: await state(m.id) };
      },
      "reminders",
    );
  else if (phase === "backoff")
    await check(
      "reconciliation SQL timeout retries have durable finite delay and review ceiling",
      async () => {
        const u = await sqlUser("reconcile-timeout"),
          i = await createInvoice(p, u.id, "pls", 30, false),
          e = payload(i, u),
          q = await p.connect();
        await provider.query(
          "insert into fake_provider.record values($1,$2,$3,now())",
          [e.eventId, e.paymentId, e],
        );
        try {
          await q.query("begin");
          await q.query("select id from customer where id=$1 for update", [
            u.id,
          ]);
          for (let n = 1; n <= 5; n++) {
            await w.tick();
            const r = (
              await p.query(
                "select * from reconcile_attempt where event_id=$1",
                [e.eventId],
              )
            ).rows[0];
            assert.equal(r.attempts, n);
            assert.equal(r.state, n === 5 ? "needs_review" : "retry");
            assert.equal(r.reason, "TRANSIENT_FAILURE");
            assert.ok(+r.next_at > +r.updated_at);
            if (n < 5)
              await p.query(
                "update reconcile_attempt set next_at=now() where event_id=$1",
                [e.eventId],
              );
          }
          await q.query("commit");
          await w.tick();
          assert.equal(
            (
              await p.query(
                "select attempts from reconcile_attempt where event_id=$1",
                [e.eventId],
              )
            ).rows[0].attempts,
            5,
          );
          assert.equal(
            (
              await p.query("select 1 from credit where payment_id=$1", [
                e.paymentId,
              ])
            ).rowCount,
            0,
          );
          return {
            actualTimeouts: 5,
            attemptCeiling: 5,
            grant: false,
            fixture: "due-time advanced in SQL between real lock timeouts",
          };
        } finally {
          await q.query("rollback");
          q.release();
        }
      },
      "reminders",
    );
  else throw Error("UNKNOWN_REMINDER_PHASE");
} catch {
  process.exitCode = 1;
} finally {
  await w.stop();
  await close();
}
