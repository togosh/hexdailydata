import { invoiceBudget, budgetPolicy, bindSources } from "./payment-budget.js";
import { calendarKind, monthBoundary, purchaseCalendar } from "./calendar.js";
import type pg from "pg";
import { randomInt, randomUUID, randomBytes } from "node:crypto";
import { verifyMessage } from "ethers";
import { Denied, lockAccount } from "./db.js";
import { boundedTransaction, type Work } from "./metering.js";
import { createPeriod, selectPeriods, databaseTime } from "./period.js";
import {
  admin,
  digest,
  issueInput,
  caseInput,
  priceInput,
  proofInput,
  actionInput,
  profileSchema,
  showHearts,
  type Profile,
  type Context,
} from "./hex-types.js";

export class HexPayments {
  readonly profile: Profile;
  constructor(
    readonly pool: pg.Pool,
    profile: Profile,
    readonly options: {
      clock?: typeof databaseTime;
      suffix?: (max: number) => number;
      maxTotal?: number;
      maxActive?: number;
      issueLimit?: number;
      afterCommit?: () => void;
    } = {},
  ) {
    this.profile = profileSchema.parse(profile);
  }
  time = async (q: pg.PoolClient) => (this.options.clock ?? databaseTime)(q);
  work<T>(fn: (q: pg.PoolClient) => Promise<T>, work: Work = {}) {
    return boundedTransaction(this.pool, work, fn);
  }
  async requireDailyPolicy(identities: readonly [string, string]) {
    return this.work(async q => {
      const policy = await budgetPolicy(q);
      if (!policy) throw Error("DAILY_POLICY_REQUIRED");
      bindSources(policy, identities);
    });
  }
  async configure() {
    return this.work(async (q) => {
      await q.query(
        "INSERT INTO hex_profile(id,config) VALUES($1,$2) ON CONFLICT DO NOTHING",
        [this.profile.id, this.profile],
      );
      const {
        rows: [p],
      } = await q.query("SELECT config FROM hex_profile WHERE id=$1", [
        this.profile.id,
      ]);
      if (
        digest(p.config) !== digest(JSON.parse(JSON.stringify(this.profile)))
      ) {
        // jsonb key order is not an identity; compare fields explicitly.
        if (
          Object.keys(this.profile).some(
            (k) => p.config[k] !== this.profile[k as keyof Profile],
          )
        )
          throw Error("PROFILE_IMMUTABLE");
      }
      await q.query(
        "INSERT INTO hex_stream(profile_id,cursor_height,cursor_hash) VALUES($1,$2,$3) ON CONFLICT DO NOTHING",
        [this.profile.id, this.profile.initialHeight, this.profile.initialHash],
      );
    });
  }
  async publish(ctx: Context, input: unknown) {
    admin(ctx);
    const p = priceInput.parse(input);
    return this.work(async (q) => {
      const {
        rows: [old],
      } = await q.query("SELECT snapshot FROM hex_price WHERE id=$1", [p.id]);
      if (old) {
        if (
          Object.keys(p).some((k) => priceInput.parse(old.snapshot)[k as keyof typeof p] !== p[k as keyof typeof p])
        )
          throw new Denied("PRICE_IMMUTABLE", 409);
        return old.snapshot;
      }
      await q.query(
        "INSERT INTO hex_price(id,snapshot,actor,created_at) VALUES($1,$2,$3,$4)",
        [p.id, p, ctx.accountId, await this.time(q)],
      );
      return p;
    });
  }
  async freshness(q: pg.PoolClient, now: Date) {
    const {
      rows: [s],
    } = await q.query(
      "SELECT * FROM hex_stream WHERE profile_id=$1 FOR SHARE",
      [this.profile.id],
    );
    if (
      !s ||
      s.paused ||
      !s.head ||
      !s.refreshed_at ||
      +now - +s.refreshed_at > this.profile.freshSeconds * 1000 ||
      +s.refreshed_at > +now
    )
      throw new Denied("PAYMENT_SOURCE_UNAVAILABLE", 503);
    try { await invoiceBudget(q); }
    catch { throw new Denied("PAYMENT_SOURCE_UNAVAILABLE", 503); }
    return s;
  }
  async conflicts(q: pg.PoolClient, account: string, now: Date) {
    const c = await lockAccount(q, account);
    const {
      rows: [m],
    } = await q.query(
      `SELECT exists(SELECT 1 FROM grant_record WHERE account_id=$1 AND mode<>'hex' AND NOT refunded AND ends_at>$2) coverage,
      exists(SELECT 1 FROM invoice WHERE account_id=$1 AND mode<>'hex' AND ((status='open' AND expires_at>$2) OR collectible)) debt`,
      [account, now],
    );
    if (c.card_active || c.card_due || m.coverage || m.debt)
      throw new Denied("BILLING_MODE_CONFLICT", 409);
    return selectPeriods(q, account, now);
  }
  async issue(ctx: Context, input: unknown) {
    const b = issueInput.parse(input);
    const admission = await this.work(async (q) => {
      await lockAccount(q, ctx.accountId);
      const now = await this.time(q);
      const {
        rows: [old],
      } = await q.query(
        "SELECT * FROM hex_quote WHERE account_id=$1 AND (request_id=$2 OR reserved) ORDER BY issued_at DESC LIMIT 1",
        [ctx.accountId, b.requestId],
      );
      if (old) return { existing: old };
      const {
        rows: [r],
      } = await q.query(
        `INSERT INTO hex_issue_rate(account_id,window_at,attempts) VALUES($1,$2,1)
        ON CONFLICT(account_id) DO UPDATE SET attempts=CASE WHEN hex_issue_rate.window_at<=$2::timestamptz-interval '1 hour' THEN 1 ELSE least(hex_issue_rate.attempts+1,100) END,
        window_at=CASE WHEN hex_issue_rate.window_at<=$2::timestamptz-interval '1 hour' THEN $2 ELSE hex_issue_rate.window_at END RETURNING attempts`,
        [ctx.accountId, now],
      );
      return {
        allowed: r.attempts <= Math.min(20, this.options.issueLimit ?? 10),
      };
    });
    if (admission.existing) return this.view(admission.existing);
    if (!admission.allowed) throw new Denied("INVOICE_RATE", 429);
    return this.work(async (q) => {
      await lockAccount(q, ctx.accountId);
      const now = await this.time(q);
      const {
        rows: [same],
      } = await q.query(
        "SELECT * FROM hex_quote WHERE account_id=$1 AND request_id=$2",
        [ctx.accountId, b.requestId],
      );
      if (same) return this.view(same, q);
      // One global finite issuance namespace, serialized after the account lock.
      await q.query("SELECT pg_advisory_xact_lock(733106,1)");
      const {
        rows: [open],
      } = await q.query(
        "SELECT * FROM hex_quote WHERE account_id=$1 AND reserved",
        [ctx.accountId],
      );
      if (open) return this.view(open, q);
      const periods = await this.conflicts(q, ctx.accountId, now);
      if (periods.next) throw new Denied("SUCCESSOR_RESERVED", 409);
      const s = await this.freshness(q, now);
      const {
        rows: [counts],
      } = await q.query(
        "SELECT count(*)::int total,count(*) FILTER(WHERE reserved)::int active FROM hex_quote",
      );
      if (
        counts.total >= Math.min(5000, this.options.maxTotal ?? 5000) ||
        counts.active >= Math.min(512, this.options.maxActive ?? 512)
      )
        throw new Denied("INVOICE_CAPACITY", 429);
      const {
        rows: [price],
      } = await q.query(
        "SELECT snapshot FROM hex_price WHERE coalesce(snapshot->>'plan','synthetic30')=$1 ORDER BY published_seq DESC LIMIT 1",
        [b.plan],
      );
      if (!price) throw new Denied("NO_PRICE", 503);
      const p = priceInput.parse(price.snapshot),
        months = p.plan === "synthetic-year" ? 12 : p.plan === "synthetic-month" ? 1 : null,
        id = randomUUID(),
        expires = new Date(+now + this.profile.windowSeconds * 1000);
      const {
        rows: [capacity],
      } = await q.query(
        `SELECT count(*)::int used FROM hex_assignment WHERE chain=$1 AND token=$2 AND recipient=$3 AND amount_hearts>$4 AND amount_hearts<=$5`,
        [
          this.profile.chain,
          this.profile.token,
          this.profile.recipient,
          p.baseHearts,
          (BigInt(p.baseHearts) + BigInt(p.suffixMax)).toString(),
        ],
      );
      if (capacity.used >= p.suffixMax)
        throw new Denied("AMOUNT_NAMESPACE_EXHAUSTED", 503);
      for (let attempt = 0; attempt < 16; attempt++) {
        const adjustment = (
          this.options.suffix ?? ((max) => randomInt(1, max + 1))
        )(p.suffixMax);
        if (
          !Number.isInteger(adjustment) ||
          adjustment < 1 ||
          adjustment > p.suffixMax
        )
          throw Error("INVALID_ALLOCATOR");
        const amount = (BigInt(p.baseHearts) + BigInt(adjustment)).toString();
        await q.query("SAVEPOINT amount_allocation");
        try {
          await q.query(
            `INSERT INTO invoice(id,account_id,mode,days,amount,expires_at,term_kind,calendar_months) VALUES($1,$2,'hex',$5,$3,$4,$6,$7)`,
            [id, ctx.accountId, amount, expires,months ? null : 30,months ? calendarKind : 'fixed30',months],
          );
          await q.query(
            `INSERT INTO hex_quote(invoice_id,account_id,request_id,profile_id,price_id,snapshot,base_hearts,adjustment,amount_hearts,issued_at,expires_at,fence_height,fence_hash)
          VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)`,
            [
              id,
              ctx.accountId,
              b.requestId,
              this.profile.id,
              p.id,
              {
                ...p,
                ...(months ? {kind:calendarKind,calendarMonths:months} : {kind:"fixed30",termSeconds:2592000}),
                referenceMonthlyUSD: 30,
                referenceAnnualUSD: 300,
                annualAvailable: !!months,
              },
              p.baseHearts,
              adjustment,
              amount,
              now,
              expires,
              s.head.number,
              s.head.hash,
            ],
          );
          await q.query("INSERT INTO hex_assignment VALUES($1,$2,$3,$4,$5)", [
            369,
            this.profile.token,
            this.profile.recipient,
            amount,
            id,
          ]);
          await q.query("RELEASE SAVEPOINT amount_allocation");
          const {
            rows: [v],
          } = await q.query("SELECT * FROM hex_quote WHERE invoice_id=$1", [
            id,
          ]);
          return {
            ...(await this.view(v, q)),
            namespace: {
              used: capacity.used + 1,
              remaining: p.suffixMax - capacity.used - 1,
            },
            allocationAttempts: attempt + 1,
          };
        } catch (e: any) {
          await q.query("ROLLBACK TO SAVEPOINT amount_allocation");
          if (e.code !== "23505" || e.constraint !== "hex_assignment_pkey")
            throw e;
        }
      }
      throw new Denied("AMOUNT_ALLOCATION_RETRY", 503);
    });
  }
  async view(v: any, q: pg.Pool | pg.PoolClient = this.pool) {
    const {
      rows: [bound],
    } = await q.query("SELECT config FROM hex_profile WHERE id=$1", [
      v.profile_id,
    ]);
    if (!bound) throw Error("MISSING_BOUND_PROFILE");
    return {
      id: v.invoice_id,
      status: v.status,
      reason: v.reason,
      amountHearts: v.amount_hearts,
      amountHEX: showHearts(v.amount_hearts),
      baseHearts: v.base_hearts,
      adjustment: v.adjustment,
      issuedAt: v.issued_at,
      expiresAt: v.expires_at,
      network: "Synthetic PulseChain / chain 369",
      profileId: v.profile_id,
      token: bound.config.token,
      recipient: bound.config.recipient,
      price: v.snapshot,
      grantId: v.grant_id,
      actualHearts: v.actual_hearts,
      reserved: v.reserved,
    };
  }
  async authoritative(q: pg.PoolClient, o: any) {
    if (!o) return o;
    if (o.profile_id !== this.profile.id)
      throw new Denied("PROFILE_READER_REQUIRED", 409);
    const {
      rows: [a],
    } = await q.query(
      "SELECT invoice_id FROM hex_assignment WHERE chain=$1 AND token=$2 AND recipient=$3 AND amount_hearts=$4",
      [
        this.profile.chain,
        this.profile.token,
        this.profile.recipient,
        o.amount_hearts,
      ],
    );
    o.assigned_invoice = a?.invoice_id ?? null;
    return o;
  }
  async invoice(ctx: Context, id: string) {
    return this.work(async (q) => {
      const {
        rows: [v],
      } = await q.query(
        "SELECT * FROM hex_quote WHERE invoice_id=$1 AND account_id=$2",
        [id, ctx.accountId],
      );
      if (!v) throw new Denied("NOT_FOUND", 404);
      return this.view(v, q);
    });
  }
  async list(ctx: Context) {
    return this.work(async (q) =>
      Promise.all(
        (
          await q.query(
            "SELECT * FROM hex_quote WHERE account_id=$1 ORDER BY issued_at DESC LIMIT 30",
            [ctx.accountId],
          )
        ).rows.map((v) => this.view(v, q)),
      ),
    );
  }
  async cancel(ctx: Context, id: string) {
    return this.work(async (q) => {
      await lockAccount(q, ctx.accountId);
      const {
        rows: [v],
      } = await q.query(
        "SELECT * FROM hex_quote WHERE invoice_id=$1 AND account_id=$2 FOR UPDATE",
        [id, ctx.accountId],
      );
      if (!v) throw new Denied("NOT_FOUND", 404);
      if (v.status === "paid") return this.view(v, q);
      await q.query(
        "UPDATE hex_quote SET status='cancelled',reason='cancelled_sends_only' WHERE invoice_id=$1",
        [id],
      );
      v.status = "cancelled";
      return this.view(v, q);
    });
  }
  async requestReview(ctx: Context, id: string, input: unknown) {
    const b = caseInput.parse(input);
    return this.work(async (q) => {
      await lockAccount(q, ctx.accountId);
      const {
        rows: [v],
      } = await q.query(
        "SELECT * FROM hex_quote WHERE invoice_id=$1 AND account_id=$2 FOR UPDATE",
        [id, ctx.accountId],
      );
      if (!v) throw new Denied("NOT_FOUND", 404);
      if (v.profile_id !== this.profile.id)
        throw new Denied("PROFILE_READER_REQUIRED", 409);
      const {
        rows: [c],
      } = await q.query(
        `INSERT INTO hex_case(id,invoice_id,account_id,reason,hint_hash,hint_index,created_at) VALUES($1,$2,$3,$4,$5,$6,$7)
      ON CONFLICT(invoice_id) DO UPDATE SET invoice_id=excluded.invoice_id RETURNING *`,
        [
          randomUUID(),
          id,
          ctx.accountId,
          b.reason,
          b.txHash ?? null,
          b.logIndex ?? 0,
          await this.time(q),
        ],
      );
      if (
        b.txHash &&
        (b.txHash !== c.hint_hash || (b.logIndex ?? 0) !== c.hint_index)
      ) {
        if (c.proven_at || ["paid", "rejected"].includes(c.resolution?.status))
          throw new Denied("CASE_HINT_LOCKED", 409);
        if (c.hint_revisions >= 3) throw new Denied("CASE_HINT_LIMIT", 429);
        const {
          rows: [updated],
        } = await q.query(
          `UPDATE hex_case SET hint_hash=$2,hint_index=$3,reason=$4,hint_revisions=hint_revisions+1,
          payment_key=NULL,status='pending',attempts=0,retry_due=NULL,last_attempt_at=NULL,retry_state='ready',retry_reason=NULL,message=NULL,message_digest=NULL,challenge_expires=NULL,challenge_proof_digest=NULL,
          proof_digest=NULL,signature_digest=NULL,proven_at=NULL,resolution=NULL WHERE id=$1 RETURNING *`,
          [c.id, b.txHash, b.logIndex ?? 0, b.reason],
        );
        return this.caseView(updated, false);
      }
      return this.caseView(c, false);
    });
  }
  caseView(c: any, owner: boolean) {
    return {
      id: c.id,
      invoiceId: c.invoice_id,
      status: c.status,
      reason: c.reason,
      txHash: c.hint_hash,
      logIndex: c.hint_index,
      message: c.message,
      challengeExpires: c.challenge_expires,
      proven: !!c.proven_at,
      resolution: c.resolution,
      priorResolution: c.prior_resolution,
      retry: { attempts: c.attempts, due: c.retry_due, state: c.retry_state, reason: c.retry_reason },
      ...(owner ? { accountId: c.account_id, paymentKey: c.payment_key } : {}),
    };
  }
  async getCase(ctx: Context, id: string) {
    return this.work(async (q) => {
      const {
        rows: [c],
      } = await q.query(
        "SELECT * FROM hex_case WHERE id=$1 AND (account_id=$2 OR $3)",
        [id, ctx.accountId, !!ctx.admin],
      );
      if (!c) throw new Denied("NOT_FOUND", 404);
      if (!ctx.admin) return this.caseView(c, false);
      const {
        rows: [i],
      } = await q.query("SELECT * FROM hex_quote WHERE invoice_id=$1", [
        c.invoice_id,
      ]);
      const {
        rows: [o],
      } = await q.query("SELECT * FROM hex_observation WHERE payment_key=$1", [
        c.payment_key,
      ]);
      return {
        ...this.caseView(c, true),
        invoice: await this.view(i, q),
        evidence: o ?? null,
      };
    });
  }
  async queue(ctx: Context) {
    admin(ctx);
    return this.work(async (q) =>
      (
        await q.query(`SELECT c.* FROM hex_case c JOIN hex_quote v ON v.invoice_id=c.invoice_id
          WHERE c.status NOT IN ('paid','rejected') AND v.grant_id IS NULL
          ORDER BY c.created_at,c.id LIMIT 100`)
      ).rows.map((c) => this.caseView(c, true)),
    );
  }
  async challenge(ctx: Context, id: string) {
    admin(ctx);
    return this.work(async (q) => {
      const {
        rows: [c0],
      } = await q.query("SELECT account_id FROM hex_case WHERE id=$1", [id]);
      if (!c0) throw new Denied("NOT_FOUND", 404);
      await lockAccount(q, c0.account_id);
      await q.query("SELECT pg_advisory_xact_lock(733106,1)");
      const {
        rows: [c],
      } = await q.query("SELECT * FROM hex_case WHERE id=$1 FOR UPDATE", [id]);
      const now = await this.time(q);
      await this.freshness(q, now);
      const {
        rows: [o],
      } = await q.query(
        "SELECT * FROM hex_observation WHERE payment_key=$1 FOR UPDATE",
        [c.payment_key],
      );
      await this.authoritative(q, o);
      if (
        !o?.valid ||
        !o.proof.eoa ||
        o.assigned_invoice ||
        o.consumed_invoice ||
        ["paid", "rejected"].includes(c.resolution?.status)
      )
        throw new Denied("ADDITIONAL_EVIDENCE_REQUIRED", 409);
      if (c.proven_at || (c.message && +c.challenge_expires > +now))
        return this.caseView(c, true);
      const expiry = new Date(+now + 15 * 60000),
        nonce = randomBytes(24).toString("hex");
      const message = [
        "HEXDailyData optional support MESSAGE",
        "Not login, account recovery, a payment or token-spending permission.",
        `Origin: ${this.profile.origin}`,
        `Deployment: ${this.profile.deployment}`,
        "Action: claim incorrect HEX invoice payment",
        `Account: ${digest(c.account_id)}`,
        `Invoice: ${c.invoice_id}`,
        `Case: ${c.id}`,
        "Chain: 369",
        `Token: ${this.profile.token}`,
        `Observed Transfer.from: ${o.proof.from}`,
        `Recipient: ${this.profile.recipient}`,
        `Transaction: ${o.tx_hash}`,
        `Log index: ${o.log_index}`,
        `Observed raw hearts: ${o.amount_hearts}`,
        `Nonce: ${nonce}`,
        `Issued: ${now.toISOString()}`,
        `Expires: ${expiry.toISOString()}`,
      ].join("\n");
      await q.query(
        "UPDATE hex_case SET message=$2,message_digest=$3,challenge_expires=$4,challenge_proof_digest=$5 WHERE id=$1",
        [id, message, digest(message), expiry, o.proof_digest],
      );
      return { ...this.caseView(c, true), message, challengeExpires: expiry };
    });
  }
  async submitProof(ctx: Context, id: string, input: unknown) {
    const b = proofInput.parse(input);
    return this.work(async (q) => {
      await lockAccount(q, ctx.accountId);
      await q.query("SELECT pg_advisory_xact_lock(733106,1)");
      const {
        rows: [c],
      } = await q.query(
        "SELECT * FROM hex_case WHERE id=$1 AND account_id=$2 FOR UPDATE",
        [id, ctx.accountId],
      );
      if (!c) throw new Denied("NOT_FOUND", 404);
      if (c.resolution?.status === "rejected")
        throw new Denied("CASE_FINAL", 409);
      if (c.proven_at) {
        if (c.signature_digest !== digest(b.signature))
          throw new Denied("PROOF_REPLAY", 409);
        return this.caseView(c, false);
      }
      const {
        rows: [o],
      } = await q.query(
        "SELECT * FROM hex_observation WHERE payment_key=$1 FOR UPDATE",
        [c.payment_key],
      );
      await this.authoritative(q, o);
      if (
        !c.message ||
        +c.challenge_expires <= +(await this.time(q)) ||
        !o?.valid ||
        !o.proof.eoa ||
        o.assigned_invoice ||
        o.consumed_invoice ||
        o.proof_digest !== c.challenge_proof_digest
      )
        throw new Denied("INVALID_SUPPORT_PROOF", 409);
      let recovered = "";
      try {
        recovered = verifyMessage(c.message, b.signature).toLowerCase();
      } catch {}
      if (recovered !== o.proof.from)
        throw new Denied("INVALID_SUPPORT_PROOF", 403);
      await q.query(
        "UPDATE hex_case SET proven_at=$2,proof_digest=$3,signature_digest=$4,status='evidence_ready' WHERE id=$1",
        [id, await this.time(q), o.proof_digest, digest(b.signature)],
      );
      c.proven_at = true;
      c.status = "evidence_ready";
      return this.caseView(c, false);
    });
  }
  async fulfillIn(
    q: pg.PoolClient,
    invoiceId: string,
    paymentKey: string,
    exception = false,
  ) {
    const {
      rows: [lookup],
    } = await q.query("SELECT account_id FROM hex_quote WHERE invoice_id=$1", [
      invoiceId,
    ]);
    if (!lookup) throw new Denied("NOT_FOUND", 404);
    await lockAccount(q, lookup.account_id);
    await q.query("SELECT pg_advisory_xact_lock(733106,1)");
    const now = await this.time(q);
    const {
      rows: [v],
    } = await q.query(
      "SELECT * FROM hex_quote WHERE invoice_id=$1 FOR UPDATE",
      [invoiceId],
    );
    if (v.profile_id !== this.profile.id)
      throw new Denied("PROFILE_READER_REQUIRED", 409);
    if (v.grant_id) {
      if (v.payment_key !== paymentKey)
        return { status: "extra_payment", grantId: v.grant_id };
      return {
        status: "paid",
        grantId: v.grant_id,
        invoiceId,
        duplicate: true,
      };
    }
    const {rows:[invoiceTerms]}=await q.query("SELECT term_kind,calendar_months,days FROM invoice WHERE id=$1",[invoiceId]);
    const savedKind=v.snapshot.kind??"fixed30";
    if (!invoiceTerms || !["fixed30",calendarKind].includes(savedKind) || invoiceTerms.term_kind!==savedKind ||
      (savedKind===calendarKind ?
        ![1,12].includes(v.snapshot.calendarMonths) || invoiceTerms.calendar_months!==v.snapshot.calendarMonths || invoiceTerms.days!==null ||
        v.snapshot.plan!==(v.snapshot.calendarMonths===12?"synthetic-year":"synthetic-month") :
        invoiceTerms.calendar_months!==null || invoiceTerms.days!==30))
      throw new Denied("INVALID_CALENDAR_SNAPSHOT",503);
    const periods = await this.conflicts(q, v.account_id, now);
    if (periods.next) throw new Denied("SUCCESSOR_RESERVED", 409);
    const { rows: [other] } = await q.query(
      "SELECT invoice_id FROM hex_quote WHERE account_id=$1 AND reserved AND invoice_id<>$2",
      [v.account_id, invoiceId],
    );
    if (other) throw new Denied("PURCHASE_SLOT_RESERVED", 409);
    await this.freshness(q, now);
    const {
      rows: [o],
    } = await q.query(
      "SELECT * FROM hex_observation WHERE payment_key=$1 FOR UPDATE",
      [paymentKey],
    );
    await this.authoritative(q, o);
    if (
      !o?.valid ||
      o.profile_id !== v.profile_id ||
      (o.consumed_invoice && o.consumed_invoice !== invoiceId) ||
      (o.assigned_invoice && o.assigned_invoice !== invoiceId)
    )
      throw new Denied("PAYMENT_NOT_ELIGIBLE", 409);
    const timely =
      o.proof.height > Number(v.fence_height) &&
      o.proof.timestamp * 1000 >= +v.issued_at &&
      o.proof.timestamp * 1000 < +v.expires_at;
    if (
      !exception &&
      (!timely ||
        v.status === "cancelled" ||
        o.amount_hearts !== v.amount_hearts ||
        o.assigned_invoice !== invoiceId)
    )
      throw new Denied("PAYMENT_REVIEW_REQUIRED", 409);
    // All invoice source terms and external economic identity remain immutable.
    const fingerprint = digest([
      paymentKey,
      invoiceId,
      v.account_id,
      o.amount_hearts,
      "HEX",
      369,
      this.profile.token,
      this.profile.recipient,
    ]);
    await q.query(
      "INSERT INTO payment_identity(payment_id,fingerprint) VALUES($1,$2) ON CONFLICT DO NOTHING",
      [paymentKey, fingerprint],
    );
    const {
      rows: [pi],
    } = await q.query(
      "SELECT * FROM payment_identity WHERE payment_id=$1 FOR UPDATE",
      [paymentKey],
    );
    if (pi.refund_seen || pi.fingerprint !== fingerprint)
      throw new Denied("PAYMENT_REFUND_OR_CONFLICT", 409);
    await q.query(
      "INSERT INTO credit(payment_id,invoice_id,account_id,fingerprint) VALUES($1,$2,$3,$4)",
      [paymentKey, invoiceId, v.account_id, fingerprint],
    );
    const calendar = v.snapshot.kind === calendarKind
      ? purchaseCalendar(now,periods.current,v.snapshot.calendarMonths) : undefined;
    if (calendar && ![1,12].includes(calendar.months)) throw new Denied("INVALID_CALENDAR_SNAPSHOT",503);
    const start = calendar ? monthBoundary(calendar.anchor,calendar.index) : new Date(
      Math.max(+now, periods.paidThrough ? +periods.paidThrough : 0));
    const end = calendar ? monthBoundary(calendar.anchor,calendar.index+calendar.months) : new Date(+start + 2592000000);
    const grantId = randomUUID();
    const state = await createPeriod(
      q,
      {
        id: grantId,
        accountId: v.account_id,
        paymentId: paymentKey,
        mode: "hex",
        start,
        end,
        activation: now,
        plan: v.price_id,
        allowance: v.snapshot.allowance,
        threshold: v.snapshot.threshold,
        calendar,
      },
      this.time,
    );
    await q.query(
      "UPDATE hex_quote SET status='paid',reason=$2,reserved=false,grant_id=$3,payment_key=$4,actual_hearts=$5 WHERE invoice_id=$1",
      [
        invoiceId,
        exception ? "owner_exception" : "exact_verified",
        grantId,
        paymentKey,
        o.amount_hearts,
      ],
    );
    await q.query("UPDATE invoice SET status='granted' WHERE id=$1", [
      invoiceId,
    ]);
    await q.query(
      "UPDATE hex_observation SET consumed_invoice=$2 WHERE payment_key=$1",
      [paymentKey, invoiceId],
    );
    return {
      status: "paid",
      invoiceId,
      grantId,
      period: state,
      expectedHearts: v.amount_hearts,
      actualHearts: o.amount_hearts,
      proofClass: exception
        ? "owner_accepted_verified_exception"
        : "exact_verified",
    };
  }
  async fulfill(id: string, key: string, work: Work = {}) {
    const result = await this.work((q) => this.fulfillIn(q, id, key), work);
    this.options.afterCommit?.();
    return result;
  }
  async resolve(ctx: Context, id: string, input: unknown) {
    admin(ctx);
    const b = actionInput.parse(input),
      d = digest([id, ctx.accountId, b]);
    const result = await this.work(async (q) => {
      const {
        rows: [who],
      } = await q.query("SELECT account_id FROM hex_case WHERE id=$1", [id]);
      if (!who) throw new Denied("NOT_FOUND", 404);
      await lockAccount(q, who.account_id);
      await q.query("SELECT pg_advisory_xact_lock(733106,1)");
      const {
        rows: [c],
      } = await q.query("SELECT * FROM hex_case WHERE id=$1 FOR UPDATE", [id]);
      const {
        rows: [old],
      } = await q.query("SELECT * FROM hex_action WHERE id=$1", [b.id]);
      if (old) {
        if (old.digest !== d) throw new Denied("ACTION_ID_CONFLICT", 409);
        return old.result;
      }
      if (c.resolution?.status === "paid") return c.resolution;
      if (c.resolution?.status === "rejected")
        throw new Denied("CASE_FINAL", 409);
      let resolution: any = {
        status:
          b.action === "reject" ? "rejected" : "additional_evidence_required",
      };
      if (b.action === "accept") {
        const {
          rows: [o],
        } = await q.query(
          "SELECT * FROM hex_observation WHERE payment_key=$1 FOR UPDATE",
          [c.payment_key],
        );
        await this.authoritative(q, o);
        const {
          rows: [v],
        } = await q.query("SELECT * FROM hex_quote WHERE invoice_id=$1", [
          c.invoice_id,
        ]);
        if (
          !o?.valid ||
          (o.consumed_invoice && o.consumed_invoice !== c.invoice_id) ||
          (o.assigned_invoice && o.assigned_invoice !== c.invoice_id)
        )
          throw new Denied("PAYMENT_NOT_ELIGIBLE", 409);
        const late =
          o.proof.height > Number(v.fence_height) &&
          o.proof.timestamp * 1000 >= +v.expires_at;
        const exactLate =
          o.assigned_invoice === c.invoice_id &&
          o.amount_hearts === v.amount_hearts &&
          late &&
          b.reason === "exact_late";
        const incorrect =
          !o.assigned_invoice &&
          !!c.proven_at &&
          c.proof_digest === o.proof_digest &&
          o.proof.eoa &&
          b.reason === "supported_incorrect_amount" &&
          o.amount_hearts !== v.amount_hearts &&
          o.proof.height > Number(v.fence_height) &&
          o.proof.timestamp * 1000 >= +v.issued_at;
        if (!exactLate && !incorrect)
          throw new Denied("ADDITIONAL_EVIDENCE_REQUIRED", 409);
        resolution = await this.fulfillIn(q, c.invoice_id, o.payment_key, true);
      }
      await q.query("UPDATE hex_case SET status=$2,resolution=$3 WHERE id=$1", [
        id,
        b.action === "await" && c.hint_hash && !c.payment_key && c.retry_state === "ready" && c.attempts < 5
          ? "pending"
          : resolution.status,
        resolution,
      ]);
      await q.query(
        "INSERT INTO hex_action VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9)",
        [
          b.id,
          id,
          ctx.accountId,
          b.action,
          b.reason,
          b.note,
          d,
          resolution,
          await this.time(q),
        ],
      );
      return resolution;
    });
    this.options.afterCommit?.();
    return result;
  }
}
