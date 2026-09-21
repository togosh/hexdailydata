import { spawn } from 'node:child_process';
import net from 'node:net';

// The API watch process stays alive after a failed child start. Refuse fixed-port
// conflicts before launching either server so Vite cannot proxy to someone else's API.
for (const port of [4320, 4321]) {
  const probe = net.createServer();
  try {
    await new Promise((resolve, reject) => {
      probe.once('error', reject);
      probe.listen({ host: '127.0.0.1', port, exclusive: true }, resolve);
    });
  } catch (error) {
    console.error(`Development startup refused: localhost:${port} is unavailable (${error.code}).`);
    process.exitCode = 1;
    break;
  } finally {
    if (probe.listening) await new Promise((resolve) => probe.close(resolve));
  }
}
if (process.exitCode) process.exit(process.exitCode);

// Direct child processes keep Ctrl+C cleanup portable without a shell/process tree.
const children = [
  spawn(process.execPath, ['--watch', 'src/api/main.ts'], { stdio: 'inherit' }),
  spawn(process.execPath, ['node_modules/vite/bin/vite.js'], { stdio: 'inherit' }),
];
let stopping = false;
function stop(code = 0) {
  if (stopping) return;
  stopping = true;
  process.exitCode = code;
  for (const child of children) child.kill();
}
for (const child of children) {
  child.once('error', (error) => {
    console.error(error.message);
    stop(1);
  });
  child.once('exit', (code) => stop(code ?? 1));
}
process.once('SIGINT', () => stop());
process.once('SIGTERM', () => stop());
