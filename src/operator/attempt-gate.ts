import type { Clock } from '../providers/budget.ts';
import type { Transport, RpcCall } from '../providers/rpc.ts';
import { operatorError } from './errors.ts';
import {
  RpcExchange,
  attachRpcDiagnostic,
  rpcDiagnostic,
  safeRpcError,
} from '../providers/rpc-diagnostic.ts';
export class CanaryStop extends Error {}
export interface RequestScope {
  request(chain: number, calls: RpcCall[]): void;
  response(calls: (RpcCall & { id?: number })[], text: string): void;
}
export interface AttemptOwner {
  state: {
    start: number | null;
    deadline: number | null;
    http: number;
    logical: number;
    chargedBytes: number;
    observedBytes: number;
    pending: boolean;
    uncertainAttempts: number;
  };
  plan: {
    caps: { bytes: number; responseBytes: number };
    profile: { contract: string; commonHistory: string };
  };
  clock: Clock;
  controller: AbortController;
  hooks: { beforeDispatch?: () => Promise<void>; beforeSettlement?: () => Promise<void> };
  time(): number;
  save(): Promise<void>;
  check(logical?: number): void;
  stop(reason: string): void;
  deadline?(): number;
  secondary?(reason: string): void;
}
/** One serialized response and durable reservation/settlement shared by bounded operators. */
export class AttemptGate {
  private tail = Promise.resolve();
  private starts: { at: number; logical: number }[] = [];
  private lastStart = 0;
  constructor(private owner: AttemptOwner) {}
  async drain() {
    await this.tail;
  }
  transport(
    chain: 1 | 369,
    transport: Transport,
    source: string,
    scope: RequestScope,
    phase?: {
      cadence: {
        rollingMilliseconds: number;
        http: number;
        logical: number;
        quarantineMilliseconds: number;
        spacingMilliseconds: number;
      };
    },
    floor = 0,
    auditContext?: { guard: () => Promise<void> },
  ): Transport {
    // chain is the authorized logical phase, not eth_chainId of the serving network.
    return async (body, signal, requestDeadline = Infinity) => {
      const previous = this.tail;
      let unlock!: () => void;
      this.tail = new Promise<void>((r) => {
        unlock = r;
      });
      await previous;
      const combined = AbortSignal.any([signal, this.owner.controller.signal]);
      let reserved = 0,
        observed = 0,
        finished = false;
      let dispatchAt: number | null = null;
      let exchange: RpcExchange | undefined;
      const chunks: Buffer[] = [];
      const aborter = new AbortController();
      const active = AbortSignal.any([combined, aborter.signal]);
      const checkDeadline = () => {
        active.throwIfAborted();
        const now = this.owner.time();
        if (now >= (this.owner.deadline?.() ?? this.owner.state.deadline!)) {
          this.owner.stop('Canary elapsed cap reached.');
          throw this.owner.controller.signal.reason;
        }
        // A late continuation can precede an already-due abort timer callback.
        // The RPC attempt's absolute deadline therefore travels through this gate.
        if (now >= requestDeadline)
          throw new CanaryStop('Canary original request deadline expired.');
        return now;
      };
      const settle = async (complete: boolean) => {
        if (finished) return;
        finished = true;
        try {
          if (reserved) {
            this.owner.state.observedBytes += observed;
            this.owner.state.chargedBytes +=
              (complete ? observed : Math.max(reserved, observed)) - reserved;
            this.owner.state.pending = false;
            if (!complete) this.owner.state.uncertainAttempts++;
            await this.owner.save();
            if (phase)
              console.log(
                JSON.stringify({
                  event: 'canary_attempt',
                  source,
                  dispatchAt,
                  ended: this.owner.time(),
                  observedBytes: observed,
                  complete,
                  calls: JSON.parse(body).map((c: RpcCall) =>
                    c.method === 'eth_call'
                      ? (c.params[0] as { data: string }).data.slice(0, 10)
                      : c.method,
                  ),
                }),
              );
          }
        } finally {
          unlock();
        }
      };
      const settleAfterError = async (primary: unknown) => {
        try {
          await settle(false);
        } catch (secondary) {
          this.owner.secondary?.(operatorError(secondary).slice(0, 240));
          console.error(
            JSON.stringify({
              event: 'canary_settlement_failed',
              primary: operatorError(primary),
              secondary: operatorError(secondary),
              rpcDiagnostic: rpcDiagnostic(primary),
              diagnosticPersistence: 'failed',
            }),
          );
        }
      };
      try {
        combined.throwIfAborted();
        const calls = JSON.parse(body) as RpcCall[];
        if (scope) scope.request(chain, calls);

        this.owner.check(calls.length);
        const remaining = this.owner.plan.caps.bytes - this.owner.state.chargedBytes;
        reserved = this.owner.plan.caps.responseBytes * 2;
        if (remaining < reserved) {
          reserved = 0;
          this.owner.stop('Canary byte reservation unavailable.');
          throw this.owner.controller.signal.reason;
        }
        this.owner.state.http++;
        this.owner.state.logical += calls.length;
        this.owner.state.chargedBytes += reserved;
        this.owner.state.pending = true;
        await this.owner.save();
        await this.owner.hooks.beforeDispatch?.();
        if (phase) {
          // Recheck after queueing, persistence and late wakes; this gate counts actual
          // physical starts, not ProviderBudget's earlier slot reservations.
          for (;;) {
            const now = checkDeadline();
            this.starts = this.starts.filter((s) => s.at > now - phase.cadence.rollingMilliseconds);
            const full =
              this.starts.length >= phase.cadence.http ||
              this.starts.reduce((n, s) => n + s.logical, 0) + calls.length > phase.cadence.logical;
            const earliest = Math.max(
              this.owner.state.start! + phase.cadence.quarantineMilliseconds,
              floor,
              this.lastStart + phase.cadence.spacingMilliseconds,
              full ? this.starts[0]!.at + phase.cadence.rollingMilliseconds : now,
            );
            if (earliest <= now) break;
            await this.owner.clock.sleep(
              Math.min(
                earliest - now,
                (this.owner.deadline?.() ?? this.owner.state.deadline!) - now,
                requestDeadline - now,
              ),
              active,
            );
          }
        }
        // Fence lost SQL snapshots/locks after cadence/persistence waits and before
        // every physical dispatch, including retries. Never reconnect to continue.
        await auditContext?.guard();
        dispatchAt = checkDeadline();
        this.lastStart = dispatchAt;
        this.starts.push({ at: dispatchAt, logical: calls.length });
        exchange = new RpcExchange(
          source,
          calls,
          this.owner.plan.profile.contract,
          this.owner.state.http,
          dispatchAt,
          requestDeadline,
        );
        exchange.binding = {
          originChainId: chain,
          networkChainId:
            chain === 1 && this.owner.plan.profile.commonHistory !== 'pulsechain' ? 1 : 369,
        };
        const response = await transport(body, active, requestDeadline);
        exchange.headers(response.status, response.retryAfter);
        const self = this;
        let closed = false;
        let cleanupFailure: unknown;
        const closeResponse = async () => {
          if (closed) {
            if (cleanupFailure) throw cleanupFailure;
            return;
          }
          closed = true;
          try {
            await response.close?.();
          } catch {
            self.owner.stop('Canary response cleanup failed.');
            cleanupFailure = self.owner.controller.signal.reason;
            throw cleanupFailure;
          } finally {
            aborter.abort();
          }
        };
        return {
          ...response,
          exchange,
          close: async () => {
            try {
              await closeResponse();
            } finally {
              await settle(false);
            }
            // Deliberate per-attempt cancellation is distinct from a global stop.
            combined.throwIfAborted();
            if (
              self.owner.time() >= requestDeadline ||
              self.owner.time() >= (self.owner.deadline?.() ?? self.owner.state.deadline!)
            )
              throw new CanaryStop('Canary original request/session deadline expired.');
          },
          body: (async function* () {
            let complete = false;
            let failure: unknown;
            let receiving = true;
            let sizeFailure = false;
            try {
              for await (const chunk of response.body) {
                // Count the entire observed chunk even if it crosses the ceiling.
                observed += chunk.byteLength;
                exchange!.observe(chunk);
                checkDeadline();
                if (observed > self.owner.plan.caps.responseBytes) {
                  sizeFailure = true;
                  self.owner.stop('Canary response byte cap crossed.');
                  throw self.owner.controller.signal.reason;
                }
                if (scope && response.status === 200) chunks.push(Buffer.from(chunk));
                receiving = false;
                yield chunk;
                receiving = true;
              }
              exchange!.complete = true;
              active.throwIfAborted();
              await self.owner.hooks.beforeSettlement?.();
              if (scope && response.status === 200)
                scope.response(calls, Buffer.concat(chunks).toString('utf8'));
              checkDeadline();
              complete = true;
            } catch (caught) {
              // An exception while unwinding a yielded chunk is an iterator-return
              // failure. It must never be hidden by the client's local RangeError.
              if (!receiving) self.owner.stop('Canary response iterator cleanup failed.');
              const error = !receiving ? self.owner.controller.signal.reason : safeRpcError(caught);
              attachRpcDiagnostic(
                error,
                exchange!.failure(
                  'prefix',
                  self.owner.clock.now(),
                  Buffer.concat(chunks),
                  sizeFailure
                    ? 'response-size'
                    : active.aborted ||
                        self.owner.clock.now() >= requestDeadline ||
                        self.owner.clock.now() >= self.owner.state.deadline!
                      ? 'deadline'
                      : 'scope',
                ),
              );
              failure = error;
              throw error;
            } finally {
              // Hold the serialized transport gate through cleanup and durable
              // settlement, including an early consumer return without acceptance.
              try {
                await closeResponse();
              } catch (cleanup) {
                if (failure) {
                  const diagnostic = rpcDiagnostic(failure);
                  if (diagnostic) diagnostic.cleanupFailed = true;
                } else if (!complete) {
                  attachRpcDiagnostic(
                    cleanup,
                    exchange!.failure('prefix', self.owner.clock.now(), undefined, 'close'),
                  );
                  throw cleanup;
                }
                // A complete body still reaches the unchanged RPC envelope parser.
                // close() then reports cleanup failure without replacing that primary.
              } finally {
                if (failure) await settleAfterError(failure);
                else await settle(complete);
              }
            }
          })(),
        };
      } catch (caught) {
        const e = safeRpcError(caught);
        if (exchange)
          attachRpcDiagnostic(
            e,
            exchange.failure(
              'prefix',
              this.owner.clock.now(),
              undefined,
              active.aborted ||
                this.owner.clock.now() >= requestDeadline ||
                this.owner.clock.now() >= this.owner.state.deadline!
                ? 'deadline'
                : 'transport',
            ),
          );
        aborter.abort();
        await settleAfterError(e);
        throw e;
      }
    };
  }
}
