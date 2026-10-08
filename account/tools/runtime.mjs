import fs from "node:fs";
import path from "node:path";
import net from "node:net";
import { spawnSync, spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { rootCheck, readState } from "./lab.mjs";
const root = rootCheck(process.cwd()),
  lab = readState(root),
  images = JSON.parse(fs.readFileSync("config/images.json"));
const statePath = path.join(root, ".local/current.json"),
  cmd = process.argv[2];
const evidenceDir = path.resolve(
  root,
  process.env.LAB_EVIDENCE_DIR || "evidence",
);
if (
  !evidenceDir.startsWith(path.join(root, "evidence") + path.sep) &&
  evidenceDir !== path.join(root, "evidence")
)
  throw Error("WRONG_EVIDENCE_DIRECTORY");
const secret = () => randomBytes(32).toString("hex");
export function docker(args, input, timeout = 120000) {
  const r = spawnSync("docker", args, {
    input,
    encoding: "utf8",
    timeout,
    maxBuffer: 16 * 1024 * 1024,
  });
  if (r.status !== 0)
    throw Error(
      `docker ${args[0]} failed: ${r.stderr?.slice(-1500) || r.error?.message}`,
    );
  return r.stdout.trim();
}
const inspect = (type, id) => JSON.parse(docker([type, "inspect", id]))[0];
function owned(type, id, s) {
  const r = inspect(type, id);
  const labels = type === "container" ? r.Config.Labels : r.Labels;
  if (labels?.["hdd.lab"] !== lab.labId || labels?.["hdd.run"] !== s.runId)
    throw Error("RESOURCE_OWNERSHIP_REFUSED");
  return r;
}
function save(s) {
  fs.writeFileSync(statePath, JSON.stringify(s, null, 2));
}
function labels(s) {
  return [
    "--label",
    "hdd.lab=" + lab.labId,
    "--label",
    "hdd.run=" + s.runId,
    "--label",
    "hdd.purpose=paid-api-lab",
  ];
}
function checkedState() {
  const s = JSON.parse(fs.readFileSync(statePath));
  if (s.labId !== lab.labId || !s.runId.startsWith(lab.projectPrefix + "-"))
    throw Error("WRONG_RUN");
  if (
    path.dirname(path.resolve(s.dir)) !== path.join(root, ".local", "runs") ||
    !/^[a-f0-9]{8}$/.test(path.basename(s.dir)) ||
    fs.lstatSync(s.dir).isSymbolicLink()
  )
    throw Error("WRONG_RUN_DIRECTORY");
  return s;
}
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
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
function run(s, name, cpu, mem, args) {
  const id = docker([
    "run",
    "-d",
    "--name",
    s.runId + "-" + name,
    ...labels(s),
    "--cpus",
    String(cpu),
    "--memory",
    mem,
    "--pids-limit",
    "192",
    "--security-opt",
    "no-new-privileges",
    ...args,
  ]);
  s.containers[name] = id;
  save(s);
  return id;
}
function configMount(s) {
  return [
    "--mount",
    `type=bind,src=${path.join(s.dir, "config.json")},dst=/run/lab/config.json,readonly`,
  ];
}
function cleanup(s) {
  fs.writeFileSync(path.join(s.dir, "proxy.stop"), "stop");
  for (const [name, id] of Object.entries(s.containers)) {
    owned("container", id, s);
    docker(["rm", "-f", id]);
    delete s.containers[name];
    save(s);
  }
  for (const id of s.networks) {
    owned("network", id, s);
    docker(["network", "rm", id]);
  }
  s.networks = [];
  s.stopped = true;
  save(s);
}
async function start() {
  if (fs.existsSync(statePath)) {
    const old = checkedState();
    if (!old.stopped)
      throw Error("EXISTING_LAB_RUN: stop it with lab:stop first");
  }
  const suffix = randomBytes(4).toString("hex"),
    s = {
      labId: lab.labId,
      runId: lab.projectPrefix + "-" + suffix,
      dir: path.join(root, ".local", "runs", suffix),
      containers: {},
      networks: [],
      stopped: false,
    };
  fs.mkdirSync(path.dirname(s.dir), { recursive: true });
  fs.mkdirSync(s.dir); // Refuse a colliding run directory, even one with a plausible name.
  save(s);
  const image = s.runId + ":app";
  console.log(
    "Building lab image (installation/build overhead outside runtime cap)",
  );
  docker(["build", "--tag", image, "."], undefined, 900000);
  s.image = image;
  save(s);
  const network = docker([
    "network",
    "create",
    "--internal",
    "--opt",
    "com.docker.network.bridge.gateway_mode_ipv4=isolated",
    ...labels(s),
    s.runId,
  ]);
  s.network = network;
  s.networks.push(network);
  save(s);
  const volume = docker(["volume", "create", ...labels(s), s.runId + "-db"]);
  owned("volume", volume, s);
  s.volume = volume;
  save(s);
  const dbname = "lab_" + suffix,
    boot = secret(),
    runtime = secret(),
    provider = secret(),
    migrator = secret();
  fs.writeFileSync(path.join(s.dir, "bootstrap"), boot);
  fs.writeFileSync(path.join(s.dir, "migrator"), migrator);
  const init = `CREATE SCHEMA boundary; CREATE TABLE boundary.identity(lab_id text PRIMARY KEY,run_id text NOT NULL); INSERT INTO boundary.identity VALUES('${lab.labId}','${s.runId}'); REVOKE ALL ON SCHEMA public FROM PUBLIC; REVOKE CONNECT ON DATABASE ${dbname} FROM PUBLIC; CREATE ROLE lab_runtime LOGIN PASSWORD '${runtime}'; CREATE ROLE lab_provider LOGIN PASSWORD '${provider}'; CREATE ROLE lab_migrator LOGIN PASSWORD '${migrator}'; GRANT CONNECT ON DATABASE ${dbname} TO lab_runtime,lab_provider,lab_migrator; GRANT USAGE ON SCHEMA boundary TO lab_runtime,lab_provider,lab_migrator; GRANT SELECT ON boundary.identity TO lab_runtime,lab_provider,lab_migrator; GRANT ALL ON SCHEMA public TO lab_migrator; GRANT USAGE ON SCHEMA public TO lab_runtime; CREATE SCHEMA fake_provider AUTHORIZATION lab_migrator; GRANT USAGE ON SCHEMA fake_provider TO lab_provider,lab_runtime;`;
  fs.writeFileSync(path.join(s.dir, "init.sql"), init);
  const db = run(s, "db", 0.75, "768m", [
    "--network",
    network,
    "--network-alias",
    "db",
    "--mount",
    `type=volume,src=${volume},dst=/var/lib/postgresql/data`,
    "--mount",
    `type=bind,src=${path.join(s.dir, "init.sql")},dst=/docker-entrypoint-initdb.d/01.sql,readonly`,
    "--mount",
    `type=bind,src=${path.join(s.dir, "bootstrap")},dst=/run/secrets/bootstrap,readonly`,
    "-e",
    "POSTGRES_PASSWORD_FILE=/run/secrets/bootstrap",
    "-e",
    "POSTGRES_USER=lab_bootstrap",
    "-e",
    "POSTGRES_DB=" + dbname,
    images.postgres,
  ]);
  const appPort = await port(),
    inboxPort = await port();
  if (appPort === 4320 || inboxPort === 4320 || appPort === inboxPort)
    throw Error("PORT_COLLISION_RETRY");
  const inbox = run(s, "inbox", 0.125, "128m", [
    "--network",
    network,
    "--network-alias",
    "inbox",
    "--cap-drop",
    "ALL",
    "-e",
    "MP_MAX_MESSAGES=100",
    "-e",
    "MP_DISABLE_VERSION_CHECK=true",
    "-e",
    "MP_SMTP_AUTH_ACCEPT_ANY=false",
    images.inbox,
  ]);
  const addr = Object.values(
    inspect("container", db).NetworkSettings.Networks,
  )[0].IPAddress;
  const c = {
    mode: "isolated-lab",
    labId: lab.labId,
    runId: s.runId,
    database: dbname,
    dbHost: "db",
    dbAddress: addr,
    dbPassword: runtime,
    providerPassword: provider,
    secret: secret(),
    eventSecret: secret(),
    origin: "http://127.0.0.1:" + appPort,
    inboxOrigin: "http://127.0.0.1:" + inboxPort,
    annualDemo: false,
  };
  fs.writeFileSync(path.join(s.dir, "config.json"), JSON.stringify(c));
  s.origin = c.origin;
  s.inboxOrigin = c.inboxOrigin;
  save(s);
  // A task-owned target on a different network supplies a real denial witness.
  const dummyNet = docker([
    "network",
    "create",
    ...labels(s),
    s.runId + "-dummy",
  ]);
  s.networks.push(dummyNet);
  save(s);
  const dummy = run(s, "dummy", 0.125, "64m", [
    "--network",
    dummyNet,
    "--cap-drop",
    "ALL",
    images.node,
    "node",
    "-e",
    "require('http').createServer((q,r)=>r.end('dummy')).listen(8080,'0.0.0.0')",
  ]);
  const target = Object.values(
    inspect("container", dummy).NetworkSettings.Networks,
  )[0];
  const probeCode = `const net=require('net'),fs=require('fs');const denied=(host)=>new Promise((resolve,reject)=>{const s=net.connect({host,port:8080});s.setTimeout(1200);s.on('connect',()=>{s.destroy();reject(Error('EGRESS_AVAILABLE'))});s.on('error',()=>resolve());s.on('timeout',()=>{s.destroy();resolve()})});(async()=>{await denied('${target.IPAddress}');await denied('${target.Gateway}');const routes=fs.readFileSync('/proc/net/route','utf8');if(routes.split('\\n').slice(1).some(x=>x.split(/\\s+/)[1]==='00000000'))throw Error('DEFAULT_ROUTE_PRESENT');console.log('EGRESS_AND_HOST_GATEWAY_DENIED')})().catch(e=>{console.error(e.message);process.exit(1)})`;
  const evidence = {
    runId: s.runId,
    network: inspect("network", network),
    probes: [],
    resources: [],
    at: new Date().toISOString(),
  };
  for (const ns of [network, "container:" + inbox]) {
    const out = docker([
      "run",
      "--rm",
      ...labels(s),
      "--network",
      ns,
      "--cpus",
      ".5",
      "--memory",
      "128m",
      "--cap-drop",
      "ALL",
      "--security-opt",
      "no-new-privileges",
      images.node,
      "node",
      "-e",
      probeCode,
    ]);
    evidence.probes.push({ namespace: ns, result: out });
  }
  owned("container", dummy, s);
  docker(["rm", "-f", dummy]);
  delete s.containers.dummy;
  owned("network", dummyNet, s);
  docker(["network", "rm", dummyNet]);
  s.networks = s.networks.filter((x) => x !== dummyNet);
  save(s);
  for (let n = 0; n < 40; n++) {
    try {
      docker(["exec", db, "pg_isready", "-U", "lab_bootstrap", "-d", dbname]);
      break;
    } catch {
      await sleep(500);
    }
  }
  console.log("Runtime egress guards passed; migrating fresh owned database");
  console.log(
    docker([
      "run",
      "--rm",
      ...labels(s),
      "--network",
      network,
      "--cpus",
      ".5",
      "--memory",
      "512m",
      "--cap-drop",
      "ALL",
      ...configMount(s),
      "--mount",
      `type=bind,src=${path.join(s.dir, "migrator")},dst=/run/lab/migrator,readonly`,
      image,
      "node",
      "dist/server/migrate.js",
    ]),
  );
  const app = run(s, "app", 0.5, "512m", [
    "--network",
    network,
    "--network-alias",
    "app",
    "--cap-drop",
    "ALL",
    "--read-only",
    "--tmpfs",
    "/tmp:size=64m",
    ...configMount(s),
    image,
  ]);
  for (const [name, id] of Object.entries(s.containers)) {
    const r = owned("container", id, s);
    evidence.resources.push({
      name,
      cpu: r.HostConfig.NanoCpus,
      memory: r.HostConfig.Memory,
      privileged: r.HostConfig.Privileged,
      capDrop: r.HostConfig.CapDrop,
      ports: r.HostConfig.PortBindings,
      networks: Object.keys(r.NetworkSettings.Networks),
      mounts: r.Mounts.map((m) => ({
        type: m.Type,
        destination: m.Destination,
        rw: m.RW,
      })),
    });
  }
  fs.mkdirSync(evidenceDir, { recursive: true });
  fs.writeFileSync(
    path.join(evidenceDir, "isolation.json"),
    JSON.stringify(evidence, null, 2),
  );
  const proxy = spawn(
    process.execPath,
    ["tools/loopback-proxy.mjs", statePath],
    { cwd: root, detached: true, stdio: "ignore", windowsHide: true },
  );
  proxy.unref();
  for (let n = 0; n < 60; n++) {
    try {
      const r = await fetch(c.origin + "/health");
      if (r.ok) {
        console.log(
          JSON.stringify({
            status: "LAB_READY",
            runId: s.runId,
            app: c.origin,
            inbox: c.inboxOrigin,
          }),
        );
        return;
      }
    } catch {}
    await sleep(500);
  }
  console.log(docker(["logs", app]));
  throw Error("APP_START_FAILED");
}
try {
  if (cmd === "start") await start();
  else if (cmd === "stop") {
    const s = checkedState();
    cleanup(s);
    console.log(
      "OWNED_LAB_CONTAINERS_AND_NETWORKS_REMOVED; private DB volume retained",
    );
  } else if (cmd === "test") {
    const s = checkedState();
    for (const id of Object.values(s.containers)) owned("container", id, s);
    if (s.containers.runner) throw Error("LAB_TEST_ALREADY_RUNNING");
    const suite = process.argv[3] || "integration";
    if (!["integration", "controls"].includes(suite))
      throw Error("UNKNOWN_SUITE");
    const runner = run(s, "runner", 0.625, "640m", [
      "--network",
      s.network,
      "--cap-drop",
      "ALL",
      ...configMount(s),
      "--mount",
      `type=bind,src=${evidenceDir},dst=/lab/evidence`,
      "--mount",
      `type=bind,src=${path.join(root, "tests", suite + ".mjs")},dst=/lab/tests/${suite}.mjs,readonly`,
      s.image,
      "node",
      `tests/${suite}.mjs`,
    ]);
    const info = owned("container", runner, s);
    fs.writeFileSync(
      path.join(evidenceDir, "runner.json"),
      JSON.stringify(
        {
          runId: s.runId,
          cpu: info.HostConfig.NanoCpus,
          memory: info.HostConfig.Memory,
          pids: info.HostConfig.PidsLimit,
          image: info.Image,
          networks: Object.keys(info.NetworkSettings.Networks),
        },
        null,
        2,
      ),
    );
    const status = docker(["wait", runner], undefined, 600000);
    console.log(docker(["logs", runner]));
    owned("container", runner, s);
    docker(["rm", runner]);
    delete s.containers.runner;
    save(s);
    if (status !== "0") throw Error("INTEGRATION_FAILED_EXIT_" + status);
  } else throw Error("Use start | test | stop");
} catch (e) {
  console.error(e.message);
  process.exitCode = 1;
}
