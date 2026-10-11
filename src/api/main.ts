import { startEntry } from './entry.ts';
try {
  const { app, config } = await startEntry();
  const address = app.server.address();
  console.log(
    JSON.stringify({
      event: 'listening',
      mode: config.mode,
      serving: process.env.HDD_V2_API_MODE ?? 'product',
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
          console.log(JSON.stringify({ event: 'closed' }));
        },
        () => process.exit(1),
      );
    });
  }
} catch {
  console.error(
    JSON.stringify({
      event: 'startup_failed',
      code: 'explicit_mode_profile_or_dependency_unavailable',
    }),
  );
  process.exitCode = 1;
}
