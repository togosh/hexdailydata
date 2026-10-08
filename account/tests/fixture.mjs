// Shared bounded SQL/HTTP/SMTP fixture. Secrets stay in memory or an owned private mount.
import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import { randomUUID } from "node:crypto";
import { chromium } from "playwright";
import { config } from "../dist/server/config.js";
import { poolFor, guard } from "../dist/server/db.js";
export const c = config(),
  p = poolFor(c),
  provider = poolFor(c, true);
await guard(p, c);
await guard(provider, c, true);
export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
export const results = [];
export function failure(e) {
  const scalar = (v) =>
    typeof v === "number" || typeof v === "boolean" || v === null
      ? v
      : undefined;
  return {
    name: e.name,
    code: e.code,
    operator: e.operator,
    actual: scalar(e.actual),
    expected: scalar(e.expected),
    frames: e.stack
      ?.split("\n")
      .filter((x) => /^\s+at /.test(x))
      .slice(0, 4),
  };
}
export async function check(name, fn, file = "followthrough") {
  const start = Date.now();
  try {
    const detail = await fn();
    results.push({ name, result: "PASS", ms: Date.now() - start, detail });
    console.log("PASS " + name);
  } catch (e) {
    results.push({ name, result: "FAIL", error: failure(e) });
    console.error("FAIL " + name + " " + JSON.stringify(failure(e)));
    throw e;
  } finally {
    fs.writeFileSync(
      `evidence/${file}.json`,
      JSON.stringify(
        { runId: c.runId, at: new Date().toISOString(), results },
        null,
        2,
      ),
    );
  }
}
export function request(url, body, headers = {}) {
  return new Promise((resolve, reject) => {
    const raw = body === undefined ? undefined : JSON.stringify(body);
    const req = http.request(
      {
        hostname: process.env.LAB_APP_ALIAS || "app",
        port: 3000,
        path: url,
        method: raw ? "POST" : "GET",
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
    req.setTimeout(15000, () => req.destroy(Error("HTTP_TIMEOUT")));
    req.on("error", reject);
    req.end(raw);
  });
}
export const session = (u) => ({ cookie: u.cookie });
export async function inbox(email, subject, exclude = []) {
  for (let n = 0; n < 60; n++) {
    const list = await (
      await fetch("http://inbox:8025/api/v1/messages")
    ).json();
    const m = list.messages?.find(
      (m) =>
        m.To?.some((x) => x.Address === email) &&
        m.Subject === subject &&
        !exclude.includes(m.ID),
    );
    if (m) {
      const d = await (
        await fetch("http://inbox:8025/api/v1/message/" + m.ID)
      ).json();
      return { id: m.ID, text: d.Text.trim() };
    }
    await sleep(200);
  }
  throw Error("LOCAL_MAIL_NOT_RECEIVED");
}
export async function login(u) {
  const r = await request("/api/auth/sign-in/email", {
    email: u.email,
    password: u.password,
  });
  assert.equal(r.status, 200);
  return {
    ...u,
    id: r.data.user.id,
    cookie: r.headers["set-cookie"].map((x) => x.split(";")[0]).join("; "),
  };
}
export async function register(label) {
  const u = {
    email: label + "-" + randomUUID().slice(0, 8) + "@example.test",
    password: "Lab-password-" + randomUUID(),
  };
  assert.equal((await request("/api/auth/sign-up/email", u)).status, 200);
  const mail = await inbox(u.email, "Verify lab email"),
    url = new URL(mail.text);
  assert.ok(
    [200, 302].includes((await request(url.pathname + url.search)).status),
  );
  return { ...(await login(u)), verifyLink: mail.text };
}
export const payload = (i, u, status = "paid", version = 1) => ({
  eventId: randomUUID(),
  paymentId: i.id,
  invoiceId: i.id,
  accountId: u.id,
  amount: i.amount,
  asset: i.mode === "pls" ? "PLS" : "USD",
  chain: i.mode === "pls" ? 369 : 0,
  recipient: "lab-vault",
  status,
  version,
});
export async function sqlUser(label) {
  const id = randomUUID(),
    email = label + "-" + id.slice(0, 8) + "@example.test";
  await p.query(
    'insert into "user"(id,name,email,"emailVerified","createdAt","updatedAt") values($1,$2,$3,true,now(),now())',
    [id, "SQL fixture", email],
  );
  return { id, email };
}
export async function browserFixture() {
  const proxies = [];
  for (const [origin, host, port] of [
    [c.origin, process.env.LAB_APP_ALIAS || "app", 3000],
    [c.inboxOrigin, "inbox", 8025],
  ]) {
    const s = http.createServer((q, r) => {
      const up = http.request(
        {
          hostname: host,
          port,
          path: q.url,
          method: q.method,
          headers: q.headers,
        },
        (v) => {
          r.writeHead(v.statusCode, v.headers);
          v.pipe(r);
        },
      );
      up.on("error", () => {
        r.statusCode = 502;
        r.end();
      });
      q.pipe(up);
    });
    await new Promise((r) =>
      s.listen(Number(new URL(origin).port), "127.0.0.1", r),
    );
    proxies.push(s);
  }
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
  return {
    browser,
    close: async () => {
      await browser.close();
      for (const s of proxies) await new Promise((r) => s.close(r));
    },
  };
}
export async function browserLogin(page, u) {
  await page.goto(c.origin);
  const form = page.locator("form").first();
  await form.locator("[name=email]").fill(u.email);
  await form.locator("[name=password]").fill(u.password);
  await form.getByRole("button", { name: "Sign in", exact: true }).click();
  await page.getByRole("heading", { name: "API keys", exact: true }).waitFor();
}
export async function close() {
  await p.end();
  await provider.end();
}
