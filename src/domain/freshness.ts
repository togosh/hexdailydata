/** Fresh means a recent source observation, not merely a recently retried request. */
export function observationStatus(
  sourceSeconds: bigint,
  nowSeconds: bigint,
  freshSeconds = 120n,
  maximumStaleSeconds = 1800n,
): 'fresh' | 'stale' | 'unavailable' {
  if (
    sourceSeconds < 0n ||
    nowSeconds < 0n ||
    freshSeconds < 0n ||
    maximumStaleSeconds < freshSeconds
  ) {
    throw new RangeError('Invalid freshness bounds.');
  }
  if (sourceSeconds > nowSeconds) return 'unavailable'; // caller explains clock/source disagreement
  const age = nowSeconds - sourceSeconds;
  return age <= freshSeconds ? 'fresh' : age <= maximumStaleSeconds ? 'stale' : 'unavailable';
}
