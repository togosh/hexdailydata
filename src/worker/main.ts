import { readFile, stat, mkdir } from 'node:fs/promises';
import { resolve } from 'node:path';
import { z } from 'zod';
import { connect, databaseConfig } from '../db/connect.ts';
import { CanonicalWriter } from '../services/projections/writer.ts';
import { ProviderBudget } from '../providers/budget.ts';
import { cooldownFiles } from '../providers/cooldown.ts';
import { httpTransport, RpcClient } from '../providers/rpc.ts';
import { Source } from '../providers/source.ts';
import { SyncEngine } from './sync/engine.ts';
import { profileSchema } from './sync/profile.ts';
import { exportSeed, importSeed } from './bootstrap/seed.ts';
import { PriceReader, priceTargets } from '../services/live/price.ts';
import { MetricsService } from './metrics/service.ts';
import { SqlMetricStore } from './metrics/store.ts';
import { MetricsJob, runWorkerLifecycle } from './lifecycle.ts';
import { DailyService, capturePrice } from './daily/service.ts';
import { configureMarket, importMarketBars } from './daily/market.ts';

const command = process.argv[2] ?? 'help';
const controller = new AbortController();
for (const sig of ['SIGINT', 'SIGTERM'] as const)
  process.once(sig, () => controller.abort(new Error('Worker cancelled.')));
