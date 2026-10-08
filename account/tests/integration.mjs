import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import { randomUUID, createHmac, createHash } from "node:crypto";
import { performance } from "node:perf_hooks";
import { spawn } from "node:child_process";
import { chromium } from "playwright";
import { config } from "../dist/server/config.js";
import { poolFor, guard } from "../dist/server/db.js";
import {
  processEvent,
  createInvoice,
  eventSchema,
} from "../dist/server/billing.js";
import { authorizeAndConsume, createKey } from "../dist/server/access.js";
const c = config(),
  p = poolFor(c),
  provider = poolFor(c, true);
await guard(p, c);
await guard(provider, c, true);
const results = [];
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function check(name, fn) {
  const start = performance.now();
  try {
    const detail = await fn();
    results.push({
      name,
      result: "PASS",
      ms: Math.round(performance.now() - start),
      detail,
    });
    console.log("PASS " + name);
  } catch (e) {
    results.push({
      name,
      result: "FAIL",
      error: String(e.message).slice(0, 240),
    });
    console.error("FAIL " + name + " " + e.message);
    throw e;
  } finally {
    fs.writeFileSync(
      "evidence/tests.json",
      JSON.stringify(
        { runId: c.runId, at: new Date().toISOString(), results },
        null,
        2,
      ),
    );
  }
}
function request(url, body, headers = {}, method) {
  return new Promise((resolve, reject) => {
    const raw =
      body === undefined
        ? undefined
        : typeof body === "string"
          ? body
          : JSON.stringify(body);
    const req = http.request(
      {
        hostname: "app",
        port: 3000,
        path: url,
        method: method || (raw ? "POST" : "GET"),
        headers: {
          host: new URL(c.origin).host,
          origin: c.origin,
          ...(raw
            ? {
                "content-type": "application/json",
                "content-length": Buffer.byteLength(raw),
              }
            : {}),
          ...headers,
        },
      },
      (r) => {
        let text = "";
        r.on("data", (x) => (text += x));
        r.on("end", () => {
          let data;
          try {
            data = JSON.parse(text);
          } catch {
            data = text;
          }
          resolve({ status: r.statusCode, data, headers: r.headers });
        });
      },
    );
    req.on("error", reject);
    if (raw) req.write(raw);
    req.end();
  });
}
async function inbox(email, subject) {
  for (let n = 0; n < 40; n++) {
    const list = await (
      await fetch("http://inbox:8025/api/v1/messages")
    ).json();
    const m = list.messages?.find(
      (m) => m.To?.some((x) => x.Address === email) && m.Subject === subject,
    );
    if (m)
      return (
        await (await fetch("http://inbox:8025/api/v1/message/" + m.ID)).json()
      ).Text;
    await sleep(250);
  }
  throw Error("LOCAL_MAIL_NOT_RECEIVED");
}
async function register(label) {
  const email = label + "-" + randomUUID().slice(0, 8) + "@example.test",
    password = "Lab-password-" + randomUUID();
  let r = await request("/api/auth/sign-up/email", { email, password });
  assert.equal(r.status, 200);
  assert.equal(r.data.token, undefined);
  assert.equal(
    (await request("/api/auth/sign-in/email", { email, password })).status,
    403,
  );
  const text = await inbox(email, "Verify lab email"),
    url = new URL(text.trim());
  r = await request(url.pathname + url.search);
  assert.ok([200, 302].includes(r.status));
  assert.equal((await request(url.pathname + url.search)).status, 401);
  r = await request("/api/auth/sign-in/email", { email, password });
  assert.equal(r.status, 200);
  const cookie = r.headers["set-cookie"].map((x) => x.split(";")[0]).join("; ");
  assert.match(r.headers["set-cookie"].join(" "), /HttpOnly/i);
  assert.match(r.headers["set-cookie"].join(" "), /SameSite=Lax/i);
  return { email, password, cookie, id: r.data.user.id };
}
const session = (u) => ({ cookie: u.cookie });
const payload = (i, u, status = "paid") => ({
  eventId: randomUUID(),
  paymentId: i.id,
  invoiceId: i.id,
  accountId: u.id,
  amount: i.amount,
  asset: i.mode === "pls" ? "PLS" : "USD",
  chain: i.mode === "pls" ? 369 : 0,
  recipient: "lab-vault",
  status,
  version: 1,
});
async function callback(e) {
  const raw = JSON.stringify(e);
  return request("/internal/events", raw, {
    "x-lab-signature": createHmac("sha256", c.eventSecret)
      .update(raw)
      .digest("hex"),
  });
}
let alice, bob, invoice, key, secondKey;
await check(
  "guard: wrong UUID and runtime DDL/provider-write refusal",
  async () => {
    await assert.rejects(
      () => guard(p, { ...c, labId: randomUUID() }),
      /WRONG_LAB/,
    );
    await assert.rejects(
      () => p.query("create table should_not_exist(id int)"),
      /permission denied/,
    );
    await assert.rejects(
      () => p.query("insert into fake_provider.record values('no','no','{}')"),
      /permission denied/,
    );
    return "Real private PostgreSQL, runtime role";
  },
);
await check(
  "real registration, SMTP verification, login and verification replay",
  async () => {
    alice = await register("alice");
    bob = await register("bob");
    const {
      rows: [r],
    } = await p.query('select password from account where "userId"=$1', [
      alice.id,
    ]);
    assert.notEqual(r.password, alice.password);
    assert.ok(r.password.length > 64);
  },
);
await check(
  "ownership, CSRF, host, mass assignment and cookie/key separation",
  async () => {
    assert.equal(
      (
        await request(
          "/api/invoices",
          { mode: "pls", days: 30, paidUntil: "2099-01-01" },
          session(alice),
        )
      ).status,
      400,
    );
    assert.equal(
      (
        await request(
          "/api/invoices",
          { mode: "pls", days: 30 },
          { ...session(alice), origin: "http://foreign.example.test" },
        )
      ).status,
      403,
    );
    assert.equal(
      (await request("/health", undefined, { host: "foreign.example.test" }))
        .status,
      400,
    );
    assert.equal(
      (await request("/api/data", undefined, session(alice))).status,
      401,
    );
    assert.equal(
      (
        await request("/api/auth/sign-up/email", {
          email: "blocked@example.test",
          password: "This-is-long-enough",
          emailVerified: true,
        })
      ).status,
      400,
    );
    assert.equal(
      (
        await request(
          "/api/auth/verify-email?token=bad&callbackURL=https://outside.example.test",
        )
      ).status,
      400,
    );
  },
);
await check(
  "saved PLS invoice, signed internal purchase, grant, show-once key, protected GET",
  async () => {
    let r = await request(
      "/api/invoices",
      { mode: "pls", days: 30 },
      session(alice),
    );
    assert.equal(r.status, 200);
    invoice = r.data;
    assert.equal(invoice.amount, "123456789012345678901");
    assert.equal(
      (await request("/api/simulate", { invoiceId: invoice.id }, session(bob)))
        .status,
      404,
    );
    assert.equal(
      (
        await request(
          "/internal/events",
          JSON.stringify(payload(invoice, alice)),
          { "x-lab-signature": "0".repeat(64) },
        )
      ).status,
      401,
    );
    r = await request(
      "/api/simulate",
      { invoiceId: invoice.id },
      session(alice),
    );
    assert.equal(r.data.result, "granted");
    r = await request("/api/keys", { label: "first" }, session(alice));
    assert.equal(r.status, 200);
    key = r.data;
    assert.equal(
      (
        await request("/api/account", undefined, {
          authorization: "Bearer " + key.secret,
        })
      ).status,
      401,
    );
    r = await request("/api/data", undefined, {
      authorization: "Bearer " + key.secret,
    });
    assert.equal(r.status, 200);
    assert.equal(r.data.synthetic, true);
    assert.equal(r.data.remaining, 99);
    const state = (await request("/api/account", undefined, session(alice)))
      .data;
    assert.ok(!JSON.stringify(state).includes(key.secret));
    const {
      rows: [k],
    } = await p.query("select * from api_key where id=$1", [key.id]);
    assert.equal(
      k.verifier,
      createHash("sha256").update(key.secret).digest("hex"),
    );
  },
);
await check(
  "20 concurrent deliveries, economic dedup and altered event conflict",
  async () => {
    const i = (
        await request(
          "/api/invoices",
          { mode: "pls", days: 90 },
          session(alice),
        )
      ).data,
      e = payload(i, alice);
    const rs = await Promise.all(Array.from({ length: 20 }, () => callback(e)));
    assert.ok(rs.every((x) => x.status === 200 && x.data.result === "granted"));
    assert.equal(
      (await callback({ ...e, eventId: randomUUID() })).data.result,
      "granted",
    );
    assert.equal((await callback({ ...e, amount: "1" })).status, 409);
    const {
      rows: [r],
    } = await p.query(
      "select count(*)::int n from credit where payment_id=$1",
      [e.paymentId],
    );
    assert.equal(r.n, 1);
    const { rows: grants } = await p.query(
      "select * from grant_record where account_id=$1 order by starts_at",
      [alice.id],
    );
    assert.equal(+grants[1].starts_at, +grants[0].ends_at);
    assert.equal(+grants[1].ends_at - +grants[1].starts_at, 90 * 86400000);
    assert.equal(
      (
        await request("/api/data", undefined, {
          authorization: "Bearer " + key.secret,
        })
      ).status,
      200,
    );
  },
);
await check(
  "distinct concurrent 30+90 purchases add 120 exact days",
  async () => {
    const a = await createInvoice(p, alice.id, "pls", 30, false),
      b = await createInvoice(p, alice.id, "pls", 90, false);
    const rs = await Promise.all([
      callback(payload(a, alice)),
      callback(payload(b, alice)),
    ]);
    assert.ok(rs.every((r) => r.data.result === "granted"));
    const { rows: g } = await p.query(
      "select * from grant_record where payment_id=any($1) order by starts_at",
      [[a.id, b.id]],
    );
    assert.equal(+g[0].ends_at, +g[1].starts_at);
    assert.equal(+g[1].ends_at - +g[0].starts_at, 120 * 86400000);
  },
);
await check(
  "missed callback reconciliation from independent durable provider record",
  async () => {
    const i = (
      await request("/api/invoices", { mode: "pls", days: 30 }, session(bob))
    ).data;
    assert.equal(
      (
        await request(
          "/api/simulate",
          { invoiceId: i.id, missCallback: true },
          session(bob),
        )
      ).data.result,
      "durable_provider_record",
    );
    for (let n = 0; n < 30; n++) {
      const { rowCount } = await p.query(
        "select 1 from credit where payment_id=$1",
        [i.id],
      );
      if (rowCount)
        return "Worker recovered authoritative fake-provider record";
      await sleep(200);
    }
    throw Error("RECONCILIATION_NOT_OBSERVED");
  },
);
await check(
  "real SQL two-key final quota race, rotation and revoked key after renewal",
  async () => {
    secondKey = (
      await request("/api/keys", { label: "second" }, session(alice))
    ).data;
    await p.query(
      "insert into usage_bucket values($1,current_date,99) on conflict(account_id,day) do update set units=99",
      [alice.id],
    );
    await p.query("delete from burst_bucket where account_id=$1", [alice.id]);
    const rs = await Promise.all(
      [key, secondKey].map((k) =>
        request("/api/data", undefined, {
          authorization: "Bearer " + k.secret,
        }),
      ),
    );
    assert.deepEqual(rs.map((r) => r.status).sort(), [200, 429]);
    await request("/api/keys/revoke", { id: key.id }, session(alice));
    const i = await createInvoice(p, alice.id, "pls", 30, false);
    await callback(payload(i, alice));
    assert.equal(
      (
        await request("/api/data", undefined, {
          authorization: "Bearer " + key.secret,
        })
      ).status,
      401,
    );
    const rotated = (
      await request(
        "/api/keys",
        { label: "rotated", rotate: secondKey.id },
        session(alice),
      )
    ).data;
    assert.equal(
      (
        await request("/api/data", undefined, {
          authorization: "Bearer " + rotated.secret,
        })
      ).status,
      429,
    );
    assert.equal(
      (await request("/api/keys/revoke", { id: rotated.id }, session(bob)))
        .status,
      404,
    );
  },
);
await check(
  "reset through SMTP, session revocation and single-use replay",
  async () => {
    assert.equal(
      (await request("/api/auth/request-password-reset", { email: bob.email }))
        .status,
      200,
    );
    const link = new URL((await inbox(bob.email, "Reset lab password")).trim());
    const r = await request(link.pathname + link.search);
    assert.equal(r.status, 302);
    const token = new URL(r.headers.location, c.origin).searchParams.get(
      "token",
    );
    assert.ok(token);
    const body = { token, newPassword: "Replacement-password-1234" };
    assert.equal((await request("/api/auth/reset-password", body)).status, 200);
    assert.equal((await request("/api/auth/reset-password", body)).status, 401);
    assert.equal(
      (await request("/api/account", undefined, session(bob))).status,
      401,
    );
  },
);
await check(
  "durable grant crash before/after SQL commit, lost ack retry",
  async () => {
    for (const stage of ["beforeCommit", "afterCommit"]) {
      const i = await createInvoice(p, alice.id, "pls", 30, false),
        e = payload(i, alice);
      const child = spawn(process.execPath, ["tests/crash-child.mjs", stage], {
        stdio: ["pipe", "pipe", "pipe"],
      });
      child.stdin.end(JSON.stringify(e));
      const exit = await new Promise((r) => child.on("exit", r));
      assert.equal(exit, 73);
      const { rowCount: count } = await p.query(
        "select 1 from credit where payment_id=$1",
        [e.paymentId],
      );
      assert.equal(count, stage === "beforeCommit" ? 0 : 1);
      const before = (
        await p.query(
          "select starts_at,ends_at from grant_record where payment_id=$1",
          [e.paymentId],
        )
      ).rows[0];
      assert.equal((await callback(e)).data.result, "granted");
      if (before)
        assert.deepEqual(
          (
            await p.query(
              "select starts_at,ends_at from grant_record where payment_id=$1",
              [e.paymentId],
            )
          ).rows[0],
          before,
        );
    }
    return "Actual child exits at commit boundary, not caught exceptions";
  },
);
await check(
  "calendar card periods, stale cancellation, mode block and scoped refund",
  async () => {
    const id = bob.id;
    await p.query("update grant_record set refunded=true where account_id=$1", [
      id,
    ]);
    const i = await createInvoice(
      p,
      id,
      "card",
      30,
      false,
      new Date("2028-02-15T12:00:00Z"),
    );
    assert.equal(+i.period_end - +i.period_start, 29 * 86400000);
    const e = payload(i, bob);
    assert.equal(
      await processEvent(p, e, new Date("2028-02-15T12:01:00Z")),
      "granted",
    );
    await processEvent(
      p,
      { ...e, eventId: randomUUID(), status: "cancel", version: 3 },
      new Date("2028-02-15T12:02:00Z"),
    );
    await processEvent(
      p,
      { ...e, eventId: randomUUID(), version: 2 },
      new Date("2028-02-15T12:03:00Z"),
    );
    assert.equal(
      (await p.query("select card_active from customer where id=$1", [id]))
        .rows[0].card_active,
      false,
    );
    await assert.rejects(
      () => createInvoice(p, id, "pls", 30, false, new Date("2028-02-16")),
      /BILLING_MODE_CONFLICT/,
    );
    await processEvent(
      p,
      { ...e, eventId: randomUUID(), status: "refund", version: 4 },
      new Date("2028-02-16"),
    );
    assert.equal(
      (
        await p.query("select refunded from grant_record where payment_id=$1", [
          e.paymentId,
        ])
      ).rows[0].refunded,
      true,
    );
    return "Virtual business timestamps; real SQL and same billing service";
  },
);
await check(
  "exact expiry and prepaid 365/20+90 vectors; malformed and late payment review",
  async () => {
    const now = new Date("2030-03-10T00:00:00Z");
    const i = await createInvoice(p, bob.id, "pls", 365, true, now);
    const e = payload(i, bob);
    assert.equal(await processEvent(p, e, now), "granted");
    const {
      rows: [g],
    } = await p.query("select * from grant_record where payment_id=$1", [i.id]);
    assert.equal(+g.ends_at - +g.starts_at, 365 * 86400000);
    const k = await createKey(p, bob.id, "expiry-test");
    await authorizeAndConsume(p, k.secret, new Date(+g.ends_at - 1));
    await assert.rejects(
      () => authorizeAndConsume(p, k.secret, g.ends_at),
      /ACCESS_EXPIRED/,
    );
    const at = new Date(+g.ends_at - 20 * 86400000),
      j = await createInvoice(p, bob.id, "pls", 90, false, at);
    await processEvent(p, payload(j, bob), at);
    const {
      rows: [g2],
    } = await p.query("select * from grant_record where payment_id=$1", [j.id]);
    assert.equal(+g2.ends_at - +at, 110 * 86400000);
    for (const amount of ["-1", "1e20", "01", "9".repeat(79)])
      assert.equal(eventSchema.safeParse({ ...e, amount }).success, false);
    const late = await createInvoice(p, alice.id, "pls", 30, false);
    assert.equal(
      await processEvent(
        p,
        payload(late, alice),
        new Date(+late.expires_at + 1),
      ),
      "needs_review",
    );
    return "Virtual business timestamps, not wall-clock waiting";
  },
);
await check("compiled production/config refusal", async () => {
  const exit = await new Promise((r) => {
    const child = spawn(process.execPath, ["dist/server/main.js"], {
      env: { ...process.env, NODE_ENV: "production" },
      stdio: "ignore",
    });
    child.on("exit", r);
  });
  assert.notEqual(exit, 0);
});
await check(
  "pending payment identity cannot change; correct transition credits once",
  async () => {
    const i = await createInvoice(p, alice.id, "pls", 30, false),
      e = payload(i, alice, "pending");
    assert.equal((await callback(e)).data.result, "pending");
    assert.equal(
      (
        await callback({
          ...e,
          eventId: randomUUID(),
          status: "paid",
          amount: "1",
        })
      ).status,
      409,
    );
    assert.equal(
      (await callback({ ...e, eventId: randomUUID(), status: "paid" })).data
        .result,
      "granted",
    );
    const j = await createInvoice(p, alice.id, "pls", 30, false);
    assert.equal(
      (await callback({ ...payload(j, alice), chain: 1 })).data.result,
      "needs_review",
    );
    const a = await createInvoice(p, alice.id, "pls", 30, false),
      b = await createInvoice(p, alice.id, "pls", 90, false),
      ea = payload(a, alice),
      eb = payload(b, alice);
    await callback(ea);
    await callback(eb);
    const before = (
      await p.query("select * from grant_record where payment_id=$1", [b.id])
    ).rows[0];
    await callback({ ...ea, eventId: randomUUID(), status: "refund" });
    await callback({ ...ea, eventId: randomUUID(), status: "refund" });
    assert.deepEqual(
      (await p.query("select * from grant_record where payment_id=$1", [b.id]))
        .rows[0],
      before,
    );
  },
);
await check(
  "collectible card debt survives cancellation and another paid period",
  async () => {
    const at = new Date("2035-01-15T12:00:00Z");
    const a = await createInvoice(p, bob.id, "card", 30, false, at),
      ea = payload(a, bob, "failed");
    await processEvent(p, { ...ea, version: 10 }, at);
    await processEvent(
      p,
      { ...ea, eventId: randomUUID(), status: "cancel", version: 11 },
      at,
    );
    await assert.rejects(
      () => createInvoice(p, bob.id, "pls", 30, false, new Date("2035-01-16")),
      /BILLING_MODE_CONFLICT/,
    );
    const feb = new Date("2035-02-15T12:00:00Z"),
      b = await createInvoice(p, bob.id, "card", 30, false, feb),
      eb = payload(b, bob);
    await processEvent(p, { ...eb, version: 12 }, feb);
    await processEvent(
      p,
      { ...eb, eventId: randomUUID(), status: "cancel", version: 13 },
      feb,
    );
    const state = (
      await p.query("select card_active,card_due from customer where id=$1", [
        bob.id,
      ])
    ).rows[0];
    assert.deepEqual(state, { card_active: false, card_due: true });
    assert.equal(
      (await p.query("select collectible from invoice where id=$1", [a.id]))
        .rows[0].collectible,
      true,
    );
    await assert.rejects(
      () => createInvoice(p, bob.id, "pls", 30, false, new Date("2035-03-02")),
      /BILLING_MODE_CONFLICT/,
    );
    return "Virtual calendar fixtures, actual per-invoice collectible SQL state";
  },
);
await check(
  "wall clock sampled after SQL account lock for activation and expiry",
  async () => {
    await p.query("update grant_record set refunded=true where account_id=$1", [
      alice.id,
    ]);
    const i = await createInvoice(p, alice.id, "pls", 30, false),
      e = payload(i, alice);
    const lock = await p.connect();
    try {
      await lock.query("begin");
      await lock.query("select id from customer where id=$1 for update", [
        alice.id,
      ]);
      const waiting = processEvent(p, e);
      await sleep(350);
      const released = Date.now();
      await lock.query("commit");
      assert.equal(await waiting, "granted");
      const g = (
        await p.query("select * from grant_record where payment_id=$1", [i.id])
      ).rows[0];
      assert.ok(+g.starts_at >= released);
      const k = await createKey(p, alice.id, "clock-regression");
      await p.query(
        "update usage_bucket set units=50 where account_id=$1 and day=current_date",
        [alice.id],
      );
      await p.query("delete from burst_bucket where account_id=$1", [alice.id]);
      await p.query("update grant_record set ends_at=$2 where payment_id=$1", [
        i.id,
        new Date(Date.now() + 150),
      ]);
      await lock.query("begin");
      await lock.query("select id from customer where id=$1 for update", [
        alice.id,
      ]);
      const admission = authorizeAndConsume(p, k.secret).then(
        () => ({ admitted: true }),
        (e) => ({ admitted: false, error: e.message }),
      );
      await sleep(350);
      await lock.query("commit");
      assert.deepEqual(await admission, {
        admitted: false,
        error: "ACCESS_EXPIRED",
      });
      assert.equal(
        (
          await p.query(
            "select units from usage_bucket where account_id=$1 and day=current_date",
            [alice.id],
          )
        ).rows[0].units,
        50,
      );
    } finally {
      await lock.query("rollback");
      lock.release();
    }
    return "Real 350 ms lock waits; expiry crossed; no virtual time passed to service";
  },
);
// Isolated browser sees loopback endpoints via two in-namespace proxies, never a host gateway.
const proxies = [];
for (const [origin, target, port] of [
  [c.origin, "app", 3000],
  [c.inboxOrigin, "inbox", 8025],
]) {
  const proxy = http.createServer((req, res) => {
    const upstream = http.request(
      {
        hostname: target,
        port,
        path: req.url,
        method: req.method,
        headers: req.headers,
      },
      (r) => {
        res.writeHead(r.statusCode, r.headers);
        r.pipe(res);
      },
    );
    upstream.on("error", () => res.end());
    req.pipe(upstream);
  });
  await new Promise((r) =>
    proxy.listen(Number(new URL(origin).port), "127.0.0.1", r),
  );
  proxies.push(proxy);
}
let browserUser;
await check(
  "real Chromium registration, inbox verification, purchase, key, same-key renewal and revoke",
  async () => {
    const browser = await chromium.launch({
      executablePath: "/usr/bin/chromium",
      headless: true,
      args: [
        "--no-sandbox",
        "--disable-dev-shm-usage",
        "--disable-background-networking",
        "--disable-component-update",
      ],
    });
    try {
      const page = await browser.newPage({
        viewport: { width: 1280, height: 900 },
      });
      const errors = [];
      page.on("pageerror", (e) => errors.push(e.message));
      await page.goto(c.origin);
      const email = "browser-" + randomUUID().slice(0, 8) + "@example.test",
        password = "Browser-password-" + randomUUID();
      const signup = page.locator("form").nth(1);
      await signup.locator("[name=email]").fill(email);
      await signup.locator("[name=password]").fill(password);
      await signup
        .getByRole("button", { name: "Register", exact: true })
        .click();
      await page
        .getByRole("status")
        .filter({ hasText: "Check the local inbox" })
        .waitFor();
      const link = (await inbox(email, "Verify lab email")).trim();
      await page.goto(link);
      const signin = page.locator("form").first();
      await signin.locator("[name=email]").fill(email);
      await signin.locator("[name=password]").fill(password);
      await signin
        .getByRole("button", { name: "Sign in", exact: true })
        .click();
      await page
        .getByRole("heading", { name: "API keys", exact: true })
        .waitFor();
      await page
        .getByRole("button", { name: "30 days PLS", exact: true })
        .click();
      await page
        .getByRole("button", { name: "Simulate purchase", exact: true })
        .click();
      await page.getByText("Active", { exact: true }).waitFor();
      await page
        .getByRole("button", { name: "Create key", exact: true })
        .click();
      const keyInput = page.getByRole("textbox", { name: "New API key" });
      await page.locator('[aria-label="New API key"]').waitFor();
      const secret = await page
        .locator('[aria-label="New API key"]')
        .inputValue();
      const dataInput = page.locator("[name=key]");
      await dataInput.fill(secret);
      await page
        .getByRole("button", { name: "Request synthetic data", exact: true })
        .click();
      await page
        .locator("pre")
        .filter({ hasText: '"synthetic": true' })
        .waitFor();
      await page
        .getByRole("button", { name: "90 days PLS", exact: true })
        .click();
      await page
        .getByRole("button", { name: "Simulate purchase", exact: true })
        .click();
      await page
        .getByRole("button", { name: "Request synthetic data", exact: true })
        .click();
      await page
        .locator("pre")
        .filter({ hasText: '"remaining": 98' })
        .waitFor();
      const cookies = await page.context().cookies();
      const cookie = cookies.map((x) => x.name + "=" + x.value).join("; ");
      const state = (await request("/api/account", undefined, { cookie })).data;
      browserUser = {
        email,
        password,
        cookie,
        id: state.customer.id,
        key: { secret },
      };
      await page
        .getByRole("button", { name: "Dismiss key", exact: true })
        .click();
      await dataInput.fill("");
      await page.screenshot({
        path: "evidence/dashboard-desktop.png",
        fullPage: true,
      });
      await page.setViewportSize({ width: 390, height: 844 });
      await page.screenshot({
        path: "evidence/dashboard-mobile.png",
        fullPage: true,
      });
      assert.equal(
        await page.evaluate(
          () => document.documentElement.scrollWidth > innerWidth,
        ),
        false,
      );
      await page.keyboard.press("Tab");
      assert.ok(
        await page.evaluate(() => document.activeElement !== document.body),
      );
      await page.getByRole("button", { name: "Revoke", exact: true }).click();
      await dataInput.fill(secret);
      await page
        .getByRole("button", { name: "Request synthetic data", exact: true })
        .click();
      await page.locator("pre").filter({ hasText: "REVOKED_KEY" }).waitFor();
      assert.deepEqual(errors, []);
    } finally {
      await browser.close();
    }
  },
);
await check(
  "100 useful warm protected HTTP requests and actual SQL query count",
  async () => {
    const users = [];
    for (let n = 0; n < 4; n++) {
      if (n) await sleep(11000);
      const u = await register("perf" + n);
      const i = (
        await request("/api/invoices", { mode: "pls", days: 30 }, session(u))
      ).data;
      assert.equal(
        (await request("/api/simulate", { invoiceId: i.id }, session(u))).data
          .result,
        "granted",
      );
      u.key = (
        await request("/api/keys", { label: "performance" }, session(u))
      ).data;
      users.push(u);
    }
    const latencies = [],
      queries = [];
    const coldStart = performance.now();
    assert.equal(
      (
        await request("/api/data", undefined, {
          authorization: "Bearer " + users[0].key.secret,
        })
      ).status,
      200,
    );
    const firstMs = performance.now() - coldStart;
    for (let n = 0; n < 100; n++) {
      const start = performance.now(),
        r = await request("/api/data", undefined, {
          authorization: "Bearer " + users[n % 4].key.secret,
        });
      assert.equal(r.status, 200);
      assert.equal(r.data.synthetic, true);
      latencies.push(performance.now() - start);
      queries.push(Number(r.headers["x-lab-sql-queries"]));
    }
    latencies.sort((a, b) => a - b);
    const measurement = {
      admitted: 100,
      deniedIncluded: 0,
      concurrency: 1,
      accounts: 4,
      firstRequestMs: firstMs,
      p50Ms: latencies[49],
      p95Ms: latencies[94],
      sqlStatementsPerAdmission: [...new Set(queries)],
      dataset: "one synthetic row, four verified accounts",
      runtimeCaps: {
        db: "0.75 CPU / 768 MiB",
        app: "0.5 CPU / 512 MiB",
        inbox: "0.125 CPU / 128 MiB",
        runner: "0.625 CPU / 640 MiB",
      },
      path: "private HTTP to Fastify; no provider or mail calls on admission path",
    };
    fs.writeFileSync(
      "evidence/performance.json",
      JSON.stringify(measurement, null, 2),
    );
    return measurement;
  },
);
for (const proxy of proxies) await new Promise((r) => proxy.close(r));
await p.end();
await provider.end();
console.log("INTEGRATION_COMPLETE");
