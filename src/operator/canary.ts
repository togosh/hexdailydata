import { connect, databaseConfig } from '../db/connect.ts';
import { performance } from 'node:perf_hooks';
import { realClock, ProviderBudget, type Clock } from '../providers/budget.ts';
import { cooldownFiles } from '../providers/cooldown.ts';
import { httpTransport, RpcClient, type Transport } from '../providers/rpc.ts';
import { profileSources } from '../worker/sync/profile.ts';
import { CanonicalWriter, type FaultHooks } from '../services/projections/writer.ts';
import { SyncEngine } from '../worker/sync/engine.ts';
import { emptyTarget } from '../worker/bootstrap/seed.ts';
import { MetricsService } from '../worker/metrics/service.ts';
import { SqlMetricStore } from '../worker/metrics/store.ts';
import { PriceReader, priceTargets } from '../services/live/price.ts';
import { AddressService } from '../services/live/address.ts';
import { SqlAddressBaseline } from '../services/live/baseline.ts';
import { capturePrice } from '../worker/daily/service.ts';
import { maintenanceLease } from './lease.ts';
import { operatorError } from './errors.ts';
import { CanarySession } from './canary-session.ts';
import { canaryAuthority, canaryPlanSchema, checkCanary, readCanaryJson } from './canary-plan.ts';
import { prefixPhase } from './canary-prefix.ts';
import { plainHeader } from '../providers/abi.ts';
import type { SessionHooks } from './canary-session.ts';

export const canaryHelp =
  'canary check|prepare|status|run|resume <plan.json> [owner-approval.json]. Check is local; prepare requires a NEW empty v2 DB/Linux paths. Run/resume require separate owner approval, session opt-in and live opt-in. No providers by default.';
