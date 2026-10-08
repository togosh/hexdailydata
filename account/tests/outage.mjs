import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { config } from "../dist/server/config.js";
import { poolFor, guard } from "../dist/server/db.js";
import { createInvoice, processEvent } from "../dist/server/billing.js";
import { createKey, authorizeAndConsume } from "../dist/server/access.js";
const c = config(),
  p = poolFor(c);
await guard(p, c);
const {
  rows: [u],
} = await p.query(
  `select id from "user" where "emailVerified" order by "createdAt" limit 1`,
);
const i = await createInvoice(p, u.id, "pls", 30, false);
const e = {
  eventId: randomUUID(),
  paymentId: i.id,
  invoiceId: i.id,
  accountId: u.id,
  amount: i.amount,
  asset: "PLS",
  chain: 369,
  recipient: "lab-vault",
  status: "paid",
  version: 1,
};
assert.equal(await processEvent(p, e), "granted");
await p.query("update api_key set revoked=true where account_id=$1", [u.id]);
const k = await createKey(p, u.id, "outage");
await p.query("delete from burst_bucket where account_id=$1", [u.id]);
await p.query(
  "update usage_bucket set units=50 where account_id=$1 and day=current_date",
  [u.id],
);
await authorizeAndConsume(p, k.secret);
await new Promise((r) => setTimeout(r, 2500));
const {
  rows: [m],
} = await p.query("select attempts,delivered_at from outbox where dedup=$1", [
  "receipt:" + i.id,
]);
assert.ok(m.attempts >= 1);
assert.equal(m.delivered_at, null);
console.log(
  "Purchase committed, protected admission succeeded, durable SMTP failure attempt observed",
);
await p.end();
