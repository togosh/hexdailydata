/** Contract day is zero based. Human display day is explicitly one based. */
export const HEX_LAUNCH_SECONDS = 1_575_331_200n;
export const SECONDS_PER_DAY = 86_400n;
export function contractDayAt(unixSeconds: bigint): number {
  if (unixSeconds < HEX_LAUNCH_SECONDS) throw new RangeError('Before HEX launch.');
  const day = (unixSeconds - HEX_LAUNCH_SECONDS) / SECONDS_PER_DAY;
  if (day > 65_535n) throw new RangeError('Outside the supported protocol day horizon.');
  return Number(day);
}
export function displayDay(contractDay: number): number {
  if (!Number.isInteger(contractDay) || contractDay < 0 || contractDay > 65_535) {
    throw new RangeError('Invalid contract day.');
  }
  return contractDay + 1;
}
export function dayStartSeconds(day: number): bigint {
  displayDay(day);
  return HEX_LAUNCH_SECONDS + BigInt(day) * SECONDS_PER_DAY;
}
export function newStakeTiming(startSeconds: bigint, days: number) {
  if (!Number.isInteger(days) || days < 1 || days > 5555)
    throw new RangeError('Stake length must be 1–5555 days.');
  const transactionDay = contractDayAt(startSeconds);
  const lockedDay = Math.max(transactionDay + 1, 2);
  const maturityDay = lockedDay + days;
  if (maturityDay > 65_535) throw new RangeError('Maturity exceeds the supported day horizon.');
  return { transactionDay, lockedDay, maturityDay, maturitySeconds: dayStartSeconds(maturityDay) };
}
