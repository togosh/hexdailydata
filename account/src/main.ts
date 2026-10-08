import Fastify from "fastify";
import statics from "@fastify/static";
import { fromNodeHeaders } from "better-auth/node";
import { z } from "zod";
import { randomUUID } from "node:crypto";
import path from "node:path";
import { config } from "./config.js";
import { poolFor, guard, Denied, tx, lockAccount } from "./db.js";
import { makeAuth } from "./auth.js";
import {
  createInvoice,
  eventSchema,
  hash,
  processEvent,
  sign,
  verify,
} from "./billing.js";
import { authorizeAndConsume, createKey, revokeKey } from "./access.js";
import { worker } from "./worker.js";
const c = config(),
  p = poolFor(c),
  provider = poolFor(c, true);
await guard(p, c);
await guard(provider, c, true);
const auth = makeAuth(c, p),
  app = Fastify({ logger: false, bodyLimit: 16384, trustProxy: false });
const email = z
  .string()
  .trim()
  .toLowerCase()
  .regex(/^[a-z0-9.!#$%&'*+/=?^_`{|}~-]{1,64}@example\.test$/);
const password = z.string().min(12).max(128);
const authBodies: Record<string, z.ZodType> = {
  "/sign-up/email": z.object({ email, password }).strict(),
  "/sign-in/email": z.object({ email, password }).strict(),
  "/request-password-reset": z.object({ email }).strict(),
  "/send-verification-email": z.object({ email }).strict(),
  "/reset-password": z
    .object({ token: z.string().min(10).max(2048), newPassword: password })
    .strict(),
  "/sign-out": z.object({}).strict(),
};
// Fixed-size shared limiter: no caller-selected identity is retained.
const rates = new Map<string, { start: number; count: number }>();
app.addHook("onRequest", async (req, reply) => {
  reply
    .header("cache-control", "no-store")
    .header("referrer-policy", "no-referrer")
    .header("x-content-type-options", "nosniff")
    .header(
      "content-security-policy",
      "default-src 'self'; script-src 'self'; style-src 'self'; connect-src 'self'; img-src 'self' data:; frame-ancestors 'none'; base-uri 'none'; form-action 'self'",
    );
  if (
    req.headers.host !== new URL(c.origin).host ||
    [
      "forwarded",
      "x-forwarded-host",
      "x-forwarded-proto",
      "x-forwarded-for",
      "x-real-ip",
    ].some((h) => req.headers[h])
  )
    throw new Denied("INVALID_HOST", 400);
  if (
    req.method !== "GET" &&
    req.url !== "/internal/events" &&
    req.headers.origin !== c.origin
  )
    throw new Denied("ORIGIN_REQUIRED", 403);
  if (req.headers.origin && req.headers.origin !== c.origin)
    throw new Denied("FOREIGN_ORIGIN", 403);
  if (req.url.startsWith("/api/auth/")) {
    const bucket = req.method;
    const t = Date.now(),
      r = rates.get(bucket);
    if (!r || t - r.start > 60000) rates.set(bucket, { start: t, count: 1 });
    else if (++r.count > 40) throw new Denied("AUTH_RATE_LIMIT", 429);
  }
});
app.setErrorHandler((e, _req, reply) => {
  if (e instanceof Denied) return reply.code(e.status).send({ error: e.code });
  if (e instanceof z.ZodError || e instanceof SyntaxError)
    return reply.code(400).send({ error: "INVALID_INPUT" });
  console.error("REQUEST_FAILED");
  return reply.code(500).send({ error: "REQUEST_FAILED" });
});
app.route({
  method: ["GET", "POST"],
  url: "/api/auth/*",
  handler: async (req, reply) => {
    const started = performance.now();
    const url = new URL(req.url, c.origin),
      sub = url.pathname.slice("/api/auth".length);
    let body: any;
    if (req.method === "POST") {
      if (!authBodies[sub]) throw new Denied("AUTH_ROUTE_DISABLED", 404);
      body = authBodies[sub].parse(req.body);
      if (sub === "/sign-up/email") {
        body.name = "Lab member";
        body.callbackURL = c.origin + "/";
      }
      if (sub === "/send-verification-email") body.callbackURL = c.origin + "/";
      if (sub === "/request-password-reset")
        body.redirectTo = c.origin + "/reset";
    } else {
      if (
        sub !== "/get-session" &&
        sub !== "/verify-email" &&
        !/^\/reset-password\/[A-Za-z0-9_-]{10,200}$/.test(sub)
      )
        throw new Denied("AUTH_ROUTE_DISABLED", 404);
      for (const key of url.searchParams.keys())
        if (!["token", "callbackURL"].includes(key))
          throw new Denied("INVALID_QUERY");
      const cb = url.searchParams.get("callbackURL");
      if (cb && ![c.origin + "/", c.origin + "/reset", "/"].includes(cb))
        throw new Denied("REDIRECT_REFUSED");
    }
    const token =
      sub === "/verify-email"
        ? url.searchParams.get("token")
        : sub === "/reset-password"
          ? body?.token
          : undefined;
    if (token) {
      if (token.length > 2048) throw new Denied("INVALID_TOKEN");
      const { rowCount } = await p.query(
        "insert into used_link(digest,expires_at) values($1,now()+interval '1 hour') on conflict do nothing",
        [hash(sub + token)],
      );
      if (!rowCount) throw new Denied("TOKEN_ALREADY_USED", 401);
    }
    let response: Response;
    try {
      response = await auth.handler(
        new Request(url, {
          method: req.method,
          headers: fromNodeHeaders(req.headers),
          ...(body ? { body: JSON.stringify(body) } : {}),
        }),
      );
    } catch (e) {
      if (token) throw new Denied("AUTH_LINK_RETRY_REQUEST_NEW", 503);
      throw e;
    }
    // An ambiguous consumed link is never reopened. Recovery uses a fresh library link.
    if (token && response.status >= 500)
      throw new Denied("AUTH_LINK_RETRY_REQUEST_NEW", 503);
    reply.code(response.status);
    for (const [key, value] of response.headers)
      if (key !== "set-cookie") reply.header(key, value);
    const cookies = response.headers.getSetCookie();
    if (cookies.length) reply.header("set-cookie", cookies);
    const raw = await response.text();
    // Bounded response floor reduces the ordinary SQL branch timing signal.
    // Load and failures may exceed it; this is not a constant-time guarantee.
    if (
      [
        "/sign-up/email",
        "/sign-in/email",
        "/request-password-reset",
        "/send-verification-email",
      ].includes(sub)
    )
      await new Promise((r) =>
        setTimeout(r, Math.max(0, 500 - (performance.now() - started))),
      );
    if (sub === "/sign-up/email" && response.ok)
      return {
        status: true,
        message: "Check the local inbox if registration can proceed.",
      };
    if (sub === "/sign-in/email" && response.ok) {
      const data = JSON.parse(raw);
      return { user: data.user };
    }
    if (sub === "/get-session" && response.ok) {
      const data = JSON.parse(raw);
      return data ? { user: data.user } : null;
    }
    return raw;
  },
});
async function account(req: any) {
  const session = await auth.api.getSession({
    headers: fromNodeHeaders(req.headers),
  });
  if (!session?.user.emailVerified)
    throw new Denied("VERIFIED_LOGIN_REQUIRED", 401);
  return session.user.id;
}
app.get("/health", async () => ({ lab: true, runId: c.runId }));
app.get("/api/account", async (req) => {
  const id = await account(req);
  await tx(p, (q) => lockAccount(q, id));
  const results = await Promise.all([
    p.query(
      "select id,card_active,card_due,disabled from customer where id=$1",
      [id],
    ),
    p.query(
      "select * from invoice where account_id=$1 order by created_at desc limit 100",
      [id],
    ),
    p.query(
      "select * from grant_record where account_id=$1 order by starts_at",
      [id],
    ),
    p.query(
      "select id,label,prefix,revoked,created_at from api_key where account_id=$1 order by created_at",
      [id],
    ),
    p.query(
      "select units from usage_bucket where account_id=$1 and day=current_date",
      [id],
    ),
  ]);
  return {
    customer: results[0].rows[0],
    invoices: results[1].rows,
    grants: results[2].rows,
    keys: results[3].rows,
    remaining: 100 - (results[4].rows[0]?.units ?? 0),
    annualDemo: c.annualDemo,
    inboxOrigin: c.inboxOrigin,
  };
});
app.post("/api/invoices", async (req) => {
  const id = await account(req);
  const b = z
    .object({ mode: z.enum(["pls", "card"]), days: z.number().int() })
    .strict()
    .parse(req.body);
  return createInvoice(p, id, b.mode, b.days, c.annualDemo);
});
app.post("/api/simulate", async (req) => {
  const id = await account(req);
  const b = z
    .object({
      invoiceId: z.uuid(),
      status: z
        .enum([
          "paid",
          "pending",
          "refund",
          "partial-refund",
          "failed",
          "cancel",
        ])
        .default("paid"),
      missCallback: z.boolean().default(false),
    })
    .strict()
    .parse(req.body);
  const {
    rows: [i],
  } = await p.query("select * from invoice where id=$1 and account_id=$2", [
    b.invoiceId,
    id,
  ]);
  if (!i) throw new Denied("INVOICE_NOT_FOUND", 404);
  // Stable economic identity is this invoice; every delivery has its own event identity.
  const e = await tx(provider, async (pq) => {
    await pq.query("select pg_advisory_xact_lock(hashtextextended($1,0))", [
      id,
    ]);
    const {
      rows: [seq],
    } = await pq.query(
      "select count(*)::int n from fake_provider.record where payload->>'accountId'=$1",
      [id],
    );
    const e = eventSchema.parse({
      eventId: randomUUID(),
      paymentId: i.id,
      invoiceId: i.id,
      accountId: id,
      amount: i.amount,
      asset: i.mode === "pls" ? "PLS" : "USD",
      chain: i.mode === "pls" ? 369 : 0,
      recipient: "lab-vault",
      status: b.status,
      version: seq.n + 1,
    });
    await pq.query(
      "insert into fake_provider.record(event_id,payment_id,payload) values($1,$2,$3)",
      [e.eventId, e.paymentId, e],
    );
    return e;
  });
  const raw = JSON.stringify(e);
  return {
    simulation: true,
    eventId: e.eventId,
    result: b.missCallback
      ? "durable_provider_record"
      : await processEvent(
          p,
          verify(raw, sign(raw, c.eventSecret), c.eventSecret),
        ),
  };
});
app.register(async (sub) => {
  sub.removeContentTypeParser("application/json");
  sub.addContentTypeParser(
    "application/json",
    { parseAs: "string" },
    (_req, body, done) => done(null, body),
  );
  sub.post("/internal/events", async (req) => ({
    result: await processEvent(
      p,
      verify(
        req.body as string,
        String(req.headers["x-lab-signature"] ?? ""),
        c.eventSecret,
      ),
    ),
  }));
});
app.post("/api/keys", async (req) => {
  const id = await account(req);
  const b = z
    .object({ label: z.string().min(1).max(40), rotate: z.uuid().optional() })
    .strict()
    .parse(req.body);
  return createKey(p, id, b.label, b.rotate);
});
app.post("/api/keys/revoke", async (req) => {
  const id = await account(req);
  const b = z.object({ id: z.uuid() }).strict().parse(req.body);
  return revokeKey(p, id, b.id);
});
app.get("/api/data", async (req, reply) => {
  if (req.url.includes("?")) throw new Denied("QUERY_KEYS_FORBIDDEN");
  const a = String(req.headers.authorization ?? "");
  const result = await authorizeAndConsume(
    p,
    a.startsWith("Bearer ") ? a.slice(7) : "",
  );
  reply.header("x-lab-sql-queries", result.queryCount);
  return {
    synthetic: true,
    series: [{ day: "2026-09-19", fixtureValue: "42.00000000" }],
    remaining: result.remaining,
  };
});
await app.register(statics, { root: path.resolve("dist/ui") });
app.get("/reset", async (_req, reply) => reply.sendFile("index.html"));
const jobs = worker(p);
await app.listen({ host: "0.0.0.0", port: 3000 });
console.log("LAB_APP_READY");
process.on(
  "SIGTERM",
  () =>
    void (async () => {
      await jobs.stop();
      await app.close();
      await p.end();
      await provider.end();
      process.exit(0);
    })(),
);
