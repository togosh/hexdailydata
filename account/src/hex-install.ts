import { validatePolicy, type DailyPolicy } from "./payment-budget.js";
import type pg from "pg";
import type { Config } from "./config.js";
import { readFile } from "node:fs/promises";
import { boundedTransaction } from "./metering.js";
async function migrationTarget(q: pg.PoolClient, c: Config) {
    const {
      rows: [r],
    } = await q.query(
      `SELECT current_database() db,current_user usr,host(inet_server_addr()) addr,lab_id,run_id FROM boundary.identity`,
    );
    if (
      r?.db !== c.database ||
      r.usr !== "lab_migrator" ||
      r.addr !== c.dbAddress ||
      r.lab_id !== c.labId ||
      r.run_id !== c.runId
    )
      throw Error("WRONG_MIGRATION_TARGET");
    const {
      rows: [role],
    } = await q.query(
      "SELECT rolsuper,rolcreatedb,rolcreaterole FROM pg_roles WHERE rolname=current_user",
    );
    if (role.rolsuper || role.rolcreatedb || role.rolcreaterole)
      throw Error("UNSAFE_MIGRATION_ROLE");
    await q.query("SELECT pg_advisory_xact_lock(733105,1)");
    return r;
}
export async function installHex(pool: pg.Pool, c: Config) {
  const sql = await readFile(new URL("./hex.sql", import.meta.url), "utf8");
  return boundedTransaction(pool, {}, async (q) => {
    await migrationTarget(q,c);
    const {
      rows: [p],
    } = await q.query("SELECT to_regclass('period_usage') periods");
    if (!p.periods) throw Error("PERIOD_SCHEMA_REQUIRED");
    await q.query(sql);
    const {
      rows: [v],
    } = await q.query(
      "SELECT pg_get_constraintdef(oid) definition FROM pg_constraint WHERE conrelid='hex_assignment'::regclass AND contype='p'",
    );
    if (
      v?.definition !== "PRIMARY KEY (chain, token, recipient, amount_hearts)"
    )
      throw Error("INCOMPATIBLE_HEX_SCHEMA");
  });
}

export async function installPaymentBudget(pool: pg.Pool, c: Config, input: DailyPolicy) {
  const policy = validatePolicy(input);
  const sql = await readFile(new URL("./payment-budget.sql", import.meta.url), "utf8");
  return boundedTransaction(pool, {}, async q => {
    const r = await migrationTarget(q,c);
    await q.query("SELECT pg_advisory_xact_lock(733107,1)");
    const { rows: [schema] } = await q.query("SELECT to_regclass('public.hex_stream') present");
    if (!schema.present) throw Error("HEX_SCHEMA_REQUIRED");
    await q.query(sql);
    const boundary = `${r.db}:${r.lab_id}:${r.run_id}`;
    await q.query("INSERT INTO payment_budget_policy(singleton,boundary,config) VALUES(true,$1,$2) ON CONFLICT DO NOTHING", [boundary, policy]);
    const { rows: [stored] } = await q.query("SELECT boundary,config=$1::jsonb same FROM payment_budget_policy WHERE singleton", [policy]);
    if (stored.boundary !== boundary || !stored.same) throw Error("DAILY_POLICY_IMMUTABLE");
  });
}
