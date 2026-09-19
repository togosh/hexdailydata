import limits from '../../config/limits.json' with { type: 'json' };

export type Lane = 'address' | 'metrics' | 'sync';
export interface Clock {
  now(): number;
  sleep(ms: number, signal: AbortSignal): Promise<void>;
}
export const realClock: Clock = {
  now: Date.now,
  sleep(ms, signal) {
    return new Promise((resolve, reject) => {
      signal.throwIfAborted();
      const abort = () => {
        clearTimeout(timer);
        reject(signal.reason);
      };
      const timer = setTimeout(() => {
        signal.removeEventListener('abort', abort);
        resolve();
      }, ms);
      signal.addEventListener('abort', abort, { once: true });
    });
  },
};
export interface CooldownStore {
  read(): Promise<number>;
  extend(until: number): Promise<void>;
}
interface Job<T> {
  lane: Lane;
  logical: number;
  deadline: number;
  signal: AbortSignal;
  work: () => Promise<T>;
  resolve: (v: T) => void;
  reject: (e: unknown) => void;
}
const allocations = limits.provider.aggregateBudget.lanes;
// Disjoint epoch slots enforce spacing across ONE API + ONE worker, even on a shared
// account. 100ms dispatch tolerance + 2100ms slots leaves at least 2000ms separation.
const slots: Lane[] = ['address', 'sync', 'address', 'metrics', 'sync'];
const slotMs = 2100,
  tolerance = 100,
  windowMs = 60_000;
export class ProviderBudget {
  private queue: Job<unknown>[] = [];
  private active = false;
  private started: number;
  private used: Record<Lane, { at: number; logical: number }[]> = {
    address: [],
    metrics: [],
    sync: [],
  };
  private lastSlot = -1;
  readonly counters = { attempts: 0, logical: 0, waitingMs: 0, cooldownMs: 0, queuePeak: 0 };
  readonly role: 'api' | 'worker';
  readonly cooldown: CooldownStore;
  readonly clock: Clock;
  constructor(role: 'api' | 'worker', cooldown: CooldownStore, clock: Clock = realClock) {
    this.role = role;
    this.cooldown = cooldown;
    this.clock = clock;
    this.started = clock.now();
  }
  run<T>(
    lane: Lane,
    logical: number,
    deadline: number,
    signal: AbortSignal,
    work: () => Promise<T>,
  ): Promise<T> {
    if (
      (this.role === 'api') !== (lane === 'address') ||
      !Number.isSafeInteger(logical) ||
      logical < 1 ||
      logical > allocations[lane].logicalRpcCalls
    )
      return Promise.reject(new Error('Invalid role/lane/logical reservation.'));
    if (signal.aborted) return Promise.reject(signal.reason);
    if (this.queue.length >= limits.provider.maximumQueuedHttpPerProcess)
      return Promise.reject(new Error('Provider queue saturated.'));
    return new Promise<T>((resolve, reject) => {
      const job: Job<unknown> = {
        lane,
        logical,
        deadline,
        signal,
        work,
        resolve: resolve as (v: unknown) => void,
        reject,
      };
      this.queue.push(job);
      this.counters.queuePeak = Math.max(this.counters.queuePeak, this.queue.length);
      void this.drain();
    });
  }
  async backoff(until: number) {
    await this.cooldown.extend(until);
  }
  private async drain() {
    if (this.active) return;
    this.active = true;
    try {
      while (this.queue.length) {
        // Re-evaluate priority after every wait; new metrics can precede undispatched sync.
        this.queue.sort((a, b) => Number(b.lane === 'metrics') - Number(a.lane === 'metrics'));
        const job = this.queue[0]!;
        try {
          job.signal.throwIfAborted();
          const cooldown = await this.cooldown.read();
          const now = this.clock.now();
          if (now >= job.deadline) throw new Error('Provider deadline expired in queue.');
          const used = (this.used[job.lane] = this.used[job.lane].filter(
            (x) => x.at > now - windowMs,
          ));
          let earliest = Math.max(now, this.started + windowMs, cooldown);
          if (
            used.length >= allocations[job.lane].httpAttempts ||
            used.reduce((n, x) => n + x.logical, 0) + job.logical >
              allocations[job.lane].logicalRpcCalls
          )
            earliest = Math.max(earliest, used[0]!.at + windowMs);
          let slot = Math.max(Math.floor(earliest / slotMs), this.lastSlot + 1);
          if (earliest - slot * slotMs > tolerance) slot++;
          while (slots[slot % slots.length] !== job.lane) slot++;
          const at = Math.max(slot * slotMs, earliest);
          if (at >= job.deadline) throw new Error('Provider work cannot meet deadline.');
          if (at > now) {
            const wait = Math.min(at - now, 1000);
            this.counters.waitingMs += wait;
            if (cooldown > now) this.counters.cooldownMs += wait;
            await this.clock.sleep(wait, job.signal);
            continue;
          }
          const dispatchAt = this.clock.now();
          if (dispatchAt > slot * slotMs + tolerance || dispatchAt >= job.deadline) continue;
          job.signal.throwIfAborted();
          this.queue.shift();
          this.lastSlot = slot;
          used.push({ at: dispatchAt, logical: job.logical });
          this.counters.attempts++;
          this.counters.logical += job.logical;
          // Charged work is never refunded after timeout, cancellation or transport failure.
          try {
            job.resolve(await job.work());
          } catch (error) {
            job.reject(error);
          }
        } catch (error) {
          this.queue.splice(this.queue.indexOf(job), 1);
          job.reject(error);
        }
      }
    } finally {
      this.active = false;
    }
  }
}
