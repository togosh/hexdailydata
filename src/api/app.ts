import Fastify from 'fastify';
import fastifyStatic from '@fastify/static';
import { z } from 'zod';
import { ApiErrorSchema, ChainKeySchema, StatusResponseSchema } from '../contracts/api.ts';

export function createApp(options: { webRoot?: string } = {}) {
  const app = Fastify({ logger: false, requestTimeout: 5_000, bodyLimit: 16_384 });
  const errorBody = (requestId: string, code: string, message: string, retryable = false) =>
    ApiErrorSchema.parse({ error: { code, message, retryable }, requestId });

  app.addHook('onRequest', async (request, reply) => {
    reply.header('Cache-Control', 'no-store').header('X-Content-Type-Options', 'nosniff');
    if (!['GET', 'HEAD'].includes(request.method)) {
      return reply
        .code(405)
        .header('Allow', 'GET, HEAD')
        .send(errorBody(request.id, 'read_only', 'Only read requests are supported.'));
    }
  });
  app.setErrorHandler((error, request, reply) => {
    const errorStatus =
      error instanceof Error && 'statusCode' in error ? error.statusCode : undefined;
    const status =
      typeof errorStatus === 'number' && errorStatus >= 400 && errorStatus < 500
        ? errorStatus
        : 500;
    reply
      .code(status)
      .send(
        errorBody(
          request.id,
          status === 500 ? 'internal_error' : 'invalid_request',
          status === 500 ? 'Request could not be completed.' : 'Invalid request.',
        ),
      );
  });
  app.setNotFoundHandler((request, reply) => {
    reply.code(404).send(errorBody(request.id, 'not_found', 'Route not found.'));
  });
  app.get('/health/live', async () => ({ status: 'live', mode: 'development' }));
  app.get('/health/ready', async (request, reply) =>
    reply
      .code(503)
      .send(
        errorBody(
          request.id,
          'not_initialized',
          'Data dependencies and schema are not initialized.',
        ),
      ),
  );
  app.get('/api/v2/status', async () =>
    StatusResponseSchema.parse({
      mode: 'development',
      chain: 'pulsechain',
      state: 'uninitialized',
      productionReady: false,
      chainSyncImplemented: false,
      liveProvidersEnabled: false,
    }),
  );
  app.get('/api/v2/home', async (request, reply) => {
    const query = z
      .strictObject({ chain: ChainKeySchema.default('pulsechain') })
      .safeParse(request.query);
    if (!query.success)
      return reply.code(400).send(errorBody(request.id, 'invalid_query', 'Invalid chain query.'));
    return reply
      .code(503)
      .send(errorBody(request.id, 'not_implemented', 'Home data is not implemented yet.'));
  });
  if (options.webRoot) {
    app.register(fastifyStatic, { root: options.webRoot, index: ['index.html'], dotfiles: 'deny' });
  }
  return app;
}
