import { isDeepStrictEqual } from 'node:util';
import { contractDayAt } from '../../domain/day.ts';
import { estimateCurrentPayout } from '../../domain/current.ts';
import { displayRatio, hexPerTShareBeforeBonuses, payoutHexPerTShare } from '../../domain/units.ts';
import {
  decodeHeader,
  plainHeader,
  q,
  selectors,
  word,
  words,
  dailyWords,
} from '../../providers/abi.ts';
import { decodeCurrent, liveSelectors } from '../../providers/live-abi.ts';
import type { RpcClient } from '../../providers/rpc.ts';
import { blockRef, observed, unavailable } from '../../services/live/observations.ts';
import { PriceReader, pinnedCall, verifyCode } from '../../services/live/price.ts';
import { readMetrics, type MetricStore, type Metrics } from './store.ts';

export class MetricsService {
  readonly sources: readonly [RpcClient, RpcClient];
  readonly codeHash: string;
  readonly price: PriceReader | null;
  readonly store: MetricStore;
  readonly counters = { ticks: 0, updates: 0, failures: 0 };
  constructor(
    sources: readonly [RpcClient, RpcClient],
    codeHash: string,
    price: PriceReader | null,
    store: MetricStore,
  ) {
    if (
      sources[0].budget !== sources[1].budget ||
      sources[0].chain !== sources[1].chain ||
      sources[0].contract !== sources[1].contract ||
      sources[0].id === sources[1].id ||
      (sources[0].operator !== null && sources[0].operator === sources[1].operator)
    )
      throw new Error('Metrics require two distinct sources sharing one worker budget.');
    this.sources = sources;
    this.codeHash = codeHash;
    this.price = price;
    this.store = store;
  }
  async tick(signal: AbortSignal) {
    this.counters.ticks++;
    const [a, b] = this.sources,
      clock = a.budget.clock,
      deadline = clock.now() + 60000;
    const previous = await readMetrics(this.store, a.chain, clock.now());
    const next: Metrics = { ...previous };
    const inputs: Record<string, unknown> = {};
    try {
      const [chain, raw] = await a.calls(
        [
          { method: 'eth_chainId', params: [] },
          { method: 'eth_getBlockByNumber', params: ['latest', false] },
        ],
        signal,
        deadline,
        'metrics',
      );
      if (chain !== q(a.chain)) throw new Error('Wrong metric chain.');
      const h = plainHeader(decodeHeader(raw)),
        asOf = blockRef(a.chain, h);
      if (BigInt(h.timestamp) > BigInt(Math.floor(clock.now() / 1000)))
        throw new Error('Future metric source.');
      let planA: ReturnType<PriceReader['plan']> | undefined;
      try {
        planA = this.price?.plan(a, h, clock.now());
      } catch {
        this.counters.failures++;
        if (!previous.price.value)
          next.price = unavailable('allowlisted-reserve-ratio', 'price_profile_invalid');
      }
      const results = await a.calls(
        [
          { method: 'eth_getBlockByNumber', params: [q(h.number), false] },
          { method: 'eth_getCode', params: [a.contract, q(h.number)] },
          pinnedCall(a.contract, selectors.globalInfo, h),
          pinnedCall(a.contract, liveSelectors.currentDay, h),
          pinnedCall(a.contract, selectors.totalSupply, h),
          ...(planA?.calls ?? []),
        ],
        signal,
        deadline,
        'metrics',
        { settledMetrics: true },
      );
      if (!isDeepStrictEqual(plainHeader(decodeHeader(results[0])), h))
        throw new Error('Metric block affinity lost.');
      verifyCode(results[1], this.codeHash);
      const day = contractDayAt(BigInt(h.timestamp));
      // A successful new-day header invalidates old estimates even if the globals fail.
      if (next.todayPayoutEstimate.value?.contractDay !== day)
        next.todayPayoutEstimate = unavailable('post-claim-1', 'new_protocol_day');
      try {
        const globals = decodeCurrent(results[2]);
        if (
          globals.timestamp !== BigInt(h.timestamp) ||
          words(results[3], 1)[0] !== BigInt(day) ||
          globals.dailyDataCount > day
        )
          throw new Error('Current state day affinity.');
        inputs.current = globals;
        next.shareRate = observed(
          {
            rawShareRate: globals.rawShareRate.toString(),
            hexPerTShareBeforeBonuses: displayRatio(
              hexPerTShareBeforeBonuses(globals.rawShareRate),
            ),
          },
          asOf,
          clock.now(),
          'globalInfo',
        );
        try {
          if (words(results[4], 1)[0] !== globals.totalSupply) throw new Error('Supply conflict.');
          const estimate = estimateCurrentPayout({ ...globals, currentDay: day });
          next.todayPayoutEstimate =
            estimate.status === 'unavailable'
              ? unavailable('post-claim-1', estimate.reason)
              : observed(
                  {
                    contractDay: day,
                    displayDay: day + 1,
                    hexPerTShare: displayRatio(
                      payoutHexPerTShare(estimate.payoutHearts, estimate.stakeShares),
                    ),
                    payoutHearts: estimate.payoutHearts.toString(),
                    stakeShares: estimate.stakeShares.toString(),
                    kind: 'current_day_estimate',
                  },
                  asOf,
                  clock.now(),
                  'post-claim-1',
                  ['Excludes future transactions and penalties.'],
                );
        } catch {
          next.todayPayoutEstimate = unavailable('post-claim-1', 'unsafe_inputs');
          this.counters.failures++;
        }
        if (globals.dailyDataCount > 0) {
          try {
            const last = globals.dailyDataCount - 1;
            const ledger = await a.calls(
              [pinnedCall(a.contract, selectors.dailyDataRange + word(last) + word(last + 1), h)],
              signal,
              deadline,
              'metrics',
            );
            const row = dailyWords(ledger[0], last, last + 1)[0]!;
            next.latestCompletedPayout =
              BigInt(row.shares) === 0n
                ? unavailable('dailyDataRange', 'zero_shares')
                : observed(
                    {
                      contractDay: last,
                      displayDay: last + 1,
                      hexPerTShare: displayRatio(
                        payoutHexPerTShare(BigInt(row.payout), BigInt(row.shares)),
                      ),
                      payoutHearts: row.payout,
                      stakeShares: row.shares,
                      kind: 'completed',
                    },
                    asOf,
                    clock.now(),
                    'dailyDataRange',
                    ['Materialized ledger; observation is provisional until canonical acceptance.'],
                  );
          } catch {
            this.counters.failures++;
          }
        } else next.latestCompletedPayout = unavailable('dailyDataRange', 'no_materialized_day');
      } catch {
        next.todayPayoutEstimate = unavailable('post-claim-1', 'unsafe_inputs');
        this.counters.failures++;
      }
      if (this.price && planA) {
        try {
          const ra = planA.decode(results.slice(5));
          const planB = this.price.plan(b, h, clock.now());
          const rb = await b.calls(
            [
              { method: 'eth_chainId', params: [] },
              { method: 'eth_getBlockByNumber', params: [q(h.number), false] },
              { method: 'eth_getCode', params: [b.contract, q(h.number)] },
              ...planB.calls,
            ],
            signal,
            deadline,
            'metrics',
            { settledMetrics: true },
          );
          if (rb[0] !== q(b.chain) || !isDeepStrictEqual(plainHeader(decodeHeader(rb[1])), h))
            throw new Error('Price source affinity conflict.');
          verifyCode(rb[2], this.codeHash);
          const reserves = planB.decode(rb.slice(3));
          const value = this.price.value(ra, reserves);
          inputs.price = ra;
          next.price = observed(value, asOf, clock.now(), 'allowlisted-reserve-ratio', [
            'Fixed $1 anchor; reserve mark is not a trade or redemption quote.',
            `Provider correlation: ${a.operator && b.operator ? 'distinct_declared_operators' : 'unknown'}.`,
            ...ra.map((r, i) => `Pool ${i} reserve update seconds: ${r.updated}.`),
          ]);
        } catch {
          this.counters.failures++;
        }
      } else if (!this.price)
        next.price = unavailable('allowlisted-reserve-ratio', 'price_profile_unqualified');
    } catch {
      signal.throwIfAborted();
      this.counters.failures++;
    }
    signal.throwIfAborted();
    // One small upsert per component, on a connection independent of the native writer.
    for (const key of Object.keys(next) as (keyof Metrics)[]) {
      // A failed refresh leaves both the prior observation and its exact inputs intact.
      // Freshness is computed by readers, so ageing needs no synthetic database write.
      if (next[key] === previous[key]) continue;
      try {
        await this.store.put(
          a.chain,
          key,
          next[key],
          key === 'price'
            ? { reserves: inputs.price ?? null }
            : { current: inputs.current ?? null },
        );
        this.counters.updates++;
      } catch {
        this.counters.failures++;
      }
    }
    return readMetrics(this.store, a.chain, clock.now());
  }
}
