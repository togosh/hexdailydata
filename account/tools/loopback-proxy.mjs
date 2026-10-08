// Control-plane loopback transport. Runtime keeps a gateway-free isolated network.
// Docker exec carries bytes over stdio; no socket or host gateway enters a container.
import fs from "node:fs";
import net from "node:net";
import path from "node:path";
import { spawn, spawnSync } from "node:child_process";
const stateFile = process.argv[2],
  s = JSON.parse(fs.readFileSync(stateFile));
const r = spawnSync("docker", ["inspect", s.containers.app], {
  encoding: "utf8",
  windowsHide: true,
});
if (r.status !== 0) throw Error("NO_OWNED_APP");
const app = JSON.parse(r.stdout)[0];
if (
  app.Config.Labels["hdd.run"] !== s.runId ||
  app.Config.Labels["hdd.lab"] !== s.labId
)
  throw Error("WRONG_PROXY_TARGET");
const servers = [],
  children = new Set();
for (const [origin, host, port] of [
  [s.origin, "127.0.0.1", 3000],
  [s.inboxOrigin, "inbox", 8025],
]) {
  const server = net.createServer((socket) => {
    const code = `const s=require('net').connect(${port},'${host}');process.stdin.pipe(s);s.pipe(process.stdout);s.on('error',()=>process.exit(1));s.on('close',()=>process.exit(0));process.stdin.on('end',()=>s.end());`;
    const child = spawn(
      "docker",
      ["exec", "-i", s.containers.app, "node", "-e", code],
      { stdio: ["pipe", "pipe", "ignore"], windowsHide: true },
    );
    children.add(child);
    socket.pipe(child.stdin);
    child.stdout.pipe(socket);
    child.stdin.on("error", () => socket.destroy());
    child.on("exit", () => {
      children.delete(child);
      socket.destroy();
    });
    socket.on("error", () => child.kill());
    socket.on("close", () => child.kill());
  });
  await new Promise((resolve, reject) => {
    server.on("error", reject);
    server.listen(Number(new URL(origin).port), "127.0.0.1", resolve);
  });
  servers.push(server);
}
fs.writeFileSync(path.join(s.dir, "proxy.ready"), "ready");
setInterval(() => {
  if (fs.existsSync(path.join(s.dir, "proxy.stop"))) {
    for (const server of servers) server.close();
    for (const child of children) child.kill();
    process.exit(0);
  }
}, 500);
