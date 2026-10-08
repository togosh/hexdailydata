import type { z } from 'zod';
import type { HomeResponseSchema } from '../contracts/api.ts';
import { UINT72_MAX } from '../domain/calculator.ts';
import { HEARTS_PER_HEX, parseUnits, rational, displayRatio } from '../domain/units.ts';
import { observationState } from './format.ts';

export const AMOUNT_LIMIT = 100;
export const AMOUNT_SESSION_KEY = 'calculator-amount-v1';
// Presentation only: preserve every digit, including trailing zeros; never round through Number.
export function formatAmount(text: string, minimumDecimals: 0 | 2 = 0): string {
  if (text.length > AMOUNT_LIMIT || !/^(0|[1-9][0-9]*)(\.[0-9]+)?$/.test(text)) return text;
  const [whole, fraction = ''] = text.split('.');
  const decimals = fraction.padEnd(minimumDecimals, '0');
  return whole!.replace(/\B(?=(\d{3})+(?!\d))/g, ',') + (decimals ? '.' + decimals : '');
}
// Admit only conventional whole-part grouping. Bad commas stay visible and fail validation.
export function ungroupAmount(text: string): string {
  return /^[1-9][0-9]{0,2}(?:,[0-9]{3})+(?:\.[0-9]*)?$/.test(text)
    ? text.replaceAll(',', '')
    : text;
}
export type AmountFields = {
  version: 1;
  unit: 'USD' | 'HEX';
  usd: string;
  hex: string;
  days: string;
  preset: string;
  future: string;
  futureMode: 'current' | 'custom';
};
export const defaultAmountFields = (): AmountFields => ({
  version: 1,
  unit: 'USD',
  usd: '100',
  hex: '10000',
  days: '365',
  preset: '30',
  future: '',
  futureMode: 'current',
});
export function readAmountFields(serialized: string | null): AmountFields {
  try {
    if (!serialized || serialized.length > 1024) return defaultAmountFields();
    const f = JSON.parse(serialized);
    if (
      !f ||
      f.version !== 1 ||
      !['USD', 'HEX'].includes(f.unit) ||
      !['current', 'custom'].includes(f.futureMode) ||
      !['', '1', '30', '365'].includes(f.preset) ||
      !['usd', 'hex', 'future'].every(
        (key) => typeof f[key] === 'string' && f[key].length <= AMOUNT_LIMIT,
      ) ||
      typeof f.days !== 'string' ||
      f.days.length > 5
    )
      return defaultAmountFields();
    // Drafts may be unfinished/invalid edits: keep their labels and validate at use time.
    // Reconstruct known fields; never spread persisted properties into state.
    return {
      version: 1,
      unit: f.unit,
      usd: f.usd,
      hex: f.hex,
      days: f.days,
      preset: f.preset,
      future: f.future,
      futureMode: f.futureMode,
    };
  } catch {
    return defaultAmountFields();
  }
}
function boundedDraft(text: string) {
  if (typeof text !== 'string' || text.length > AMOUNT_LIMIT)
    throw new Error('Amount must be at most 100 characters.');
}
export function usdCents(text: string): bigint {
  boundedDraft(text);
  if (!/^(0|[1-9][0-9]*)(\.[0-9]{1,2})?$/.test(text))
    throw new Error('Use a USD amount with at most 2 decimals and correctly grouped commas.');
  const cents = parseUnits(text, 2, 10n ** 102n - 1n);
  if (cents === 0n) throw new Error('Enter a positive USD amount.');
  return cents;
}
export function exactPrice(text: string) {
  if (
    typeof text !== 'string' ||
    text.length > 120 ||
    !/^(0|[1-9][0-9]*)(\.[0-9]{1,36})?$/.test(text)
  )
    throw new Error('Current HEX price must be a bounded plain decimal.');
  const [whole, fraction = ''] = text.split('.');
  const numerator = BigInt(whole + fraction);
  if (numerator === 0n) throw new Error('Current HEX price must be positive.');
  return { numerator, denominator: 10n ** BigInt(fraction.length) };
}
export function usdToHearts(usd: string, price: string): bigint {
  const cents = usdCents(usd),
    p = exactPrice(price);
  const hearts = (cents * p.denominator * HEARTS_PER_HEX) / (100n * p.numerator);
  if (hearts === 0n) throw new Error('USD amount converts to less than 0.00000001 HEX.');
  if (hearts > UINT72_MAX) throw new Error('Converted HEX exceeds the supported principal limit.');
  return hearts;
}
export function hexHearts(text: string): bigint {
  boundedDraft(text);
  const hearts = parseUnits(text, 8, UINT72_MAX);
  if (hearts === 0n) throw new Error('Enter a positive HEX amount.');
  return hearts;
}
export function currentUsdEquivalent(hearts: bigint, price: string): string {
  const p = exactPrice(price);
  return displayRatio(rational(hearts * p.numerator, HEARTS_PER_HEX * p.denominator), 8);
}
export function qualifiedAmountPrice(
  home: z.infer<typeof HomeResponseSchema> | undefined,
  now: number,
  error?: string,
) {
  const price = home?.live.price;
  if (
    error ||
    home?.chain !== 'pulsechain' ||
    price?.asOf?.chainId !== 369 ||
    price.status === 'unavailable' ||
    price.value?.kind !== 'spot_estimate' ||
    !Number.isFinite(Date.parse(price.asOf.blockTimestamp)) ||
    Date.parse(price.asOf.blockTimestamp) > now ||
    Date.parse(price.observedAt ?? '') < Date.parse(price.asOf.blockTimestamp) ||
    !Number.isFinite(Date.parse(price.observedAt ?? '')) ||
    observationState(price, now) !== 'fresh'
  )
    return null;
  try {
    exactPrice(price.value.usdPerHex);
    return price;
  } catch {
    return null;
  }
}
