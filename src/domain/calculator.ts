import { newStakeTiming } from './day.ts';
import {
  rational,
  SHARE_RATE_SCALE,
  HEARTS_PER_HEX,
  SHARES_PER_TSHARE,
  type Rational,
} from './units.ts';

export const UINT72_MAX = (1n << 72n) - 1n;
const UINT40_MAX = (1n << 40n) - 1n;
const AMOUNT_CAP = 150_000_000n * HEARTS_PER_HEX;
const BPB = AMOUNT_CAP * 10n;
const LPB = 1820n;

/** Ordinary new stake only. The two bonuses share ONE floor before share issuance. */
export function quoteStake(
  principalHearts: bigint,
  days: number,
  rawShareRate: bigint,
  startSeconds: bigint,
) {
  if (principalHearts <= 0n || principalHearts > UINT72_MAX)
    throw new RangeError('Principal must fit a positive uint72 amount.');
  if (rawShareRate <= 0n || rawShareRate > UINT40_MAX)
    throw new RangeError('Share rate must fit a positive uint40 value.');
  const timing = newStakeTiming(startSeconds, days);
  const extraDays = BigInt(Math.min(days - 1, 3640));
  const capped = principalHearts < AMOUNT_CAP ? principalHearts : AMOUNT_CAP;
  const bonusHearts = (principalHearts * (extraDays * BPB + capped * LPB)) / (LPB * BPB);
  const stakeShares = ((principalHearts + bonusHearts) * SHARE_RATE_SCALE) / rawShareRate;
  if (stakeShares === 0n || stakeShares > UINT72_MAX)
    throw new RangeError('Calculated shares must fit a positive uint72 value.');
  return { principalHearts, bonusHearts, stakeShares, days, ...timing };
}

/** Constant daily HEX/T-share scenario: no compounding or promised contract rewards. */
export function payoutScenario(
  quote: ReturnType<typeof quoteStake>,
  daily: Rational,
  futureUsd: Rational | null,
) {
  const rate = rational(daily.numerator, daily.denominator);
  const rewardHex = rational(
    rate.numerator * quote.stakeShares * BigInt(quote.days),
    rate.denominator * SHARES_PER_TSHARE,
  );
  const totalHex = rational(
    quote.principalHearts * rewardHex.denominator + rewardHex.numerator * HEARTS_PER_HEX,
    HEARTS_PER_HEX * rewardHex.denominator,
  );
  const price = futureUsd === null ? null : rational(futureUsd.numerator, futureUsd.denominator);
  const usd =
    price === null
      ? null
      : rational(totalHex.numerator * price.numerator, totalHex.denominator * price.denominator);
  return { rewardHex, totalHex, usd };
}

/** Annualized end-of-term return, not daily compounding. Root truncated to 12 places. */
export function stakeApy(
  principalHearts: bigint,
  years: 1 | 5 | 10,
  rawShareRate: bigint,
  daily: Rational,
  startSeconds: bigint,
): Rational {
  if (![1, 5, 10].includes(years)) throw new RangeError('Unsupported APY term.');
  const quote = quoteStake(principalHearts, years * 365, rawShareRate, startSeconds);
  const { totalHex } = payoutScenario(quote, daily, null);
  const numerator = totalHex.numerator * HEARTS_PER_HEX;
  const denominator = totalHex.denominator * principalHearts;
  const scale = 10n ** 12n;
  const exponent = BigInt(years);
  const target = numerator * scale ** exponent;
  let low = scale;
  let high = scale * 2n;
  while (high ** exponent * denominator <= target) high *= 2n;
  while (high - low > 1n) {
    const middle = (low + high) / 2n;
    if (middle ** exponent * denominator <= target) low = middle;
    else high = middle;
  }
  return rational((low - scale) * 100n, scale);
}
