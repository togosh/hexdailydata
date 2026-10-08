// A second runtime targets a new restored DB; source config is never repointed.
import fs from "node:fs";
import path from "node:path";
import net from "node:net";
import { spawn } from "node:child_process";
import { randomBytes, randomUUID } from "node:crypto";
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
  snapshot,
  tables,
  runner,
  healthy,
} from "./followthrough-lib.mjs";
const output = fs.mkdtempSync(path.join(dir, "recovery-"));
console.log("RECOVERY_EVIDENCE " + output);
const privateDir = path.join(
  s.dir,
  "restore-" + randomBytes(4).toString("hex"),
);
fs.mkdirSync(privateDir);
const fixtureMount = [
  "--mount",
  `type=bind,src=${privateDir},dst=/run/fixture`,
];
const result = {
  sourceRun: s.runId,
  checks: [],
  limitations: [
    "One owned PostgreSQL instance; independent fake-provider schema is synthetic",
    "Auth secret retained privately; outstanding mailed URLs retain original origin; request fresh links at restored origin",
  ],
};
let targetId,
  proxyDir,
  before,
  originalError,
  forcedFailure = false;
const note = (name, detail) => {
  result.checks.push({ name, result: "PASS", detail });
};
async function port() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.on("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const p = server.address().port;
      server.close(() => resolve(p));
    });
  });
}
try {
  runner(
    "tests/restored.mjs",
    ["prepare"],
    path.join(s.dir, "config.json"),
    fixtureMount,
    output,
  );
  owned(s.containers.app);
  docker(["stop", "--time", "15", s.containers.app]);
  runner(
    "tests/restored.mjs",
    ["seed"],
    path.join(s.dir, "config.json"),
    fixtureMount,
    output,
  );
  before = snapshot(c.database);
  const dump = docker(
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
  fs.writeFileSync(path.join(privateDir, "database.dump"), dump);
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
    `REVOKE CONNECT ON DATABASE ${target} FROM PUBLIC; GRANT CONNECT ON DATABASE ${target} TO lab_runtime,lab_provider,lab_migrator; CREATE SCHEMA boundary; CREATE TABLE boundary.identity(lab_id text PRIMARY KEY,run_id text NOT NULL); INSERT INTO boundary.identity VALUES('${labId}','${runId}'); GRANT USAGE ON SCHEMA boundary TO lab_runtime,lab_provider,lab_migrator; GRANT SELECT ON boundary.identity TO lab_runtime,lab_provider,lab_migrator;`,
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
  assert.deepEqual(snapshot(target), before);
  note(
    "all security and billing rows restored including burst_bucket and used_link",
    {
      tables: tables.length,
      rows: Object.fromEntries(
        Object.entries(before).map(([k, v]) => [k, Number(v.split("|")[0])]),
      ),
      dumpBytes: dump.length,
    },
  );
  const origin = "http://127.0.0.1:" + (await port()),
    inboxOrigin = "http://127.0.0.1:" + (await port());
  assert.notEqual(origin, c.origin);
  assert.notEqual(origin, inboxOrigin);
  assert.notEqual(new URL(origin).port, "4320");
  assert.notEqual(new URL(inboxOrigin).port, "4320");
  const configFile = path.join(privateDir, "config.json");
  fs.writeFileSync(
    configFile,
    JSON.stringify({
      ...c,
      labId,
      runId,
      database: target,
      origin,
      inboxOrigin,
    }),
  );
  targetId = docker([
    "run",
    "-d",
    ...labels,
    "--label",
    "hdd.restored=" + runId,
    "--network",
    s.network,
    "--network-alias",
    "restored-app",
    "--cpus",
    ".5",
    "--memory",
    "512m",
    "--pids-limit",
    "192",
    "--cap-drop",
    "ALL",
    "--security-opt",
    "no-new-privileges",
    "--read-only",
    "--tmpfs",
    "/tmp:size=64m",
    "--mount",
    `type=bind,src=${configFile},dst=/run/lab/config.json,readonly`,
    s.image,
  ]).trim();
  const resource = owned(targetId);
  assert.equal(owned(s.containers.app).State.Running, false);
  assert.equal(resource.HostConfig.Privileged, false);
  assert.equal(Object.keys(resource.NetworkSettings.Networks).length, 1);
  assert.deepEqual(resource.HostConfig.PortBindings, {});
  proxyDir = path.join(privateDir, "proxy");
  fs.mkdirSync(proxyDir);
  const proxyState = path.join(proxyDir, "state.json");
  fs.writeFileSync(
    proxyState,
    JSON.stringify({
      ...s,
      dir: proxyDir,
      origin,
      inboxOrigin,
      containers: { app: targetId },
    }),
  );
  const proxy = spawn(
    process.execPath,
    ["tools/loopback-proxy.mjs", proxyState],
    { cwd: root, detached: true, stdio: "ignore", windowsHide: true },
  );
  proxy.unref();
  assert.equal((await healthy(origin)).runId, runId);
  note("restored runtime actual resource/health inspection", {
    runId,
    database: target,
    sourceStopped: true,
    cpu: resource.HostConfig.NanoCpus,
    memory: resource.HostConfig.Memory,
    privateNetwork: s.network,
    origin,
  });
  runner(
    "tests/restored.mjs",
    ["journey"],
    configFile,
    [...fixtureMount, "-e", "LAB_APP_ALIAS=restored-app"],
    output,
  );
  assert.deepEqual(snapshot(c.database), before);
  note(
    "source tables unchanged while restored runtime used",
    `${tables.length}-table equality while original app stopped`,
  );
  try {
    runner(
      "tests/restored.mjs",
      ["forced-failure"],
      configFile,
      [...fixtureMount, "-e", "LAB_APP_ALIAS=restored-app"],
      output,
    );
  } catch (e) {
    if (e.message !== "TEST_FAILED_EXIT_73") throw e;
    forcedFailure = true;
  }
  assert.equal(forcedFailure, true);
} catch (e) {
  originalError = e;
  result.error = e.message;
} finally {
  const cleanupErrors = [];
  if (proxyDir)
    try {
      fs.writeFileSync(path.join(proxyDir, "proxy.stop"), "stop");
    } catch (e) {
      cleanupErrors.push(e);
    }
  if (targetId)
    try {
      owned(targetId);
      docker(["rm", "-f", targetId]);
    } catch (e) {
      cleanupErrors.push(e);
    }
  try {
    if (before) assert.deepEqual(snapshot(c.database), before);
    owned(s.containers.app);
    docker(["start", s.containers.app]);
    assert.equal((await healthy(c.origin)).runId, s.runId);
    note("source configuration restored after target test termination", {
      forcedTestExit: forcedFailure ? 73 : null,
      sourceHealthy: true,
      targetRemoved: !!targetId && !cleanupErrors.length,
      privateDumpAndDatabase: "retained in owned lab storage",
    });
  } catch (e) {
    cleanupErrors.push(e);
  }
  if (cleanupErrors.length)
    result.cleanupErrors = cleanupErrors.map((e) => e.message);
  fs.writeFileSync(
    path.join(output, "recovery.json"),
    JSON.stringify(result, null, 2),
  );
  if (originalError || cleanupErrors.length)
    throw new AggregateError(
      [originalError, ...cleanupErrors].filter(Boolean),
      "RESTORED_JOURNEY_FAILED",
    );
}
console.log(JSON.stringify(result, null, 2));
