import type pg from "pg";
type Query = Pick<pg.Pool, "query"> | pg.PoolClient;
const fictional = (s: unknown): s is string => typeof s === "string" && /^[^@]+@example\.test$/.test(s);
async function installed(q: Query) {
  return !!(await q.query("SELECT to_regclass('account_access') present")).rows[0].present;
}
// Used only to select a recipient; never changes a grant, period or usage counter.
export async function accountRecipient(q: Query, id: string): Promise<string | null> {
  let r;
  if (await installed(q)) {
    r = (await q.query(`SELECT CASE WHEN a.account_id IS NOT NULL THEN a.current_email
      WHEN NOT u."internalEmail" AND u."emailVerified" THEN u.email END email
      FROM "user" u LEFT JOIN account_access a ON a.account_id=u.id
      JOIN customer c ON c.id=u.id WHERE u.id=$1 AND NOT c.disabled`, [id])).rows[0];
  } else {
    r = (await q.query(`SELECT u.email FROM "user" u JOIN customer c ON c.id=u.id
      WHERE u.id=$1 AND u."emailVerified" AND NOT c.disabled`, [id])).rows[0];
  }
  return fictional(r?.email) ? r.email : null;
}
export async function mailRecipientValid(q: Query, m: any): Promise<boolean> {
  if (!fictional(m.recipient)) return false;
  if (m.access_owner) {
    const { rows: [r] } = await q.query(`SELECT t.recipient FROM account_token t
      JOIN account_access a ON a.account_id=t.account_id JOIN customer c ON c.id=a.account_id
      WHERE t.account_id=$1 AND t.purpose=$2 AND t.digest=$3 AND t.recipient=$4
      AND t.generation=a.generation AND t.contact_generation=a.contact_generation
      AND t.expires_at>clock_timestamp() AND NOT c.disabled
      AND t.recipient=CASE WHEN t.purpose='verify' THEN a.pending_email ELSE a.current_email END`,
      [m.access_owner,m.access_purpose,m.access_digest,m.recipient]);
    return !!r;
  }
  let account: string | undefined;
  if (m.dedup.startsWith("quota:")) account = m.dedup.slice(6,-11);
  if (m.dedup.startsWith("period-quota:")) {
    try { const v = JSON.parse(m.dedup.slice(13)); if (Array.isArray(v) && typeof v[0] === "string") account=v[0]; } catch { return false; }
  }
  for (const prefix of ["window-quota:","calendar-expiry:"]) if(m.dedup.startsWith(prefix)) {
    try { const v=JSON.parse(m.dedup.slice(prefix.length)); if(Array.isArray(v)&&typeof v[0]==="string") account=v[0]; } catch {return false;}
  }
  if (m.dedup.startsWith("expiry:")) account = (await q.query("SELECT account_id FROM grant_record WHERE id::text=$1", [m.dedup.slice(7)])).rows[0]?.account_id;
  if (account) return (await accountRecipient(q,account)) === m.recipient;
  // Legacy auth messages: only real legacy addresses, never internal aliases.
  const internal = await installed(q);
  return !!(await q.query(`SELECT id FROM "user" WHERE email=$1 ${internal ? 'AND NOT "internalEmail"' : ''}
    AND ($2='Verify lab email' OR "emailVerified")`, [m.recipient,m.subject])).rowCount;
}
export async function cleanAccountMail(q: Query) {
  if (!await installed(q)) return;
  // Access mail alone: redact stale or exhausted plaintext challenges, while
  // retaining live proofs that may already have reached the local recipient.
  await q.query(`UPDATE outbox SET body='[obsolete access message suppressed]',
    cancelled_at=coalesce(cancelled_at,clock_timestamp()) WHERE id IN (
    SELECT m.id FROM outbox m WHERE m.access_owner IS NOT NULL AND m.delivered_at IS NULL
    AND m.body<>'[obsolete access message suppressed]' AND
    (m.cancelled_at IS NOT NULL OR m.attempts>=8 OR NOT EXISTS (
      SELECT 1 FROM account_token t JOIN account_access a ON a.account_id=t.account_id
      JOIN customer c ON c.id=a.account_id WHERE t.account_id=m.access_owner
      AND t.purpose=m.access_purpose AND t.digest=m.access_digest AND t.recipient=m.recipient
      AND t.generation=a.generation AND t.contact_generation=a.contact_generation
      AND t.expires_at>clock_timestamp() AND NOT c.disabled
      AND t.recipient=CASE WHEN t.purpose='verify' THEN a.pending_email ELSE a.current_email END))
    ORDER BY m.next_at,m.id LIMIT 32)`);
  await q.query(`DELETE FROM outbox WHERE id IN (SELECT id FROM outbox
    WHERE access_owner IS NOT NULL AND coalesce(delivered_at,cancelled_at)<clock_timestamp()-interval '7 days'
    ORDER BY coalesce(delivered_at,cancelled_at),id LIMIT 32)`);
  // At most 2 challenge rows per account, bounded expiry cleanup per call.
  await q.query(`DELETE FROM account_token WHERE (account_id,purpose) IN
    (SELECT account_id,purpose FROM account_token WHERE expires_at<=clock_timestamp() LIMIT 32)`);
}
