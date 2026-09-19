import { fileURLToPath } from 'node:url';
import { createApp } from './app.ts';
import { developmentConfig } from './config.ts';

const config = developmentConfig(process.env);
const app = createApp(
  import.meta.url.endsWith('.js')
    ? { webRoot: fileURLToPath(new URL('../web/', import.meta.url)) }
    : {},
);
await app.listen(config);
const address = app.server.address();
console.log(
  JSON.stringify({
    event: 'listening',
    mode: 'development',
    host: config.host,
    port: typeof address === 'object' && address ? address.port : null,
  }),
);
for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.once(signal, () => {
    const deadline = setTimeout(() => process.exit(1), 5_000).unref();
    void app.close().then(
      () => {
        clearTimeout(deadline);
      },
      () => process.exit(1),
    );
  });
}
