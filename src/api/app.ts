import Fastify from 'fastify';
import fastifyStatic from '@fastify/static';
import type { FastifyError, FastifyRequest, FastifyReply } from 'fastify';
import { createHash } from 'node:crypto';
import { ApiErrorSchema } from '../contracts/api.ts';
import { routes, jsonRevalidation } from './routes.ts';
import { ApiFailure, unavailable } from './errors.ts';
import { type ApiDependencies, sqlBaseline } from './dependencies.ts';
import { PageCursors } from '../services/queries/cursor.ts';
import { home, status, chainId } from '../services/queries/home.ts';
import { daily, markets, calculator } from '../services/queries/history.ts';
import { stakes, holders, indexedStake } from '../services/queries/lists.ts';
import { AddressSchema, StakeIdSchema } from '../contracts/reads.ts';

export function createApp(
  options: {
    webRoot?: string;
    mode?: 'development' | 'production';
    dependencies?: ApiDependencies;
    now?: () => number;
    admission?: { capacity: number; concurrent: number };
  } = {},
) {
  const app = Fastify({
    logger: false,
    requestTimeout: 15000,
    connectionTimeout: 15000,
    keepAliveTimeout: 5000,
    bodyLimit: 16384,
    routerOptions: { maxParamLength: 2048 },
    trustProxy: false,
    forceCloseConnections: true,
    frameworkErrors(error: FastifyError, request: FastifyRequest, reply: FastifyReply) {
      const invalid = ['FST_ERR_BAD_URL', 'FST_ERR_MAX_PARAM_LENGTH'].includes(error.code);
      reply
        .code(invalid ? 400 : 503)
        .header('Cache-Control', 'no-store')
        .header('X-Content-Type-Options', 'nosniff')
        .send(
          errorBody(
            request.id,
            invalid ? 'invalid_request' : 'source_unavailable',
            invalid ? 'Invalid request.' : 'Required data is unavailable.',
            !invalid,
          ),
        );
    },
  });
  const deps = options.dependencies ?? {},
    now = options.now ?? Date.now,
    cursors = new PageCursors();
  const contexts = new Map<
    string,
    { controller: AbortController; timer: NodeJS.Timeout; cleanup: () => void }
  >();
  const capacity = options.admission?.capacity ?? 1200,
    concurrent = options.admission?.concurrent ?? 64;
  let tokens = capacity,
    last = Date.now();
  const errorBody = (id: string, code: string, message: string, retryable = false) =>
    ApiErrorSchema.parse({ error: { code, message, retryable }, requestId: id });
  app.addHook('onRequest', async (request, reply) => {
    reply.header('Cache-Control', 'no-store').header('X-Content-Type-Options', 'nosniff');
    if (!['GET', 'HEAD'].includes(request.method))
      return reply
        .code(405)
        .header('Allow', 'GET, HEAD')
        .send(errorBody(request.id, 'read_only', 'Only read requests are supported.'));
    if (
      request.url.length > 4096 ||
      request.url
        .split('?')[0]!
        .split('/')
        .some((s) => s.length > 2048) ||
      Buffer.byteLength(JSON.stringify(request.headers)) > 8192
    )
      throw new ApiFailure(400, 'invalid_request', 'Request exceeds input bounds.');
    const time = Date.now();
    tokens = Math.min(capacity, tokens + ((time - last) * capacity) / 60000);
    last = time;
    if (tokens < 1 || contexts.size >= concurrent)
      throw new ApiFailure(429, 'http_quota', 'HTTP admission limit reached.');
    tokens--;
    const controller = new AbortController();
    const download = request.routeOptions.url === '/api/v2/downloads/:bundle/:dataset';
    const live =
      request.routeOptions.url?.includes('/addresses/') ||
      request.routeOptions.url === '/api/v2/stakes/:id';
    const timer = setTimeout(
      () => controller.abort(),
      download ? 120000 : live ? 10000 : 8000,
    ).unref();
    const aborted = () => controller.abort();
    const close = () => {
      if (!reply.raw.writableFinished) controller.abort();
    };
    request.raw.once('aborted', aborted);
    reply.raw.once('close', close);
    const cleanup = () => {
      clearTimeout(timer);
      request.raw.removeListener('aborted', aborted);
      reply.raw.removeListener('close', close);
      contexts.delete(request.id);
    };
    reply.raw.once('close', cleanup);
    contexts.set(request.id, { controller, timer, cleanup });
  });
  app.addHook('onResponse', async (request) => contexts.get(request.id)?.cleanup());
  app.addHook('onClose', async () => {
    for (const c of contexts.values()) {
      c.controller.abort();
      c.cleanup();
    }
    await deps.close?.();
  });
  app.setErrorHandler((error, request, reply) => {
    const e = error instanceof ApiFailure ? error : unavailable();
    if (reply.raw.headersSent) {
      reply.raw.destroy();
      return;
    }
    if (e.status === 429) reply.header('Retry-After', '60');
    reply
      .code(e.status)
      .send(errorBody(request.id, e.code, e.message, e.status === 429 || e.status === 503));
  });
  app.setNotFoundHandler((request, reply) =>
    reply.code(404).send(errorBody(request.id, 'not_found', 'Route not found.')),
  );
  for (const route of routes)
    app.get(route.path, async (request, reply) => {
      const query = route.query.safeParse(request.query),
        params = route.params.safeParse(request.params);
      if (!query.success || !params.success)
        throw new ApiFailure(400, 'invalid_request', 'Invalid request.');
      const q: any = query.data,
        p: any = params.data;
      const signal = contexts.get(request.id)!.controller.signal;
      const db = () => {
        if (!deps.db)
          throw new ApiFailure(503, 'not_initialized', 'Data dependencies are not configured.');
        return deps.db;
      };
      let body: unknown;
      switch (route.id) {
        case 'live':
          body = { status: 'live', mode: options.mode ?? 'development' };
          break;
        case 'ready':
          await db().read(signal, (c) => c.query('SELECT 1'));
          body = { status: 'ready' };
          break;
        case 'status':
          body = await status(
            deps.db,
            q.chain,
            signal,
            now(),
            Boolean(deps.addresses),
            options.mode,
          );
          break;
        case 'home': {
          body = await home(db(), q.chain, signal, now(), options.mode);
          const h = body as Awaited<ReturnType<typeof home>>;
          if (!h.daily && Object.values(h.live).every((o) => o.value === null))
            throw new ApiFailure(
              503,
              'not_initialized',
              'No useful Home observations are available.',
            );
          break;
        }
        case 'daily':
          body = await daily(db(), q, signal);
          break;
        case 'markets':
          body = await markets(db(), q, signal);
          break;
        case 'stakes':
          body = await stakes(db(), q, signal, cursors, now());
          break;
        case 'holders':
          body = await holders(db(), q, signal, cursors, now());
          break;
        case 'calculator':
          body = await calculator(db(), q.chain, signal, now());
          break;
        case 'address':
        case 'addressStakes': {
          if (q.cursor && (q.chain !== 'pulsechain' || !deps.addresses))
            throw new ApiFailure(
              409,
              'cursor_incompatible',
              'Observation changed or expired; restart pagination.',
            );
          const result =
            q.chain === 'pulsechain' && deps.addresses
              ? await deps.addresses.get(p.address, signal, q.limit, q.cursor)
              : {
                  outcome: 'unavailable',
                  reason: 'live_not_configured',
                  indexed: await sqlBaseline(db()).address(chainId(q.chain), p.address, signal),
                  live: null,
                };
          if (result.outcome === 'expired')
            throw new ApiFailure(
              409,
              'cursor_incompatible',
              'Observation changed or expired; restart pagination.',
            );
          const usefulIndexed =
            result.indexed &&
            [
              result.indexed.liquidHearts,
              result.indexed.accountedHearts,
              result.indexed.stakeCount,
            ].some((value) => value !== null);
          if (!usefulIndexed && !result.live)
            throw result.outcome === 'quota'
              ? new ApiFailure(429, 'provider_quota', 'Live observation quota is unavailable.')
              : unavailable();
          body = result;
          break;
        }
        case 'stake': {
          const known = await indexedStake(db(), q.chain, p.id, signal);
          if (q.address && known.indexed && q.address !== known.indexed.address)
            throw new ApiFailure(
              409,
              'incompatible_owner',
              'Owner hint conflicts with indexed history.',
            );
          const recent =
            q.chain === 'pulsechain' && deps.addresses
              ? await deps.addresses.stake(p.id, signal, q.address)
              : { outcome: 'unavailable', live: null, observation: null };
          if (!known.indexed && recent.outcome === 'indexing')
            throw new ApiFailure(
              503,
              'not_indexed',
              'Stake is not indexed; recent bounded discovery is inconclusive.',
            );
          if (!known.indexed && ['unavailable', 'quota'].includes(recent.outcome))
            throw recent.outcome === 'quota'
              ? new ApiFailure(429, 'provider_quota', 'Live observation quota is unavailable.')
              : unavailable();
          body = {
            chain: q.chain,
            ...known,
            recent: {
              outcome: recent.outcome,
              live: recent.live,
              observation: 'observation' in recent ? recent.observation : null,
              observedAt: 'observedAt' in recent ? recent.observedAt : null,
              expiresAt: 'expiresAt' in recent ? recent.expiresAt : null,
              finality: 'provisional',
            },
          };
          break;
        }
        case 'downloads':
          body = deps.downloads
            ? await deps.downloads.catalog(chainId(q.chain))
            : { status: 'rebuilding', bundles: [] };
          break;
        case 'download': {
          if (!deps.downloads) throw unavailable();
          const opened = await deps.downloads.openStream(p.bundle, p.dataset, signal);
          if (opened.status !== 'available')
            throw opened.status === 'retired'
              ? new ApiFailure(410, 'bundle_retired', 'This immutable bundle is retired.')
              : unavailable();
          const { stream, released, etag, bytes } = opened;
          stream.on('error', () => {});
          reply
            .header('Content-Type', 'text/csv; charset=utf-8')
            .header('Content-Disposition', `attachment; filename="${p.dataset}-${p.bundle}.csv"`)
            .header('ETag', etag)
            .header('Cache-Control', 'public, max-age=31536000, immutable')
            .header('Accept-Ranges', 'none');
          if (matches(request.headers['if-none-match'], etag) || request.method === 'HEAD') {
            stream.destroy();
            await released;
            if (matches(request.headers['if-none-match'], etag)) return reply.code(304).send();
            return reply.header('Content-Length', bytes).send();
          }
          return reply.header('Content-Length', bytes).send(stream);
        }
      }
      const parsed = route.response?.safeParse(body);
      if (parsed && !parsed.success) throw unavailable();
      const json = JSON.stringify(parsed?.data ?? body);
      if (Buffer.byteLength(json) > 2 * 1024 * 1024) throw unavailable();
      if (jsonRevalidation.has(route.id)) {
        const etag = '"' + createHash('sha256').update(json).digest('hex') + '"';
        reply.header('Cache-Control', 'no-cache, must-revalidate').header('ETag', etag);
        if (matches(request.headers['if-none-match'], etag)) return reply.code(304).send();
      }
      return reply.type('application/json; charset=utf-8').send(json);
    });
  if (options.webRoot) {
    app.register(fastifyStatic, { root: options.webRoot, index: ['index.html'], dotfiles: 'deny' });
    for (const path of [
      '/charts',
      '/search',
      '/calculator',
      '/downloads',
      '/learn',
      '/status',
      '/address/:address',
      '/stake/:id',
    ]) {
      app.get(path, (request, reply) => {
        const params = request.params as { address?: string; id?: string };
        if (
          (params.address && !AddressSchema.safeParse(params.address).success) ||
          (params.id && !StakeIdSchema.safeParse(params.id).success)
        )
          return reply.code(404).send(errorBody(request.id, 'not_found', 'Route not found.'));
        return reply.sendFile('index.html');
      });
    }
  }
  return app;
}
function matches(value: string | undefined, etag: string) {
  return (
    value?.split(',').some((s) => s.trim() === '*' || s.trim().replace(/^W\//, '') === etag) ??
    false
  );
}
