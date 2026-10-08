import { createHash } from "node:crypto";
import { z } from "zod";
import { Denied } from "./db.js";
export const MAX = (1n << 256n) - 1n;
export const address = z.string().regex(/^0x[0-9a-f]{40}$/);
export const hash32 = z.string().regex(/^0x[0-9a-f]{64}$/);
export const hearts = z
  .string()
  .regex(/^[1-9][0-9]{0,77}$/)
  .refine((s) => BigInt(s) <= MAX);
export const issueInput = z
  .object({ requestId: z.uuid(), plan: z.enum(["synthetic-month","synthetic-year"]) })
  .strict();
export const caseInput = z
  .object({
    reason: z.string().trim().min(1).max(500),
    txHash: hash32.optional(),
    logIndex: z.number().int().min(0).max(1000000).optional(),
  })
  .strict()
  .refine((b) => b.logIndex === undefined || b.txHash !== undefined);
export const proofInput = z
  .object({ signature: z.string().regex(/^0x[0-9a-fA-F]{130}$/) })
  .strict();
export const actionInput = z
  .object({
    id: z.uuid(),
    action: z.enum(["accept", "reject", "await"]),
    reason: z.enum([
      "exact_late",
      "supported_incorrect_amount",
      "insufficient_evidence",
      "unsupported",
    ]),
    note: z.string().max(500),
  })
  .strict();
export const priceInput = z
  .object({
    id: z.string().regex(/^fixture-[a-z0-9-]{1,60}$/),
    plan: z.enum(["synthetic30","synthetic-month","synthetic-year"]).default("synthetic30"),
    baseHearts: hearts,
    allowance: z.number().int().min(1).max(2147483647),
    threshold: z.number().int().min(1),
    suffixMax: z.number().int().min(1).max(999999),
  })
  .strict()
  .refine(
    (b) =>
      b.threshold <= b.allowance &&
      BigInt(b.baseHearts) + BigInt(b.suffixMax) <= MAX,
  );
export type Price = z.infer<typeof priceInput>;
export type Context = { accountId: string; admin?: boolean }; // server-derived only
export type Profile = {
  id: string;
  chain: 369;
  token: string;
  recipient: string;
  codeHash: string;
  origin: string;
  deployment: string;
  initialHeight: number;
  initialHash: string;
  windowSeconds: number;
  freshSeconds: number;
  synthetic: true;
};
export const profileSchema = z
  .object({
    id: z.string().regex(/^fixture-[a-z0-9-]{1,60}$/),
    chain: z.literal(369),
    token: address,
    recipient: address,
    codeHash: hash32,
    origin: z
      .string()
      .url()
      .refine((x) => new URL(x).hostname === "127.0.0.1"),
    deployment: z.string().min(1).max(100),
    initialHeight: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER),
    initialHash: hash32,
    windowSeconds: z.number().int().min(1).max(3600),
    freshSeconds: z.number().int().min(1).max(120),
    synthetic: z.literal(true),
  })
  .strict();
export const digest = (x: unknown) =>
  createHash("sha256")
    .update(typeof x === "string" ? x : JSON.stringify(x))
    .digest("hex");
export function showHearts(s: string) {
  hearts.parse(s);
  const n = BigInt(s);
  return `${n / 100000000n}.${(n % 100000000n).toString().padStart(8, "0")}`;
}
export function parseHexAmount(s: string) {
  if (!/^(0|[1-9][0-9]{0,69})\.[0-9]{8}$/.test(s))
    throw new Denied("INVALID_AMOUNT");
  return hearts.parse(BigInt(s.replace(".", "")).toString());
}
export function admin(c: Context) {
  if (!c.admin) throw new Denied("ADMIN_REQUIRED", 403);
}
export function quantity(x: unknown): number {
  if (typeof x !== "string" || !/^0x(0|[1-9a-f][0-9a-f]*)$/.test(x))
    throw Error("RAW_QUANTITY");
  const n = BigInt(x);
  if (n > BigInt(Number.MAX_SAFE_INTEGER)) throw Error("RAW_QUANTITY");
  return Number(n);
}
export const hex = (n: number) => "0x" + n.toString(16);
