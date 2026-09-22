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
import { rpcDiagnostic } from '../providers/rpc-diagnostic.ts';
import {
  auditPhase,
  beginAuditSnapshot,
  inspectAuditTarget,
  canonicalEvidence,
  runPinnedAudit,
} from './canary-audit.ts';
import { atomicJson, reserve } from './files.ts';

export const canaryHelp =
  'canary check|prepare|status|run|resume <plan.json> [owner-approval.json]. Check is local; prepare requires a NEW empty v2 DB/Linux paths, except explicit pinned-audit retained read-only admission. One-shot common-prefix/pinned-audit cannot resume. Run/resume require separate owner approval, session opt-in and live opt-in. No providers by default.';
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
  const prefix = prefixPhase(plan),
    audit = auditPhase(plan),
    oneShot = prefix ?? audit;
  if (oneShot && command === 'run' && !options.transport) {
    const supplied = Number(env.HDD_V2_CANARY_INVOKED_AT);
    if (!Number.isSafeInteger(supplied) || supplied <= 0 || supplied > invocationStart)
      throw new Error('One-shot canary requires the canary-once host invocation clock.');
    invocationStart = supplied;
  }
  if (prefix && command === 'resume') throw new Error('Common prefix resume is not authorized.');
  if (audit && command === 'resume') throw new Error('Pinned audit resume is not authorized.');
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
      if (oneShot && urls.some((url, i) => url !== oneShot.endpoints[i]))
        throw new Error('One-shot canary endpoint URL mismatch.');
    }
  }
  const controller = new AbortController();
  let activeSignal = AbortSignal.any([signal, controller.signal]);
  let release: (() => Promise<void>) | undefined;
  const deadline = invocationStart + plan.caps.milliseconds;
  const invocationTimer =
    oneShot && command === 'run'
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
  let auditReader: Awaited<ReturnType<typeof connect>> | undefined;
  let auditOwner: Awaited<ReturnType<typeof connect>> | undefined;
  let admitted: Awaited<ReturnType<typeof inspectAuditTarget>> | undefined;
  const failure = (error: unknown) => {
    const detail = operatorError(error);
    return /https?:\/\//i.test(detail) ? 'Canary provider transport failed.' : detail;
  };
  const cancelSql = () => {
    for (const c of clients) void c.end().catch((e) => secondary.push(failure(e)));
  };
  const invocationSignal = activeSignal;
  invocationSignal.addEventListener('abort', cancelSql, { once: true });
  async function auditReserve() {
    await reserve(plan.storagePath);
    await reserve(plan.quotaPath);
  }
  async function db(role: 'api' | 'worker' = 'worker') {
    const c = await connect(databaseConfig(role, env), { signal: activeSignal });
    clients.push(c);
    c.on('error', () => controller.abort(new Error('Canary database ownership lost.')));
    c.on('end', () => controller.abort(new Error('Canary database connection ended.')));
    if (audit) await c.query('SET default_transaction_read_only = on');
    return c;
  }
  try {
    await CanarySession.checkAuditRoots(plan);
    release = await maintenanceLease([plan.storagePath, plan.quotaPath], activeSignal);
    if (command === 'status') return (await CanarySession.load(plan, clock)).state;
    if (audit && command === 'run') {
      session = await CanarySession.load(plan, clock, options.sessionHooks);
      if (session.state.start !== null || session.state.status !== 'prepared')
        throw Error('Pinned audit session already spent.');
    }
    if (audit) await auditReserve();
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
    if (audit) {
      auditOwner = owner;
      auditReader = await db('api');
      await beginAuditSnapshot(auditReader, Math.max(0, deadline - clock.now()));
      admitted = await inspectAuditTarget(auditReader, owner, plan.profile, audit.admission);
      if (
        admitted.inventoryDigest !== audit.inventoryDigest ||
        admitted.canonical.digest !== audit.canonicalDigest
      )
        throw Error('Pinned audit inventory/canonical digest mismatch.');
      await atomicJson(plan.storagePath, 'audit-before.json', admitted);
    }
    if (command === 'prepare') {
      if (!audit) await emptyTarget(owner);
      session = await CanarySession.prepare(plan, clock);
      return session.state;
    }
    session ??= await CanarySession.load(plan, clock, options.sessionHooks);
    if (command === 'run' && !audit) await emptyTarget(owner);
    if (session.state.status === 'complete' || (oneShot && session.state.start !== null))
      throw new Error('Canary already complete or spent.');
    ownsExecution = true;
    await session.start(command === 'resume', oneShot ? invocationStart : clock.now());
    activeSignal = AbortSignal.any([activeSignal, session.controller.signal]);
    const cooldown = await cooldownFiles(plan.quotaPath, 'worker');
    const workerBudget = new ProviderBudget('worker', cooldown, clock);
    const apiBudget = new ProviderBudget('api', cooldown, clock);
    const transports = new Map<string, Transport>();
    for (const [chain, pair] of [
      [1, plan.profile.ethereum],
      [369, plan.profile.pulsechain],
    ] as const) {
      if (oneShot && chain === 369) continue;
      for (const source of pair)
        transports.set(
          source.id,
          session.transport(
            chain,
            (options.transport ?? httpTransport)(env[source.endpointEnv]!),
            source.id,
            audit
              ? {
                  inventory: admitted!.inventory,
                  guard: async () => {
                    activeSignal.throwIfAborted();
                    await auditReserve();
                    const state = (
                      await auditReader!.query(
                        "SELECT current_setting('transaction_read_only') AS readonly,current_setting('transaction_isolation') AS isolation",
                      )
                    ).rows[0];
                    if (state.readonly !== 'on' || state.isolation !== 'repeatable read')
                      throw Error('Pinned audit snapshot lost.');
                    for (const [client, locks] of [
                      [
                        owner,
                        [
                          [4244, 0],
                          [4244, 1],
                          [4250, 0],
                        ],
                      ],
                      ...[1, 369].map((c) => [writerClients.get(c as 1 | 369)!, [[4242, c]]]),
                    ] as [Awaited<ReturnType<typeof connect>>, number[][]][]) {
                      const held = (
                        await client.query(
                          "SELECT classid::int AS a,objid::int AS b FROM pg_locks WHERE pid=pg_backend_pid() AND locktype='advisory' AND objsubid=2 AND granted",
                        )
                      ).rows;
                      if (locks.some(([a, b]) => !held.some((r) => r.a === a && r.b === b)))
                        throw Error('Pinned audit ownership lost.');
                    }
                    activeSignal.throwIfAborted();
                  },
                }
              : undefined,
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
          profileSources(
            plan.profile,
            chain,
            (s) => transports.get(s.id)!,
            workerBudget,
            prefix ? 2 * 1024 * 1024 : undefined,
          ),
        );
      return sourcePairs.get(chain)!;
    };
    const reader = auditReader ?? (await db());
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
      if (phase.kind === 'pinned-audit') {
        result = await runPinnedAudit(
          reader,
          pair(1),
          session,
          phase,
          admitted!.inventory,
          activeSignal,
        );
      } else if (phase.kind === 'capabilities') {
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
      const diagnostic = rpcDiagnostic(error);
      if (diagnostic) session.state.rpcDiagnostic = diagnostic;
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
    if (auditReader && auditOwner && admitted) {
      await cleanup(async () => {
        // End the provider-wait snapshot, then read a fresh snapshot while ALL
        // exclusions remain held. A same-snapshot comparison proves nothing.
        await auditReader!.query('ROLLBACK');
        await beginAuditSnapshot(auditReader!, Math.max(0, deadline - clock.now()));
        const after = await canonicalEvidence(auditReader!, auditOwner!);
        await atomicJson(plan.storagePath, 'audit-after.json', after);
        if (session?.state.audit) {
          session.state.audit.after = after.digest;
          session.state.audit.unchanged = after.digest === admitted!.canonical.digest;
        }
        if (after.digest !== admitted!.canonical.digest)
          throw Error('Pinned audit canonical state changed.');
        await auditReader!.query('ROLLBACK');
      });
    }
    for (const c of clients) c.removeAllListeners('end');
    for (const writer of writers.values()) await cleanup(() => writer.close());
    for (const c of clients) {
      c.removeAllListeners('end');
      await cleanup(() => c.end());
    }
    await cleanup(async () => options.cleanupHook?.());
    if (audit && ownsExecution) await cleanup(auditReserve);
    if (oneShot) {
      // A spent common-prefix session cannot run/resume again. Publish completion
      // only after SQL clients and the filesystem leases have actually closed.
      await cleanup(async () => release?.());
      release = undefined;
    }
    if (ownsExecution && session?.state.start !== null && session) {
      if (oneShot && (clock.now() >= deadline || controller.signal.aborted || signal.aborted))
        primary ??= failure(
          controller.signal.reason ??
            signal.reason ??
            new Error('Canary invocation elapsed cap reached.'),
        );
      const oneShotState = session.state.audit ?? session.state.prefix;
      if (oneShotState) {
        secondary.unshift(...oneShotState.secondary);
        oneShotState.secondary = secondary.slice(0, 16).map((s) => s.slice(0, 240));
        oneShotState.accounting = [...sourcePairs.values()].flat().map((s) => ({
          source: s.identity,
          rpc: s.rpc.counters,
          sourceCounters: s.counters,
          budget: s.rpc.budget.counters,
        }));
      }
      await cleanup(async () => {
        if (session!.state.rpcDiagnostic) session!.state.diagnosticPersistence = 'saved';
        try {
          await session!.finish(
            completed && !primary && !secondary.length ? 'complete' : 'stopped',
            primary ?? secondary[0] ?? 'Bounded phases complete; no full feasibility claim.',
          );
        } catch (e) {
          if (session!.state.rpcDiagnostic) session!.state.diagnosticPersistence = 'failed';
          throw e;
        }
      });
    }
    await cleanup(async () => release?.());
    if (
      session?.state.start !== null &&
      session &&
      ownsExecution &&
      (secondary.length || (oneShot && clock.now() >= deadline))
    ) {
      session.state.status = 'stopped';
      if (oneShot) session.state.terminal = true;
      session.state.reason = (
        primary ??
        secondary[0] ??
        'Canary invocation elapsed cap reached during release.'
      ).slice(0, 160);
      const oneShotState = session.state.audit ?? session.state.prefix;
      if (oneShotState) oneShotState.secondary = secondary.slice(0, 16).map((s) => s.slice(0, 240));
      try {
        if (session.state.rpcDiagnostic) session.state.diagnosticPersistence = 'saved';
        await session.save();
      } catch (e) {
        if (session.state.rpcDiagnostic) session.state.diagnosticPersistence = 'failed';
        console.error(
          JSON.stringify({
            event: 'canary_finalization_failed',
            primary,
            secondary,
            error: failure(e),
            rpcDiagnostic: session.state.rpcDiagnostic,
            diagnosticPersistence: session.state.diagnosticPersistence,
          }),
        );
      }
    }
    if (invocationTimer) clearTimeout(invocationTimer);
    invocationSignal.removeEventListener('abort', cancelSql);
    if (secondary.length && (!session || (audit && !ownsExecution)))
      throw new Error(secondary.join('; '));
  }
}
