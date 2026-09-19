/** Exact units only. No HTTP, SQL, filesystem, or rounding through Number. */
export const HEARTS_PER_HEX = 100_000_000n;
export const SHARES_PER_TSHARE = 1_000_000_000_000n;
export const SHARE_RATE_SCALE = 100_000n;
export const UINT256_MAX = (1n << 256n) - 1n;

function scale(decimals: number): bigint {
  if (!Number.isInteger(decimals) || decimals < 0 || decimals > 36) {
    throw new RangeError('Decimal scale must be an integer from 0 through 36.');
  }
  return 10n ** BigInt(decimals);
}
export function parseUnits(value: string, decimals: number, maximum = UINT256_MAX): bigint {
  const factor = scale(decimals);
  if (
    typeof value !== 'string' ||
    value.length > 120 ||
    !/^(0|[1-9][0-9]*)(\.[0-9]+)?$/.test(value)
  ) {
    throw new TypeError(
      'Use an unsigned plain decimal without commas, spaces or exponent notation.',
    );
  }
  const [whole = '0', fraction = ''] = value.split('.');
  if (fraction.length > decimals) throw new RangeError('Too many decimal places.');
  const raw = BigInt(whole) * factor + BigInt(fraction.padEnd(decimals, '0') || '0');
  if (maximum < 0n || raw > maximum) throw new RangeError('Amount exceeds the supported bound.');
  return raw;
}
export function formatUnits(raw: bigint, decimals: number): string {
  scale(decimals);
  if (raw < 0n) throw new RangeError('Negative unsigned amount.');
  if (decimals === 0) return raw.toString();
  const text = raw.toString().padStart(decimals + 1, '0');
  const fraction = text.slice(-decimals).replace(/0+$/, '');
  return text.slice(0, -decimals) + (fraction ? '.' + fraction : '');
}
export interface Rational {
  numerator: bigint;
  denominator: bigint;
}
export function rational(numerator: bigint, denominator: bigint): Rational {
  if (numerator < 0n || denominator <= 0n) throw new RangeError('Invalid unsigned ratio.');
  let a = numerator;
  let b = denominator;
  while (b !== 0n) [a, b] = [b, a % b];
  return { numerator: numerator / a, denominator: denominator / a };
}
/** Presentation only: truncate, never use as canonical stored observation. */
export function displayRatio(value: Rational, decimalPlaces = 8): string {
  const factor = scale(decimalPlaces);
  if (value.numerator < 0n || value.denominator <= 0n) throw new RangeError('Invalid ratio.');
  return formatUnits((value.numerator * factor) / value.denominator, decimalPlaces);
}
export function payoutHexPerTShare(payoutHearts: bigint, dayShares: bigint): Rational {
  return rational(payoutHearts * SHARES_PER_TSHARE, dayShares * HEARTS_PER_HEX);
}
export function hexPerTShareBeforeBonuses(rawShareRate: bigint): Rational {
  if (rawShareRate <= 0n) throw new RangeError('Share rate must be positive.');
  return rational(rawShareRate * SHARES_PER_TSHARE, SHARE_RATE_SCALE * HEARTS_PER_HEX);
}
