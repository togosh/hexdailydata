import { fileURLToPath } from 'node:url';
import { createApp } from './app.ts';
import { developmentConfig } from './config.ts';
import { openDependencies } from './dependencies.ts';
import { sampleRoutes } from './samples.ts';

/** Ordinary read-only serving composition. No account or publication owner. */
export async function startEntry(env = process.env) {
  const config = developmentConfig(env);
  const dependencies = await openDependencies(env);
  let app: ReturnType<typeof createApp> | undefined;
  try {
    app = createApp({
      ...(import.meta.url.endsWith('.js')
        ? { webRoot: fileURLToPath(new URL('../web/', import.meta.url)) }
        : {}),
      dependencies,
      mode: config.mode,
      samples: sampleRoutes,
    });
    await app.listen(config);
    return { app, config };
  } catch (error) {
    if (app) await app.close();
    else await dependencies.close?.();
    throw error;
  }
}
