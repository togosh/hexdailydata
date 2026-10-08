import type pg from "pg";
import {
  createHash,
  createHmac,
  randomUUID,
  timingSafeEqual,
} from "node:crypto";
import { z } from "zod";
import { Denied, lockAccount, tx } from "./db.js";
export const hash = (s: string) => createHash("sha256").update(s).digest("hex");
export const eventSchema = z
  .object({
    eventId: z.uuid(),
    paymentId: z.uuid(),
    invoiceId: z.uuid(),
    accountId: z.string().min(1).max(100),
    amount: z.string().regex(/^(0|[1-9][0-9]{0,77})$/),
    asset: z.enum(["PLS", "USD"]),
    chain: z.number().int(),
    recipient: z.string().max(50),
    status: z.enum([
      "pending",
      "paid",
      "refund",
      "partial-refund",
      "failed",
      "cancel",
    ]),
    version: z.number().int().nonnegative().max(2147483647),
  })
  .strict();
export type PaymentEvent = z.infer<typeof eventSchema>;
export const sign = (raw: string, secret: string) =>
  createHmac("sha256", secret).update(raw).digest("hex");
export function verify(raw: string, sig: string, secret: string) {
  if (
    !/^[a-f0-9]{64}$/.test(sig) ||
    !timingSafeEqual(
      Buffer.from(sig, "hex"),
      Buffer.from(sign(raw, secret), "hex"),
    )
  )
    throw new Denied("INVALID_SIGNATURE", 401);
  return eventSchema.parse(JSON.parse(raw));
}
export async function createInvoice(
  p: pg.Pool,
  accountId: string,
  mode: "pls" | "card",
  days: number,
  annualDemo: boolean,
  now?: Date,
) {
  if (
    ![30, 90, 365].includes(days) ||
    (days === 365 && !annualDemo) ||
    (mode === "card" && days === 90)
  )
    throw new Denied("UNAVAILABLE_FIXTURE");
  return tx(p, async (q) => {
    const c = await lockAccount(q, accountId);
    const instant = now ?? new Date();
    const {
      rows: [r],
    } = await q.query(
      `select exists(select 1 from grant_record where account_id=$1 and mode<>$2 and not refunded and ends_at>$3) coverage, exists(select 1 from invoice where account_id=$1 and mode<>$2 and status='open' and expires_at>$3) invoice`,
      [accountId, mode, instant],
    );
    if (
      r.coverage ||
      r.invoice ||
      (mode === "pls" && (c.card_active || c.card_due))
    )
      throw new Denied("BILLING_MODE_CONFLICT", 409);
    const start =
      mode === "card"
        ? new Date(Date.UTC(instant.getUTCFullYear(), instant.getUTCMonth(), 1))
        : null;
    const end = start
      ? new Date(
          Date.UTC(
            start.getUTCFullYear() + (days === 365 ? 1 : 0),
            start.getUTCMonth() + (days === 365 ? 0 : 1),
            1,
          ),
        )
      : null;
    if (start) {
      const { rowCount } = await q.query(
        "select 1 from invoice where period_id=$1",
        [accountId + ":" + start.toISOString() + ":" + end!.toISOString()],
      );
      if (rowCount) throw new Denied("PERIOD_ALREADY_INVOICED", 409);
    }
    const amount =
      mode === "pls"
        ? (
            {
              30: "123456789012345678901",
              90: "300000000000000000000",
              365: "1000000000000000000000",
            } as Record<number, string>
          )[days]
        : days === 365
          ? "900"
          : "100";
    const {
      rows: [invoice],
    } = await q.query(
      `insert into invoice(id,account_id,mode,days,amount,expires_at,period_start,period_end,period_id) values($1,$2,$3,$4,$5,$6,$7,$8,$9) returning *`,
      [
        randomUUID(),
        accountId,
        mode,
        mode === "pls" ? days : null,
        amount,
        new Date(+instant + 900000),
        start,
        end,
        start
          ? accountId + ":" + start.toISOString() + ":" + end!.toISOString()
          : null,
      ],
    );
    return invoice;
  });
}
// Hooks are callable only by an isolated child-process test, never by an HTTP field.
export async function processEvent(
  p: pg.Pool,
  e: PaymentEvent,
  now?: Date,
  hooks?: { beforeCommit?: () => void; afterCommit?: () => void },
) {
  const canonical = JSON.stringify(eventSchema.parse(e));
  const digest = hash(canonical);
  const result = await tx(p, async (q) => {
    await q.query("select pg_advisory_xact_lock(hashtextextended($1,0))", [
      e.eventId,
    ]);
    const {
      rows: [previous],
    } = await q.query("select * from event where id=$1", [e.eventId]);
    if (previous) {
      if (previous.digest !== digest)
        throw new Denied("EVENT_ID_CONFLICT", 409);
      return previous.result;
    }
    const {
      rows: [i],
    } = await q.query("select * from invoice where id=$1", [e.invoiceId]);
    if (!i || i.account_id !== e.accountId)
      throw new Denied("INVOICE_OWNERSHIP", 404);
    const c = await lockAccount(q, e.accountId);
    const instant = now ?? new Date();
    // Invoice fields are immutable, but its current status may have changed while waiting.
    const {
      rows: [currentInvoice],
    } = await q.query("select status_version from invoice where id=$1", [i.id]);
    const fingerprint = hash(
      JSON.stringify([
        e.paymentId,
        e.invoiceId,
        e.accountId,
        e.amount,
        e.asset,
        e.chain,
        e.recipient,
      ]),
    );
    // Economic identity is immutable even before credit (pending -> paid).
    await q.query(
      "insert into payment_identity(payment_id,fingerprint) values($1,$2) on conflict do nothing",
      [e.paymentId, fingerprint],
    );
    const {
      rows: [identity],
    } = await q.query(
      "select fingerprint,refund_seen from payment_identity where payment_id=$1",
      [e.paymentId],
    );
    if (identity.fingerprint !== fingerprint)
      throw new Denied("PAYMENT_ID_CONFLICT", 409);
    const {
      rows: [credit],
    } = await q.query("select * from credit where payment_id=$1", [
      e.paymentId,
    ]);
    if (credit && credit.fingerprint !== fingerprint)
      throw new Denied("PAYMENT_ID_CONFLICT", 409);
    const {
      rows: [invoiceCredit],
    } = await q.query(
      "select c.payment_id,g.refunded from credit c join grant_record g on g.payment_id=c.payment_id where c.invoice_id=$1",
      [i.id],
    );
    let createdCredit = false;
    let outcome: string = e.status;
    const exact =
      e.amount === i.amount &&
      e.asset === (i.mode === "pls" ? "PLS" : "USD") &&
      e.chain === (i.mode === "pls" ? 369 : 0) &&
      e.recipient === "lab-vault";
    // Refund delivery can precede credit. Preserve it on the economic identity.
    if (exact && (e.status === "refund" || e.status === "partial-refund")) {
      await q.query(
        "update payment_identity set refund_seen=true where payment_id=$1",
        [e.paymentId],
      );
      identity.refund_seen = true;
    }
    if (!exact) outcome = "needs_review";
    else if (e.status === "refund") {
      if (!credit) outcome = "needs_review";
      else {
        await q.query(
          "update grant_record set refunded=true where payment_id=$1",
          [e.paymentId],
        );
        outcome = "refunded";
      }
    } else if (e.status === "partial-refund") outcome = "needs_review";
    else if (
      identity.refund_seen &&
      !credit &&
      ["paid", "failed", "pending"].includes(e.status)
    )
      outcome = "needs_review";
    else if (e.status === "paid" && !credit) {
      const {
        rows: [mixed],
      } = await q.query(
        `select exists(select 1 from grant_record where account_id=$1 and mode<>$2 and not refunded and ends_at>$3) coverage, exists(select 1 from invoice where account_id=$1 and mode<>$2 and status='open' and expires_at>$3) invoice`,
        [e.accountId, i.mode, instant],
      );
      const { rowCount: credited } = await q.query(
        "select 1 from credit where invoice_id=$1",
        [i.id],
      );
      if (
        credited ||
        +i.expires_at <= +instant ||
        mixed.coverage ||
        mixed.invoice ||
        (i.mode === "pls" && (c.card_active || c.card_due))
      )
        outcome = "needs_review";
      else {
        let start: Date, end: Date;
        if (i.mode === "pls") {
          const {
            rows: [last],
          } = await q.query(
            `select max(ends_at) ending from grant_record where account_id=$1 and mode='pls' and not refunded`,
            [e.accountId],
          );
          start = new Date(Math.max(+instant, last.ending ? +last.ending : 0));
          end = new Date(+start + i.days * 86400000);
        } else {
          start = i.period_start;
          end = i.period_end;
        }
        await q.query(
          "insert into credit(payment_id,invoice_id,account_id,fingerprint) values($1,$2,$3,$4)",
          [e.paymentId, i.id, e.accountId, fingerprint],
        );
        await q.query(
          "insert into grant_record(id,payment_id,account_id,mode,starts_at,ends_at) values($1,$2,$3,$4,$5,$6)",
          [randomUUID(), e.paymentId, e.accountId, i.mode, start, end],
        );
        const {
          rows: [user],
        } = await q.query('select email from "user" where id=$1', [
          e.accountId,
        ]);
        await q.query(
          "insert into outbox(id,dedup,recipient,subject,body) values($1,$2,$3,$4,$5) on conflict(dedup) do nothing",
          [
            randomUUID(),
            "receipt:" + e.paymentId,
            user.email,
            "LAB simulated purchase receipt",
            `Internal ${i.mode} test only. Coverage ${start.toISOString()} to ${end.toISOString()}. No real payment or settlement.`,
          ],
        );
        outcome = "granted";
        createdCredit = true;
      }
    } else if (e.status === "paid" && credit)
      outcome = invoiceCredit?.refunded ? "refunded" : "granted";
    if (i.mode === "card" && exact) {
      // Collectible debt belongs to an invoice, not the auto-renew switch.
      // An independently verified payment resolves only its own invoice.
      if (e.status === "failed" && !invoiceCredit && outcome !== "needs_review")
        await q.query("update invoice set collectible=true where id=$1", [
          i.id,
        ]);
      if (e.status === "paid" && outcome === "granted")
        await q.query("update invoice set collectible=false where id=$1", [
          i.id,
        ]);
      if (
        (createdCredit ||
          (e.status === "failed" && !invoiceCredit) ||
          e.status === "cancel") &&
        outcome !== "needs_review" &&
        e.version > Number(c.card_version)
      ) {
        await q.query(
          "update customer set card_active=$2,card_version=$3 where id=$1",
          [e.accountId, e.status !== "cancel", e.version],
        );
      }
    }
    await q.query(
      "insert into event(id,digest,payment_id,result) values($1,$2,$3,$4)",
      [e.eventId, digest, e.paymentId, outcome],
    );
    // Current economic state survives stale/different attempts; event.result remains history.
    const {
      rows: [state],
    } = await q.query(
      "select g.refunded from credit c join grant_record g on g.payment_id=c.payment_id where c.invoice_id=$1",
      [i.id],
    );
    if (state)
      await q.query(
        "update invoice set status=$2,collectible=false where id=$1",
        [i.id, state.refunded ? "refunded" : "granted"],
      );
    else if (e.version >= Number(currentInvoice.status_version))
      await q.query(
        "update invoice set status=$2,status_version=$3 where id=$1",
        [i.id, outcome, e.version],
      );
    if (i.mode === "card")
      await q.query(
        "update customer set card_due=exists(select 1 from invoice where account_id=$1 and mode='card' and collectible) where id=$1",
        [e.accountId],
      );
    hooks?.beforeCommit?.();
    return outcome;
  });
  hooks?.afterCommit?.();
  return result;
}
