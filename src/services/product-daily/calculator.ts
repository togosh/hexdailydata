import { CalculatorResponseSchema } from '../../contracts/reads.ts';
import { ProtocolReadingSchema } from '../../contracts/protocol-daily.ts';
import { contractDayAt } from '../../domain/day.ts';
import { observationStatus } from '../../domain/freshness.ts';
import { payoutPreset } from '../../domain/payout.ts';
import { displayRatio, hexPerTShareBeforeBonuses } from '../../domain/units.ts';
import type { AdmittedProduct } from './store.ts';

const rawWord = (value: string | null) => {
  if (value === null) return null;
  if (!/^(0|[1-9][0-9]{0,21})$/.test(value) || BigInt(value) >= 1n << 72n)
    throw Error('CALCULATOR_PAYOUT_WORD');
  return BigInt(value);
};

/** Read only one admitted product. Never reconstruct native inputs from display ratios. */
export function productCalculator(snapshot: AdmittedProduct, now: number) {
  if (!Number.isSafeInteger(now) || now < 1575331200000) throw Error('CALCULATOR_CLOCK');
  const currentDay = contractDayAt(BigInt(Math.floor(now / 1000)));
  const protocol = snapshot.metadata.readings.find((r) => r.kind === 'protocol');
  const metadata = {
    finality: 'provisional' as const,
    method: 'paired-hash-pinned-hex-globals',
    notes: [
      'Raw globals word 2; block agreement is not finality. Last-known rate policy applies.',
    ],
  };
  let shareRate: ReturnType<typeof CalculatorResponseSchema.parse>['shareRate'] = {
    ...metadata,
    status: 'unavailable',
    value: null,
    asOf: null,
    observedAt: null,
    reason: 'No qualified protocol share-rate observation.',
  };
  if (protocol) {
    const reading = ProtocolReadingSchema.parse(protocol);
    const raw = BigInt(reading.globalWords[2]!);
    if (raw <= 0n || raw >= 1n << 40n) throw Error('CALCULATOR_SHARE_RATE_BOUND');
    const observedAt = new Date(reading.observedAtUtc).toISOString();
    const asOf = {
      chainId: 369 as const,
      blockNumber: String(reading.blockNumber),
      blockHash: reading.blockHash,
      blockTimestamp: observedAt,
    };
    const status = observationStatus(
      BigInt(reading.globalWords[10]!),
      BigInt(Math.floor(now / 1000)),
    );
    shareRate =
      status === 'unavailable'
        ? {
            ...metadata,
            status,
            value: null,
            asOf,
            observedAt,
            reason: 'Protocol rate expired or source time is in the future.',
          }
        : {
            ...metadata,
            status,
            asOf,
            observedAt,
            value: {
              rawShareRate: String(raw),
              hexPerTShareBeforeBonuses: displayRatio(hexPerTShareBeforeBonuses(raw)),
            },
          };
  }
  // Coverage is a materialized-period count, never the wall-clock current payout.
  const last = Math.min(snapshot.metadata.coverage.ledgerDates - 1, currentDay - 1);
  const presets = ([1, 30, 365] as const).map((window) => {
    const selected = snapshot.rows.filter(
      (r) => r.contractDay >= last - window + 1 && r.contractDay <= last,
    );
    const result =
      last < 0
        ? { status: 'unavailable' as const, value: null, reason: 'missing_days' as const }
        : payoutPreset(
            selected.map((r) => ({
              contractDay: r.contractDay,
              status:
                r.payoutHearts === null || r.payoutStakeShares === null
                  ? ('pending' as const)
                  : ('completed' as const),
              payoutHearts: rawWord(r.payoutHearts),
              stakeShares: rawWord(r.payoutStakeShares),
            })),
            window,
            last,
            currentDay,
          );
    return {
      window,
      fromDay: last < 0 ? null : last - window + 1,
      toDay: last < 0 ? null : last,
      count: selected.length,
      status: result.status,
      reason: result.status === 'available' ? null : result.reason,
      value: result.value
        ? {
            numerator: String(result.value.numerator),
            denominator: String(result.value.denominator),
            hexPerTShare: displayRatio(result.value),
          }
        : null,
    };
  });
  return CalculatorResponseSchema.parse({
    chain: 'pulsechain',
    calculationVersion: 'hex-native-1',
    datasetVersion: snapshot.version,
    shareRate,
    presets,
  });
}
