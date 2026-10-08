// Rebuild only this owned run. Prove additive upgrade first on a populated copy.
import fs from "node:fs";
import path from "node:path";
import { randomBytes, randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import assert from "node:assert/strict";
import {
  root,
  lab,
  s,
  c,
  dir,
  docker,
  owned,
  labels,
  sql,
  tables,
  healthy,
} from "./followthrough-lib.mjs";
const output = fs.mkdtempSync(path.join(dir, "upgrade-")),
  priv = path.join(s.dir, "upgrade-" + randomBytes(4).toString("hex"));
fs.mkdirSync(priv);
// Compare every column that exists before this upgrade, including earlier additions.
const columns = Object.fromEntries(
  tables.map((t) => [
    t,
    sql(
      c.database,
      `select string_agg(quote_ident(attname),',' order by attnum) from pg_attribute where attrelid='${t}'::regclass and attnum>0 and not attisdropped`,
    ),
  ]),
);
const snap = (db) =>
  Object.fromEntries(
    tables.map((t) => [
      t,
      sql(
        db,
        `select count(*)||'|'||md5(coalesce(string_agg(row_to_json(x)::text,E'\\n' order by row_to_json(x)::text),'')) from (select ${columns[t]} from ${t}) x`,
      ),
    ]),
  );
const migrate = (configFile) =>
  docker([
    "run",
    "--rm",
    ...labels,
    "--network",
    s.network,
    "--cpus",
    ".625",
    "--memory",
    "512m",
    "--cap-drop",
    "ALL",
    "--security-opt",
    "no-new-privileges",
    "--mount",
    `type=bind,src=${configFile},dst=/run/lab/config.json,readonly`,
    "--mount",
    `type=bind,src=${path.join(s.dir, "migrator")},dst=/run/lab/migrator,readonly`,
    s.image,
    "node",
    "dist/server/upgrade.js",
  ]);
const result = { checks: [], sourceRun: s.runId };
let error,
  removed = false;
try {
  docker(["build", "--tag", s.image, "."], undefined, 900000);
  owned(s.containers.app);
  docker(["stop", "--time", "15", s.containers.app]);
  if (!process.argv.includes("--code-only")) {
    const before = snap(c.database),
      dump = docker(
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
        Buffer.alloc(0),
      );
    fs.writeFileSync(path.join(priv, "pre-upgrade.dump"), dump);
    const target = "lab_" + randomBytes(4).toString("hex"),
      labId = randomUUID(),
      runId =
        "hddpaylab-" +
        labId.replaceAll("-", "").slice(0, 12) +
        "-" +
        randomBytes(4).toString("hex");
    assert.equal(
      sql(
        c.database,
        `select count(*) from pg_database where datname='${target}'`,
      ),
      "0",
    );
    sql(c.database, `CREATE DATABASE ${target} OWNER lab_migrator`);
    sql(
      target,
      `REVOKE CONNECT ON DATABASE ${target} FROM PUBLIC; GRANT CONNECT ON DATABASE ${target} TO lab_runtime,lab_provider,lab_migrator; CREATE SCHEMA boundary; CREATE TABLE boundary.identity(lab_id text primary key,run_id text); INSERT INTO boundary.identity VALUES('${labId}','${runId}'); GRANT USAGE ON SCHEMA boundary TO lab_runtime,lab_provider,lab_migrator; GRANT SELECT ON boundary.identity TO lab_runtime,lab_provider,lab_migrator;`,
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
      dump,
    );
    const configFile = path.join(priv, "config.json");
    fs.writeFileSync(
      configFile,
      JSON.stringify({ ...c, database: target, labId, runId }),
    );
    assert.deepEqual(snap(target), before);
    migrate(configFile);
    assert.deepEqual(snap(target), before);
    migrate(configFile);
    assert.deepEqual(snap(target), before);
    result.checks.push({
      name: "populated lab copy additive upgrade and repeat",
      result: "PASS",
      tables: tables.length,
      comparedColumns: columns,
      rows: Object.fromEntries(
        Object.entries(before).map(([k, v]) => [k, +v.split("|")[0]]),
      ),
      target,
    });
    migrate(path.join(s.dir, "config.json"));
    assert.deepEqual(snap(c.database), before);
    result.checks.push({
      name: "source lab upgrade preserves previous columns",
      result: "PASS",
    });
  }
  fs.writeFileSync(path.join(s.dir, "proxy.stop"), "stop");
  await new Promise((r) => setTimeout(r, 1000));
  owned(s.containers.app);
  docker(["rm", s.containers.app]);
  removed = true;
  const id = docker([
    "run",
    "-d",
    "--name",
    s.runId + "-app",
    ...labels,
    "--network",
    s.network,
    "--network-alias",
    "app",
    "--cpus",
    ".5",
    "--memory",
    "512m",
    "--pids-limit",
    "192",
    "--security-opt",
    "no-new-privileges",
    "--cap-drop",
    "ALL",
    "--read-only",
    "--tmpfs",
    "/tmp:size=64m",
    "--mount",
    `type=bind,src=${path.join(s.dir, "config.json")},dst=/run/lab/config.json,readonly`,
    s.image,
  ]).trim();
  s.containers.app = id;
  fs.writeFileSync(".local/current.json", JSON.stringify(s, null, 2));
  fs.unlinkSync(path.join(s.dir, "proxy.stop"));
  const proxy = spawn(
    process.execPath,
    ["tools/loopback-proxy.mjs", path.join(root, ".local/current.json")],
    { cwd: root, detached: true, stdio: "ignore", windowsHide: true },
  );
  proxy.unref();
  await healthy(c.origin);
  result.checks.push({ name: "updated owned app healthy", result: "PASS" });
} catch (e) {
  error = e;
  result.error = e.message;
} finally {
  if (error && !removed)
    try {
      owned(s.containers.app);
      docker(["start", s.containers.app]);
    } catch (e) {
      error = new AggregateError([error, e], "UPGRADE_AND_RESTART_FAILED");
    }
  fs.writeFileSync(
    path.join(output, "upgrade.json"),
    JSON.stringify(result, null, 2),
  );
}
console.log(JSON.stringify(result));
if (error) throw error;
