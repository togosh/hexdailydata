import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import {
  p,
  provider,
  sqlUser,
  payload,
  check,
  close,
  failure,
} from "./fixture.mjs";
import { worker } from "../dist/server/worker.js";
import { createInvoice } from "../dist/server/billing.js";
const w = worker(p, { automatic: false });
try {
  await check(
    "20 rejected provider records do not starve a later valid purchase",
    async () => {
      const u = await sqlUser("fairness"),
        i = await createInvoice(p, u.id, "pls", 30, false),
        ids = [];
      for (let n = 0; n < 20; n++) {
        const id = randomUUID();
        ids.push(id);
        await provider.query(
          "insert into fake_provider.record(event_id,payment_id,payload,created_at) values($1,$2,$3,now()-interval '1 hour')",
          [id, randomUUID(), { invalid: true }],
        );
      }
      const e = payload(i, u);
      await provider.query(
        "insert into fake_provider.record(event_id,payment_id,payload) values($1,$2,$3)",
        [e.eventId, e.paymentId, e],
      );
      for (let n = 0; n < 3; n++) await w.tick();
      const n = (
        await p.query(
          "select count(*)::int n from credit where payment_id=$1",
          [e.paymentId],
        )
      ).rows[0].n;
      assert.equal(n, 1);
      const rows = (
        await p.query(
          "select attempts,state,reason from reconcile_attempt where event_id=any($1)",
          [ids],
        )
      ).rows;
      assert.equal(rows.length, 20);
      assert.ok(
        rows.every(
          (r) =>
            r.attempts === 1 &&
            r.state === "needs_review" &&
            r.reason === "INVALID_EVENT",
        ),
      );
      assert.equal(
        (
          await provider.query(
            "select count(*)::int n from fake_provider.record where event_id=any($1)",
            [ids],
          )
        ).rows[0].n,
        20,
      );
      return {
        ticks: 3,
        invalidRetained: 20,
        validCredits: n,
        invalidAttempts: 1,
      };
    },
    "starvation",
  );
} catch (e) {
  console.error(JSON.stringify(failure(e)));
  process.exitCode = 1;
} finally {
  await w.stop();
  await close();
}
