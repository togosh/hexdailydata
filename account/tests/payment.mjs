import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { p, sqlUser, payload, check, close, sleep } from "./fixture.mjs";
import { createInvoice, processEvent } from "../dist/server/billing.js";
import { createKey, authorizeAndConsume } from "../dist/server/access.js";
const t = new Date("2032-01-15T12:00:00Z"),
  feb = new Date("2032-02-15T12:00:00Z");
const event = (e, status, version = 2) => ({
  ...e,
  eventId: randomUUID(),
  status,
  version,
});
const invoiceState = async (i) =>
  (await p.query("select status,collectible from invoice where id=$1", [i.id]))
    .rows[0];
const tests = [
  [
    "refund before credit survives older/newer paid deliveries, replay and failed-attempt debt",
    async () => {
      const observations = [];
      for (const mode of ["pls", "card"])
        for (const status of ["refund", "partial-refund"]) {
          const u = await sqlUser("refund-first"),
            i = await createInvoice(p, u.id, mode, 30, false, t),
            e = payload(i, u, status, 4);
          assert.equal(await processEvent(p, e, t), "needs_review");
          for (const version of [3, 5])
            assert.equal(
              await processEvent(p, event(e, "paid", version), t),
              "needs_review",
            );
          assert.equal(
            await processEvent(p, event(e, "failed", 6), t),
            "needs_review",
          );
          assert.equal(await processEvent(p, e, t), "needs_review");
          assert.equal(
            (
              await p.query(
                "select refund_seen from payment_identity where payment_id=$1",
                [e.paymentId],
              )
            ).rows[0].refund_seen,
            true,
          );
          assert.equal(
            (await p.query("select 1 from credit where invoice_id=$1", [i.id]))
              .rowCount,
            0,
          );
          assert.deepEqual(await invoiceState(i), {
            status: "needs_review",
            collectible: false,
          });
          assert.deepEqual(
            (
              await p.query(
                "select card_active,card_due from customer where id=$1",
                [u.id],
              )
            ).rows[0],
            { card_active: false, card_due: false },
          );
          const key = await createKey(p, u.id, "refund fence");
          await assert.rejects(
            () => authorizeAndConsume(p, key.secret, t),
            /ACCESS_EXPIRED/,
          );
          assert.equal(
            (
              await p.query("select 1 from usage_bucket where account_id=$1", [
                u.id,
              ])
            ).rowCount,
            0,
          );
          observations.push({
            mode,
            status,
            refundSeen: true,
            credits: 0,
            admitted: false,
          });
        }
      return observations;
    },
  ],
  [
    "concurrent paid and full refund leave no spendable coverage in either SQL arrival order",
    async () => {
      const observations = [];
      for (const mode of ["pls", "card"])
        for (const refundFirst of [false, true]) {
          const u = await sqlUser("refund-race"),
            i = await createInvoice(p, u.id, mode, 30, false, t),
            paid = payload(i, u, "paid", 3),
            refund = event(paid, "refund", 4);
          const results = await Promise.all(
            (refundFirst ? [refund, paid] : [paid, refund]).map((e) =>
              processEvent(p, e, t),
            ),
          );
          assert.equal(
            (
              await p.query(
                "select refund_seen from payment_identity where payment_id=$1",
                [paid.paymentId],
              )
            ).rows[0].refund_seen,
            true,
          );
          const grants = (
            await p.query(
              "select refunded from grant_record where payment_id=$1",
              [paid.paymentId],
            )
          ).rows;
          assert.ok(grants.length <= 1 && grants.every((g) => g.refunded));
          const key = await createKey(p, u.id, "refund race");
          await assert.rejects(
            () => authorizeAndConsume(p, key.secret, t),
            /ACCESS_EXPIRED/,
          );
          observations.push({
            mode,
            refundFirst,
            results,
            grants: grants.length,
            admitted: false,
          });
        }
      return observations;
    },
  ],
  [
    "already-paid invoice resists failed alternate attempt and unrelated debt survives",
    async () => {
      const u = await sqlUser("paid-attempt"),
        a = await createInvoice(p, u.id, "card", 30, false, t),
        ea = payload(a, u);
      await processEvent(p, ea, t);
      await processEvent(
        p,
        { ...event(ea, "failed", 9), paymentId: randomUUID() },
        t,
      );
      assert.deepEqual(await invoiceState(a), {
        status: "granted",
        collectible: false,
      });
      const b = await createInvoice(p, u.id, "card", 30, false, feb),
        eb = payload(b, u, "failed", 10);
      await processEvent(p, eb, feb);
      await processEvent(p, event(eb, "cancel", 11), feb);
      assert.equal(
        await processEvent(
          p,
          { ...event(ea, "paid", 12), paymentId: randomUUID() },
          feb,
        ),
        "needs_review",
      );
      assert.deepEqual(await invoiceState(a), {
        status: "granted",
        collectible: false,
      });
      assert.deepEqual(await invoiceState(b), {
        status: "cancel",
        collectible: true,
      });
      assert.equal(
        (await p.query("select card_due from customer where id=$1", [u.id]))
          .rows[0].card_due,
        true,
      );
      assert.equal(
        await processEvent(p, event(eb, "paid", 10), feb),
        "granted",
      );
      assert.equal(
        (await p.query("select card_due from customer where id=$1", [u.id]))
          .rows[0].card_due,
        false,
      );
    },
  ],
  [
    "refund followed by original replay and new delivery never reinstates state or auto-renew",
    async () => {
      const u = await sqlUser("refund"),
        i = await createInvoice(p, u.id, "card", 30, false, t),
        e = payload(i, u);
      await processEvent(p, e, t);
      await processEvent(p, event(e, "cancel", 3), t);
      await processEvent(p, event(e, "refund", 4), t);
      assert.equal(await processEvent(p, e, t), "granted"); // durable original result
      assert.equal(await processEvent(p, event(e, "paid", 5), t), "refunded");
      assert.equal((await invoiceState(i)).status, "refunded");
      assert.equal(
        (await p.query("select card_active from customer where id=$1", [u.id]))
          .rows[0].card_active,
        false,
      );
      assert.equal(
        (
          await p.query(
            "select refunded from grant_record where payment_id=$1",
            [i.id],
          )
        ).rows[0].refunded,
        true,
      );
    },
  ],
  [
    "failed then paid/cancel and old failures preserve paid history and newest subscription state",
    async () => {
      const u = await sqlUser("ordering"),
        i = await createInvoice(p, u.id, "card", 30, false, t),
        e = payload(i, u, "failed", 2);
      await processEvent(p, e, t);
      const results = await Promise.all([
        processEvent(p, event(e, "paid", 3), t),
        processEvent(p, event(e, "cancel", 4), t),
      ]);
      assert.ok(results.includes("granted"));
      await processEvent(p, event(e, "failed", 1), t);
      await processEvent(p, event(e, "paid", 5), t);
      assert.deepEqual(await invoiceState(i), {
        status: "granted",
        collectible: false,
      });
      assert.deepEqual(
        (
          await p.query(
            "select card_active,card_due from customer where id=$1",
            [u.id],
          )
        ).rows[0],
        { card_active: false, card_due: false },
      );
      assert.equal(
        (
          await p.query(
            "select count(*)::int n from credit where invoice_id=$1",
            [i.id],
          )
        ).rows[0].n,
        1,
      );
    },
  ],
  [
    "mixed PLS/card order creation races serialize on two SQL connections",
    async () => {
      const outcomes = [];
      for (let n = 0; n < 6; n++) {
        const u = await sqlUser("order-race");
        const r = await Promise.allSettled([
          createInvoice(p, u.id, n % 2 ? "card" : "pls", 30, false, t),
          createInvoice(p, u.id, n % 2 ? "pls" : "card", 30, false, t),
        ]);
        assert.equal(r.filter((v) => v.status === "fulfilled").length, 1);
        assert.equal(
          r.find((v) => v.status === "rejected").reason.message,
          "BILLING_MODE_CONFLICT",
        );
        outcomes.push(r.find((v) => v.status === "fulfilled").value.mode);
      }
      return { races: 6, winners: outcomes };
    },
  ],
  [
    "mixed fulfillment races never grant both modes; explicit conflict retained",
    async () => {
      const outcomes = [];
      for (let n = 0; n < 4; n++) {
        const u = await sqlUser("fulfill-race");
        const a = await createInvoice(p, u.id, "pls", 30, false, t);
        await p.query("update invoice set status='needs_review' where id=$1", [
          a.id,
        ]);
        const b = await createInvoice(p, u.id, "card", 30, false, t);
        await p.query("update invoice set status='open' where id=$1", [a.id]);
        const es =
          n % 2
            ? [payload(a, u), payload(b, u)]
            : [payload(b, u), payload(a, u)];
        const r = await Promise.all(es.map((e) => processEvent(p, e, t)));
        assert.equal(r.filter((x) => x === "granted").length, 1);
        assert.equal(r.filter((x) => x === "needs_review").length, 1);
        assert.equal(
          (
            await p.query(
              "select count(*)::int n from grant_record where account_id=$1",
              [u.id],
            )
          ).rows[0].n,
          1,
        );
        outcomes.push(r);
      }
      return {
        races: 4,
        outcomes,
        fixture:
          "two historical opposing saved invoices; no production checkout",
      };
    },
  ],
  [
    "live activation/quote expiry/admission sample time after actual lock waits",
    async () => {
      const u = await sqlUser("lock"),
        i = await createInvoice(p, u.id, "pls", 30, false),
        e = payload(i, u),
        q = await p.connect();
      try {
        await q.query("begin");
        await q.query("select id from customer where id=$1 for update", [u.id]);
        const pending = processEvent(p, e);
        await sleep(400);
        const release = Date.now();
        await q.query("commit");
        assert.equal(await pending, "granted");
        const g = (
          await p.query("select * from grant_record where payment_id=$1", [
            i.id,
          ])
        ).rows[0];
        assert.ok(+g.starts_at >= release);
        const k = await createKey(p, u.id, "clock");
        await p.query(
          "update grant_record set ends_at=now()+interval '150 milliseconds' where payment_id=$1",
          [i.id],
        );
        await q.query("begin");
        await q.query("select id from customer where id=$1 for update", [u.id]);
        const denied = authorizeAndConsume(p, k.secret).then(
          () => null,
          (e) => e.message,
        );
        await sleep(400);
        await q.query("commit");
        assert.equal(await denied, "ACCESS_EXPIRED");
        assert.equal(
          (
            await p.query(
              "select count(*)::int n from usage_bucket where account_id=$1",
              [u.id],
            )
          ).rows[0].n,
          0,
        );
        const late = await createInvoice(p, u.id, "pls", 30, false);
        await p.query(
          "update invoice set expires_at=now()+interval '150 milliseconds' where id=$1",
          [late.id],
        );
        await q.query("begin");
        await q.query("select id from customer where id=$1 for update", [u.id]);
        const wait = processEvent(p, payload(late, u));
        await sleep(400);
        await q.query("commit");
        assert.equal(await wait, "needs_review");
        return {
          lockWaitMs: 400,
          admission: "expired/no usage",
          latePayment: "needs_review; no occurrence-time proof",
        };
      } finally {
        await q.query("rollback");
        q.release();
      }
    },
  ],
];
tests.push([
  "wrong asset/chain/recipient/partial/excess inputs and partial refund remain non-granted",
  async () => {
    const u = await sqlUser("validation");
    const cases = [
      { asset: "USD" },
      { chain: 1 },
      { recipient: "different-fixture-vault" },
      { amount: "1" },
      {
        amount:
          "999999999999999999999999999999999999999999999999999999999999999999999999999999",
      },
      { status: "partial-refund" },
    ];
    for (const change of cases) {
      const i = await createInvoice(p, u.id, "pls", 30, false);
      const e = { ...payload(i, u), ...change };
      assert.equal(await processEvent(p, e), "needs_review");
      assert.equal((await invoiceState(i)).status, "needs_review");
      assert.equal(
        (await p.query("select 1 from credit where invoice_id=$1", [i.id]))
          .rowCount,
        0,
      );
    }
    const exact = await createInvoice(p, u.id, "pls", 30, false);
    assert.equal(exact.amount, "123456789012345678901");
    assert.equal(await processEvent(p, payload(exact, u)), "granted");
    return { nonGranted: cases, exactBaseUnits: exact.amount };
  },
]);
let failures = 0;
try {
  for (const [name, fn] of tests)
    try {
      await check(name, fn, "payment");
    } catch {
      failures++;
    }
} finally {
  await close();
}
if (failures) process.exitCode = 1;
