import type pg from "pg";
import type { Config } from "./config.js";
import { readFile } from "node:fs/promises";
import { boundedTransaction } from "./metering.js";

export async function installPeriods(pool: pg.Pool, c: Config) {
  const sql = await readFile(new URL("./period.sql", import.meta.url), "utf8");
  return boundedTransaction(pool, {}, async (q) => {
    const {
      rows: [r],
    } = await q.query(`SELECT current_database() db,current_user usr,
      host(inet_server_addr()) addr,lab_id,run_id FROM boundary.identity`);
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
    const {
      rows: [before],
    } = await q.query(`SELECT
      (SELECT count(*)::int FROM information_schema.columns WHERE table_schema='public' AND table_name='grant_record' AND column_name IN ('activated_at','plan_revision','allowance','reminder_threshold')) n,
      to_regclass('public.period_usage') aggregate,
      (SELECT count(*)::int FROM information_schema.columns WHERE table_schema='public' AND table_name='meter_receipt' AND column_name='period_id') receipt`);
    if (
      !(before.n === 0 && !before.aggregate && before.receipt === 0) &&
      !(before.n === 4 && before.aggregate && before.receipt === 1)
    )
      throw Error("INCOMPATIBLE_PERIOD_SCHEMA");
    await q.query(sql);
    const expected: Record<string, string> = {
      "grant_record.activated_at": "timestamp with time zone:YES",
      "grant_record.plan_revision": "text:YES",
      "grant_record.allowance": "integer:YES",
      "grant_record.reminder_threshold": "integer:YES",
      "period_usage.account_id": "text:NO",
      "period_usage.period_id": "uuid:NO",
      "period_usage.used": "integer:NO",
      "meter_receipt.period_id": "uuid:YES",
      "meter_receipt.day": "date:YES",
    };
    const { rows } = await q.query(
      `SELECT table_name,column_name,data_type,is_nullable FROM information_schema.columns WHERE table_schema='public' AND table_name IN ('grant_record','period_usage','meter_receipt')`,
    );
    for (const [name, value] of Object.entries(expected)) {
      const row = rows.find((r) => r.table_name + "." + r.column_name === name);
      if (!row || row.data_type + ":" + row.is_nullable !== value)
        throw Error("INCOMPATIBLE_PERIOD_SCHEMA");
    }
    const { rows: constraints } =
      await q.query(`SELECT conname,convalidated,pg_get_constraintdef(oid) definition FROM pg_constraint
      WHERE conrelid IN ('grant_record'::regclass,'period_usage'::regclass,'meter_receipt'::regclass)`);
    const rules: Record<string, string[]> = {
      period_terms: [
        "activated_at IS NULL",
        "activated_at < ends_at",
        "allowance >= 1",
        "allowance <= 2147483647",
        "reminder_threshold <= allowance",
      ],
      period_owner: ["UNIQUE (account_id, id)"],
      period_usage_pkey: ["PRIMARY KEY (account_id, period_id)"],
      period_usage_account_id_period_id_fkey: [
        "FOREIGN KEY (account_id, period_id) REFERENCES grant_record(account_id, id)",
      ],
      period_usage_used_check: ["used >= 0", "used <= 2147483647"],
      meter_owner_shape: [
        "day IS NOT NULL",
        "period_id IS NULL",
        "day IS NULL",
        "period_id IS NOT NULL",
      ],
      meter_period_owner: [
        "FOREIGN KEY (account_id, period_id) REFERENCES period_usage(account_id, period_id)",
      ],
    };
    if (constraints.some(r=>r.conname === "meter_term_owner")) {
      delete rules.meter_period_owner;
      rules.meter_term_owner=["FOREIGN KEY (account_id, period_id) REFERENCES grant_record(account_id, id)"];
      rules.meter_window_owner=["FOREIGN KEY (account_id, period_id, window_id) REFERENCES window_usage(account_id, term_id, window_id)"];
    }
    for (const [name, parts] of Object.entries(rules)) {
      const row = constraints.find((r) => r.conname === name);
      if (!row?.convalidated || !parts.every((p) => row.definition.includes(p)))
        throw Error("INCOMPATIBLE_PERIOD_SCHEMA");
    }
  });
}
