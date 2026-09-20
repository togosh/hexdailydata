import { dayStartSeconds, contractDayAt } from '../domain/day.ts';
import { observationStatus } from '../domain/freshness.ts';
import type { Observation } from '../contracts/api.ts';

/** Expand an admitted decimal token without passing its significant digits through Number. */
export function decimal(token: string): string {
  if (token.length > 160 || !/^-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d{1,3})?$/.test(token))
    throw new Error('Invalid decimal.');
  const negative = token.startsWith('-');
  const [mantissa = '', exponent = '0'] = token.replace(/^-/, '').toLowerCase().split('e');
  const [whole = '', fraction = ''] = mantissa.split('.');
  const digits = whole + fraction;
  const point = whole.length + Number(exponent);
  let result =
    point <= 0
      ? '0.' + '0'.repeat(-point) + digits
      : point >= digits.length
        ? digits + '0'.repeat(point - digits.length)
        : digits.slice(0, point) + '.' + digits.slice(point);
  result = result
    .replace(/^0+(?=\d)/, '')
    .replace(/(\.\d*?)0+$/, '$1')
    .replace(/\.$/, '');
  return negative && /[1-9]/.test(result) ? '-' + result : result;
}
export function numberText(value: string | null | undefined, places?: number): string {
  if (value == null) return 'Unavailable';
  const exact = decimal(value);
  let [whole = '', fraction = ''] = exact.split('.');
  // Never present a small nonzero value as zero. Full precision is always available via Value.
  if (places !== undefined && (/[1-9]/.test(whole) || /[1-9]/.test(fraction.slice(0, places))))
    fraction = fraction.slice(0, places).replace(/0+$/, '');
  whole = whole.replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  return whole + (fraction ? '.' + fraction : '');
}
export const dayDate = (day: number) =>
  new Date(Number(dayStartSeconds(day)) * 1000).toISOString().slice(0, 10);
export const dayLabel = (day: number) => `${dayDate(day)} · day ${day + 1}`;
export const dateShift = (date: string, days: number) =>
  new Date(Date.parse(date) + days * 86400000).toISOString().slice(0, 10);
export const today = () => new Date().toISOString().slice(0, 10);
/** Display-only truncation: exact strings stay in Home Details; never round a nonzero to zero. */
export function compactNumber(
  value: string | null | undefined,
  places = 2,
  abbreviate = true,
): string {
  if (value == null) return 'Unavailable';
  const exact = decimal(value);
  const [whole = '', fraction = ''] = exact.replace(/^-/, '').split('.');
  const sign = exact.startsWith('-') ? '-' : '';
  if (abbreviate && whole.length > 15) {
    const digits = whole + fraction;
    return '≈' + sign + digits[0] + '.' + digits.slice(1, 3) + ' × 10^' + (whole.length - 1);
  }
  const power = abbreviate ? Math.min(4, Math.floor((whole.length - 1) / 3)) : 0;
  const shifted = power
    ? decimal(sign + whole + (fraction ? '.' + fraction : '') + 'e-' + power * 3)
    : exact;
  const displayed = numberText(shifted, places);
  const approximate = decimal(displayed.replaceAll(',', '')) !== shifted;
  return (approximate ? '≈' : '') + displayed + ['', 'K', 'M', 'B', 'T'][power];
}
export function yearsFromDays(days: string | null | undefined): string | null {
  if (days == null) return null;
  const [whole = '0', fraction = ''] = decimal(days).split('.');
  const scale = 10n ** BigInt(fraction.length);
  // 365.25 days per display year; retain eight places before presentation truncation.
  const units = (BigInt(whole + fraction) * 10000000000n) / (36525n * scale);
  return `${units / 100000000n}.${(units % 100000000n).toString().padStart(8, '0')}`;
}
export function compactObservation(
  row: Observation<unknown> | undefined,
  now: number,
  state: string,
) {
  if (!row?.asOf) return 'Unavailable';
  const seconds = Math.max(
    0,
    Math.floor(
      (now -
        Math.min(
          Date.parse(row.asOf.blockTimestamp),
          Date.parse(row.observedAt ?? row.asOf.blockTimestamp),
        )) /
        1000,
    ),
  );
  return `${state === 'fresh' ? 'Observed' : state === 'stale' ? 'Stale' : 'Expired'} · ${seconds < 60 ? seconds + 's' : Math.floor(seconds / 60) + 'm'} ago`;
}
export function observationState(
  row: Pick<Observation<unknown>, 'status' | 'asOf' | 'observedAt'> | undefined,
  now: number,
  estimateDay?: number,
) {
  if (!row?.asOf || !row.observedAt || row.status === 'unavailable') return 'unavailable';
  if (estimateDay !== undefined && estimateDay !== contractDayAt(BigInt(Math.floor(now / 1000))))
    return 'unavailable';
  const source = Date.parse(row.asOf.blockTimestamp),
    collected = Date.parse(row.observedAt);
  const status = observationStatus(
    BigInt(Math.floor(Math.min(source, collected) / 1000)),
    BigInt(Math.floor(now / 1000)),
  );
  if (collected > now || status === 'unavailable') return 'unavailable';
  return row.status === 'stale' ? 'stale' : status;
}
export function observationLabel<T>(row: Observation<T> | undefined, now: number, state: string) {
  if (!row?.asOf) return 'No qualified observation';
  const seconds = Math.max(0, Math.floor((now - Date.parse(row.asOf.blockTimestamp)) / 1000));
  return `${state === 'fresh' ? 'Observed' : state === 'stale' ? 'Last known' : 'Expired'} ${seconds < 60 ? seconds + 's' : Math.floor(seconds / 60) + 'm'} ago · ${row.finality}`;
}
