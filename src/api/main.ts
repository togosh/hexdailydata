/** Safe scaffold. Task 01 supplies the app factory; task 06 supplies the data API. */
import { createServer } from 'node:http';

if (process.env.HDD_V2_MODE && process.env.HDD_V2_MODE !== 'scaffold') {
  console.error('This starter does not implement production/demo sync. Complete the build tasks.');
  process.exit(2);
}

const rawPort = process.env.HDD_V2_HTTP_PORT ?? '4320';
if (!/^\d{1,5}$/.test(rawPort) || Number(rawPort) > 65_535) {
  throw new Error('Invalid scaffold HTTP port.');
}
const host = process.env.HDD_V2_HTTP_HOST ?? '127.0.0.1';

const server = createServer((request, response) => {
  response.setHeader('Content-Type', 'application/json; charset=utf-8');
  response.setHeader('Cache-Control', 'no-store');
  response.setHeader('X-Content-Type-Options', 'nosniff');

  if (request.method !== 'GET') {
    response.writeHead(405, { Allow: 'GET' });
    response.end(JSON.stringify({ error: 'read_only_scaffold' }));
    return;
  }
  if (request.url === '/health/live') {
    response.end(JSON.stringify({ status: 'live', mode: 'scaffold' }));
    return;
  }
  if (request.url === '/health/ready') {
    response.writeHead(503);
    response.end(JSON.stringify({ status: 'not_ready', reason: 'scaffold_not_initialized' }));
    return;
  }
  if (request.url === '/api/v2/status') {
    response.end(JSON.stringify({
      mode: 'scaffold', productionReady: false, chainSyncImplemented: false,
    }));
    return;
  }
  response.writeHead(404);
  response.end(JSON.stringify({ error: 'not_implemented_in_scaffold' }));
});

server.requestTimeout = 5_000;
server.headersTimeout = 5_000;
server.listen(Number(rawPort), host, () => {
  const address = server.address();
  console.log(JSON.stringify({
    event: 'listening',
    mode: 'scaffold',
    host,
    port: typeof address === 'object' && address ? address.port : null,
  }));
});

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.once(signal, () => {
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(1), 5_000).unref();
  });
}
