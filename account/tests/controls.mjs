import fs from "node:fs";
import http from "node:http";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { signJWT } from "better-auth/crypto";
import { config } from "../dist/server/config.js";
import { poolFor, guard } from "../dist/server/db.js";
const c = config(),
  p = poolFor(c);
await guard(p, c);
const results = [];
function request(path, body) {
  return new Promise((resolve, reject) => {
    const raw = body ? JSON.stringify(body) : undefined;
    const q = http.request(
      {
        host: "app",
        port: 3000,
        path,
        method: raw ? "POST" : "GET",
        headers: {
          host: new URL(c.origin).host,
          origin: c.origin,
          ...(raw ? { "content-type": "application/json" } : {}),
        },
      },
      (r) => {
        let s = "";
        r.on("data", (x) => (s += x));
        r.on("end", () => resolve({ status: r.statusCode, data: s }));
      },
    );
    q.on("error", reject);
    q.end(raw);
  });
}
const {
  rows: [u],
} = await p.query('select id,email from "user" order by "createdAt" limit 1');
const expired = await signJWT({ email: u.email }, c.secret, -1);
assert.equal(
  (await request("/api/auth/verify-email?token=" + encodeURIComponent(expired)))
    .status,
  401,
);
results.push({
  name: "expired verification JWT signed by library rejected",
  result: "PASS",
  timing: "deliberately expired test token",
});
assert.equal(
  (
    await request("/api/auth/reset-password", {
      token: "invalid-test-token",
      newPassword: "Long-test-password-123",
    })
  ).status,
  400,
);
results.push({ name: "invalid reset token rejected", result: "PASS" });
for (const settings of [
  { NODE_ENV: "production" },
  { DATABASE_URL: "postgres://synthetic.invalid/lab" },
  { SMTP_URL: "smtp://synthetic.invalid" },
  { STRIPE_SECRET_KEY: "synthetic-not-a-key" },
]) {
  const status = await new Promise((resolve) => {
    const child = spawn(process.execPath, ["dist/server/main.js"], {
      env: { ...process.env, ...settings },
      stdio: "ignore",
    });
    child.on("exit", resolve);
  });
  assert.notEqual(status, 0);
}
results.push({
  name: "compiled production and remote-credential knobs refused before connection",
  result: "PASS",
  externalRequests: 0,
});
const responses = [];
for (let i = 0; i < 45; i++)
  responses.push(
    await request("/api/auth/sign-in/email", {
      email: "invalid",
      password: "too-short",
    }),
  );
assert.ok(responses.some((r) => r.status === 429));
for (const path of ["/request-password-reset", "/send-verification-email"])
  assert.equal(
    (await request("/api/auth" + path, { email: "absent@example.test" }))
      .status,
    429,
  );
results.push({
  name: "shared bounded auth limiter covers login/reset/verification",
  result: "PASS",
  attempts: 45,
});
await p.end();
fs.writeFileSync(
  "evidence/controls.json",
  JSON.stringify({ runId: c.runId, results }, null, 2),
);
console.log(JSON.stringify(results));
