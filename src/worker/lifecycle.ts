import type { Clock } from '../providers/budget.ts';

/** One active tick and at most one pending tick, independent of native replay/audit. */
export class MetricsJob {
  readonly clock: Clock;
  readonly tick: (signal: AbortSignal) => Promise<unknown>;
  readonly counters = { scheduled: 0, coalesced: 0, failures: 0 };
  private running: Promise<void> | undefined;
  private pending = false;
  private started = false;
  constructor(clock: Clock, tick: (signal: AbortSignal) => Promise<unknown>) {
    this.clock = clock;
    this.tick = tick;
  }
  private request(signal: AbortSignal) {
    this.counters.scheduled++;
    if (this.running) {
      this.pending = true;
      this.counters.coalesced++;
      return;
    }
    this.running = (async () => {
      do {
        this.pending = false;
        try {
          await this.tick(signal);
        } catch {
          if (!signal.aborted) this.counters.failures++;
        }
      } while (this.pending && !signal.aborted);
    })().finally(() => {
      this.running = undefined;
    });
  }
  async run(signal: AbortSignal) {
    if (this.started) throw new Error('Metrics recurring job already started.');
    this.started = true;
    try {
      this.request(signal);
      while (!signal.aborted) {
        await this.clock.sleep(60000, signal);
        if (!signal.aborted) this.request(signal);
      }
    } catch (error) {
      if (!signal.aborted) throw error;
    } finally {
      await this.running;
      this.pending = false;
      this.started = false;
    }
  }
}
export async function runWorkerLifecycle<T>(
  work: (signal: AbortSignal) => Promise<T>,
  metrics: MetricsJob,
  signal: AbortSignal,
  keepMetricsOnNativeFailure = false,
  background: MetricsJob[] = [],
): Promise<T> {
  const controller = new AbortController();
  const combined = AbortSignal.any([signal, controller.signal]);
  let jobFailure: unknown;
  const recurring = Promise.all([metrics, ...background].map((job) => job.run(combined))).catch(
    (error) => {
      jobFailure = error;
      controller.abort(error);
    },
  );
  try {
    let value: T;
    try {
      value = await work(combined);
    } catch (error) {
      if (!keepMetricsOnNativeFailure || combined.aborted) throw error;
      // Watch stops the conflicted native stream without a retry storm. Its progress
      // retains the original error; unrelated observations continue until shutdown.
      try {
        while (true) await metrics.clock.sleep(60000, combined);
      } catch {
        throw error;
      }
    }
    if (jobFailure) throw jobFailure;
    return value;
  } finally {
    controller.abort(new Error('Worker lifecycle stopped.'));
    await recurring;
  }
}
