import { createMaintenance } from './maintenance.mjs';

// Explicit runtime wiring only. The caller performs guarded migrations, publishes
// fixture prices separately and supplies the actual analytics/export dependencies.
export function createPaidService({ account, serving, delivery, config, pool,
  profile, sources, clock, dependencies, webRoot, accountWebRoot, now,
  capture, verifierOptions = {}, maintenanceOptions = {}, accountOptions = {} }) {
  if (config.mode !== 'isolated-lab' || profile.synthetic !== true || profile.origin !== config.origin)
    throw Error('ISOLATED_PROFILE_WIRING_REQUIRED');
  if (!Array.isArray(sources) || sources.length !== 2 || sources.some(v => typeof v !== 'function'))
    throw Error('TWO_RAW_SOURCES_REQUIRED');
  if (!(pool.options?.connectionTimeoutMillis > 0 && pool.options.connectionTimeoutMillis <= 3000) ||
      !(pool.options?.statement_timeout > 0 && pool.options.statement_timeout <= 5000))
    throw Error('BOUNDED_ACCOUNT_POOL_REQUIRED');
  if (typeof clock !== 'function' || typeof dependencies.close !== 'function')
    throw Error('EXPLICIT_CLOCK_AND_RESOURCE_CLOSE_REQUIRED');
  for (const [name, ceiling] of Object.entries({ readMs: 5000, tickMs: 30000, maxReads: 80, maxBytes: 16777216, maxJobs: 10 })) {
    const value = verifierOptions[name];
    if (value !== undefined && (!Number.isInteger(value) || value < 1 || value > ceiling))
      throw Error('VERIFIER_OPTION_BOUND');
  }
  const payments = new account.HexPayments(pool, profile, { clock });
  const verifier = new account.HexVerifier(payments, sources, verifierOptions);
  const meter = new account.SuccessMeter(pool, { mode: 'period', clock });
  let configured = false, firstFreshCycle = false, lifecycle = 'created';
  let stoppedTask, stoppedBound, startupTask;
  const worker = createMaintenance({ ...maintenanceOptions, account, pool, meter, clock, capture,
    requireDailyPolicy: () => payments.requireDailyPolicy(verifierOptions.dailySources),
    verify: async () => {
      if (!configured) {
        await account.guard(pool, config);
        await payments.configure();
        configured = true;
      }
      const result = await verifier.tick();
      if (result.completed && !result.reason) firstFreshCycle = true;
      return result;
    },
  });
  // Keep existing account operations and invoice ownership intact. Issuance is
  // unavailable until this runtime has validated wiring and observed freshness;
  // thereafter HexPayments' persisted freshness/pause check remains authoritative.
  const customerPayments = new Proxy(payments, {
    get(target, name) {
      if (name === 'issue') return (...args) => {
        if (!firstFreshCycle) throw new account.Denied('PAYMENT_SOURCE_UNAVAILABLE', 503);
        return target.issue(...args);
      };
      const value = Reflect.get(target, name);
      return typeof value === 'function' ? value.bind(target) : value;
    },
  });
  // Defer resource closure until both HTTP finalization and the worker drain.
  const { close: closeData, ...reads } = dependencies;
  const app = delivery.composePaidApp({ serving, account, config, pool,
    payments: customerPayments, dependencies: reads, webRoot, accountWebRoot,
    now, meter, accountOptions });

  function stop() {
    if (stoppedBound) return stoppedBound;
    lifecycle = 'stopping';
    worker.stopScheduling();
    stoppedTask = (async () => {
      // Startup/policy/listen work is admitted work too. Its raw promise never
      // awaits stop(), so this drain cannot depend on its own completion.
      await Promise.allSettled([startupTask]);
      const outcomes = await Promise.allSettled([app.close(), worker.stop()]);
      const failures = outcomes.filter(v => v.status === 'rejected').map(v => v.reason);
      try { await meter.drain(); } catch (error) { failures.push(error); }
      // No account/analytics pool is closed while admitted worker work is active.
      for (const close of [() => closeData.call(dependencies), () => pool.end()]) {
        try { await close(); } catch (error) { failures.push(error); }
      }
      lifecycle = failures.length ? 'failed' : 'stopped';
      if (failures.length) throw new AggregateError(failures, 'SERVICE_DRAIN_FAILED');
      return { state: 'stopped', worker: worker.status(), meterPending: meter.pendingWork() };
    })();
    let timer;
    stoppedBound = Promise.race([stoppedTask, new Promise((_, reject) => {
      timer = setTimeout(() => reject(Error('SERVICE_SHUTDOWN_BOUND_45_SECONDS')), 45000);
    })]).finally(() => clearTimeout(timer));
    return stoppedBound;
  }
  function start({ host = '127.0.0.1', port, workerForMs, workerMode } = {}) {
    if (lifecycle !== 'created') throw Error('SERVICE_ALREADY_STARTED_OR_STOPPED');
    if ((workerMode !== undefined && workerMode !== 'service') || (workerMode === 'service' && workerForMs !== undefined))
      throw Error('INCOMPATIBLE_WORKER_OPTIONS');
    if (workerForMs !== undefined && (!Number.isInteger(workerForMs) || workerForMs < 1 || workerForMs > 2400000))
      throw Error('FINITE_WORKER_DURATION_REQUIRED');
    lifecycle = 'starting';
    startupTask = (async () => {
      if (workerMode === 'service') {
        await account.guard(pool, config);
        await payments.requireDailyPolicy(verifierOptions.dailySources);
      }
      if (lifecycle !== 'starting') throw Error('SERVICE_STOPPED');
      const startup = await worker.runOnce();
      if (lifecycle !== 'starting') throw Error('SERVICE_STOPPED');
      await app.listen({ host, port });
      if (lifecycle !== 'starting') { await app.close(); throw Error('SERVICE_STOPPED'); }
      lifecycle = 'running';
      if (workerMode === 'service') await worker.startService();
      if (workerForMs !== undefined) {
        const finite = worker.start({ durationMs: workerForMs });
        void finite.done.then(() => stop()).catch(() => { lifecycle = 'failed'; });
      }
      return { state: 'running', startup };
    })();
    return startupTask.catch(async error => { await stop(); throw error; });
  }
  return { app, payments, verifier, meter, worker, start, stop,
    status: () => ({ lifecycle, configured, firstFreshCycle, worker: worker.status() }),
    // After a reported shutdown deadline the outer owner must still settle this
    // task, or terminate only its exact owned process. No half-commit force-close.
    drained: () => stoppedTask ?? Promise.resolve() };
}
