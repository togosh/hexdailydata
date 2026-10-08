import { betterAuth } from "better-auth";
import type pg from "pg";
import { createHash, randomUUID } from "node:crypto";
import type { Config } from "./config.js";
export function makeAuth(c: Config, p: pg.Pool) {
  const send = async (to: string, subject: string, url: string) => {
    if (!/^[^@]+@example\.test$/.test(to) || new URL(url).origin !== c.origin)
      throw Error("MAIL_BOUNDARY");
    await p.query(
      "insert into outbox(id,dedup,recipient,subject,body) values($1,$2,$3,$4,$5) on conflict(dedup) do nothing",
      [
        randomUUID(),
        createHash("sha256")
          .update(subject + url)
          .digest("hex"),
        to,
        subject,
        url,
      ],
    );
  };
  return betterAuth({
    database: p,
    baseURL: c.origin,
    secret: c.secret,
    trustedOrigins: [c.origin],
    logger: { disabled: true },
    emailAndPassword: {
      enabled: true,
      requireEmailVerification: true,
      autoSignIn: false,
      minPasswordLength: 12,
      maxPasswordLength: 128,
      resetPasswordTokenExpiresIn: 900,
      revokeSessionsOnPasswordReset: true,
      sendResetPassword: async ({ user, url }) =>
        send(user.email, "Reset lab password", url),
    },
    emailVerification: {
      sendOnSignUp: true,
      sendOnSignIn: false,
      autoSignInAfterVerification: false,
      expiresIn: 1800,
      sendVerificationEmail: async ({ user, url }) =>
        send(user.email, "Verify lab email", url),
    },
    session: { expiresIn: 3600, cookieCache: { enabled: false } },
    advanced: {
      useSecureCookies: false,
      defaultCookieAttributes: { httpOnly: true, sameSite: "lax" },
      ipAddress: { disableIpTracking: true },
    },
    rateLimit: { enabled: true, window: 60, max: 20, storage: "memory" },
    user: { changeEmail: { enabled: false } },
    account: { accountLinking: { enabled: false } },
  });
}
