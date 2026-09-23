import { realClock, type Clock, type CooldownStore } from '../providers/budget.ts';
import { atomicJson } from './files.ts';
import { readCanaryJson } from './canary-plan.ts';
import { cooldownFiles } from '../providers/cooldown.ts';

const ms = 1_000_000n;
const maximum = BigInt(Number.MAX_SAFE_INTEGER) * ms;
export interface ClockSamples {
  wall(): unknown;
  monotonic(): unknown;
  sleep?: Clock['sleep'];
}
export const clockValue = (value: unknown) => ({
  type: typeof value,
  value:
    typeof value === 'number' || typeof value === 'bigint'
      ? String(value).slice(0, 80)
      : 'invalid-type',
});
export class ReconstructionClockError extends Error {
  constructor(readonly witness: ClockWitness) {
    super('Reconstruction clock invalid/unprovable: ' + witness.reason);
  }
}
export interface ClockWitness {
  classification: 'wall-adjustment' | 'terminal';
  reason: string;
  context: unknown;
  previousRawWall: number | null;
  rawWall: ReturnType<typeof clockValue>;
  previousEffective: number | null;
  monotonic: ReturnType<typeof clockValue>;
  monotonicDeltaNanoseconds: string | null;
  monotonicValid: boolean;
  selectedEffective: number | null;
}
/** Expiry uses a rebased upper envelope; minimum waits use an unbroken elapsed axis.
 * Neither process-local monotonic origin is persisted or compared across processes. */
export class ReconstructionClock implements Clock {
  private origin: bigint | undefined;
  private epoch = 0n;
  private anchor = 0n;
  private anchorMono = 0n;
  private previousMono: bigint | undefined;
  private raw: number | null = null;
  private effective: number | null = null;
  private waiting: number | null = null;
  private fault: ReconstructionClockError | undefined;
  private anomalies = {
    count: 0,
    first: null as ClockWitness | null,
    last: null as ClockWitness | null,
  };
  context: () => unknown = () => ({ phase: 'startup' });
  readonly sleep: Clock['sleep'];
  constructor(
    private samples: ClockSamples = { wall: Date.now, monotonic: process.hrtime.bigint },
  ) {
    this.sleep = samples.sleep ?? realClock.sleep;
  }
  private record(witness: ClockWitness) {
    this.anomalies.count++;
    this.anomalies.first ??= witness;
    this.anomalies.last = witness;
  }
  private sample() {
    if (this.fault) throw this.fault;
    let wall: unknown, mono: unknown;
    let reason = '';
    try {
      wall = this.samples.wall();
      mono = this.samples.monotonic();
    } catch {
      reason = 'sample-threw';
    }
    const witness: ClockWitness = {
      classification: 'terminal',
      reason,
      context: this.context(),
      previousRawWall: this.raw,
      rawWall: clockValue(wall),
      previousEffective: this.effective,
      monotonic: clockValue(mono),
      monotonicDeltaNanoseconds:
        typeof mono === 'bigint' && this.previousMono !== undefined
          ? String(mono - this.previousMono).slice(0, 80)
          : null,
      monotonicValid:
        typeof mono === 'bigint' &&
        mono >= 0n &&
        (this.previousMono === undefined || mono >= this.previousMono),
      selectedEffective: null,
    };
    if (!reason && (typeof wall !== 'number' || !Number.isSafeInteger(wall) || wall < 0))
      reason = 'invalid-wall';
    if (!reason && (typeof mono !== 'bigint' || mono < 0n)) reason = 'invalid-monotonic';
    if (!reason && this.previousMono !== undefined && (mono as bigint) < this.previousMono)
      reason = 'monotonic-regression';
    if (!reason) {
      const w = wall as number,
        m = mono as bigint;
      if (this.origin === undefined) {
        this.origin = this.anchorMono = m;
        this.epoch = this.anchor = BigInt(w) * ms;
      }
      let ceiling = this.anchor + m - this.anchorMono;
      const continuous = this.epoch + m - this.origin;
      if (BigInt(w) * ms > ceiling) {
        ceiling = this.anchor = BigInt(w) * ms;
        this.anchorMono = m;
      }
      if (ceiling > maximum || continuous > maximum) reason = 'clock-overflow';
      else {
        witness.selectedEffective = Number(ceiling / ms);
        if (this.raw !== null && w < this.raw) {
          witness.classification = 'wall-adjustment';
          witness.reason = 'backward-wall';
          this.record(witness);
        }
        this.raw = w;
        this.previousMono = m;
        this.effective = witness.selectedEffective;
        this.waiting = Number(continuous / ms);
        return;
      }
    }
    witness.reason = reason;
    this.record(witness);
    this.fault = new ReconstructionClockError(witness);
    throw this.fault;
  }
  now() {
    this.sample();
    return this.effective!;
  }
  waitNow() {
    this.sample();
    return this.waiting!;
  }
  wallNow() {
    this.sample();
    return this.raw!;
  }
  assertContinuity(highWater: number) {
    this.sample();
    if (this.raw! < highWater) {
      const witness: ClockWitness = {
        classification: 'terminal',
        reason: 'raw-continuity-below-durable-high-water',
        context: this.context(),
        previousRawWall: null,
        rawWall: clockValue(this.raw),
        previousEffective: highWater,
        monotonic: clockValue(this.previousMono),
        monotonicDeltaNanoseconds: null,
        monotonicValid: true,
        selectedEffective: null,
      };
      this.record(witness);
      this.fault = new ReconstructionClockError(witness);
      throw this.fault;
    }
  }
  snapshot() {
    return {
      domain: 'reconstruction-ceiling-epoch-ms',
      waitDomain: 'process-monotonic-epoch-ms',
      rawWall: this.raw,
      effective: this.effective,
      continuous: this.waiting,
      failed: Boolean(this.fault),
      anomalies: structuredClone(this.anomalies),
    };
  }
}

/** Restart conservatively reimposes the saved duration in full. A wall jump or a new
 * monotonic origin cannot forgive a promised wait; at worst a restart waits again. */
export async function reconstructionCooldown(
  directory: string,
  clock: Clock,
): Promise<CooldownStore> {
  const now = () => clock.waitNow?.() ?? clock.now();
  let duration = 0;
  try {
    const saved = (await readCanaryJson(directory + '/reconstruction-cooldown.json')) as {
      version: number;
      milliseconds: number;
    };
    if (saved.version !== 1 || !Number.isSafeInteger(saved.milliseconds) || saved.milliseconds < 0)
      throw Error('Invalid reconstruction cooldown.');
    duration = saved.milliseconds;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }
  let until = now() + duration;
  const legacy = await cooldownFiles(directory, 'worker');
  until = Math.max(
    until,
    now() + Math.max(0, (await legacy.read()) - (clock.wallNow?.() ?? clock.now())),
  );
  if (!Number.isSafeInteger(until)) throw Error('Reconstruction cooldown overflow.');
  const persist = (milliseconds: number) =>
    atomicJson(directory, 'reconstruction-cooldown.json', { version: 1, milliseconds });
  return {
    async read() {
      if (duration && now() >= until) {
        await persist(0);
        duration = 0;
      }
      return until;
    },
    async extend(next) {
      if (!Number.isSafeInteger(next) || next < 0) throw Error('Invalid reconstruction cooldown.');
      until = Math.max(until, next);
      duration = Math.max(0, until - now());
      await persist(duration);
    },
  };
}
