import assert from "node:assert/strict";
import fs from "node:fs";
import { randomUUID } from "node:crypto";
import {
  c,
  p,
  provider,
  request,
  session,
  register,
  inbox,
  payload,
  check,
  close,
  browserFixture,
  browserLogin,
  sleep,
  failure,
  sqlUser,
} from "./fixture.mjs";
import { createInvoice, processEvent } from "../dist/server/billing.js";
import {
  createKey,
  revokeKey,
  authorizeAndConsume,
} from "../dist/server/access.js";
import { guard } from "../dist/server/db.js";
const privateFile = "/run/fixture/customer.json",
  stage = process.argv[2];
try {
  if (stage === "prepare") {
    const a = await register("restore-a"),
      b = await register("restore-b");
    const i = await createInvoice(p, a.id, "pls", 30, false);
    await processEvent(p, payload(i, a));
    const active = await createKey(p, a.id, "retained active"),
      revoked = await createKey(p, a.id, "retained revoked");
    await revokeKey(p, a.id, revoked.id);
    await authorizeAndConsume(p, active.secret);
    assert.equal(
      (await request("/api/auth/request-password-reset", { email: a.email }))
        .status,
      200,
    );
    const resetMail = await inbox(a.email, "Reset lab password");
    const link = new URL(resetMail.text);
    const r = await request(link.pathname + link.search);
    assert.equal(r.status, 302);
    const token = new URL(r.headers.location, c.origin).searchParams.get(
      "token",
    );
    assert.ok(token);
    const previous = await request("/api/auth/reset-password", {
      token,
      newPassword: a.password,
    });
    assert.equal(previous.status, 200);
    const login = await request("/api/auth/sign-in/email", {
      email: a.email,
      password: a.password,
    });
    assert.equal(login.status, 200);
    a.cookie = login.headers["set-cookie"]
      .map((x) => x.split(";")[0])
      .join("; ");
    const pending = await createInvoice(p, b.id, "pls", 30, false);
    const refunds = [];
    for (const mode of ["pls", "card"]) {
      const user = await sqlUser("restore-refund"),
        invoice = await createInvoice(p, user.id, mode, 30, false),
        event = payload(invoice, user, "refund", 4),
        key = await createKey(p, user.id, "restored refund fence");
      assert.equal(await processEvent(p, event), "needs_review");
      refunds.push({ event, key, mode });
    }
    fs.writeFileSync(
      privateFile,
      JSON.stringify({
        a,
        b,
        active,
        revoked,
        token,
        resetMailId: resetMail.id,
        pending,
        refunds,
        source: {
          labId: c.labId,
          runId: c.runId,
          database: c.database,
          origin: c.origin,
        },
      }),
    );
    console.log("RESTORE_FIXTURE_PREPARED_PRIVATE");
  } else if (stage === "seed") {
    // Source application is stopped before these pending records enter the backup.
    const f = JSON.parse(fs.readFileSync(privateFile));
    const e = payload(f.pending, f.b);
    await provider.query(
      "insert into fake_provider.record(event_id,payment_id,payload) values($1,$2,$3)",
      [e.eventId, e.paymentId, e],
    );
    f.pendingEvent = e.eventId;
    f.mailId = randomUUID();
    await p.query(
      "insert into outbox(id,dedup,recipient,subject,body) values($1,$2,$3,'Restored pending delivery','Synthetic restore witness')",
      [f.mailId, "restore:" + f.mailId, f.a.email],
    );
    fs.writeFileSync(privateFile, JSON.stringify(f));
    console.log("PENDING_PROVIDER_AND_MAIL_SEEDED");
  } else if (stage === "journey") {
    const f = JSON.parse(fs.readFileSync(privateFile));
    await check(
      "restored refund-before-credit identity prevents later paid activation",
      async () => {
        for (const { event, key } of f.refunds) {
          assert.equal(
            (
              await p.query(
                "select refund_seen from payment_identity where payment_id=$1",
                [event.paymentId],
              )
            ).rows[0].refund_seen,
            true,
          );
          for (const version of [3, 5])
            assert.equal(
              await processEvent(p, {
                ...event,
                eventId: randomUUID(),
                status: "paid",
                version,
              }),
              "needs_review",
            );
          await assert.rejects(
            () => authorizeAndConsume(p, key.secret),
            /ACCESS_EXPIRED/,
          );
          assert.equal(
            (
              await p.query("select 1 from credit where payment_id=$1", [
                event.paymentId,
              ])
            ).rowCount,
            0,
          );
        }
        return {
          identities: 2,
          refundSeenRetained: true,
          credits: 0,
          admitted: false,
        };
      },
      "restored",
    );
    await check(
      "restored actual boundary, roles and source target refusal",
      async () => {
        assert.notEqual(c.labId, f.source.labId);
        assert.notEqual(c.runId, f.source.runId);
        assert.notEqual(c.database, f.source.database);
        assert.notEqual(c.origin, f.source.origin);
        await assert.rejects(
          () => guard(p, { ...c, ...f.source }),
          /WRONG_LAB_DATABASE/,
        );
        await assert.rejects(
          () => p.query("create table forbidden_restore_ddl(id int)"),
          /permission denied/,
        );
        await assert.rejects(
          () =>
            p.query(
              "insert into fake_provider.record values('wrong','wrong','{}')",
            ),
          /permission denied/,
        );
        assert.equal((await request("/health")).data.runId, c.runId);
        return {
          sourceDatabase: f.source.database,
          restoredDatabase: c.database,
          newBoundary: true,
        };
      },
      "restored",
    );
    await check(
      "restored session continuity, used reset replay, keys and account quota",
      async () => {
        const state = await request("/api/account", undefined, session(f.a));
        assert.equal(state.status, 200);
        assert.equal(state.data.customer.id, f.a.id);
        assert.equal(state.data.remaining, 99);
        assert.equal(
          (
            await request("/api/auth/reset-password", {
              token: f.token,
              newPassword: f.a.password,
            })
          ).status,
          401,
        );
        const r = await request("/api/data", undefined, {
          authorization: "Bearer " + f.active.secret,
        });
        assert.equal(r.status, 200);
        assert.equal(r.data.remaining, 98);
        assert.equal(
          (
            await request("/api/data", undefined, {
              authorization: "Bearer " + f.revoked.secret,
            })
          ).status,
          401,
        );
        assert.equal(
          (
            await p.query(
              "select units from burst_bucket where account_id=$1",
              [f.a.id],
            )
          ).rows[0].units >= 1,
          true,
        );
        return {
          authSecret:
            "privately retained for session continuity; never packaged",
          remaining: 98,
          revoked: "rejected",
          usedReset: "rejected",
        };
      },
      "restored",
    );
    await check(
      "restored pending independent provider reconciliation and SMTP outbox delivery",
      async () => {
        await inbox(f.a.email, "Restored pending delivery");
        for (let n = 0; n < 50; n++) {
          if (
            (
              await p.query("select 1 from credit where payment_id=$1", [
                f.pending.id,
              ])
            ).rowCount
          )
            break;
          await sleep(200);
        }
        assert.equal(
          (
            await p.query("select 1 from credit where payment_id=$1", [
              f.pending.id,
            ])
          ).rowCount,
          1,
        );
        assert.ok(
          (
            await p.query("select delivered_at from outbox where id=$1", [
              f.mailId,
            ])
          ).rows[0].delivered_at,
        );
        return "Pending rows were included before dump; actual restored worker and local SMTP consumed them";
      },
      "restored",
    );
    await check(
      "fresh restored Chromium login, ownership, renewal and reset session revocation",
      async () => {
        const fixture = await browserFixture();
        try {
          const ca = await fixture.browser.newContext(),
            cb = await fixture.browser.newContext();
          const a = await ca.newPage(),
            b = await cb.newPage();
          const errors = [];
          a.on("pageerror", () => errors.push("pageerror"));
          b.on("pageerror", () => errors.push("pageerror"));
          await browserLogin(a, f.a);
          await browserLogin(b, f.b);
          const api = async (page, url, body) =>
            page.evaluate(
              async ({ url, body }) => {
                const r = await fetch(url, {
                  ...(body
                    ? {
                        method: "POST",
                        headers: { "content-type": "application/json" },
                        body: JSON.stringify(body),
                      }
                    : {}),
                });
                return { status: r.status, data: await r.json() };
              },
              { url, body },
            );
          const state = (await api(a, "/api/account")).data;
          assert.equal((await api(b, "/api/account")).data.customer.id, f.b.id);
          assert.equal(
            (await api(b, "/api/keys/revoke", { id: f.active.id })).status,
            404,
          );
          assert.equal(
            (await api(b, "/api/simulate", { invoiceId: state.invoices[0].id }))
              .status,
            404,
          );
          assert.equal(
            (
              await api(b, "/api/keys", {
                label: "cross-account",
                rotate: f.active.id,
              })
            ).status,
            404,
          );
          assert.equal((await api(a, "/api/data")).status, 401);
          await a
            .getByRole("button", { name: "90 days PLS", exact: true })
            .click();
          await a
            .getByRole("button", { name: "Simulate purchase", exact: true })
            .click();
          await a.getByRole("status").filter({ hasText: "granted" }).waitFor();
          await a.locator("[name=key]").fill(f.active.secret);
          await a
            .getByRole("button", {
              name: "Request synthetic data",
              exact: true,
            })
            .click();
          await a
            .locator("pre")
            .filter({ hasText: '"remaining": 97' })
            .waitFor();
          await a.locator("[name=key]").fill("");
          await a.screenshot({
            path: "evidence/restored-desktop.png",
            fullPage: true,
          });
          await a.setViewportSize({ width: 390, height: 844 });
          await a.screenshot({
            path: "evidence/restored-mobile.png",
            fullPage: true,
          });
          assert.equal(
            await a.evaluate(
              () => document.documentElement.scrollWidth > innerWidth,
            ),
            false,
          );
          await a.keyboard.press("Tab");
          assert.equal(
            await a.evaluate(() => document.activeElement !== document.body),
            true,
          );
          const oldCookies = (await ca.cookies())
            .map((x) => x.name + "=" + x.value)
            .join("; ");
          assert.equal(
            (
              await request("/api/auth/request-password-reset", {
                email: f.a.email,
              })
            ).status,
            200,
          );
          const mail = await inbox(f.a.email, "Reset lab password", [
            f.resetMailId,
          ]);
          const url = new URL(mail.text);
          // New reset links are built with the restored origin. Old mailed URLs keep the old origin.
          assert.equal(url.origin, c.origin);
          const redirect = await request(url.pathname + url.search);
          const token = new URL(
            redirect.headers.location,
            c.origin,
          ).searchParams.get("token");
          assert.equal(
            (
              await request("/api/auth/reset-password", {
                token,
                newPassword: f.a.password,
              })
            ).status,
            200,
          );
          assert.equal(
            (
              await request("/api/auth/reset-password", {
                token,
                newPassword: f.a.password,
              })
            ).status,
            401,
          );
          assert.equal(
            (await request("/api/account", undefined, { cookie: oldCookies }))
              .status,
            401,
          );
          assert.equal((await api(a, "/api/account")).status, 401);
          assert.equal((await api(b, "/api/account")).status, 200);
          assert.equal(
            (
              await request("/api/data", undefined, {
                authorization: "Bearer " + f.revoked.secret,
              })
            ).status,
            401,
          );
          assert.deepEqual(errors, []);
          return {
            contexts: 2,
            sameKeyRemaining: 97,
            sessionRevoked: true,
            desktop: [1280, 720],
            mobile: [390, 844],
          };
        } finally {
          await fixture.close();
        }
      },
      "restored",
    );
  } else if (stage === "forced-failure") {
    assert.equal((await request("/health")).data.runId, c.runId);
    console.log("INTENTIONAL_RESTORED_TEST_FAILURE");
    process.exitCode = 73;
  } else throw Error("UNKNOWN_RESTORE_STAGE");
} catch (e) {
  console.error("RESTORE_STAGE_FAILED " + JSON.stringify(failure(e)));
  process.exitCode = 1;
} finally {
  await close();
}
