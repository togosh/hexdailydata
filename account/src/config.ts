import fs from "node:fs";
import { z } from "zod";
const schema = z
  .object({
    mode: z.literal("isolated-lab"),
    labId: z.uuid(),
    runId: z.string().regex(/^hddpaylab-[a-f0-9]{12}-[a-f0-9]{8}$/),
    database: z.string().regex(/^lab_[a-f0-9]{8}$/),
    dbHost: z.literal("db"),
    dbAddress: z.string().regex(/^172\.([12][0-9]|3[01])\./),
    dbPassword: z.string().min(40),
    providerPassword: z.string().min(40),
    secret: z.string().min(40),
    eventSecret: z.string().min(40),
    origin: z.string().url(),
    inboxOrigin: z.string().url(),
    annualDemo: z.boolean(),
  })
  .strict();
export type Config = z.infer<typeof schema>;
export function config(): Config {
  if (
    process.env.NODE_ENV === "production" ||
    Object.keys(process.env).some((k) =>
      /^(DATABASE_URL|SMTP_URL|STRIPE_|PADDLE_|POLAR_|RPC_URL|PRODUCTION|LIVE_PROVIDER)/i.test(
        k,
      ),
    )
  )
    throw Error("LAB_ONLY_CONFIG_REFUSED");
  // A copied config is insufficient: require the gateway-free runtime namespace.
  if (
    process.platform !== "linux" ||
    fs.readdirSync("/sys/class/net").sort().join(",") !== "eth0,lo" ||
    fs
      .readFileSync("/proc/net/route", "utf8")
      .split("\n")
      .slice(1)
      .some((line) => line.trim().split(/\s+/)[1] === "00000000")
  )
    throw Error("ISOLATED_NAMESPACE_REQUIRED");
  const c = schema.parse(
    JSON.parse(fs.readFileSync("/run/lab/config.json", "utf8")),
  );
  for (const s of [c.origin, c.inboxOrigin]) {
    const u = new URL(s);
    if (
      u.hostname !== "127.0.0.1" ||
      u.protocol !== "http:" ||
      u.port === "4320" ||
      u.username ||
      u.password ||
      u.pathname !== "/"
    )
      throw Error("LOOPBACK_REQUIRED");
  }
  return c;
}
