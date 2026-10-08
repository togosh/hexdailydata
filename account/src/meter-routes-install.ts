import type pg from "pg";
import type { Config } from "./config.js";
import { boundedTransaction } from "./metering.js";
import { METER_ROUTES } from "./meter-routes.js";

// Explicit account migration; never run DDL in an HTTP request or on an analytics pool.
export async function installMeterRoutes(pool: pg.Pool, c: Config) {
  return boundedTransaction(pool, {}, async q => {
    const { rows: [r] } = await q.query(`SELECT current_database() db,current_user usr,
      host(inet_server_addr()) addr,lab_id,run_id FROM boundary.identity`);
    if (r?.db !== c.database || r.usr !== "lab_migrator" || r.addr !== c.dbAddress ||
        r.lab_id !== c.labId || r.run_id !== c.runId) throw Error("WRONG_MIGRATION_TARGET");
    const { rows: [role] } = await q.query(
      "SELECT rolsuper,rolcreatedb,rolcreaterole FROM pg_roles WHERE rolname=current_user");
    if (role.rolsuper || role.rolcreatedb || role.rolcreaterole) throw Error("UNSAFE_MIGRATION_ROLE");
    await q.query("SELECT pg_advisory_xact_lock(733105,1)");
    await q.query("LOCK TABLE public.meter_receipt IN ACCESS EXCLUSIVE MODE");
    const { rows: [rule] } = await q.query(`SELECT convalidated,pg_get_constraintdef(oid) definition
      FROM pg_constraint WHERE conrelid='public.meter_receipt'::regclass AND conname='meter_receipt_route_check' AND contype='c'`);
    const definition = (routes: readonly string[]) =>
      "CHECK ((route = ANY (ARRAY[" + routes.map(s => "'" + s + "'::text").join(", ") + "])))";
    const old = definition(["home", "daily", "stakes", "stakeEvents"]);
    const next = definition(METER_ROUTES);
    if (!rule?.convalidated || ![old, next].includes(rule.definition))
      throw Error("INCOMPATIBLE_METER_ROUTE_SCHEMA");
    if (rule.definition === next) return;
    // Only constant source-controlled IDs enter DDL. Existing rows/holds stay untouched.
    await q.query("ALTER TABLE public.meter_receipt DROP CONSTRAINT meter_receipt_route_check");
    await q.query("ALTER TABLE public.meter_receipt ADD CONSTRAINT meter_receipt_route_check CHECK (route IN (" +
      METER_ROUTES.map(s => "'" + s + "'").join(",") + "))");
  });
}
