import fs from "node:fs";
import pg from "pg";
import { config } from "./config.js";
const c = config();
const p = new pg.Pool({
  host: "db",
  database: c.database,
  user: "lab_migrator",
  password: fs.readFileSync("/run/lab/migrator", "utf8"),
});
try {
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
    throw Error("WRONG_UPGRADE_TARGET");
  await p.query("begin");
  await p.query(fs.readFileSync("src/upgrade.sql", "utf8"));
  await p.query("commit");
  console.log("OWNED_LAB_UPGRADED");
} catch (e) {
  await p.query("rollback");
  throw e;
} finally {
  await p.end();
}