export async function runCanary(
  args: string[],
  signal: AbortSignal,
  options: {
    env?: NodeJS.ProcessEnv;
    clock?: Clock;
    transport?: (endpoint: string) => Transport;
    hooks?: FaultHooks;
    sessionHooks?: SessionHooks;
    cleanupHook?: () => Promise<void>;
  } = {},
) {
  let invocationStart = (options.clock ?? realClock).now();
  const [command, planPath, approvalPath] = args;
  if (command === 'help' || command === '--help' || !command) return { help: canaryHelp };
  if (!['check', 'prepare', 'status', 'run', 'resume'].includes(command) || !planPath)
    throw new Error(canaryHelp);
  const input = await readCanaryJson(planPath);
  if (command === 'check') return checkCanary(input);
  const plan = canaryPlanSchema.parse(input),
    env = options.env ?? process.env,
    clock = options.clock ?? realClock;
  const prefix = prefixPhase(plan);
  if (prefix && command === 'run' && !options.transport) {
    const supplied = Number(env.HDD_V2_CANARY_INVOKED_AT);
    if (!Number.isSafeInteger(supplied) || supplied <= 0 || supplied > invocationStart)
      throw new Error('Common prefix requires the canary-once host invocation clock.');
    invocationStart = supplied;
  }
  if (prefix && command === 'resume') throw new Error('Common prefix resume is not authorized.');
  // No external transport is constructed before ALL local and destination guards.
  if (
    env.HDD_V2_PROJECT !== plan.project ||
    env.HDD_V2_DB_INSTANCE !== plan.instance ||
    env.HDD_V2_CANARY_RELEASE !== plan.release ||
    env.HDD_V2_STORAGE_PATH !== plan.storagePath ||
    env.HDD_V2_PROVIDER_STATE !== plan.quotaPath
  )
    throw new Error('Canary destination/release/environment mismatch.');
  if (process.platform !== 'linux') throw new Error('Canary durable operation requires Linux.');
  if (command === 'run' || command === 'resume') {
    canaryAuthority(plan, approvalPath ? await readCanaryJson(approvalPath) : null, env);
    for (const pair of [plan.profile.ethereum, plan.profile.pulsechain]) {
      const urls = pair.map((p) => env[p.endpointEnv]);
      if (urls.some((u) => !u) || urls[0] === urls[1])
        throw new Error('Canary endpoints missing or duplicated.');
      if (prefix && urls.some((url, i) => url !== prefix.endpoints[i]))
        throw new Error('Common prefix endpoint URL mismatch.');
    }
  }
  const controller = new AbortController();
  let activeSignal = AbortSignal.any([signal, controller.signal]);
  let release: (() => Promise<void>) | undefined;
  const deadline = invocationStart + plan.caps.milliseconds;
  const invocationTimer =
    prefix && command === 'run'
      ? setTimeout(
          () => controller.abort(new Error('Canary invocation elapsed cap reached.')),
          Math.max(0, deadline - clock.now()),
        )
      : undefined;
  const clients: Awaited<ReturnType<typeof connect>>[] = [];
  let session: CanarySession | undefined;
  const writers = new Map<1 | 369, CanonicalWriter>();
  const writerClients = new Map<1 | 369, Awaited<ReturnType<typeof connect>>>();
  let progressTimer: NodeJS.Timeout | undefined;
  let primary: string | undefined;
  let completed = false;
  let ownsExecution = false;
  const secondary: string[] = [];
  const sourcePairs = new Map<1 | 369, ReturnType<typeof profileSources>>();
  const failure = (error: unknown) => {
    const detail = operatorError(error);
    return /https?:\/\//i.test(detail) ? 'Canary provider transport failed.' : detail;
  };
  const cancelSql = () => {
    for (const c of clients) void c.end().catch((e) => secondary.push(failure(e)));
  };
  const invocationSignal = activeSignal;
  invocationSignal.addEventListener('abort', cancelSql, { once: true });
  async function db() {
    const c = await connect(databaseConfig('worker', env), { signal: activeSignal });
    clients.push(c);
    c.on('error', () => controller.abort(new Error('Canary database ownership lost.')));
    c.on('end', () => controller.abort(new Error('Canary database connection ended.')));
    return c;
  }
  try {
    release = await maintenanceLease([plan.storagePath, plan.quotaPath], activeSignal);
    if (command === 'status') return (await CanarySession.load(plan, clock)).state;
    const owner = await db();
    if (
      (await owner.query('SELECT version FROM hdd.schema_migrations ORDER BY version')).rows
        .map((r) => r.version)
        .join(',') !== '1,2,3,4,5'
    )
      throw new Error('Canary requires schema5.');
    // Keep ordinary live API/worker and canonical/seed writers out of this instance.
    for (const [a, b] of [
      [4244, 0],
      [4244, 1],
      [4250, 0],
    ])
      if (
        !(await owner.query('SELECT pg_try_advisory_lock($1::int,$2::int) AS held', [a, b])).rows[0]
          .held
      )
        throw new Error('Canary requires exclusive stopped API/worker/writers.');
    for (const chain of [1, 369] as const) {
      const c = await db();
      writerClients.set(chain, c);
      writers.set(chain, await CanonicalWriter.acquire(c, chain));
    }
    if (command === 'prepare') {
      await emptyTarget(owner);
      session = await CanarySession.prepare(plan, clock);
      return session.state;
    }
    session = await CanarySession.load(plan, clock, options.sessionHooks);
    if (command === 'run') await emptyTarget(owner);
    if (session.state.status === 'complete' || (prefix && session.state.start !== null))
      throw new Error('Canary already complete or spent.');
    ownsExecution = true;
    await session.start(command === 'resume', prefix ? invocationStart : clock.now());
    activeSignal = AbortSignal.any([activeSignal, session.controller.signal]);
    const cooldown = await cooldownFiles(plan.quotaPath, 'worker');
    const workerBudget = new ProviderBudget('worker', cooldown, clock);
    const apiBudget = new ProviderBudget('api', cooldown, clock);
    const transports = new Map<string, Transport>();
    for (const [chain, pair] of [
      [1, plan.profile.ethereum],
      [369, plan.profile.pulsechain],
    ] as const) {
      if (prefix && chain === 369) continue;
      for (const source of pair)
        transports.set(
          source.id,
          session.transport(
            chain,
            (options.transport ?? httpTransport)(env[source.endpointEnv]!),
            source.id,
          ),
        );
    }
    const price = plan.price ? new PriceReader(plan.price, plan.profile.contract) : null;
    const rpcPair = (chain: 1 | 369, budget = workerBudget) =>
      (chain === 1 ? plan.profile.ethereum : plan.profile.pulsechain).map(
        (s) =>
          new RpcClient(
            s.id,
            s.operator,
            chain,
            plan.profile.contract,
            transports.get(s.id)!,
            budget,
            chain === 369 && price ? priceTargets(price.profile) : undefined,
          ),
      ) as [RpcClient, RpcClient];
    const pair = (chain: 1 | 369) => {
      if (!sourcePairs.has(chain))
        sourcePairs.set(
          chain,
          profileSources(plan.profile, chain, (s) => transports.get(s.id)!, workerBudget),
        );
      return sourcePairs.get(chain)!;
    };
    const reader = await db();
    progressTimer = setInterval(
      () => console.log(JSON.stringify({ event: 'canary_progress', ...session!.state })),
      30000,
    );
    while (session.state.phase < plan.phases.length) {
      session.check();
      activeSignal.throwIfAborted();
      const phase = plan.phases[session.state.phase]!,
        begin = performance.now();
      const before = {
        http: session.state.http,
        logical: session.state.logical,
        observedBytes: session.state.observedBytes,
      };
      let result: unknown;
      if (phase.kind === 'capabilities') {
        const observed = [];
        for (const source of pair(phase.chain)) {
          await source.verify(phase.at, activeSignal);
          observed.push(await source.state(phase.at, activeSignal));
        }
        if (JSON.stringify(observed[0]) !== JSON.stringify(observed[1]))
          throw new Error('Canary pinned state disagreement.');
        result = {
          verifiedBoundary: phase.at,
          code: 'source-verified',
          stateAgreement: true,
          sources: pair(phase.chain).map((s) => ({ ...s.identity, binding: s.binding })),
        };
      } else if (phase.kind === 'probe') {
        const acquired = [];
        for (const source of pair(phase.chain)) {
          await source.verify(phase.previous, activeSignal);
          acquired.push(
            await source.acquire(
              { blockNumber: phase.previous.number, blockHash: phase.previous.hash, revision: '0' },
              phase.to,
              [],
              null,
              activeSignal,
            ),
          );
        }
        // Acquisition only: no writer/pretend origin or fabricated canonical checkpoint.
        const value = acquired.map(({ id: _id, operator: _operator, ...v }) => v);
        if (JSON.stringify(value[0]) !== JSON.stringify(value[1]))
          throw new Error('Canary acquisition disagreement.');
        result = {
          acquisitionOnly: true,
          from: phase.previous.number,
          through: acquired[0]!.headers.at(-1)!.number,
          requestedTo: phase.to,
          completeInterval: acquired[0]!.headers.at(-1)!.number === phase.to,
          events: acquired[0]!.events.length,
        };
      } else if (phase.kind === 'common-prefix') {
        const sources = pair(1);
        const stops = [];
        for (const source of sources)
          stops.push(plainHeader(await source.header(phase.through, activeSignal, true)));
        if (JSON.stringify(stops[0]) !== JSON.stringify(stops[1]))
          throw new Error('Common prefix stop header disagreement.');
        const stopAt = stops[0]!;
        for (const source of sources) await source.verify(stopAt, activeSignal);
        session.state.prefix!.stopHeader = stopAt;
        await session.save();
        const engine = new SyncEngine(
          writers.get(1)!,
          reader,
          sources,
          plan.storagePath,
          options.hooks,
        );
        const constructor = await engine.initializeConstructor(
          plan.profile.constructor.checkpoint,
          plan.profile.constructor.transactionHash,
          plan.profile.constructor.balances,
          activeSignal,
        );
        console.log(
          JSON.stringify({
            event: 'canary_constructor',
            constructor,
            cursor: await engine.cursor(),
          }),
        );
        await engine.once(activeSignal, stopAt);
        const cursor = await engine.cursor();
        if (
          !cursor ||
          cursor.block_number !== stopAt.number ||
          '0x' + cursor.block_hash.toString('hex') !== stopAt.hash
        )
          throw new Error('Common prefix did not reach exact stop.');
        await engine.audit(activeSignal);
        if ((await reader.query('SELECT chain_id FROM hdd.chains WHERE chain_id=369')).rows.length)
          throw new Error('Common prefix unexpectedly initialized native state.');
        result = { stopAt, audit: 'all-prefix-addresses', progress: engine.progress };
      } else if (phase.kind === 'replay') {
        const progress = [];
        for (const chain of [1, 369] as const) {
          if (chain === 369) {
            // Fork initialization needs the frozen parent lock on its own connection.
            // The worker role and PulseChain lock fence other operators during transfer.
            writerClients.get(1)!.removeAllListeners('end');
            await writers.get(1)!.close();
            writers.delete(1);
            if (
              !(await writerClients.get(369)!.query('SELECT pg_try_advisory_lock(4242,1) AS held'))
                .rows[0].held
            )
              throw new Error('Canary parent ownership transfer failed.');
          }
          const engine = new SyncEngine(
            writers.get(chain)!,
            reader,
            pair(chain),
            plan.storagePath,
            options.hooks,
          );
          if (!(await engine.cursor())) {
            if (chain === 1)
              await engine.initializeConstructor(
                plan.profile.constructor.checkpoint,
                plan.profile.constructor.transactionHash,
                plan.profile.constructor.balances,
                activeSignal,
              );
            else await engine.fork(plan.profile.fork.parent, plan.profile.fork.entry, activeSignal);
          }
          await engine.once(
            activeSignal,
            chain === 1 ? plan.profile.fork.parent : plan.profile.target,
          );
          await engine.audit(activeSignal);
          progress.push({ chain, ...engine.progress });
        }
        result = progress;
      } else if (phase.kind === 'metrics') {
        const metrics = new MetricsService(
          rpcPair(369),
          plan.profile.codeHash,
          price,
          new SqlMetricStore(reader),
          (source, sample) => capturePrice(reader, 369, source, sample),
        );
        await metrics.tick(activeSignal);
        result = { ...metrics.counters, priceConfigured: Boolean(price) };
      } else {
        const service = new AddressService(
          rpcPair(369, apiBudget)[0],
          plan.profile.codeHash,
          new SqlAddressBaseline(reader),
        );
        const page = await service.get(phase.address, activeSignal, phase.pageSize);
        result = { outcome: page.outcome, live: Boolean(page.live), counters: service.counters };
      }
      activeSignal.throwIfAborted();
      await session.completed({
        kind: phase.kind,
        wallMs: performance.now() - begin,
        http: session.state.http - before.http,
        logical: session.state.logical - before.logical,
        observedBytes: session.state.observedBytes - before.observedBytes,
        result,
      });
    }
    completed = true;
    return session.state;
  } catch (error) {
    primary = failure(error);
    if (
      ownsExecution &&
      session &&
      session.state.start !== null &&
      session.state.status !== 'complete'
    ) {
      session.state.reason = primary.slice(0, 160);
      return session.state;
    }
    throw error;
  } finally {
    if (progressTimer) clearInterval(progressTimer);
    const cleanup = async (work: () => Promise<unknown>) => {
      try {
        await work();
      } catch (e) {
        secondary.push(failure(e));
      }
    };
    await cleanup(async () => session?.close());
    for (const c of clients) c.removeAllListeners('end');
    for (const writer of writers.values()) await cleanup(() => writer.close());
    for (const c of clients) {
      c.removeAllListeners('end');
      await cleanup(() => c.end());
    }
    await cleanup(async () => options.cleanupHook?.());
    if (prefix) {
      // A spent common-prefix session cannot run/resume again. Publish completion
      // only after SQL clients and the filesystem leases have actually closed.
      await cleanup(async () => release?.());
      release = undefined;
    }
    if (ownsExecution && session?.state.start !== null && session) {
      if (prefix && (clock.now() >= deadline || controller.signal.aborted || signal.aborted))
        primary ??= failure(
          controller.signal.reason ??
            signal.reason ??
            new Error('Canary invocation elapsed cap reached.'),
        );
      if (session.state.prefix) {
        secondary.unshift(...session.state.prefix.secondary);
        session.state.prefix.secondary = secondary.slice(0, 16).map((s) => s.slice(0, 240));
        session.state.prefix.accounting = [...sourcePairs.values()].flat().map((s) => ({
          source: s.identity,
          rpc: s.rpc.counters,
          sourceCounters: s.counters,
          budget: s.rpc.budget.counters,
        }));
      }
      await cleanup(() =>
        session!.finish(
          completed && !primary && !secondary.length ? 'complete' : 'stopped',
          primary ?? secondary[0] ?? 'Bounded phases complete; no full feasibility claim.',
        ),
      );
    }
    await cleanup(async () => release?.());
    if (
      session?.state.start !== null &&
      session &&
      ownsExecution &&
      (secondary.length || (prefix && clock.now() >= deadline))
    ) {
      session.state.status = 'stopped';
      session.state.reason = (
        primary ??
        secondary[0] ??
        'Canary invocation elapsed cap reached during release.'
      ).slice(0, 160);
      if (session.state.prefix)
        session.state.prefix.secondary = secondary.slice(0, 16).map((s) => s.slice(0, 240));
      try {
        await session.save();
      } catch (e) {
        console.error(
          JSON.stringify({
            event: 'canary_finalization_failed',
            primary,
            secondary,
            error: failure(e),
          }),
        );
      }
    }
    if (invocationTimer) clearTimeout(invocationTimer);
    invocationSignal.removeEventListener('abort', cancelSql);
    if (secondary.length && !session) throw new Error(secondary.join('; '));
  }
}
