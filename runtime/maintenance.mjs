import { maintenancePool } from './maintenance-pool.mjs';

const bound = (value, low, high, label) => {
  if (!Number.isInteger(value) || value < low || value > high) throw Error(label);
  return value;
};
const failure = error => ({ state: 'failed', reason: error?.message === 'MAINTENANCE_DEADLINE' ? 'deadline' : 'component_unavailable' });

// One operational maintenance worker. Cross-process payment fencing, reminders'
// deduplication and financial authority stay in the accepted modules.
export function createMaintenance({ account, pool, meter, verify, clock, capture,
  requireDailyPolicy, batchSize = 32, receiptLimit = 128, maintenanceMs = 5000, intervalMs = 60000 }) {
  bound(batchSize, 1, 32, 'REMINDER_BATCH_BOUND');
  bound(receiptLimit, 1, 128, 'RECEIPT_BATCH_BOUND');
  bound(maintenanceMs, 10, 5000, 'MAINTENANCE_TIME_BOUND');
  bound(intervalMs, 10, 60000, 'CYCLE_INTERVAL_BOUND');
  if (meter.mode !== 'period') throw Error('PERIOD_METER_REQUIRED');
  if (capture && (capture.kind !== 'local-capture' || typeof capture.send !== 'function'))
    throw Error('LOCAL_CAPTURE_REQUIRED');
  let cursor = '', running, timer, endTimer, stopped = false, scheduling = false;
  let lifecycle = 'created';
  let status = { state: 'idle', cycles: 0 };
  let cancelAncillary, finishFinite, starting;
  const pendingSend = new Set();

  async function cycle() {
    status = { state: 'running', cycles: status.cycles + 1,
      payment: { state: 'pending' }, meter: { state: 'pending' },
      reminders: { state: 'pending' }, mail: { state: 'pending' } };
    try {
      const result = await verify();
      status.payment = { state: result.budget ? 'budget_unavailable' : result.completed && !result.reason ? 'complete' : result.busy ? 'busy' : result.paused ? 'paused' : 'incomplete', result };
    } catch (error) { status.payment = failure(error); }
    // A payment failure does not prevent ordinary receipt cleanup.
    if (stopped) {
      for (const key of ['meter', 'reminders', 'mail']) status[key] = { state: 'stopped' };
    } else {
      cancelAncillary = new AbortController();
      const scope = maintenancePool(pool, { signal: cancelAncillary.signal, milliseconds: maintenanceMs });
      try {
        try { status.meter = { state: 'complete', result: await meter.maintain(receiptLimit, { signal: scope.signal, deadline: scope.deadline }) }; }
        catch (error) { status.meter = failure(error); }
        try {
          const rows = (await scope.pool.query(`SELECT c.id FROM customer c
            JOIN account_access a ON a.account_id=c.id
            WHERE c.id>$1 AND NOT c.disabled AND a.current_email IS NOT NULL
            ORDER BY c.id LIMIT $2`, [cursor, batchSize])).rows;
          const result = { selected: rows.length, visited: 0, queued: 0, failed: 0 };
          for (const row of rows) {
            if (stopped || scope.signal.aborted) break;
            cursor = row.id;
            result.visited++;
            try { result.queued += (await account.queueCalendarExpiry(scope.pool, [row.id], clock)).queued; }
            catch { result.failed++; }
          }
          if (result.visited === rows.length && rows.length < batchSize) cursor = '';
          status.reminders = { state: scope.signal.aborted || result.failed ? 'incomplete' : 'complete', result };
        } catch (error) { status.reminders = failure(error); }
        if (!capture) status.mail = { state: 'disabled' };
        else if (pendingSend.size) status.mail = { state: 'busy', pending: pendingSend.size };
        else try {
          await account.deliverOutbox(scope.pool, async message => {
            if (scope.signal.aborted || stopped) throw Error('MAINTENANCE_DEADLINE');
            if (!/^[^@]+@example[.]test$/.test(message.to)) throw Error('LOCAL_RECIPIENT_REQUIRED');
            const controller = new AbortController();
            const signal = AbortSignal.any([scope.signal, controller.signal]);
            const send = Promise.resolve().then(() => capture.send(message, { signal }));
            pendingSend.add(send);
            void send.then(() => pendingSend.delete(send), () => pendingSend.delete(send));
            let timeout;
            try {
              await Promise.race([send, new Promise((_, reject) => {
                timeout = setTimeout(() => { controller.abort(); reject(Error('LOCAL_CAPTURE_TIMEOUT')); }, Math.max(1, Math.min(500, scope.deadline - performance.now())));
              })]);
            } finally { clearTimeout(timeout); }
          }, () => stopped || scope.signal.aborted, clock);
          const row = (await scope.pool.query(`SELECT count(*) FILTER(WHERE attempts>=8)::int parked,
            count(*) FILTER(WHERE attempts<8)::int pending FROM outbox
            WHERE delivered_at IS NULL AND cancelled_at IS NULL`)).rows[0];
          status.mail = { state: row.pending || row.parked || pendingSend.size ? 'pending' : 'complete', ...row, inFlight: pendingSend.size };
        } catch (error) { status.mail = failure(error); }
      } finally { await scope.close(); cancelAncillary = undefined; }
    }
    status.state = ['payment', 'meter', 'reminders', 'mail'].every(k => ['complete', 'disabled'].includes(status[k].state)) ? 'complete' : 'degraded';
    return structuredClone(status);
  }
  function runOnce() {
    if (stopped) return Promise.resolve({ state: 'stopped' });
    if (running) return Promise.resolve({ state: 'busy' });
    lifecycle = 'running';
    running = cycle().finally(() => { running = undefined; });
    return running;
  }
  function stopScheduling() {
    stopped = true; scheduling = false; lifecycle = 'stopping';
    clearTimeout(timer); clearTimeout(endTimer);
    cancelAncillary?.abort();
  }
  async function stop() {
    stopScheduling();
    await Promise.allSettled([starting, running]);
    await Promise.allSettled([...pendingSend]);
    lifecycle = 'stopped';
    const result = { state: 'stopped', cycles: status.cycles, pendingSend: pendingSend.size };
    finishFinite?.resolve(result);
    return result;
  }
  function start({ durationMs } = {}) {
    bound(durationMs, 1, 2400000, 'FINITE_WORKER_DURATION_REQUIRED');
    if (stopped || scheduling) throw Error('WORKER_ALREADY_STARTED_OR_STOPPED');
    scheduling = true;
    const end = performance.now() + durationMs;
    const schedule = () => {
      if (stopped || performance.now() >= end) return;
      timer = setTimeout(async () => {
        if (stopped || performance.now() >= end) return;
        try { await runOnce(); }
        catch { status = { ...status, state: 'failed' }; }
        if (!stopped) schedule();
      }, Math.min(intervalMs, Math.max(1, end - performance.now())));
    };
    schedule();
    let resolve, reject;
    const done = new Promise((yes, no) => { resolve = yes; reject = no; });
    finishFinite = { resolve, reject };
    endTimer = setTimeout(() => { void stop().then(resolve, reject); }, durationMs);
    // stop() also ends a finite wrapper called before its timer fires.
    return { done, deadline: end };
  }
  async function startService() {
    if (stopped || scheduling) throw Error('WORKER_ALREADY_STARTED_OR_STOPPED');
    if (typeof requireDailyPolicy !== 'function') throw Error('DAILY_POLICY_REQUIRED');
    // Claim scheduling before awaiting SQL; a concurrent start cannot overlap.
    scheduling = true;
    starting = Promise.resolve().then(() => requireDailyPolicy());
    try { await starting; }
    catch (error) { scheduling = false; throw error; }
    finally { starting = undefined; }
    if (stopped) throw Error('WORKER_STOPPED');
    lifecycle = 'running';
    const schedule = () => {
      if (stopped) return;
      timer = setTimeout(async () => {
        if (stopped) return;
        try { await runOnce(); }
        catch { status = { ...status, state: 'failed' }; }
        schedule(); // Delay from completion: no overlap or catch-up queue.
      }, intervalMs);
    };
    schedule();
    return { mode: 'service' };
  }
  return { runOnce, start, startService, stop, stopScheduling,
    status: () => structuredClone({ ...status, lifecycle, activeCycle: !!running, scheduling }) };

}
