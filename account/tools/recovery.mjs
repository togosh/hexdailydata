import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { rootCheck, readState } from "./lab.mjs";
const root = rootCheck(process.cwd()),
  lab = readState(root),
  s = JSON.parse(fs.readFileSync(".local/current.json")),
  c = JSON.parse(fs.readFileSync(path.join(s.dir, "config.json")));
if (s.labId !== lab.labId || s.stopped) throw Error("WRONG_RUN");
function docker(args, input) {
  const r = spawnSync("docker", args, {
    input,
    encoding: input instanceof Buffer ? undefined : "utf8",
    maxBuffer: 32 * 1024 * 1024,
    timeout: 60000,
  });
  if (r.status !== 0)
    throw Error("RECOVERY_COMMAND_FAILED " + String(r.stderr).slice(-500));
  return r.stdout;
}
for (const id of Object.values(s.containers)) {
  const r = JSON.parse(docker(["inspect", id]))[0];
  if (
    r.Config.Labels["hdd.lab"] !== lab.labId ||
    r.Config.Labels["hdd.run"] !== s.runId
  )
    throw Error("NOT_OWNED");
}
const sql = (db, text) =>
  docker(
    [
      "exec",
      "-i",
      s.containers.db,
      "psql",
      "-v",
      "ON_ERROR_STOP=1",
      "-At",
      "-U",
      "lab_bootstrap",
      "-d",
      db,
    ],
    text,
  ).trim();
if (
  sql(c.database, "select lab_id||'|'||run_id from boundary.identity") !==
  lab.labId + "|" + s.runId
)
  throw Error("WRONG_SOURCE");
const tables = [
  '"user"',
  "account",
  "session",
  "verification",
  "customer",
  "invoice",
  "event",
  "payment_identity",
  "credit",
  "grant_record",
  "api_key",
  "usage_bucket",
  "outbox",
  "fake_provider.record",
];
const snapshot = (db) =>
  Object.fromEntries(
    tables.map((t) => [
      t,
      sql(
        db,
        `select count(*)||'|'||md5(coalesce(string_agg(row_to_json(x)::text,E'\n' order by row_to_json(x)::text),'')) from ${t} x`,
      ),
    ]),
  );
const result = { runId: s.runId, checks: [] };
try {
  docker(["stop", "--time", "10", s.containers.app]);
  const before = snapshot(c.database);
  const dump = spawnSync(
    "docker",
    [
      "exec",
      s.containers.db,
      "pg_dump",
      "-U",
      "lab_bootstrap",
      "-d",
      c.database,
      "-Fc",
      "--exclude-schema=boundary",
    ],
    { maxBuffer: 32 * 1024 * 1024, timeout: 60000 },
  );
  if (dump.status !== 0) throw Error("BACKUP_FAILED");
  fs.writeFileSync(path.join(s.dir, "recovery.dump"), dump.stdout);
  const target = "lab_" + randomBytes(4).toString("hex");
  if (
    sql(
      c.database,
      `select count(*) from pg_database where datname='${target}'`,
    ) !== "0"
  )
    throw Error("DESTINATION_EXISTS");
  sql(c.database, `CREATE DATABASE ${target} OWNER lab_migrator`);
  sql(
    target,
    `REVOKE CONNECT ON DATABASE ${target} FROM PUBLIC; GRANT CONNECT ON DATABASE ${target} TO lab_runtime,lab_provider; CREATE SCHEMA boundary; CREATE TABLE boundary.identity(lab_id text,run_id text); INSERT INTO boundary.identity VALUES('${lab.labId}','${s.runId}-restore'); GRANT USAGE ON SCHEMA boundary TO lab_runtime,lab_provider; GRANT SELECT ON boundary.identity TO lab_runtime,lab_provider;`,
  );
  docker(
    [
      "exec",
      "-i",
      s.containers.db,
      "pg_restore",
      "-U",
      "lab_bootstrap",
      "-d",
      target,
      "--exit-on-error",
    ],
    dump.stdout,
  );
  const after = snapshot(target);
  if (JSON.stringify(before) !== JSON.stringify(after))
    throw Error("RESTORE_DATA_MISMATCH");
  result.checks.push({
    name: "fresh guarded DB backup/restore",
    result: "PASS",
    tables: tables.length,
    rows: Object.fromEntries(
      Object.entries(after).map(([k, v]) => [k, Number(v.split("|")[0])]),
    ),
    dumpBytes: dump.stdout.length,
  });
  // No in-place overwrite path exists. The restore DB is retained in this owned lab volume.
  if (
    sql(target, "select run_id from boundary.identity") !==
    s.runId + "-restore"
  )
    throw Error("RESTORE_BOUNDARY_CHANGED");
  docker(["start", s.containers.app]);
  for (let i = 0; i < 40; i++) {
    try {
      const r = await fetch(s.origin + "/health");
      if (r.ok) break;
    } catch {}
    await new Promise((r) => setTimeout(r, 250));
  }
  const restart = snapshot(c.database);
  for (const t of ["credit", "grant_record", "api_key", "usage_bucket"])
    if (before[t] !== restart[t]) throw Error("RESTART_DATA_CHANGED");
  result.checks.push({
    name: "actual app container stop/start",
    result: "PASS",
    preserved: ["credits", "grant intervals", "key verifiers", "usage"],
  });
  // Stop only this inbox, then ask the ordinary verified purchase path to commit under outage.
  docker(["stop", "--time", "5", s.containers.inbox]);
  const args = [
    "run",
    "--rm",
    "--network",
    s.network,
    "--label",
    "hdd.lab=" + lab.labId,
    "--label",
    "hdd.run=" + s.runId,
    "--cpus",
    ".625",
    "--memory",
    "256m",
    "--cap-drop",
    "ALL",
    "--mount",
    `type=bind,src=${path.join(s.dir, "config.json")},dst=/run/lab/config.json,readonly`,
    s.image,
    "node",
    "tests/outage.mjs",
  ];
  result.checks.push({
    name: "inbox outage cannot revoke paid access",
    result: "PASS",
    detail: docker(args).trim(),
  });
  docker(["start", s.containers.inbox]);
  await new Promise((r) => setTimeout(r, 6500));
  const delivered = Number(
    sql(
      c.database,
      "select count(*) from outbox where dedup like 'receipt:%' and attempts>=2 and delivered_at is not null",
    ),
  );
  if (delivered < 1) throw Error("SMTP_RETRY_NOT_OBSERVED");
  result.checks.push({
    name: "durable SMTP retry after inbox restart",
    result: "PASS",
    deliveredAfterRetry: delivered,
  });
} finally {
  fs.writeFileSync("evidence/recovery.json", JSON.stringify(result, null, 2));
}
console.log(JSON.stringify(result, null, 2));
