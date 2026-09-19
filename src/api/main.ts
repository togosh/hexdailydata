import { fileURLToPath } from 'node:url';
import { createApp } from './app.ts';
import { developmentConfig } from './config.ts';
import { openDependencies } from './dependencies.ts';

try {
  const config = developmentConfig(process.env);
  const dependencies = await openDependencies(process.env);
  const app = createApp(
    import.meta.url.endsWith('.js')
      ? {
          webRoot: fileURLToPath(new URL('../web/', import.meta.url)),
          dependencies,
          mode: config.mode,
        }
      : { dependencies, mode: config.mode },
  );
  try {
    await app.listen(config);
  } catch {
    await app.close();
    throw new Error('Listen failed.');
  }
  const address = app.server.address();
  console.log(
    JSON.stringify({
      event: 'listening',
      mode: config.mode,
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
} catch {
  console.error(
    JSON.stringify({ event: 'startup_failed', code: 'configuration_or_dependency_unavailable' }),
  );
  process.exitCode = 1;
}
