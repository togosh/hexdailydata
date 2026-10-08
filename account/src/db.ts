import pg from "pg";
import type { Config } from "./config.js";
export function poolFor(c: Config, provider = false) {
  return new pg.Pool({
    host: c.dbHost,
    port: 5432,
    database: c.database,
    user: provider ? "lab_provider" : "lab_runtime",
    password: provider ? c.providerPassword : c.dbPassword,
    max: 6,
    connectionTimeoutMillis: 3000,
    statement_timeout: 5000,
    options: "-c timezone=UTC",
  });
}
export async function guard(p: pg.Pool, c: Config, provider = false) {
  const {
    rows: [r],
  } = await p.query(
    `select current_database() db,current_user usr,host(inet_server_addr()) addr,lab_id,run_id from boundary.identity`,
  );
  if (
    r.db !== c.database ||
    r.usr !== (provider ? "lab_provider" : "lab_runtime") ||
    r.addr !== c.dbAddress ||
    r.lab_id !== c.labId ||
    r.run_id !== c.runId
  )
    throw Error("WRONG_LAB_DATABASE");
  const {
    rows: [role],
  } = await p.query(
    "select rolsuper,rolcreatedb,rolcreaterole from pg_roles where rolname=current_user",
  );
  if (role.rolsuper || role.rolcreatedb || role.rolcreaterole)
    throw Error("UNSAFE_RUNTIME_ROLE");
}
export async function tx<T>(
  p: pg.Pool,
  work: (q: pg.PoolClient) => Promise<T>,
  meter?: { statements: number },
): Promise<T> {
  const raw = await p.connect();
  const q = meter
    ? new Proxy(raw, {
        get(target, prop) {
          if (prop === "query")
            return (...args: any[]) => {
              meter.statements++;
              return (target.query as any).apply(target, args);
            };
          return Reflect.get(target, prop);
        },
      })
    : raw;
  try {
    await q.query("begin");
    const r = await work(q);
    await q.query("commit");
    return r;
  } catch (e) {
    try {
      await q.query("rollback");
    } catch (rollbackError) {
      throw new AggregateError(
        [e, rollbackError],
        "TRANSACTION_AND_ROLLBACK_FAILED",
      );
    }
    throw e;
  } finally {
    q.release();
  }
}
export class Denied extends Error {
  constructor(
    public code: string,
    public status = 400,
  ) {
    super(code);
  }
}
export async function lockAccount(q: pg.PoolClient, id: string) {
  await q.query("insert into customer(id) values($1) on conflict do nothing", [
    id,
  ]);
  const {
    rows: [r],
  } = await q.query("select * from customer where id=$1 for update", [id]);
  if (r.disabled) throw new Denied("ACCOUNT_DISABLED", 403);
  return r;
}
