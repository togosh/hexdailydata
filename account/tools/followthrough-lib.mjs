import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { rootCheck, readState } from "./lab.mjs";
export const root = rootCheck(process.cwd()),
  lab = readState(root),
  s = JSON.parse(fs.readFileSync(".local/current.json"));
if (
  s.labId !== lab.labId ||
  s.stopped ||
  path.dirname(path.resolve(s.dir)) !== path.join(root, ".local", "runs")
)
  throw Error("WRONG_RUN");
export const c = JSON.parse(fs.readFileSync(path.join(s.dir, "config.json")));
export const dir = path.resolve(
  root,
  process.env.LAB_EVIDENCE_DIR || "evidence/followthrough",
);
if (!dir.startsWith(path.join(root, "evidence") + path.sep))
  throw Error("WRONG_EVIDENCE_DIRECTORY");
fs.mkdirSync(dir, { recursive: true });
export function docker(args, input, timeout = 60000) {
  const r = spawnSync("docker", args, {
    input,
    encoding: input instanceof Buffer ? undefined : "utf8",
    timeout,
    maxBuffer: 32 * 1024 * 1024,
    windowsHide: true,
  });
  if (r.status !== 0)
    throw Error(
      "LAB_COMMAND_FAILED " + args[0] + " " + String(r.stderr).slice(-500),
    );
  return args[0] === "logs" ? r.stdout + r.stderr : r.stdout;
}
export function owned(id) {
  const r = JSON.parse(docker(["inspect", id]))[0];
  if (
    r.Config.Labels?.["hdd.lab"] !== lab.labId ||
    r.Config.Labels?.["hdd.run"] !== s.runId
  )
    throw Error("NOT_OWNED");
  return r;
}
for (const id of Object.values(s.containers)) owned(id);
const n = JSON.parse(docker(["network", "inspect", s.network]))[0];
if (
  !n.Internal ||
  n.Options["com.docker.network.bridge.gateway_mode_ipv4"] !== "isolated" ||
  n.Labels["hdd.run"] !== s.runId
)
  throw Error("UNSAFE_NETWORK");
export const labels = [
  "--label",
  "hdd.lab=" + lab.labId,
  "--label",
  "hdd.run=" + s.runId,
  "--label",
  "hdd.purpose=paid-api-followthrough",
];
export const sql = (db, text) =>
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
export const tables = [
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
  "burst_bucket",
  "used_link",
  "outbox",
  "fake_provider.record",
];
if (
  sql(
    c.database,
    "select count(*) from pg_tables where schemaname='public' and tablename='reconcile_attempt'",
  ) === "1"
)
  tables.push("reconcile_attempt");
export const snapshot = (db) =>
  Object.fromEntries(
    tables.map((t) => [
      t,
      sql(
        db,
        `select count(*)||'|'||md5(coalesce(string_agg(row_to_json(x)::text,E'\\n' order by row_to_json(x)::text),'')) from ${t} x`,
      ),
    ]),
  );
export async function healthy(origin) {
  for (let i = 0; i < 50; i++) {
    try {
      const r = await fetch(origin + "/health", {
        signal: AbortSignal.timeout(2000),
      });
      if (r.ok) return await r.json();
    } catch {}
    await new Promise((r) => setTimeout(r, 200));
  }
  throw Error("APP_NOT_HEALTHY");
}
export function runner(
  script,
  args = [],
  configFile = path.join(s.dir, "config.json"),
  extra = [],
  folder = dir,
) {
  fs.mkdirSync(folder, { recursive: true });
  const id = docker([
    "create",
    ...labels,
    "--network",
    s.network,
    "--cpus",
    ".625",
    "--memory",
    "640m",
    "--pids-limit",
    "192",
    "--cap-drop",
    "ALL",
    "--security-opt",
    "no-new-privileges",
    "--mount",
    `type=bind,src=${configFile},dst=/run/lab/config.json,readonly`,
    "--mount",
    `type=bind,src=${path.join(root, "tests")},dst=/lab/tests,readonly`,
    "--mount",
    `type=bind,src=${folder},dst=/lab/evidence`,
    ...extra,
    s.image,
    "node",
    script,
    ...args,
  ]).trim();
  const errors = [];
  try {
    const r = owned(id);
    fs.writeFileSync(
      path.join(folder, "runner.json"),
      JSON.stringify(
        {
          cpu: r.HostConfig.NanoCpus,
          image: r.Image,
          command: ["node", script, ...args],
          at: new Date().toISOString(),
          memory: r.HostConfig.Memory,
          privileged: r.HostConfig.Privileged,
          networks: Object.keys(r.NetworkSettings.Networks),
          mounts: r.Mounts.map((x) => ({
            destination: x.Destination,
            rw: x.RW,
          })),
        },
        null,
        2,
      ),
    );
    docker(["start", id]);
    const status = docker(["wait", id], undefined, 600000).trim();
    if (status !== "0") errors.push(Error("TEST_FAILED_EXIT_" + status));
    const log = docker(["logs", id]);
    fs.writeFileSync(
      path.join(
        folder,
        path.basename(script) + "-" + (args[0] || "run") + ".log",
      ),
      log,
    );
    console.log(log.trim());
  } catch (e) {
    errors.push(e);
  }
  try {
    owned(id);
    docker(["rm", "-f", id]);
  } catch (e) {
    errors.push(e);
  }
  if (errors.length === 1) throw errors[0];
  if (errors.length > 1)
    throw new AggregateError(errors, "RUNNER_AND_CLEANUP_OR_LOG_FAILED");
}