const signal = controller.signal;
if (command === 'status') {
  console.log(
    JSON.stringify({
      mode: 'offline-by-default',
      syncImplemented: true,
      liveQualification: 'NOT_RUN',
      publicData: 'uninitialized; serving integration belongs to Task06',
    }),
  );
} else if (command === 'help' || command === '--help') {
  console.log(
    'Worker: rebuild | once | watch | repair-range <block> | daily | export | market-import <file> | seed-export <file> | seed-import <file> <expectation.json> | status. Daily/export need HDD_V2_EXPORT_PATH; no live opt-in. Market import needs HDD_V2_MARKET_PROFILE. Explicit v2 database required. Provider commands require HDD_V2_SOURCE_PROFILE and HDD_V2_ALLOW_LIVE_RPC=true; none are enabled by default.',
  );
} else {
  let writer: CanonicalWriter | undefined,
    reader: Awaited<ReturnType<typeof connect>> | undefined,
    client: Awaited<ReturnType<typeof connect>> | undefined,
    quotaOwner: Awaited<ReturnType<typeof connect>> | undefined,
    cooldown: Awaited<ReturnType<typeof cooldownFiles>> | undefined,
    metricClient: Awaited<ReturnType<typeof connect>> | undefined,
    timer: NodeJS.Timeout | undefined;
  try {
    if (
      ![
        'rebuild',
        'once',
        'watch',
        'repair-range',
        'seed-export',
        'seed-import',
        'daily',
        'export',
        'market-import',
      ].includes(command)
    )
      throw new Error('Unknown worker command.');
    if (command === 'daily' || command === 'export') {
      if (!process.env.HDD_V2_EXPORT_PATH) throw new Error('Explicit owned export root required.');
      const daily = new DailyService(
        () => connect(databaseConfig('worker')),
        resolve(process.env.HDD_V2_EXPORT_PATH),
      );
      await daily.exports.startup(signal);
      await daily.tick(signal, Date.now(), command === 'export');
      console.log(JSON.stringify(daily.status));
      if (daily.status.marketError || daily.status.exportError) process.exitCode = 1;
    } else if (command === 'market-import') {
      const path = process.argv[3],
        profilePath = process.env.HDD_V2_MARKET_PROFILE;
      if (
        !path ||
        !profilePath ||
        (await stat(path)).size > 2 * 1024 * 1024 ||
        (await stat(profilePath)).size > 4096
      )
        throw new Error('Bounded input and explicit market profile required.');
      const profile = z
        .strictObject({
          chain: z.union([z.literal(1), z.literal(369)]),
          source: z.string().regex(/^[a-z][a-z0-9_-]{0,63}$/),
          fromDay: z.number().int().min(0).max(65535),
          method: z.literal('source-reported'),
        })
        .parse(JSON.parse(await readFile(profilePath, 'utf8')));
      const raw = JSON.parse(await readFile(path, 'utf8'));
      if (raw.chain !== profile.chain || raw.source !== profile.source)
        throw new Error('Market profile mismatch.');
      client = await connect(databaseConfig('worker'));
      await configureMarket(client, profile.chain, profile.source, profile.method, profile.fromDay);
      await importMarketBars(client, raw, Math.floor(Date.now() / 1000), signal);
      console.log('Market intervals imported; aggregate with daily.');
    } else if (command.startsWith('seed-')) {
      const path = process.argv[3];
      if (!path) throw new Error('Explicit seed path required.');
      client = await connect(databaseConfig('worker'));
      if (command === 'seed-export')
        console.log(JSON.stringify(await exportSeed(client, resolve(path), signal)));
      else {
        if (!process.argv[4]) throw new Error('Explicit trusted seed expectation required.');
        const expected = z
          .strictObject({
            instance: z.uuid(),
            sha256: z.string().regex(/^[0-9a-f]{64}$/),
            contract: z.string().regex(/^0x[0-9a-f]{40}$/),
            codeHash: z.string().regex(/^0x[0-9a-f]{64}$/),
            checkpointHash: z.string().regex(/^0x[0-9a-f]{64}$/),
          })
          .parse(JSON.parse(await readFile(process.argv[4], 'utf8')));
        console.log(JSON.stringify(await importSeed(client, resolve(path), expected, signal)));
      }
    } else {
      if (
        process.env.HDD_V2_ALLOW_LIVE_RPC !== 'true' ||
        !process.env.HDD_V2_SOURCE_PROFILE ||
        !process.env.HDD_V2_PROVIDER_STATE ||
        !process.env.HDD_V2_STORAGE_PATH
      )
        throw new Error(
          'Provider work disabled: explicit source profile, persistent quota directory, storage path and live opt-in required.',
        );
      const profile = profileSchema.parse(
        JSON.parse(await readFile(process.env.HDD_V2_SOURCE_PROFILE, 'utf8')),
      );
      const transports = new Map<string, ReturnType<typeof httpTransport>>();
      for (const source of [...profile.ethereum, ...profile.pulsechain]) {
        const endpoint = process.env[source.endpointEnv];
        if (!endpoint) throw new Error(`Provider ${source.id} endpoint is NOT_CONFIGURED.`);
        transports.set(source.endpointEnv, httpTransport(endpoint));
      }
      for (const pair of [profile.ethereum, profile.pulsechain]) {
        if (
          pair[0].endpointEnv === pair[1].endpointEnv ||
          process.env[pair[0].endpointEnv] === process.env[pair[1].endpointEnv]
        )
          throw new Error('Two configured URLs cannot be the same upstream.');
      }
      quotaOwner = await connect(databaseConfig('worker'));
      const {
        rows: [owner],
      } = await quotaOwner.query('SELECT pg_try_advisory_lock(4244,1) AS held');
      if (!owner.held) throw new Error('Worker process role already active.');
      quotaOwner.on('error', () => controller.abort(new Error('Worker quota ownership lost.')));
      quotaOwner.on('end', () => controller.abort(new Error('Worker quota ownership ended.')));
      cooldown = await cooldownFiles(resolve(process.env.HDD_V2_PROVIDER_STATE), 'worker');
      // All aliases/accounts share one worker allocation. accountGroup is disclosure,
      // never another quota bucket; unknown sharing remains conservative.
      const budget = new ProviderBudget('worker', cooldown);
      const price = process.env.HDD_V2_METRICS_PROFILE
        ? new PriceReader(
            JSON.parse(await readFile(process.env.HDD_V2_METRICS_PROFILE, 'utf8')),
            profile.contract,
          )
        : null;
      metricClient = await connect(databaseConfig('worker'));
      const exportPath = resolve(
        process.env.HDD_V2_EXPORT_PATH ?? resolve(process.env.HDD_V2_STORAGE_PATH, 'exports'),
      );
      await mkdir(exportPath, { recursive: true });
      const daily = new DailyService(() => connect(databaseConfig('worker')), exportPath);
      try {
        await daily.exports.startup(signal);
      } catch (error) {
        daily.status.exportError = (error as Error).message;
      }
      const metricSources = profile.pulsechain.map(
        (s) =>
          new RpcClient(
            s.id,
            s.operator,
            369,
            profile.contract,
            transports.get(s.endpointEnv)!,
            budget,
            price ? priceTargets(price.profile) : undefined,
          ),
      ) as [RpcClient, RpcClient];
      const metrics = new MetricsService(
        metricSources,
        profile.codeHash,
        price,
        new SqlMetricStore(metricClient),
        (source, sample) => capturePrice(metricClient!, 369, source, sample),
      );
      reader = await connect(databaseConfig('api'));
      async function engine(chain: 1 | 369) {
        client = await connect(databaseConfig('worker'));
        writer = await CanonicalWriter.acquire(client, chain);
        const inputs = chain === 1 ? profile.ethereum : profile.pulsechain;
        const sources = inputs.map(
          (s) =>
            new Source(
              new RpcClient(
                s.id,
                s.operator,
                chain,
                profile.contract,
                transports.get(s.endpointEnv)!,
                budget,
              ),
              {
                codeHash: profile.codeHash,
                finality: profile.policy,
                completeness: 'filtered-ranges',
              },
            ),
        ) as [Source, Source];
        return new SyncEngine(writer, reader!, sources, resolve(process.env.HDD_V2_STORAGE_PATH!));
      }
      await runWorkerLifecycle(
        async (signal) => {
          let sync: SyncEngine;
          if (command === 'rebuild') {
            sync = await engine(1);
            if (!(await sync.cursor()))
              await sync.initializeConstructor(
                profile.constructor.checkpoint,
                profile.constructor.transactionHash,
                profile.constructor.balances,
                signal,
              );
            await sync.once(signal, profile.fork.parent);
            await sync.audit(signal);
            await writer!.close();
            sync = await engine(369);
            if (!(await sync.cursor()))
              await sync.fork(profile.fork.parent, profile.fork.entry, signal);
          } else sync = await engine(369);
          timer = setInterval(
            () => console.log(JSON.stringify({ progress: sync.progress, budget: budget.counters })),
            30000,
          );
          if (command === 'repair-range') {
            const block = process.argv[3],
              s = await sync.cursor();
            if (!block || !s) throw new Error('Explicit retained repair checkpoint required.');
            await writer!.rewind(block, {
              blockNumber: s.block_number,
              blockHash: '0x' + s.block_hash.toString('hex'),
              revision: s.revision,
            });
          } else if (command === 'watch')
            await sync.watch(signal, (progress) => console.log(JSON.stringify(progress)));
          else {
            await sync.once(signal, command === 'rebuild' ? profile.target : undefined);
            if (command === 'rebuild') await sync.audit(signal);
          }
          console.log(JSON.stringify({ progress: sync.progress, budget: budget.counters }));
          if (command !== 'watch') await daily.tick(signal);
        },
        new MetricsJob(budget.clock, (s) => metrics.tick(s)),
        signal,
        command === 'watch',
        command === 'watch'
          ? [new MetricsJob(budget.clock, (s) => daily.tick(s, budget.clock.now()))]
          : [],
      );
    }
  } catch (error) {
    console.error(error instanceof Error ? error.message : 'Worker failed.');
    process.exitCode = 1;
  } finally {
    if (timer) clearInterval(timer);
    await writer?.close().catch((error) => console.error('Writer cleanup failed:', error.message));
    await client?.end().catch(() => {});
    await reader?.end().catch(() => {});
    await metricClient?.end().catch(() => {});
    await quotaOwner?.end().catch(() => {});
    await cooldown
      ?.close()
      .catch((error) => console.error('Quota state cleanup failed:', error.message));
  }
}
