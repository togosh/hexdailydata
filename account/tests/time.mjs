import assert from "node:assert/strict";
import { p, sqlUser, payload, check, close } from "./fixture.mjs";
import { createInvoice, processEvent } from "../dist/server/billing.js";
import {
  createKey,
  revokeKey,
  authorizeAndConsume,
} from "../dist/server/access.js";
const t = new Date("2032-12-31T23:58:00Z");
try {
  await check(
    "fixed UTC minute, UTC midnight across keys, rollback, renewal and rotation preserve quota",
    async () => {
      const u = await sqlUser("utc"),
        i = await createInvoice(p, u.id, "pls", 30, false, t);
      await processEvent(p, payload(i, u), t);
      const a = await createKey(p, u.id, "a"),
        b = await createKey(p, u.id, "b");
      const end = new Date("2032-12-31T23:59:59.999Z");
      for (let n = 0; n < 30; n++)
        await authorizeAndConsume(p, n % 2 ? a.secret : b.secret, end);
      await assert.rejects(
        () => authorizeAndConsume(p, a.secret, end),
        /BURST_LIMIT/,
      );
      assert.equal(
        (
          await p.query("select units from usage_bucket where account_id=$1", [
            u.id,
          ])
        ).rows[0].units,
        30,
      );
      assert.equal(
        (
          await p.query("select units from burst_bucket where account_id=$1", [
            u.id,
          ])
        ).rows[0].units,
        30,
      );
      const next = new Date("2033-01-01T00:00:00Z");
      assert.equal(
        (await authorizeAndConsume(p, b.secret, next)).remaining,
        99,
      );
      await p.query(
        "update usage_bucket set units=99 where account_id=$1 and day='2033-01-01'",
        [u.id],
      );
      const r = await Promise.allSettled([
        authorizeAndConsume(p, a.secret, next),
        authorizeAndConsume(p, b.secret, next),
      ]);
      assert.equal(r.filter((x) => x.status === "fulfilled").length, 1);
      assert.match(
        r.find((x) => x.status === "rejected").reason.message,
        /DAILY_QUOTA/,
      );
      assert.equal(
        (
          await p.query("select units from burst_bucket where account_id=$1", [
            u.id,
          ])
        ).rows[0].units,
        2,
      );
      const renewal = await createInvoice(p, u.id, "pls", 90, false, next);
      await processEvent(p, payload(renewal, u), next);
      const rotated = await createKey(p, u.id, "rotated", a.id);
      await assert.rejects(
        () => authorizeAndConsume(p, a.secret, next),
        /REVOKED_KEY/,
      );
      await assert.rejects(
        () => authorizeAndConsume(p, rotated.secret, next),
        /DAILY_QUOTA/,
      );
      await revokeKey(p, u.id, b.id);
      await assert.rejects(
        () => authorizeAndConsume(p, b.secret, new Date("2033-01-02")),
        /REVOKED_KEY/,
      );
      return {
        clock:
          "explicit direct SQL fixture only; public HTTP has no clock input",
        dayBefore: 30,
        dayAfter: 100,
        burstAfterQuotaDenials: 2,
      };
    },
    "time",
  );
  await check(
    "before/exact/after expiry and calendar half-open month/year/leap fixtures",
    async () => {
      const u = await sqlUser("expiry"),
        i = await createInvoice(p, u.id, "pls", 30, false, t);
      await processEvent(p, payload(i, u), t);
      const g = (
          await p.query("select * from grant_record where payment_id=$1", [
            i.id,
          ])
        ).rows[0],
        k = await createKey(p, u.id, "expiry");
      await authorizeAndConsume(p, k.secret, new Date(+g.ends_at - 1));
      for (const d of [0, 1])
        await assert.rejects(
          () => authorizeAndConsume(p, k.secret, new Date(+g.ends_at + d)),
          /ACCESS_EXPIRED/,
        );
      const vectors = [
        [
          "2031-01-15",
          30,
          "2031-01-01T00:00:00.000Z",
          "2031-02-01T00:00:00.000Z",
          31,
        ],
        [
          "2031-02-15",
          30,
          "2031-02-01T00:00:00.000Z",
          "2031-03-01T00:00:00.000Z",
          28,
        ],
        [
          "2032-02-15",
          30,
          "2032-02-01T00:00:00.000Z",
          "2032-03-01T00:00:00.000Z",
          29,
        ],
        [
          "2032-12-15",
          30,
          "2032-12-01T00:00:00.000Z",
          "2033-01-01T00:00:00.000Z",
          31,
        ],
        [
          "2032-01-15",
          365,
          "2032-01-01T00:00:00.000Z",
          "2033-01-01T00:00:00.000Z",
          366,
        ],
      ];
      for (const [at, days, start, end, length] of vectors) {
        const v = await sqlUser("calendar"),
          i = await createInvoice(p, v.id, "card", days, true, new Date(at));
        assert.equal(i.period_start.toISOString(), start);
        assert.equal(i.period_end.toISOString(), end);
        assert.equal((+i.period_end - +i.period_start) / 86400000, length);
        await processEvent(p, payload(i, v), new Date(at));
        const stored = (
          await p.query(
            "select starts_at,ends_at from grant_record where payment_id=$1",
            [i.id],
          )
        ).rows[0];
        assert.equal(stored.starts_at.toISOString(), start);
        assert.equal(stored.ends_at.toISOString(), end);
      }
      await assert.rejects(
        () => createInvoice(p, u.id, "pls", 365, false, t),
        /UNAVAILABLE_FIXTURE/,
      );
      await assert.rejects(
        () => createInvoice(p, u.id, "card", 365, false, t),
        /UNAVAILABLE_FIXTURE/,
      );
      return {
        intervals: vectors,
        semantics: "[start,end)",
        annualPublic: false,
      };
    },
    "time",
  );
} catch {
  process.exitCode = 1;
} finally {
  await close();
}
