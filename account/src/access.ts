import { accountRecipient } from "./account-mail.js";
import type pg from "pg";
import { randomBytes, randomUUID } from "node:crypto";
import { hash } from "./billing.js";
import { tx, lockAccount, Denied } from "./db.js";
export async function createKey(
  p: pg.Pool,
  id: string,
  label: string,
  rotate?: string,
) {
  return tx(p, async (q) => {
    await lockAccount(q, id);
    if (rotate) {
      const { rowCount } = await q.query(
        "update api_key set revoked=true where id=$1 and account_id=$2 and not revoked",
        [rotate, id],
      );
      if (!rowCount) throw new Denied("KEY_NOT_FOUND", 404);
    }
    const {
      rows: [n],
    } = await q.query(
      "select count(*)::int n from api_key where account_id=$1 and not revoked",
      [id],
    );
    if (n.n >= 3) throw new Denied("KEY_LIMIT", 409);
    const secret = "lab_" + randomBytes(32).toString("base64url");
    const keyId = randomUUID();
    await q.query(
      "insert into api_key(id,account_id,verifier,label,prefix) values($1,$2,$3,$4,$5)",
      [keyId, id, hash(secret), label, secret.slice(0, 10)],
    );
    return { id: keyId, secret };
  });
}
export async function revokeKey(p: pg.Pool, accountId: string, keyId: string) {
  return tx(p, async (q) => {
    await lockAccount(q, accountId);
    const { rowCount } = await q.query(
      "update api_key set revoked=true where id=$1 and account_id=$2",
      [keyId, accountId],
    );
    if (!rowCount) throw new Denied("KEY_NOT_FOUND", 404);
    return { revoked: true };
  });
}
// All admissions and mutations serialize on the same customer row. No process cache.
// Expiry is half-open; requests admitted before revocation commits may complete.
export async function authorizeAndConsume(p: pg.Pool, key: string, now?: Date) {
  if (!/^lab_[A-Za-z0-9_-]{43}$/.test(key))
    throw new Denied("INVALID_KEY", 401);
  const meter = { statements: 0 };
  const result = await tx(
    p,
    async (q) => {
      const { accountId, instant } = await checkAccess(
        q,
        key,
        async () => now ?? new Date(),
      );
      const minute = new Date(Math.floor(+instant / 60000) * 60000);
      const {
        rows: [burst],
      } = await q.query(
        "insert into burst_bucket(account_id,minute,units) values($1,$2,1) on conflict(account_id) do update set minute=excluded.minute,units=case when burst_bucket.minute=excluded.minute then burst_bucket.units+1 else 1 end returning units",
        [accountId, minute],
      );
      if (burst.units > 30) throw new Denied("BURST_LIMIT", 429);
      const {
        rows: [usage],
      } = await q.query(
        `insert into usage_bucket(account_id,day,units) values($1,$2,1) on conflict(account_id,day) do update set units=usage_bucket.units+1 where usage_bucket.units<100 returning units`,
        [accountId, instant.toISOString().slice(0, 10)],
      );
      if (!usage) throw new Denied("DAILY_QUOTA", 429);

      if (usage.units === 90) {
        const recipient = await accountRecipient(q, accountId);
        await q.query(
          `insert into outbox(id,dedup,recipient,subject,body) select gen_random_uuid(),$2,$3,'Lab quota reminder','90 of 100 synthetic API requests admitted in this UTC day.' from "user" where id=$1 AND $3::text IS NOT NULL on conflict(dedup) do nothing`,
          [
            accountId,
            "quota:" + accountId + ":" + instant.toISOString().slice(0, 10),
            recipient,
          ],
        );
      }
      return { remaining: 100 - usage.units };
    },
    meter,
  );
  return { ...result, queryCount: meter.statements };
}

// Shared admission checks only. The supplied clock is sampled AFTER the customer lock.
export async function checkAccess(
  q: pg.PoolClient,
  key: string,
  sampleTime: () => Promise<Date>,
  requireLegacyGrant = true,
) {
  if (!/^lab_[A-Za-z0-9_-]{43}$/.test(key))
    throw new Denied("INVALID_KEY", 401);
  const {
    rows: [k],
  } = await q.query("select account_id from api_key where verifier=$1", [
    hash(key),
  ]);
  if (!k) throw new Denied("INVALID_KEY", 401);
  await lockAccount(q, k.account_id);
  const instant = await sampleTime();
  const {
    rows: [valid],
  } = await q.query("select revoked from api_key where verifier=$1", [
    hash(key),
  ]);
  if (valid.revoked) throw new Denied("REVOKED_KEY", 401);
  const { rowCount } = await q.query(
    "select 1 from grant_record where account_id=$1 and not refunded and starts_at<=$2 and ends_at>$2 limit 1",
    [k.account_id, instant],
  );
  if (requireLegacyGrant && !rowCount) throw new Denied("ACCESS_EXPIRED", 403);
  return { accountId: k.account_id as string, instant };
}
