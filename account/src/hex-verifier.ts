import { reserveBudget, settleBudget, BudgetUnavailable } from "./payment-budget.js";
import { logComparisonView } from "./log-comparison.js";
import type pg from "pg";
import { randomUUID } from "node:crypto";
import { id, keccak256 } from "ethers";
import { lockAccount } from "./db.js";
import { HexPayments } from "./hex-core.js";
import { hash32, address, quantity, hex, digest } from "./hex-types.js";
export type RpcRequest = {
  jsonrpc: "2.0";
  id: number;
  method: string;
  params: unknown[];
};
export type Source = (
  request: RpcRequest,
  signal: AbortSignal,
) => Promise<string>;
const TOPIC = id("Transfer(address,address,uint256)").toLowerCase();
const trustFailures = [
  "FINALIZED_ANCHOR_CHANGED", "ACCEPTED_PROOF_CHANGED", "TOKEN_CODE_MISMATCH",
  "WRONG_CHAIN", "IDENTITY_CONFLICT", "SCAN_RECEIPT_CONFLICT", "FINALITY_CONFLICT", "SOURCE_DISAGREEMENT",
];
const zero = "0x" + "0".repeat(40);
const stable = (x: any): string =>
  JSON.stringify(x, (_k, v) =>
    v && typeof v === "object" && !Array.isArray(v)
      ? Object.fromEntries(
          Object.entries(v).sort(([a], [b]) => a.localeCompare(b)),
        )
      : v,
  );
