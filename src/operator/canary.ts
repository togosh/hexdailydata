import { connect, databaseConfig } from '../db/connect.ts';
import { performance } from 'node:perf_hooks';
import { realClock, ProviderBudget, type Clock } from '../providers/budget.ts';
import { cooldownFiles } from '../providers/cooldown.ts';
import { httpTransport, RpcClient, type Transport } from '../providers/rpc.ts';
import { Source } from '../providers/source.ts';
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
  } = {},
) {
  const [command, planPath, approvalPath] = args;
  if (command === 'help' || command === '--help' || !command) return { help: canaryHelp };
  if (!['check', 'prepare', 'status', 'run', 'resume'].includes(command) || !planPath)
    throw new Error(canaryHelp);
  const input = await readCanaryJson(planPath);
  if (command === 'check') return checkCanary(input);
  const plan = canaryPlanSchema.parse(input),
    env = options.env ?? process.env,
    clock = options.clock ?? realClock;
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
    }
  }
  const controller = new AbortController();
  let activeSignal = AbortSignal.any([signal, controller.signal]);
  const release = await maintenanceLease([plan.storagePath, plan.quotaPath], activeSignal);
  const clients: Awaited<ReturnType<typeof connect>>[] = [];
  let session: CanarySession | undefined;
  const writers = new Map<1 | 369, CanonicalWriter>();
  const writerClients = new Map<1 | 369, Awaited<ReturnType<typeof connect>>>();
  let progressTimer: NodeJS.Timeout | undefined;
  async function db() {
    const c = await connect(databaseConfig('worker', env), { signal: activeSignal });
    clients.push(c);
    c.on('error', () => controller.abort(new Error('Canary database ownership lost.')));
    c.on('end', () => controller.abort(new Error('Canary database connection ended.')));
    return c;
  }
  try {
    if (command === 'status') return (await CanarySession.load(plan, clock)).state;
    const owner = await db();
    if (
      (await owner.query('SELECT version FROM hdd.schema_migrations ORDER BY version')).rows
        .map((r) => r.version)
        .join(',') !== '1,2,3,4'
    )
      throw new Error('Canary requires schema4.');
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
    session = await CanarySession.load(plan, clock);
    if (command === 'run') await emptyTarget(owner);
    await session.start(command === 'resume');
    activeSignal = AbortSignal.any([activeSignal, session.controller.signal]);
    const cooldown = await cooldownFiles(plan.quotaPath, 'worker');
    const workerBudget = new ProviderBudget('worker', cooldown, clock);
    const apiBudget = new ProviderBudget('api', cooldown, clock);
    const transports = new Map<string, Transport>();
    for (const [chain, pair] of [
      [1, plan.profile.ethereum],
      [369, plan.profile.pulsechain],
    ] as const)
      for (const source of pair)
        transports.set(
          source.id,
          session.transport(chain, (options.transport ?? httpTransport)(env[source.endpointEnv]!)),
        );
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
    const pair = (chain: 1 | 369) =>
      rpcPair(chain).map(
        (rpc) =>
          new Source(rpc, {
            codeHash: plan.profile.codeHash,
            finality: plan.profile.policy,
            completeness: 'filtered-ranges',
          }),
      ) as [Source, Source];
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
        result = { verifiedBoundary: phase.at, code: 'source-verified', stateAgreement: true };
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
    await session.finish('complete', 'Bounded phases complete; no full feasibility claim.');
    return session.state;
  } catch (error) {
    if (session && session.state.start !== null && session.state.status !== 'complete') {
      const detail = operatorError(error);
      const reason = session.controller.signal.aborted
        ? String(session.controller.signal.reason?.message)
        : signal.aborted
          ? 'Canary cancelled.'
          : /https?:\/\//i.test(detail)
            ? 'Canary provider transport failed.'
            : detail;
      await session.finish('stopped', reason);
      return session.state;
    }
    throw error;
  } finally {
    if (progressTimer) clearInterval(progressTimer);
    await session?.close();
    for (const c of clients) c.removeAllListeners('end');
    for (const writer of writers.values()) await writer.close().catch(() => {});
    for (const c of clients) {
      c.removeAllListeners('end');
      await c.end().catch(() => {});
    }
    await release();
  }
}
