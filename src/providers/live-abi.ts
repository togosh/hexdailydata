import { signature, words } from './abi.ts';
import { LiveStakePageSchema } from '../contracts/api.ts';

export const liveSelectors = Object.fromEntries(
  [
    ['currentDay', 'currentDay()'],
    ['stakeCount', 'stakeCount(address)'],
    ['stakeLists', 'stakeLists(address,uint256)'],
    ['factory', 'factory()'],
    ['token0', 'token0()'],
    ['token1', 'token1()'],
    ['decimals', 'decimals()'],
    ['getReserves', 'getReserves()'],
    ['getPair', 'getPair(address,address)'],
  ].map(([name, value]) => [name!, signature(value!).slice(0, 10)]),
) as Record<
  | 'currentDay'
  | 'stakeCount'
  | 'stakeLists'
  | 'factory'
  | 'token0'
  | 'token1'
  | 'decimals'
  | 'getReserves'
  | 'getPair',
  string
>;

export function boundedWord(v: bigint, bits: number) {
  if (v < 0n || v >= 1n << BigInt(bits)) throw new Error('Noncanonical ABI padding/width.');
  return v;
}
export function abiAddress(v: unknown) {
  return '0x' + boundedWord(words(v, 1)[0]!, 160).toString(16).padStart(40, '0');
}
export function decodeStake(v: unknown) {
  const w = words(v, 7);
  [40, 72, 72, 16, 16, 16, 1].forEach((b, i) => boundedWord(w[i]!, b));
  return LiveStakePageSchema.shape.items.element.parse({
    stakeId: w[0]!.toString(),
    principalHearts: w[1]!.toString(),
    stakeShares: w[2]!.toString(),
    lockedDay: Number(w[3]),
    stakedDays: Number(w[4]),
    unlockedDay: Number(w[5]),
    isAutoStake: w[6] === 1n,
  });
}
export function decodeCurrent(v: unknown) {
  const w = words(v, 13);
  [72, 72, 40, 72, 16, 72, 40, 51, 51, 26, 256, 256, 256].forEach((b, i) => boundedWord(w[i]!, b));
  if (!w[2]) throw new Error('Zero share rate.');
  return {
    lockedHearts: w[0]!,
    nextStakeShares: w[1]!,
    rawShareRate: w[2]!,
    stakePenalty: w[3]!,
    dailyDataCount: Number(w[4]),
    stakeShares: w[5]!,
    timestamp: w[10]!,
    totalSupply: w[11]!,
  };
}
export function decodeReserves(v: unknown) {
  const w = words(v, 3);
  return {
    reserve0: boundedWord(w[0]!, 112),
    reserve1: boundedWord(w[1]!, 112),
    updated: boundedWord(w[2]!, 32),
  };
}
