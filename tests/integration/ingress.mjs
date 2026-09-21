// Byte-only localhost test ingress. No external interface, provider or product work.
// Docker Desktop cannot publish an internal-only bridge to the Windows host.
import net from 'node:net';
import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';

function bridge(input, output, connect) {
  const sockets = new Map();
  const send = (message, done) => output.write(JSON.stringify(message) + '\n', done);
  function attach(id, socket) {
    sockets.set(id, socket);
    socket.on('data', (data) => {
      socket.pause();
      send({ id, data: data.toString('base64') });
    });
    socket.on('error', () => socket.destroy());
    socket.on('close', () => {
      sockets.delete(id);
      send({ id, close: true });
    });
  }
  const lines = createInterface({ input });
  lines.on('line', (line) => {
    const message = JSON.parse(line);
    if (message.open) attach(message.id, connect());
    const socket = sockets.get(message.id);
    if (!socket) return;
    if (message.close) socket.destroy();
    else if (message.ack) socket.resume();
    else if (message.data)
      socket.write(Buffer.from(message.data, 'base64'), () => send({ id: message.id, ack: true }));
  });
  return {
    attach,
    send,
    close() {
      lines.close();
      for (const s of sockets.values()) s.destroy();
    },
  };
}

export async function ingress(container, port) {
  const child = spawn(
    'docker',
    ['exec', '-i', container, 'node', '/app/tests/integration/ingress.mjs', '--container'],
    {
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true,
    },
  );
  let error = '';
  child.stderr.on('data', (b) => {
    error = (error + b).slice(-2000);
  });
  child.stdin.on('error', () => {});
  const mux = bridge(child.stdout, child.stdin);
  let id = 0;
  const server = net.createServer((socket) => {
    const key = ++id;
    mux.send({ id: key, open: true });
    mux.attach(key, socket);
  });
  await new Promise((yes, no) => {
    server.once('error', no);
    server.listen(port, '127.0.0.1', yes);
  });
  return async () => {
    mux.close();
    await new Promise((r) => server.close(r));
    child.stdin.end();
    if (child.exitCode === null) await new Promise((r) => child.once('close', r));
    return { kind: 'localhost byte relay over docker exec; no application external route', error };
  };
}
if (process.argv.includes('--container')) {
  const mux = bridge(process.stdin, process.stdout, () => net.connect(4320, '127.0.0.1'));
  process.stdin.on('end', () => {
    mux.close();
    process.exit(0);
  });
}
