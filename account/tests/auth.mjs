import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { performance } from "node:perf_hooks";
import { signJWT } from "better-auth/crypto";
import {
  c,
  p,
  request,
  register,
  login,
  inbox,
  session,
  check,
  close,
  sleep,
  browserFixture,
  browserLogin,
} from "./fixture.mjs";
import { createKey } from "../dist/server/access.js";
const phase = process.argv[2] || "links",
  seen = [];
async function reset(u) {
  assert.equal(
    (await request("/api/auth/request-password-reset", { email: u.email }))
      .status,
    200,
  );
  const m = await inbox(u.email, "Reset lab password", seen);
  seen.push(m.id);
  const link = new URL(m.text),
    r = await request(link.pathname + link.search);
  assert.equal(r.status, 302);
  return new URL(r.headers.location, c.origin).searchParams.get("token");
}
const consume = (token, password, headers = {}) =>
  request(
    "/api/auth/reset-password",
    { token, newPassword: password },
    headers,
  );
try {
  if (phase === "samples")
    await check(
      "generic existing/absent responses and bounded empirical timing samples",
      async () => {
        const u = await register("auth-samples"),
          stats = [];
        for (const route of [
          "/sign-up/email",
          "/sign-in/email",
          "/request-password-reset",
          "/send-verification-email",
        ]) {
          const pairs = [];
          for (let n = 0; n < 3; n++) {
            const pair = [];
            for (const exists of [n % 2 === 0, n % 2 !== 0]) {
              const body = {
                email: exists
                  ? u.email
                  : "absent-" + randomUUID() + "@example.test",
                ...(route.includes("/email")
                  ? { password: "Wrong-password-" + randomUUID() }
                  : {}),
              };
              const start = performance.now(),
                r = await request("/api/auth" + route, body);
              pair.push({
                exists,
                status: r.status,
                body: r.data,
                ms: +(performance.now() - start).toFixed(2),
              });
            }
            assert.equal(pair[0].status, pair[1].status);
            assert.deepEqual(pair[0].body, pair[1].body);
            assert.ok(pair.every((r) => r.ms >= 480 && r.ms < 5000));
            pairs.push(pair.map(({ body, ...safe }) => safe));
          }
          stats.push({ route, pairs });
        }
        return {
          samples: stats,
          claim:
            "three pairs/route; empirical bounds only, not cryptographic constant time",
        };
      },
      "auth",
    );
  else if (phase === "links")
    await check(
      "reset expiry, concurrent single use, two outstanding links, cross-account and verification replay",
      async () => {
        const a = await register("auth-links-a"),
          b = await register("auth-links-b"),
          x = await reset(a),
          y = await reset(a),
          pw = "Replacement-" + randomUUID();
        assert.equal(
          (
            await request(
              "/api/auth/reset-password",
              { token: x, newPassword: pw, accountId: b.id },
              session(b),
            )
          ).status,
          400,
        );
        assert.equal((await consume(x, pw, session(b))).status, 200);
        assert.equal(
          (await request("/api/account", undefined, session(b))).status,
          200,
        );
        assert.equal(
          (await request("/api/account", undefined, session(a))).status,
          401,
        );
        assert.equal((await consume(x, pw)).status, 401);
        assert.equal((await consume(y, pw)).status, 200);
        const z = await reset(a),
          rs = await Promise.all([consume(z, pw), consume(z, pw)]);
        assert.deepEqual(rs.map((r) => r.status).sort(), [200, 401]);
        const expired = await reset(a);
        await p.query(
          "update verification set \"expiresAt\"=now()-interval '1 second' where identifier=$1",
          ["reset-password:" + expired],
        );
        assert.equal((await consume(expired, pw)).status, 400);
        assert.equal(
          (await consume("invalid-synthetic-token", pw)).status,
          400,
        );
        const email = "two-verify-" + randomUUID() + "@example.test",
          password = "Verify-password-" + randomUUID();
        assert.equal(
          (await request("/api/auth/sign-up/email", { email, password }))
            .status,
          200,
        );
        const first = await inbox(email, "Verify lab email");
        await sleep(1100);
        assert.equal(
          (await request("/api/auth/send-verification-email", { email }))
            .status,
          200,
        );
        const second = await inbox(email, "Verify lab email", [first.id]);
        const call = (m, extra = "") => {
          const u = new URL(m.text);
          return request(u.pathname + u.search + extra, undefined, session(b));
        };
        assert.equal(
          (await call(first, "&email=" + encodeURIComponent(b.email))).status,
          400,
        );
        assert.ok([200, 302].includes((await call(first)).status));
        assert.equal((await call(first)).status, 401);
        assert.ok([200, 302].includes((await call(second)).status));
        assert.equal(
          (await request("/api/account", undefined, session(b))).data.customer
            .id,
          b.id,
        );
        const token = await signJWT({ email }, c.secret, -1);
        assert.equal(
          (
            await request(
              "/api/auth/verify-email?token=" + encodeURIComponent(token),
            )
          ).status,
          401,
        );
        assert.equal((await login({ ...a, password: pw })).id, a.id);
        return {
          concurrentStatuses: rs.map((r) => r.status),
          outstandingResetPolicy:
            "each independently usable once until TTL; pinned Better Auth consumeVerificationValue",
          verificationPolicy:
            "independent JWTs, local per-link replay fence; never signs in a different account",
        };
      },
      "auth",
    );
  else if (phase === "failure")
    await check(
      "actual SQL timeout after reset consumption has safe fresh-link recovery",
      async () => {
        const a = await register("auth-failure"),
          token = await reset(a),
          pw = "Recovered-" + randomUUID(),
          q = await p.connect();
        let r, ms;
        try {
          await q.query("begin");
          await q.query('select id from account where "userId"=$1 for update', [
            a.id,
          ]);
          const start = performance.now();
          r = await consume(token, pw);
          ms = performance.now() - start;
          assert.equal(r.status, 503);
          assert.equal(r.data.error, "AUTH_LINK_RETRY_REQUEST_NEW");
          assert.ok(ms >= 4900);
        } finally {
          await q.query("rollback");
          q.release();
        }
        assert.equal((await consume(token, pw)).status, 401);
        await login(a);
        const fresh = await reset(a);
        assert.equal((await consume(fresh, pw)).status, 200);
        await login({ ...a, password: pw });
        assert.equal(
          (await request("/api/account", undefined, session(a))).status,
          401,
        );
        return {
          failureStatus: r.status,
          actualLockWaitMs: Math.round(ms),
          replay: 401,
          freshLink: 200,
          libraryTokenNotReopened: true,
        };
      },
      "auth",
    );
  else if (phase === "browser")
    await check(
      "two browser contexts reject identifier substitution, stale links, expired sessions and credential confusion",
      async () => {
        const a = await register("browser-owner-a"),
          b = await register("browser-owner-b"),
          key = await createKey(p, a.id, "browser-private"),
          f = await browserFixture();
        try {
          const ca = await f.browser.newContext(),
            cb = await f.browser.newContext(),
            pa = await ca.newPage(),
            pb = await cb.newPage();
          await browserLogin(pa, a);
          await browserLogin(pb, b);
          const api = (page, url, body) =>
            page.evaluate(
              async ({ url, body }) => {
                const r = await fetch(
                  url,
                  body
                    ? {
                        method: "POST",
                        headers: { "content-type": "application/json" },
                        body: JSON.stringify(body),
                      }
                    : {},
                );
                return { status: r.status, data: await r.json() };
              },
              { url, body },
            );
          assert.equal(
            (await api(pb, "/api/keys/revoke", { id: key.id })).status,
            404,
          );
          assert.equal(
            (await api(pb, "/api/keys", { label: "wrong", rotate: key.id }))
              .status,
            404,
          );
          assert.ok(
            !(await api(pb, "/api/account")).data.keys.some(
              (k) => k.id === key.id,
            ),
          );
          assert.equal((await api(pa, "/api/data")).status, 401);
          assert.equal(
            (
              await request("/api/account", undefined, {
                authorization: "Bearer " + key.secret,
              })
            ).status,
            401,
          );
          const stale = new URL(a.verifyLink);
          assert.equal((await cb.request.get(stale.toString())).status(), 401);
          assert.equal((await api(pb, "/api/account")).data.customer.id, b.id);
          assert.equal(
            (
              await request("/api/auth/sign-in/email", {
                email: a.email,
                password: b.password,
              })
            ).status,
            401,
          );
          await p.query(
            'update session set "expiresAt"=now()-interval \'1 second\' where "userId"=$1',
            [a.id],
          );
          assert.equal((await api(pa, "/api/account")).status, 401);
          assert.equal((await api(pb, "/api/account")).status, 200);
          assert.equal(
            (
              await request("/health", undefined, {
                host: "foreign.example.test",
              })
            ).status,
            400,
          );
          assert.equal(
            (
              await request(
                "/api/keys",
                { label: "origin" },
                { ...session(b), origin: "http://foreign.example.test" },
              )
            ).status,
            403,
          );
          assert.equal(
            (
              await request(
                "/api/auth/verify-email?token=invalid&callbackURL=https://foreign.example.test",
              )
            ).status,
            400,
          );
          return {
            contexts: 2,
            expiredSessionRejected: true,
            otherSessionUnaffected: true,
            cookieKeySeparation: true,
          };
        } finally {
          await f.close();
        }
      },
      "auth",
    );
  else throw Error("UNKNOWN_AUTH_PHASE");
} catch {
  process.exitCode = 1;
} finally {
  await close();
}