function header(b: any) {
  if (!b) throw Error("MISSING_HEADER");
  return {
    number: quantity(b.number),
    hash: hash32.parse(b.hash),
    parentHash: hash32.parse(b.parentHash),
    timestamp: quantity(b.timestamp),
  };
}
function logValue(l: any) {
  if (
    !l ||
    l.removed !== false ||
    !Array.isArray(l.topics) ||
    l.topics.length !== 3 ||
    l.topics[0] !== TOPIC ||
    !/^0x[0-9a-f]{64}$/.test(l.data)
  )
    throw Error("MALFORMED_TRANSFER");
  const addr = (x: any) => {
    if (typeof x !== "string" || !/^0x0{24}[0-9a-f]{40}$/.test(x))
      throw Error("MALFORMED_TOPIC");
    return "0x" + x.slice(-40);
  };
  return {
    token: address.parse(l.address),
    from: addr(l.topics[1]),
    to: addr(l.topics[2]),
    amount: BigInt(l.data).toString(),
    height: quantity(l.blockNumber),
    blockHash: hash32.parse(l.blockHash),
    txHash: hash32.parse(l.transactionHash),
    index: quantity(l.logIndex),
    transactionIndex: quantity(l.transactionIndex),
  };
}
export class HexVerifier {
  constructor(
    readonly core: HexPayments,
    readonly sources: readonly [Source, Source],
    readonly options: {
      dailySources?: readonly [string, string];
      readMs?: number;
      tickMs?: number;
      maxReads?: number;
      maxBytes?: number;
      maxJobs?: number;
    } = {},
  ) {
    if (options.dailySources && (options.dailySources.length !== 2 || options.dailySources.some(v => typeof v !== "string" || !/^[\x21-\x7e]{1,256}$/.test(v)) || options.dailySources[0] === options.dailySources[1]))
      throw Error("INVALID_SOURCE_IDENTITY");
  }
  async tick() {
    const core = this.core,
      p = core.profile,
      tickId = randomUUID(),
      deadline = new Date(
        Date.now() + Math.min(30000, this.options.tickMs ?? 30000),
      );
    const acquired = await core.work(async (q) => {
      const {
        rows: [s],
      } = await q.query(
        "SELECT * FROM hex_stream WHERE profile_id=$1 FOR UPDATE",
        [p.id],
      );
      if (!s) throw Error("NO_STREAM");
      if (s.paused) return { paused: true };
      if (s.lease_until && +s.lease_until > Date.now()) return { busy: true };
      await q.query(
        "UPDATE hex_tick SET state='interrupted',reason='expired_lease' WHERE profile_id=$1 AND state='running'",
        [p.id],
      );
      await q.query(
        "INSERT INTO hex_tick(id,profile_id,started_at,deadline) VALUES($1,$2,$3,$4)",
        [tickId, p.id, new Date(), deadline],
      );
      await q.query(
        "UPDATE hex_stream SET lease=$2,lease_until=$3 WHERE profile_id=$1",
        [p.id, tickId, new Date(+deadline + 1000)],
      );
      return { stream: s };
    });
    if (!acquired.stream) return acquired;
    let requestId = 0,
      calls = 0,
      bytes = 0,
      jobs = 0,
      unmatched = 0,
      completed = false,
      reason: string | null = null;
    let budget: BudgetUnavailable["budget"] | undefined;
    const abort = new AbortController();
    const call = async (source: number, method: string, params: unknown[]) => {
      if (Date.now() >= +deadline) throw Error("TICK_DEADLINE");
      const maxResponse = 4 * 1024 * 1024;
      const reservation = await core.work(async (q) => {
        const {
          rows: [s],
        } = await q.query(
          "SELECT lease,calls FROM hex_stream WHERE profile_id=$1 FOR UPDATE",
          [p.id],
        );
        const {
          rows: [t],
        } = await q.query("SELECT * FROM hex_tick WHERE id=$1 FOR UPDATE", [
          tickId,
        ]);
        const dailyToken = await reserveBudget(q, source, this.options.dailySources);
        if (
          s.lease !== tickId ||
          Date.now() >= +deadline ||
          t.calls >= Math.min(80, this.options.maxReads ?? 80) ||
          Number(t.bytes) + maxResponse >
            Math.min(16777216, this.options.maxBytes ?? 16777216) ||
          (!dailyToken && Number(s.calls) >= 5000)
        )
          throw Error("TICK_BUDGET");
        // Reserve before dispatch; process death leaves this conservative byte charge.
        await q.query(
          "UPDATE hex_tick SET calls=calls+1,bytes=bytes+$2 WHERE id=$1",
          [tickId, maxResponse],
        );
        await q.query(
          "UPDATE hex_stream SET calls=calls+1,bytes=bytes+$2 WHERE profile_id=$1",
          [p.id, maxResponse],
        );
        return { bytes: maxResponse, dailyToken };
      });
      calls++;
      const req: RpcRequest = {
        jsonrpc: "2.0",
        id: ++requestId,
        method,
        params,
      };
      let timer: ReturnType<typeof setTimeout> | undefined;
      const controller = new AbortController();
      const onAbort = () => controller.abort();
      abort.signal.addEventListener("abort", onAbort, { once: true });
      let raw: string;
      try {
        raw = await Promise.race([
          this.sources[source](req, controller.signal),
          new Promise<never>((_, reject) => {
            timer = setTimeout(
              () => {
                controller.abort();
                reject(Error("READ_TIMEOUT"));
              },
              Math.min(
                5000,
                this.options.readMs ?? 5000,
                Math.max(1, +deadline - Date.now()),
              ),
            );
          }),
        ]);
      } catch (e: any) {
        throw Error(
          e?.message === "READ_TIMEOUT" ? "READ_TIMEOUT" : "RPC_ERROR",
        );
      } finally {
        if (timer) clearTimeout(timer);
        abort.signal.removeEventListener("abort", onAbort);
      }
      if (typeof raw !== "string") throw Error("RPC_ERROR");
      const size = Buffer.byteLength(raw);
      bytes += size;
      if (size > maxResponse) throw Error("RESPONSE_OVERSIZED");
      const settled = await core.work(async (q) => {
        await q.query("SELECT profile_id FROM hex_stream WHERE profile_id=$1 FOR UPDATE", [p.id]);
        await q.query("SELECT id FROM hex_tick WHERE id=$1 FOR UPDATE", [tickId]);
        if (reservation.dailyToken && !await settleBudget(q, reservation.dailyToken, size)) return false;
        await q.query("UPDATE hex_tick SET bytes=bytes-$2+$3 WHERE id=$1", [
          tickId,
          reservation.bytes,
          size,
        ]);
        await q.query(
          "UPDATE hex_stream SET bytes=bytes-$2+$3 WHERE profile_id=$1",
          [p.id, reservation.bytes, size],
        );
        return true;
      });
      if (!settled) throw Error("DAILY_SETTLEMENT_EXPIRED");
      let data: any;
      try {
        data = JSON.parse(raw);
      } catch {
        throw Error("RPC_ERROR");
      }
      if (
        !data ||
        typeof data !== "object" ||
        data.jsonrpc !== "2.0" ||
        data.id !== req.id ||
        data.error ||
        !Object.hasOwn(data, "result")
      )
        throw Error(data?.error?.code === -32005 ? "SPLIT_RANGE" : "RPC_ERROR");
      return data.result;
    };
    const both = async (method: string, params: unknown[]) => {
      const a = await call(0, method, params),
        b = await call(1, method, params);
      if (stable(a) !== stable(b)) throw Error("SOURCE_DISAGREEMENT");
      return a;
    };
    // Only explicit headers are reused, for this tick and this source/height.
    // Changing tags are observations, never cache keys or cross-source equality.
    const explicitHeaders = new Map<string, ReturnType<typeof header>>();
    const explicitHeader = async (source: number, height: number) => {
      const key = `${source}:${height}`;
      const saved = explicitHeaders.get(key);
      if (saved) return saved;
      const value = header(
        await call(source, "eth_getBlockByNumber", [hex(height), false]),
      );
      if (value.number === height) explicitHeaders.set(key, value);
      return value;
    };
    const commonHeader = async (
      height: number,
      conflict: string,
      expected: Partial<ReturnType<typeof header>>[] = [],
    ) => {
      const values: ReturnType<typeof header>[] = [];
      let incomplete: unknown, contradicted = false;
      // Check both sources even if one lacks history. Missing evidence must not
      // hide the other's concrete contradiction of a retained finalized anchor.
      for (const source of [0, 1]) {
        try {
          const value = await explicitHeader(source, height);
          if (
            value.number !== height ||
            expected.some((anchor) =>
              Object.entries(anchor).some(([k, v]) => value[k as keyof typeof value] !== v),
            )
          ) contradicted = true;
          values.push(value);
        } catch (error) { incomplete ??= error; }
      }
      if (contradicted || (values.length === 2 && stable(values[0]) !== stable(values[1])))
        throw Error(conflict);
      if (incomplete) throw incomplete;
      return values[0]!;
    };
    const bothLogs = async (
      method: "eth_getLogs" | "eth_getTransactionReceipt",
      params: unknown[],
      range?: { from: number; to: number },
    ) => {
      const a = await call(0, method, params), b = await call(1, method, params);
      const agreed = (height: number, hash: string) =>
        commonHeader(height, "SOURCE_DISAGREEMENT", [{ hash }]);
      const av = await logComparisonView(method, a, agreed, range);
      const bv = await logComparisonView(method, b, agreed, range);
      if (stable(av) !== stable(bv)) throw Error("SOURCE_DISAGREEMENT");
      return a;
    };
    let finalized: ReturnType<typeof header>;
    const key = (tx: string, index: number) =>
      `${p.chain}:${p.token}:${tx}:${index}`;
    const proof = async (txHash: string, index: number) => {
      const tx = await both("eth_getTransactionByHash", [txHash]);
      const receipt = await bothLogs("eth_getTransactionReceipt", [txHash]);
      if (!tx || !receipt) throw Error("MISSING_TRANSACTION");
      if (
        tx.hash !== txHash ||
        receipt.transactionHash !== txHash ||
        !["0x0", "0x1"].includes(receipt.status) ||
        !Array.isArray(receipt.logs)
      )
        throw Error("MALFORMED_RECEIPT");
      if (receipt.status === "0x0") throw Error("FAILED_RECEIPT");
      const seen = new Set();
      for (const l of receipt.logs) {
        const k = `${l.transactionHash}:${l.logIndex}`;
        if (seen.has(k)) throw Error("DUPLICATE_RECEIPT_LOG");
        seen.add(k);
      }
      const raw = receipt.logs.find((l: any) => quantity(l.logIndex) === index);
      if (!raw) throw Error("MISSING_RECEIPT_LOG");
      const l = logValue(raw);
      if (
        l.token !== p.token ||
        l.to !== p.recipient ||
        l.amount === "0" ||
        l.from === zero ||
        l.from === p.recipient
      )
        throw Error("UNSUPPORTED_TRANSFER");
      if (
        l.txHash !== txHash ||
        receipt.blockHash !== l.blockHash ||
        tx.blockHash !== l.blockHash ||
        quantity(receipt.blockNumber) !== l.height ||
        quantity(tx.blockNumber) !== l.height ||
        quantity(receipt.transactionIndex) !== l.transactionIndex ||
        quantity(tx.transactionIndex) !== l.transactionIndex
      )
        throw Error("IDENTITY_CONFLICT");
      const h = await commonHeader(
        l.height,
        l.height <= finalized.number ? "SOURCE_DISAGREEMENT" : "HEAD_NOT_AGREED",
      );
      if (h.hash !== l.blockHash || h.number !== l.height)
        throw Error("NONCANONICAL");
      const f = finalized; // Fixed, explicitly proved boundary for this tick.
      if (f.number < l.height) throw Error("UNFINALIZED");
      const code = await both("eth_getCode", [p.token, hex(l.height)]);
      if (typeof code !== "string" || keccak256(code) !== p.codeHash)
        throw Error("TOKEN_CODE_MISMATCH");
      const incoming = receipt.logs
        .filter((r: any) => r.address === p.token && r.topics?.[0] === TOPIC)
        .map(logValue);
      const to = incoming.filter((r: any) => r.to === p.recipient),
        out = incoming.filter((r: any) => r.from === p.recipient);
      // Minimal profile supports one net incoming log per receipt, including a batch
      // transaction to other recipients. Multiple incoming/outgoing forms require review.
      if (to.length !== 1 || out.length) throw Error("AMBIGUOUS_NET_RECEIPT");
      const senderCode = await both("eth_getCode", [l.from, hex(f.number)]);
      if (
        typeof senderCode !== "string" ||
        !/^0x(?:[0-9a-f]{2})*$/.test(senderCode)
      )
        throw Error("MALFORMED_SENDER_CODE");
      return {
        ...l,
        timestamp: h.timestamp,
        txFrom: address.parse(tx.from),
        txTo: tx.to === null ? null : address.parse(tx.to),
        eoa: senderCode === "0x",
        codeHash: p.codeHash,
        profile: p.id,
        synthetic: true,
      };
    };
    const save = async (
      txHash: string,
      index: number,
      value: any,
      claim?: any,
      invalidReason?: string,
    ) =>
      core.work(async (q) => {
        // Serialize proof links and trusted reopening with release/reissue.
        await q.query("SELECT pg_advisory_xact_lock(733106,1)");
        // A customer may amend an unproven hint while reads are in flight.
        // Lock case before stream (matching owner disposition), then discard
        // stale work without assigning its proof to the amended case.
        if (claim) {
          const {
            rows: [current],
          } = await q.query("SELECT * FROM hex_case WHERE id=$1 FOR UPDATE", [
            claim.id,
          ]);
          if (
            !current ||
            current.status !== "pending" ||
            current.hint_hash !== claim.hint_hash ||
            current.hint_index !== claim.hint_index ||
            current.hint_revisions !== claim.hint_revisions
          )
            return null;
        }
        const {
          rows: [s],
        } = await q.query(
          "SELECT lease,paused FROM hex_stream WHERE profile_id=$1 FOR UPDATE",
          [p.id],
        );
        if (s.lease !== tickId || s.paused) throw Error("STREAM_FENCED");
        const paymentKey = key(txHash, index);
        let assigned: any = null;
        if (value) {
          const {
            rows: [a],
          } = await q.query(
            "SELECT invoice_id FROM hex_assignment WHERE chain=$1 AND token=$2 AND recipient=$3 AND amount_hearts=$4",
            [p.chain, p.token, p.recipient, value.amount],
          );
          assigned = a?.invoice_id ?? null;
        }
        // Do not retain unsolicited dust history. A bounded authenticated claim is different.
        if (!assigned && !claim) {
          unmatched++;
          return null;
        }
        if (claim && assigned && assigned !== claim.invoice_id) {
          await q.query(
            "UPDATE hex_case SET status='additional_evidence_required',retry_state='done',retry_reason='ASSIGNED_ELSEWHERE' WHERE id=$1",
            [claim.id],
          );
          return null;
        }
        const {
          rows: [old],
        } = await q.query(
          "SELECT * FROM hex_observation WHERE payment_key=$1 FOR UPDATE",
          [paymentKey],
        );
        const v = value ?? { invalid: true },
          pd = digest(stable(v));
        if (old?.valid && (!value || old.proof_digest !== pd)) {
          await q.query(
            "UPDATE hex_stream SET paused=true,reason='ACCEPTED_PROOF_CHANGED' WHERE profile_id=$1",
            [p.id],
          );
          throw Error("ACCEPTED_PROOF_CHANGED");
        }
        if (!old) {
          const {
            rows: [n],
          } = await q.query("SELECT count(*)::int n FROM hex_observation");
          if (n.n >= 1000) throw Error("OBSERVATION_CAPACITY");
        }
        await q.query(
          `INSERT INTO hex_observation(payment_key,profile_id,tx_hash,log_index,amount_hearts,proof,proof_digest,valid,reason,assigned_invoice,observed_at)
        VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) ON CONFLICT(payment_key) DO UPDATE SET amount_hearts=excluded.amount_hearts,proof=excluded.proof,proof_digest=excluded.proof_digest,valid=excluded.valid,reason=excluded.reason,assigned_invoice=excluded.assigned_invoice`,
          [
            paymentKey,
            p.id,
            txHash,
            index,
            value?.amount ?? null,
            v,
            pd,
            !!value,
            invalidReason ?? null,
            assigned,
            await core.time(q),
          ],
        );
        // Only newly verified, historically assigned money can reopen a prior
        // no-payment rejection. Preserve the prior decision and action audit.
        if (value && assigned)
          await q.query(
            `UPDATE hex_case c SET prior_resolution=c.resolution,resolution=NULL,
             status='additional_evidence_required',payment_key=$2,retry_state='done',retry_reason='NEW_VERIFIED_PAYMENT'
             FROM hex_quote v WHERE c.invoice_id=$1 AND v.invoice_id=c.invoice_id
             AND c.status='rejected' AND c.resolution->>'status'='rejected' AND c.payment_key IS NULL
             AND v.grant_id IS NULL AND $3>v.fence_height AND to_timestamp($4)>=v.issued_at`,
            [assigned, paymentKey, value.height, value.timestamp],
          );
        if (claim)
          await q.query(
            "UPDATE hex_case SET payment_key=$2,status=$3,retry_state='done',retry_reason=NULL WHERE id=$1",
            [
              claim.id,
              paymentKey,
              value
                ? "additional_evidence_required"
                : "additional_evidence_required",
            ],
          );
        return { paymentKey, assigned };
      });
    const recoveryDeadline = () => {
      if (Date.now() >= +deadline) throw Error("TICK_DEADLINE");
      return { deadline: performance.now() + (+deadline - Date.now()) };
    };
    const recoveryWork = <T>(fn: (q: pg.PoolClient) => Promise<T>) =>
      core.work(fn, recoveryDeadline());
    // Reserve attempts/due state durably before fulfillment. A crash cannot
    // restore the allowance; expiry of the due time permits only the next attempt.
    const fulfillSaved = async (invoiceId: string, paymentKey: string) => {
      const reserved = await recoveryWork(async (q) => {
        const now = await core.time(q);
        return (await q.query(
          `UPDATE hex_observation SET retry_attempts=retry_attempts+1,last_attempt_at=$2,
           retry_due=$2::timestamptz+interval '60 seconds',
           retry_state=CASE WHEN retry_attempts+1>=5 THEN 'parked' ELSE 'ready' END,
           retry_reason='ATTEMPT_RESERVED'
           WHERE payment_key=$1 AND valid AND consumed_invoice IS NULL
           AND retry_state='ready' AND retry_attempts<5 AND (retry_due IS NULL OR retry_due<=$2) RETURNING *`,
          [paymentKey,now],
        )).rows[0];
      });
      if (!reserved) return;
      try {
        const result = await core.fulfill(invoiceId, paymentKey, recoveryDeadline());
        await recoveryWork(q=>q.query(
          "UPDATE hex_observation SET retry_state='done',retry_reason=NULL,reason=CASE WHEN $2 THEN 'extra_payment' ELSE reason END WHERE payment_key=$1",
          [paymentKey,result.status==='extra_payment'],
        ));
      } catch (e: any) {
        recoveryDeadline();
        const code=String(e.code ?? e.message).slice(0,100);
        const parked=["BILLING_MODE_CONFLICT","SUCCESSOR_RESERVED","PURCHASE_SLOT_RESERVED",
          "PAYMENT_REVIEW_REQUIRED","PAYMENT_NOT_ELIGIBLE","PAYMENT_REFUND_OR_CONFLICT","PROFILE_READER_REQUIRED"].includes(code);
        await recoveryWork(async(q)=>{
          await q.query("UPDATE hex_observation SET retry_state=CASE WHEN $2 OR retry_attempts>=5 THEN 'parked' ELSE 'ready' END,retry_reason=$3 WHERE payment_key=$1",[paymentKey,parked,code]);
          await q.query("UPDATE hex_quote SET status='review',reason=$2 WHERE invoice_id=$1 AND status NOT IN ('paid','cancelled')",[invoiceId,code]);
        });
      }
    };
    const process = async (
      txHash: string,
      index: number,
      claim?: any,
      scanLog?: any,
    ) => {
      let value: any;
      try {
        value = await proof(txHash, index);
      } catch (e: any) {
        // Only a well-formed failed or explicitly unsupported transfer is an
        // ineligible payment. Missing/malformed proof and transport failures
        // leave the range incomplete rather than silently skipping it.
        if (
          ![
            "FAILED_RECEIPT",
            "UNSUPPORTED_TRANSFER",
            "AMBIGUOUS_NET_RECEIPT",
          ].includes(e.message)
        )
          throw e;
        if (claim) await save(txHash, index, null, claim, e.message);
        return { invalid: e.message };
      }
      if (scanLog && Object.keys(scanLog).some((k) => scanLog[k] !== value[k]))
        throw Error("SCAN_RECEIPT_CONFLICT");
      const o = await save(txHash, index, value, claim);
      if (o?.assigned) await fulfillSaved(o.assigned,o.paymentKey);
      return { value };
    };
    try {
      const chain = await both("eth_chainId", []);
      if (chain !== "0x171") throw Error("WRONG_CHAIN");
      const s = acquired.stream;
      const anchors = new Map<number, Partial<ReturnType<typeof header>>[]>();
      if (s.finalized) anchors.set(s.finalized.number, [s.finalized]);
      const cursorHeight = Number(s.cursor_height);
      anchors.set(cursorHeight, [...(anchors.get(cursorHeight) ?? []), { hash: s.cursor_hash }]);
      let missingAnchor: unknown;
      for (const [height, expected] of anchors) {
        try { await commonHeader(height, "FINALIZED_ANCHOR_CHANGED", expected); }
        catch (error: any) {
          if (error.message === "FINALIZED_ANCHOR_CHANGED") throw error;
          missingAnchor ??= error;
        }
      }
      if (missingAnchor) throw missingAnchor;
      const views = [];
      for (const source of [0, 1]) {
        const final = header(await call(source, "eth_getBlockByNumber", ["finalized", false]));
        const latest = header(await call(source, "eth_getBlockByNumber", ["latest", false]));
        if (final.number > latest.number) throw Error("SOURCE_VIEW_INCOMPLETE");
        views.push({ final, latest });
      }
      const F = Math.min(...views.map((v) => v.final.number));
      const H = Math.min(...views.map((v) => v.latest.number));
      finalized = await commonHeader(F, "SOURCE_DISAGREEMENT");
      for (const source of [0, 1]) {
        const advertised = views[source]!.final;
        const canonical = await explicitHeader(source, advertised.number);
        if (stable(canonical) !== stable(advertised)) throw Error("FINALITY_CONFLICT");
      }
      const code = await both("eth_getCode", [p.token, hex(F)]);
      if (typeof code !== "string" || keccak256(code) !== p.codeHash)
        throw Error("TOKEN_CODE_MISMATCH");
      const head = await commonHeader(
        H,
        H <= Math.max(F, cursorHeight, s.finalized?.number ?? 0)
          ? "SOURCE_DISAGREEMENT" : "HEAD_NOT_AGREED",
      );
      // Keep accepted progress/freshness intact on lag, after checking concrete
      // identities (including an H that is already in finalized history).
      if (F < cursorHeight || (s.finalized && F < s.finalized.number))
        throw Error("SOURCE_BEHIND");
      await core.work(async (q) => {
        await q.query(
          "UPDATE hex_stream SET head=$2,finalized=$3,refreshed_at=$4 WHERE profile_id=$1 AND lease=$5",
          [p.id, head, finalized, await core.time(q), tickId],
        );
      });
      const start = Number(s.cursor_height) + 1,
        end = Math.min(finalized.number, start + Math.min(256, s.span) - 1);
      if (start <= end) {
        let logs: any;
        try {
          logs = await bothLogs("eth_getLogs", [
            {
              fromBlock: hex(start),
              toBlock: hex(end),
              address: p.token,
              topics: [
                TOPIC,
                null,
                "0x" + "0".repeat(24) + p.recipient.slice(2),
              ],
            },
          ], { from: start, to: end });
          if (!Array.isArray(logs) || logs.length > 200)
            throw Error("SPLIT_RANGE");
        } catch (e: any) {
          if (e.message === "SPLIT_RANGE" && end > start)
            await core.pool.query(
              "UPDATE hex_stream SET span=$2 WHERE profile_id=$1 AND lease=$3",
              [p.id, Math.max(1, Math.floor((end - start + 1) / 2)), tickId],
            );
          throw e;
        }
        const seen = new Set();
        const decoded = logs.map(logValue);
        for (const l of decoded) {
          if (
            l.token !== p.token ||
            l.to !== p.recipient ||
            l.height < start ||
            l.height > end
          )
            throw Error("INVALID_LOG_RANGE");
          const k = key(l.txHash, l.index);
          if (seen.has(k)) throw Error("DUPLICATE_SCAN_LOG");
          seen.add(k);
        }
        for (const l of decoded) {
          const {
            rows: [assignment],
          } = await core.pool.query(
            "SELECT invoice_id FROM hex_assignment WHERE chain=$1 AND token=$2 AND recipient=$3 AND amount_hearts=$4",
            [p.chain, p.token, p.recipient, l.amount],
          );
          if (!assignment) {
            unmatched++;
            continue;
          }
          const {
            rows: [saved],
          } = await core.pool.query(
            "SELECT * FROM hex_observation WHERE payment_key=$1",
            [key(l.txHash, l.index)],
          );
          if (
            saved?.valid &&
            saved.proof.blockHash === l.blockHash &&
            saved.proof.amount === l.amount &&
            saved.proof.from === l.from
          )
            continue;
          if (jobs >= Math.min(10, this.options.maxJobs ?? 10))
            throw Error("JOB_BUDGET");
          await process(l.txHash, l.index, undefined, l);
          jobs++;
        }
        const h = await commonHeader(end, "SOURCE_DISAGREEMENT");
        await core.work(async (q) => {
          const { rowCount } = await q.query(
            "UPDATE hex_stream SET cursor_height=$2,cursor_hash=$3,span=256 WHERE profile_id=$1 AND lease=$4 AND NOT paused",
            [p.id, end, h.hash, tickId],
          );
          if (rowCount !== 1) throw Error("STREAM_FENCED");
        });
        completed = end === finalized.number;
      } else completed = true;
      // Release only after this tick has proved full finalized coverage. This
      // precedes case-local work, so a bad hint cannot obstruct safe expiry.
      if (completed) {
        const candidates=(await recoveryWork(q=>q.query(
          "SELECT invoice_id,account_id FROM hex_quote WHERE profile_id=$1 AND reserved AND expires_at<=to_timestamp($2) ORDER BY account_id LIMIT 512",
          [p.id,finalized.timestamp],
        ))).rows;
        for(const v of candidates) await recoveryWork(async(q)=>{
          await lockAccount(q,v.account_id);
          await q.query("SELECT pg_advisory_xact_lock(733106,1)");
          // The same lock order as issuance/fulfillment; prove the lease still owns
          // the completed stream before touching the reserved purchase slot.
          const {rows:[current]}=await q.query("SELECT * FROM hex_stream WHERE profile_id=$1 FOR SHARE",[p.id]);
          if(current.lease!==tickId || current.paused || Number(current.cursor_height)<finalized.number)
            throw Error("STREAM_FENCED");
          await q.query(
            `UPDATE hex_quote h SET reserved=false,status=CASE WHEN status='cancelled' THEN status ELSE 'expired' END
             WHERE h.invoice_id=$1 AND h.reserved AND h.grant_id IS NULL AND h.status IN ('open','cancelled','review')
             AND h.expires_at<=to_timestamp($2)
             AND NOT EXISTS(SELECT 1 FROM hex_observation o WHERE o.assigned_invoice=h.invoice_id OR o.consumed_invoice=h.invoice_id
               OR (o.profile_id=h.profile_id AND o.amount_hearts=h.amount_hearts))
             AND NOT EXISTS(SELECT 1 FROM hex_case c WHERE c.invoice_id=h.invoice_id AND
               (c.status<>'rejected' OR c.resolution->>'status' IS DISTINCT FROM 'rejected' OR c.payment_key IS NOT NULL))`,
            [v.invoice_id,finalized.timestamp],
          );
        });
      }
      // One finite fair list across both kinds of recovery. New/unattempted work
      // sorts before previously tried work; every reservation moves its due time.
      const now=await recoveryWork(q=>core.time(q));
      const pending=(await recoveryWork(q=>q.query(
        `SELECT * FROM (
          SELECT 'proof' kind,o.payment_key id,a.invoice_id,o.last_attempt_at,o.observed_at created_at
          FROM hex_observation o JOIN hex_assignment a ON a.chain=369 AND a.token=$2 AND a.recipient=$3 AND a.amount_hearts=o.amount_hearts
          JOIN hex_quote v ON v.invoice_id=a.invoice_id WHERE o.profile_id=$1 AND o.valid AND o.consumed_invoice IS NULL
          AND o.retry_state='ready' AND o.retry_attempts<5 AND (o.retry_due IS NULL OR o.retry_due<=$4)
          AND v.grant_id IS NULL AND v.status<>'cancelled' AND o.proof->>'height' IS NOT NULL
          AND (o.proof->>'height')::bigint>v.fence_height AND to_timestamp((o.proof->>'timestamp')::double precision)>=v.issued_at
          AND to_timestamp((o.proof->>'timestamp')::double precision)<v.expires_at
          UNION ALL
          SELECT 'claim',c.id::text,c.invoice_id,c.last_attempt_at,c.created_at FROM hex_case c
          JOIN hex_quote v ON v.invoice_id=c.invoice_id WHERE v.profile_id=$1
          AND c.status='pending' AND c.hint_hash IS NOT NULL AND c.attempts<5 AND c.retry_state='ready'
          AND (c.retry_due IS NULL OR c.retry_due<=$4)
        ) jobs ORDER BY last_attempt_at NULLS FIRST,created_at,id LIMIT 10`,
        [p.id,p.token,p.recipient,now],
      ))).rows;
      for(const item of pending){
        recoveryDeadline();
        if(jobs>=Math.min(10,this.options.maxJobs??10)) break;
        jobs++;
        if(item.kind==='proof'){await fulfillSaved(item.invoice_id,item.id);continue;}
        const c=await recoveryWork(async(q)=>(await q.query(
          `UPDATE hex_case SET attempts=attempts+1,last_attempt_at=$2,retry_due=$2::timestamptz+interval '60 seconds',
           retry_state=CASE WHEN attempts+1>=5 THEN 'parked' ELSE 'ready' END,retry_reason='ATTEMPT_RESERVED'
           WHERE id=$1 AND status='pending' AND attempts<5 AND retry_state='ready' AND (retry_due IS NULL OR retry_due<=$2) RETURNING *`,
          [item.id,await core.time(q)],
        )).rows[0]);
        if(!c) continue;
        try{await process(c.hint_hash,c.hint_index,c);}
        catch(e:any){
          // Untrusted hint uncertainty is local, not a claim of complete range
          // evidence. Shared contradictions and work ceilings still stop the tick.
          if(e instanceof BudgetUnavailable || e.message.startsWith("DAILY_") || trustFailures.includes(e.message) || ["TICK_BUDGET","TICK_DEADLINE","STREAM_FENCED"].includes(e.message)) throw e;
          await recoveryWork(q=>q.query(
            `UPDATE hex_case SET retry_reason=$3,status=CASE WHEN attempts>=5 THEN 'additional_evidence_required' ELSE status END
             WHERE id=$1 AND hint_revisions=$2 AND status='pending'`,
            [c.id,c.hint_revisions,String(e.message).slice(0,100)],
          ));
        }
      }
    } catch (e: any) {
      reason = e.message;
      if (e instanceof BudgetUnavailable) budget = e.budget;
      if (trustFailures.includes(reason!))
        await core.pool.query(
          "UPDATE hex_stream SET paused=true,reason=$2 WHERE profile_id=$1",
          [p.id, reason],
        );
    } finally {
      abort.abort();
      await core.work(async (q) => {
        await q.query("SELECT profile_id FROM hex_stream WHERE profile_id=$1 FOR UPDATE", [p.id]);
        await q.query("UPDATE hex_tick SET state=$2,reason=$3 WHERE id=$1", [
          tickId,
          reason ? "incomplete" : "complete",
          reason,
        ]);
        await q.query(
          "UPDATE hex_stream SET lease=null,lease_until=null WHERE profile_id=$1 AND lease=$2",
          [p.id, tickId],
        );
      });
    }
    return {
      tickId,
      ...(budget ? { budget } : {}),
      completed: completed && !reason,
      reason,
      calls,
      decodedBytes: bytes,
      jobs,
      unmatched,
      trust: "TWO_SYNTHETIC_SOURCES_ONLY",
    };
  }
}
