import { betterAuth } from "better-auth";
import { username } from "better-auth/plugins/username";
import { hashPassword, verifyPassword } from "better-auth/crypto";
import type pg from "pg";
import type { Config } from "./config.js";

export type AccountHooks = { stage?: (stage: string) => Promise<void> };
// Only this composed app uses the username policy. The legacy auth.ts is intact.
export function makeAccountAuth(c: Config, p: pg.Pool, hooks: AccountHooks = {}) {
  return betterAuth({
    database: p, baseURL: c.origin, secret: c.secret, trustedOrigins: [c.origin],
    logger: { disabled: true },
    plugins: [username({ minUsernameLength: 3, maxUsernameLength: 32,
      usernameValidator: (s) => /^[a-z0-9_-]{3,32}$/.test(s),
      usernameNormalization: (s) => s.toLowerCase(), immutableUsername: true,
      displayUsername: false })],
    emailAndPassword: { enabled: true, requireEmailVerification: false,
      autoSignIn: true, minPasswordLength: 15, maxPasswordLength: 128,
      password: { hash: hashPassword, verify: async (input) => {
        const ok = await verifyPassword(input);
        if (ok) await hooks.stage?.("password-verified");
        return ok;
      } } },
    emailVerification: { sendOnSignUp: false, sendOnSignIn: false },
    session: { expiresIn: 3600, cookieCache: { enabled: false } },
    advanced: { useSecureCookies: new URL(c.origin).protocol === "https:",
      defaultCookieAttributes: { httpOnly: true, sameSite: "lax" },
      ipAddress: { disableIpTracking: true } },
    databaseHooks: { session: {
      create: { before: async (s) => ({ data: { ...s, ipAddress: null, userAgent: null } }) },
      update: { before: async (s) => ({ data: { ...s, ipAddress: null, userAgent: null } }) },
    } },
    // The outer routes implement fixed-size, shared SQL admission before hashing.
    rateLimit: { enabled: false },
    user: { changeEmail: { enabled: false }, additionalFields: {
      internalEmail: { type: "boolean", required: false, defaultValue: true, input: false, returned: false },
    } },
    account: { accountLinking: { enabled: false } },
  });
}
