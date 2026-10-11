import {
  dataRoutes,
  suppliedKey,
  PublicAdmission,
  PublicBrowse,
  type PaidReads,
} from './data-access.ts';
import { DownloadAdmission, type DownloadAuthorizer } from './download-access.ts';
import { validateStaticRoots, checkStaticPath } from './static-boundary.ts';
import type { FastifyInstance } from 'fastify';
import { stakeEvents } from '../services/queries/stake-events.ts';
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
import { productCalculator } from '../services/product-daily/calculator.ts';
import { archiveCharts, nativeCharts, maturities } from '../services/queries/charts.ts';
import { stakes, holders, indexedStake } from '../services/queries/lists.ts';
import { AddressSchema, StakeIdSchema } from '../contracts/reads.ts';
import { DailyLedgerResponseSchema } from '../contracts/daily-ledger.ts';
import { sourceAddress } from '../services/source-holders/address.ts';

export function createApp(
  options: {
    webRoot?: string;
    mode?: 'development' | 'production';
    dependencies?: ApiDependencies;
    now?: () => number;
    admission?: { capacity: number; concurrent: number };
    paidReads?: PaidReads;
    publicLimits?: Partial<PublicAdmission['limits']>;
    downloadAuthorizer?: DownloadAuthorizer;
    exportRoot?: string;
    account?: { register: (scope: FastifyInstance) => Promise<void>; webRoot?: string };
    samples?: (scope: FastifyInstance) => Promise<void>;
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
        .header(
          'Cache-Control',
          request.headers.authorization !== undefined ||
            request.url.startsWith('/api/v2/downloads/')
            ? 'private, no-store'
            : 'no-store',
        )
        .header('Vary', 'Authorization, Cookie, Accept-Encoding')
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
    cursors = new PageCursors(),
    publicCursors = new PageCursors();
  const publicAdmission = new PublicAdmission(options.publicLimits),
    browse = new PublicBrowse();
  const routeIds = new Map<string, string>(routes.map((route) => [route.path, route.id]));
  const mixedHeaders = (request: FastifyRequest, reply: FastifyReply) => {
    if (dataRoutes.has(routeIds.get(request.routeOptions.url ?? '') ?? '')) {
      reply.header('Vary', 'Authorization, Cookie');
      if (suppliedKey(request)) reply.header('Cache-Control', 'private, no-store');
    }
  };
  const downloadAdmission = new DownloadAdmission();
  const staticRoots = [options.webRoot, options.account?.webRoot].filter((r): r is string =>
    Boolean(r),
  );
  app.addHook('onReady', async () => {
    if (deps.downloads && staticRoots.length && !deps.downloads.root)
      throw Error('Actual export root required for static isolation.');
    if (
      deps.downloads?.root &&
      options.exportRoot &&
      deps.downloads.root !== options.exportRoot
    )
      throw Error('Export root mismatch.');
    await validateStaticRoots(staticRoots, deps.downloads?.root ?? options.exportRoot);
    if (deps.participants) await validateStaticRoots(staticRoots, deps.participants.root);
    if (deps.productDaily) await validateStaticRoots(staticRoots, deps.productDaily.root);
    if (deps.sourceStakes) await validateStaticRoots(staticRoots, deps.sourceStakes.root);
    if (deps.sourceHolders) await validateStaticRoots(staticRoots, deps.sourceHolders.root);
    if (deps.sourceGenerations)
      for (const root of [
        deps.sourceGenerations.root,
        deps.sourceGenerations.holders.root,
        deps.sourceGenerations.stakes.root,
      ])
        await validateStaticRoots(staticRoots, root);
  });
  const privateDownload = (request: FastifyRequest, reply: FastifyReply) => {
    if (request.url.split('?')[0]?.startsWith('/api/v2/downloads/'))
      reply
        .header('Cache-Control', 'private, no-store')
        .header('Vary', 'Authorization, Cookie');
  };
  const contexts = new Map<
    string,
    {
      controller: AbortController;
      deadline: number;
      timer: NodeJS.Timeout;
      cleanup: () => void;
    }
  >();
  const capacity = options.admission?.capacity ?? 1200,
    concurrent = options.admission?.concurrent ?? 64;
  let tokens = capacity,
    last = Date.now();
  const errorBody = (id: string, code: string, message: string, retryable = false) =>
    ApiErrorSchema.parse({ error: { code, message, retryable }, requestId: id });
  app.addHook('onRequest', async (request, reply) => {
    reply.header('Cache-Control', 'no-store').header('X-Content-Type-Options', 'nosniff');
    privateDownload(request, reply);
    mixedHeaders(request, reply);
    if (
      !['GET', 'HEAD'].includes(request.method) &&
      !(request.routeOptions.config as { accountMutation?: boolean }).accountMutation
    )
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
    const matched = request.routeOptions.url;
    const applicationRoute =
      routes.some((route) => route.path === matched) ||
      (request.routeOptions.config as { accountRoute?: boolean }).accountRoute ||
      ['daily', 'stakes', 'holders', 'maturities', 'markets'].some(
        (name) => matched === `/samples/${name}.csv`,
      );
    if (!applicationRoute) {
      const path = request.url.split('?')[0]!;
      if (options.account?.webRoot && (path === '/account' || path.startsWith('/account/')))
        await checkStaticPath(options.account.webRoot, path.slice('/account'.length) || '/');
      else if (options.webRoot) await checkStaticPath(options.webRoot, path);
    }
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
    const duration = download ? 120000 : live ? 10000 : 8000;
    const deadline = performance.now() + duration;
    const timer = setTimeout(() => controller.abort(), duration).unref();
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
    contexts.set(request.id, { controller, deadline, timer, cleanup });
    if (dataRoutes.has(routeIds.get(matched ?? '') ?? '') && !suppliedKey(request)) {
      const release = publicAdmission.acquire(request.raw.socket.remoteAddress);
      reply.raw.once('finish', release);
      reply.raw.once('close', release);
    }
  });
  app.addHook('onResponse', async (request) => contexts.get(request.id)?.cleanup());
  app.addHook('onClose', async () => {
    for (const c of contexts.values()) {
      c.controller.abort();
      c.cleanup();
    }
    publicAdmission.clear();
    await options.paidReads?.close();
    await deps.close?.();
  });
  app.setErrorHandler((error, request, reply) => {
    privateDownload(request, reply);
    mixedHeaders(request, reply);
    const e = error instanceof ApiFailure ? error : unavailable();
    if (reply.raw.headersSent) {
      reply.raw.destroy();
      return;
    }
    if (request.routeOptions.url === '/api/v2/downloads/:bundle/:dataset')
      reply
        .removeHeader('Content-Length')
        .removeHeader('Content-Disposition')
        .removeHeader('ETag')
        .type('application/json; charset=utf-8');
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
      let handlerDone = false,
        responseDone = false,
        releasePair: (() => void) | undefined;
      const settlePair = () => {
        if (handlerDone && responseDone) releasePair?.();
      };
      const responseFinished = () => {
        responseDone = true;
        settlePair();
      };
      reply.raw.once('finish', responseFinished);
      reply.raw.once('close', responseFinished);
      try {
        const incoming = request.query as Record<string, unknown>;
        if (
          route.path.startsWith('/api/v2/') &&
          [
            'source',
            'view',
            'series',
            'generation',
            'datasetVersion',
            'holderDatasetVersion',
            'revision',
            'afterSourceDay',
          ].some((k) => Object.hasOwn(incoming, k))
        )
          throw new ApiFailure(
            400,
            'selection_migrated',
            'Provider/view/version selection has retired. Use the normal route; restart pagination.',
          );
        const query = route.query.safeParse(request.query),
          params = route.params.safeParse(request.params);
        if (!query.success || !params.success)
          throw new ApiFailure(400, 'invalid_request', 'Invalid request.');
        const q: any = query.data,
          p: any = params.data;
        const context = contexts.get(request.id)!;
        const signal = context.controller.signal;
        const paid = dataRoutes.has(route.id) && suppliedKey(request);
        let wrapCursor: ((inner: string | null) => string | null) | null = null;
        if (dataRoutes.has(route.id)) {
          if (paid) {
            const count = request.raw.rawHeaders.filter(
              (name, i) => i % 2 === 0 && name.toLowerCase() === 'authorization',
            ).length;
            if (
              count !== 1 ||
              typeof request.headers.authorization !== 'string' ||
              !/^Bearer lab_[A-Za-z0-9_-]{43}$/.test(request.headers.authorization)
            )
              throw new ApiFailure(401, 'invalid_key', 'A valid API key is required.');
            if (!options.paidReads) throw unavailable();
            await options.paidReads.begin(request, reply, {
              route: route.id,
              signal,
              deadline: context.deadline,
            });
          } else wrapCursor = browse.prepare(route.id, q, now());
        }
        signal.throwIfAborted();
        const db = () => {
          if (!deps.db)
            throw new ApiFailure(
              503,
              'not_initialized',
              'Data dependencies are not configured.',
            );
          return deps.db;
        };
        const productRoutes = [
          'home',
          'daily',
          'markets',
          'latest',
          'stakes',
          'stake',
          'holders',
          'address',
          'addressStakes',
          'downloads',
          'download',
          ...(deps.productDaily ? ['calculator'] : []),
        ];
        if (productRoutes.includes(route.id) && route.id !== 'download') {
          if (deps.participants) await deps.participants.refresh();
          else await deps.productDaily?.refresh();
          signal.throwIfAborted();
        }
        let paired =
          productRoutes.includes(route.id) && route.id !== 'download'
            ? deps.participants?.capture()
            : undefined;
        if (paired) releasePair = paired.release;
        let product =
          productRoutes.includes(route.id) && route.id !== 'download'
            ? (paired?.product ?? deps.productDaily?.capture())
            : undefined;
        const sources = paired?.sourceGenerations ?? deps.sourceGenerations;
        if (productRoutes.includes(route.id) && route.id !== 'download' && !product)
          throw unavailable();
        if (
          product &&
          ['holders', 'stakes', 'stake', 'address', 'addressStakes'].includes(route.id)
        ) {
          if (
            !sources ||
            sources.descriptor.generation !== product.metadata.pair.generation ||
            sources.descriptor.holderDatasetVersion !==
              product.metadata.pair.holderDatasetVersion ||
            sources.descriptor.stakeDatasetVersion !==
              product.metadata.pair.stakeDatasetVersion
          )
            throw unavailable();
          q.source = 'subgraph';
          q.generation = product.metadata.pair.generation;
          q.productVersion = product.version;
        }
        let body: unknown;
        if (q.source === 'subgraph' && q.generation && q.generation !== 'base' && !sources)
          throw unavailable();
        if (
          q.source === 'subgraph' &&
          sources &&
          ['holders', 'stakes', 'stake', 'address', 'addressStakes'].includes(route.id)
        ) {
          body = await sources.read(
            route.id as 'holders' | 'stakes' | 'stake' | 'address' | 'addressStakes',
            q,
            p,
            signal,
            paid ? cursors : publicCursors,
            now(),
          );
        } else
          switch (route.id) {
            case 'latest':
              body = deps.productDaily!.live(product!, now());
              break;
            case 'live':
              body = { status: 'live', mode: options.mode ?? 'development' };
              break;
            case 'ready':
              if (deps.productDaily) deps.productDaily.capture();
              else await db().read(signal, (c) => c.query('SELECT 1'));
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
              body = deps.productDaily!.home(product!, now());
              break;
            }
            case 'daily':
              body = deps.productDaily!.read(
                product!,
                q,
                route.id,
                paid ? cursors : publicCursors,
                now(),
                paid ? 'paid' : 'public',
              );
              break;
            case 'maturities':
              if (!deps.db)
                throw new ApiFailure(
                  503,
                  'capability_unavailable',
                  'Canonical maturity data is unavailable in the saved product.',
                );
              body = await maturities(db(), signal);
              break;
            case 'markets':
              body = deps.productDaily!.read(
                product!,
                q,
                route.id,
                paid ? cursors : publicCursors,
                now(),
                paid ? 'paid' : 'public',
              );
              break;
            case 'stakes':
              if (q.source === 'subgraph') {
                if (!deps.sourceStakes) throw unavailable();
                body = await deps.sourceStakes.read(
                  'stakes',
                  q,
                  p,
                  signal,
                  paid ? cursors : publicCursors,
                  now(),
                );
                break;
              }
              body = await stakes(db(), q, signal, paid ? cursors : publicCursors, now());
              break;
            case 'stakeEvents':
              if (!deps.db)
                throw new ApiFailure(
                  503,
                  'capability_unavailable',
                  'Canonical stake events are unavailable in the saved product.',
                );
              body = await stakeEvents(db(), q, signal);
              break;
            case 'holders':
              if (q.source === 'subgraph') {
                if (!deps.sourceHolders) throw unavailable();
                body = await deps.sourceHolders.read(
                  q,
                  signal,
                  paid ? cursors : publicCursors,
                  now(),
                );
                break;
              }
              body = await holders(db(), q, signal, paid ? cursors : publicCursors, now());
              break;
            case 'calculator':
              if (product && q.chain !== 'pulsechain')
                throw new ApiFailure(
                  400,
                  'unsupported_chain',
                  'The saved Calculator supports PulseChain.',
                );
              body = product
                ? productCalculator(product, now())
                : await calculator(db(), q.chain, signal, now());
              break;
            case 'address':
            case 'addressStakes': {
              if (q.source === 'subgraph') {
                if (!deps.sourceStakes) throw unavailable();
                body = await sourceAddress(
                  deps.sourceStakes,
                  deps.sourceHolders,
                  route.id,
                  q,
                  p.address,
                  signal,
                  paid ? cursors : publicCursors,
                  now(),
                );
                break;
              }
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
                      indexed: await sqlBaseline(db()).address(
                        chainId(q.chain),
                        p.address,
                        signal,
                      ),
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
                  ? new ApiFailure(
                      429,
                      'provider_quota',
                      'Live observation quota is unavailable.',
                    )
                  : unavailable();
              body = result;
              break;
            }
            case 'stake': {
              if (q.source === 'subgraph') {
                if (!deps.sourceStakes) throw unavailable();
                body = await deps.sourceStakes.read(
                  'stake',
                  q,
                  p,
                  signal,
                  paid ? cursors : publicCursors,
                  now(),
                );
                break;
              }
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
                  ? new ApiFailure(
                      429,
                      'provider_quota',
                      'Live observation quota is unavailable.',
                    )
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
              body = deps.productDaily!.catalog(product!);
              break;
            case 'download': {
              if (!options.downloadAuthorizer) throw unavailable();
              const authorization = await options.downloadAuthorizer(request, signal);
              signal.throwIfAborted();
              if ('status' in authorization) {
                if (authorization.status === 401)
                  throw new ApiFailure(
                    401,
                    'login_required',
                    'Valid credentials are required.',
                  );
                if (authorization.status === 403)
                  throw new ApiFailure(
                    403,
                    'purchased_access_required',
                    'Current purchased access is required.',
                  );
                throw unavailable();
              }
              if (!authorization.accountId) throw unavailable();
              if (!deps.productDaily) throw unavailable();
              if (deps.participants) await deps.participants.refresh();
              else await deps.productDaily.refresh();
              signal.throwIfAborted();
              paired = deps.participants?.capture();
              if (paired) releasePair = paired.release;
              product = paired?.product ?? deps.productDaily.capture();
              const release = downloadAdmission.acquire(authorization.accountId);
              let opened;
              try {
                opened = deps.productDaily.openExport(product!, p.bundle, p.dataset, signal);
              } catch (e) {
                release();
                throw e;
              }
              if (opened.status === 'available') void opened.released.then(release, release);
              else release();
              if (opened.status !== 'available')
                throw opened.status === 'retired'
                  ? new ApiFailure(410, 'bundle_retired', 'This immutable bundle is retired.')
                  : unavailable();
              const { stream, released, etag, bytes } = opened;
              stream.on('error', () => {});
              reply
                .header('Content-Type', 'text/csv; charset=utf-8')
                .header(
                  'Content-Disposition',
                  `attachment; filename="${p.dataset}-${p.bundle}.csv"`,
                )
                .header('ETag', etag)
                .header('Cache-Control', 'private, no-store')
                .header('Vary', 'Authorization, Cookie')
                .header('Accept-Ranges', 'none');
              if (
                matches(request.headers['if-none-match'], etag) ||
                request.method === 'HEAD'
              ) {
                stream.destroy();
                await released;
                if (matches(request.headers['if-none-match'], etag))
                  return reply.code(304).send();
                // Fastify's empty-payload serializer replaces Content-Length with zero.
                // The reader is already closed: send only the verified HEAD metadata.
                reply.header('Content-Length', bytes).hijack();
                reply.raw.writeHead(
                  200,
                  Object.fromEntries(
                    Object.entries(reply.getHeaders())
                      .filter(([, value]) => value !== undefined)
                      .map(([name, value]) => [
                        name,
                        Array.isArray(value) ? value : String(value),
                      ]),
                  ),
                );
                reply.raw.end();
                return reply;
              }
              return reply.header('Content-Length', bytes).send(stream);
            }
          }
        signal.throwIfAborted();
        if (wrapCursor && body && typeof body === 'object' && 'nextCursor' in body)
          body = {
            ...body,
            nextCursor: wrapCursor((body as { nextCursor: string | null }).nextCursor),
          };
        const parsed = route.response?.safeParse(body);
        if (parsed && !parsed.success) throw unavailable();
        const json = JSON.stringify(parsed?.data ?? body);
        const maxBytes = route.id === 'stakeEvents' ? 512 * 1024 : 2 * 1024 * 1024;
        if (Buffer.byteLength(json) > maxBytes) throw unavailable();
        if (
          jsonRevalidation.has(route.id) ||
          (q.source === 'subgraph' && ['address', 'addressStakes', 'stake'].includes(route.id))
        ) {
          const updatedSource =
            q.source === 'subgraph' &&
            body &&
            typeof body === 'object' &&
            'generation' in body;
          const representation =
            product || updatedSource
              ? JSON.stringify([
                  'unified-product-v1',
                  route.id,
                  q,
                  p,
                  paid ? 'paid' : 'public',
                  json,
                ])
              : json;
          const etag = '"' + createHash('sha256').update(representation).digest('hex') + '"';
          reply
            .header('Cache-Control', paid ? 'private, no-store' : 'no-cache, must-revalidate')
            .header('ETag', etag);
          if (matches(request.headers['if-none-match'], etag)) return reply.code(304).send();
        }
        return reply.type('application/json; charset=utf-8').send(json);
      } finally {
        handlerDone = true;
        settlePair();
      }
    });
  if (options.account) {
    const account = options.account;
    app.register(async (scope) => {
      const post = new Set(
        [
          'signup',
          'login',
          'logout',
          'recover',
          'recovery-code',
          'password',
          'contact',
          'verify-contact',
          'request-email-reset',
          'email-reset',
          'keys',
          'keys/revoke',
          'invoices',
          'invoices/:id/cancel',
          'invoices/:id/review',
        ].map((p) => '/api/account/' + p),
      );
      const get = new Set([
        '/api/account',
        '/api/account/invoices/:id',
        '/api/account/reviews/:id',
      ]);
      scope.addHook('onRoute', (route) => {
        for (const method of Array.isArray(route.method) ? route.method : [route.method]) {
          if (method === 'POST' && post.has(route.url))
            route.config = { ...route.config, accountMutation: true, accountRoute: true };
          else if (['GET', 'HEAD'].includes(method) && get.has(route.url))
            route.config = { ...route.config, accountRoute: true };
          else throw Error('Account route outside allowlist.');
        }
      });
      await account.register(scope);
    });
    if (account.webRoot)
      app.register(async (scope) => {
        await scope.register(fastifyStatic, {
          root: account.webRoot!,
          prefix: '/account/',
          decorateReply: false,
          dotfiles: 'deny',
        });
        scope.get('/account', (_request, reply) => reply.redirect('/account/'));
      });
  }
  if (options.samples) app.register(options.samples);
  if (options.webRoot) {
    app.register(fastifyStatic, {
      root: options.webRoot,
      index: ['index.html'],
      dotfiles: 'deny',
    });
    for (const path of [
      '/api',
      '/api/reference',
      '/daily',
      '/live',
      '/charts',
      '/charts/detail',
      '/charts/maturities',
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
