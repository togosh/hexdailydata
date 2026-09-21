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
  onDispatch?: () => void;
  resolve: (v: T) => void;
  reject: (e: unknown) => void;
}
const allocations = limits.provider.aggregateBudget.lanes;
// Disjoint epoch slots enforce spacing across ONE API + ONE worker, even on a shared
// account. The configured minimum plus tolerance defines the slot width: a late
// dispatch in one slot is still at least that minimum before the next slot starts.
const tolerance = 100;
export const providerCalendar = {
  slots: ['address', 'sync', 'address', 'metrics', 'address', 'sync', 'address'] as readonly Lane[],
  toleranceMilliseconds: tolerance,
  slotMilliseconds: limits.provider.defaultMinimumDispatchMilliseconds + tolerance,
};
const slots = providerCalendar.slots,
  slotMs = providerCalendar.slotMilliseconds,
  windowMs = limits.provider.aggregateBudget.windowSeconds * 1000;
export class ProviderBudget {
  private reserved = { http: 0, logical: 0 };
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
    onDispatch?: () => void,
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
        ...(onDispatch ? { onDispatch } : {}),
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
  /** Reserve one entire public job, including retry headroom, before discovery.
   * Actual dispatch consumes the reservation; completion releases only unused work.
   */
  async addressRequest(deadline: number, minimumAttempts: number, signal: AbortSignal) {
    signal.throwIfAborted();
    if (this.role !== 'api') throw new Error('Address reservation requires API role.');
    if (
      !Number.isSafeInteger(deadline) ||
      deadline > this.clock.now() + 10000 ||
      !Number.isInteger(minimumAttempts) ||
      minimumAttempts < 1 ||
      minimumAttempts > 4
    )
      throw new Error('Invalid address deadline or work plan.');
    const cooldown = await this.cooldown.read();
    signal.throwIfAborted();
    const now = this.clock.now();
    const used = this.used.address.filter((x) => x.at > now - windowMs);
    const cap = limits.addressReads;
    if (
      used.length + this.reserved.http + cap.maximumHttpAttemptsPerRequest >
        allocations.address.httpAttempts ||
      used.reduce((n, x) => n + x.logical, 0) +
        this.reserved.logical +
        cap.maximumLogicalRpcCallsPerRequest >
        allocations.address.logicalRpcCalls
    )
      throw new Error('Address quota reservation unavailable.');
    let earliest = Math.max(now, this.started + windowMs, cooldown);
    let slot = Math.max(Math.floor(earliest / slotMs), this.lastSlot + 1);
    if (earliest - slot * slotMs > tolerance) slot++;
    // Existing queued work must fit too. No optimistic deadline renewal later.
    for (let i = 0; i < minimumAttempts + this.queue.length; i++) {
      while (slots[slot % slots.length] !== 'address') slot++;
      earliest = Math.max(earliest, slot * slotMs);
      slot++;
    }
    if (earliest >= deadline) throw new Error('Address work cannot meet deadline.');
    let http = cap.maximumHttpAttemptsPerRequest;
    let logical = cap.maximumLogicalRpcCallsPerRequest;
    let closed = false;
    this.reserved.http += http;
    this.reserved.logical += logical;
    const counters = { http: 0, logical: 0 };
    return {
      deadline,
      counters,
      check(count: number) {
        if (closed || http < 1 || logical < count)
          throw new Error('Address request work cap exceeded.');
      },
      charge: (count: number) => {
        if (closed || http < 1 || logical < count)
          throw new Error('Address request work cap exceeded.');
        http--;
        logical -= count;
        counters.http++;
        counters.logical += count;
        this.reserved.http--;
        this.reserved.logical -= count;
      },
      close: () => {
        if (closed) return;
        closed = true;
        this.reserved.http -= http;
        this.reserved.logical -= logical;
      },
    };
  }
  private async drain() {
    if (this.active) return;
    this.active = true;
    try {
      while (this.queue.length) {
        // Re-evaluate priority after every wait; new metrics can precede undispatched sync.
        this.queue.sort((a, b) => Number(b.lane === 'metrics') - Number(a.lane === 'metrics'));
        let job = this.queue[0]!;
        try {
          job.signal.throwIfAborted();
          const cooldown = await this.cooldown.read();
          this.queue.sort((a, b) => Number(b.lane === 'metrics') - Number(a.lane === 'metrics'));
          job = this.queue[0]!;
          job.signal.throwIfAborted();
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
          job.onDispatch?.();
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
