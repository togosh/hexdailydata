import fs from "node:fs";
import pg from "pg";
import { getMigrations } from "better-auth/db/migration";
import { config } from "./config.js";
import { makeAuth } from "./auth.js";
const c = config();
const pw = fs.readFileSync("/run/lab/migrator", "utf8");
const p = new pg.Pool({
  host: "db",
  database: c.database,
  user: "lab_migrator",
  password: pw,
});
const {
  rows: [r],
} = await p.query(
  "select current_database() db,current_user usr,host(inet_server_addr()) addr,lab_id,run_id from boundary.identity",
);
if (
  r.db !== c.database ||
  r.usr !== "lab_migrator" ||
  r.addr !== c.dbAddress ||
  r.lab_id !== c.labId ||
  r.run_id !== c.runId
)
  throw Error("WRONG_MIGRATION_TARGET");
const { rows } = await p.query(
  "select tablename from pg_tables where schemaname in ('public','fake_provider')",
);
if (rows.length) throw Error("MIGRATION_REQUIRES_FRESH_TARGET");
const auth = makeAuth(c, p);
const m = await getMigrations(auth.options);
await m.runMigrations();
await p.query(fs.readFileSync("src/schema.sql", "utf8"));
await p.query(fs.readFileSync("src/upgrade.sql", "utf8"));
await p.query(
  "GRANT SELECT,INSERT,UPDATE,DELETE ON ALL TABLES IN SCHEMA public TO lab_runtime",
);
await p.end();
console.log("FRESH_LAB_MIGRATED");
process.exit(0);
