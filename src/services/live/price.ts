import { createHash } from 'node:crypto';
import { z } from 'zod';
import { address, hash, type Header } from '../projections/input.ts';
import { q, word, words } from '../../providers/abi.ts';
import {
  abiAddress,
  boundedWord,
  decodeReserves,
  liveSelectors as s,
} from '../../providers/live-abi.ts';
import type { RpcCall, RpcClient, ReadTargets } from '../../providers/rpc.ts';
import { rational, displayRatio, type Rational } from '../../domain/units.ts';
import type { PriceValue } from '../../contracts/api.ts';

const tokenSchema = z.strictObject({
  address,
  decimals: z.number().int().min(0).max(18),
  codeHash: hash,
});
export const priceProfileSchema = z
  .strictObject({
    chain: z.union([z.literal(1), z.literal(369)]),
    tokens: z.array(tokenSchema).min(2).max(3),
    factory: z.strictObject({ address, codeHash: hash }),
    pools: z
      .array(z.strictObject({ address, codeHash: hash, token0: address, token1: address }))
      .min(1)
      .max(2),
    route: z.array(address).min(2).max(3),
    minimumAnchorUnits: z.string().regex(/^[1-9][0-9]{0,35}$/),
    anchor: z.strictObject({ token: address, valuation: z.literal('peg_assumed') }),
    metadataRecheckSeconds: z.number().int().min(3600).max(86400),
  })
  .superRefine((p, ctx) => {
    const tokens = new Set(p.tokens.map((t) => t.address));
    const pairs = p.pools.map((x) => [x.token0, x.token1].sort().join('/'));
    if (
      tokens.size !== p.tokens.length ||
      new Set(p.route).size !== p.route.length ||
      new Set(p.pools.map((x) => x.address)).size !== p.pools.length ||
      new Set(pairs).size !== pairs.length ||
      p.route.at(-1) !== p.anchor.token ||
      p.route.some((x) => !tokens.has(x)) ||
      p.pools.some(
        (x) => x.token0 === x.token1 || !tokens.has(x.token0) || !tokens.has(x.token1),
      ) ||
      p.route.slice(1).some((x, i) => !pairs.includes([p.route[i]!, x].sort().join('/')))
    )
      ctx.addIssue({ code: 'custom', message: 'Incompatible price route identities.' });
  });
export type PriceProfile = z.infer<typeof priceProfileSchema>;
export function priceTargets(p: PriceProfile): ReadTargets {
  return {
    tokens: p.tokens.map((x) => x.address),
    pools: p.pools.map((x) => x.address),
    factories: [p.factory.address],
  };
}
export const pinnedCall = (to: string, data: string, h: Header): RpcCall => ({
  method: 'eth_call',
  params: [
    { to, data },
    { blockHash: h.hash, requireCanonical: true },
  ],
});
export function verifyCode(raw: unknown, expected: string) {
  if (
    typeof raw !== 'string' ||
    !/^0x(?:[0-9a-f]{2})+$/.test(raw) ||
    '0x' +
      createHash('sha256')
        .update(Buffer.from(raw.slice(2), 'hex'))
        .digest('hex') !==
      expected
  )
    throw new Error('Wrong deployed code.');
}
export class PriceReader {
  readonly profile: PriceProfile;
  private verified = new Map<string, number>();
  constructor(input: unknown, contract: string) {
    this.profile = priceProfileSchema.parse(input);
    if (
      this.profile.route[0] !== contract ||
      this.profile.tokens.find((t) => t.address === contract)?.decimals !== 8
    )
      throw new Error('Price route must begin with HEX in exact units.');
  }
  plan(rpc: RpcClient, h: Header, now: number) {
    const p = this.profile;
    if (rpc.chain !== p.chain) throw new Error('Price chain mismatch.');
    const metadata = now >= (this.verified.get(rpc.id) ?? -Infinity);
    const calls: RpcCall[] = [];
    if (metadata) {
      calls.push({ method: 'eth_getCode', params: [p.factory.address, q(h.number)] });
      for (const t of p.tokens)
        calls.push(
          { method: 'eth_getCode', params: [t.address, q(h.number)] },
          pinnedCall(t.address, s.decimals, h),
        );
      for (const pool of p.pools)
        calls.push(
          { method: 'eth_getCode', params: [pool.address, q(h.number)] },
          pinnedCall(pool.address, s.factory, h),
          pinnedCall(pool.address, s.token0, h),
          pinnedCall(pool.address, s.token1, h),
          pinnedCall(
            p.factory.address,
            s.getPair + word(BigInt(pool.token0)) + word(BigInt(pool.token1)),
            h,
          ),
        );
    }
    for (const pool of p.pools) calls.push(pinnedCall(pool.address, s.getReserves, h));
    return {
      calls,
      decode: (results: unknown[]) => {
        try {
          let i = 0;
          if (metadata) {
            verifyCode(results[i++], p.factory.codeHash);
            for (const t of p.tokens) {
              verifyCode(results[i++], t.codeHash);
              if (boundedWord(words(results[i++], 1)[0]!, 8) !== BigInt(t.decimals))
                throw new Error('Wrong token decimals.');
            }
            for (const pool of p.pools) {
              verifyCode(results[i++], pool.codeHash);
              if (
                abiAddress(results[i++]) !== p.factory.address ||
                abiAddress(results[i++]) !== pool.token0 ||
                abiAddress(results[i++]) !== pool.token1 ||
                abiAddress(results[i++]) !== pool.address
              )
                throw new Error('Wrong factory/token/pool metadata.');
            }
          }
          const reserves = p.pools.map(() => decodeReserves(results[i++]));
          if (reserves.some((r) => r.updated > BigInt(h.timestamp)))
            throw new Error('Future reserve activity.');
          if (metadata) this.verified.set(rpc.id, now + p.metadataRecheckSeconds * 1000);
          return reserves;
        } catch (error) {
          this.verified.delete(rpc.id);
          throw error;
        }
      },
    };
  }
  ratio(a: ReturnType<typeof decodeReserves>[], b: ReturnType<typeof decodeReserves>[]): Rational {
    if (
      JSON.stringify(a, (_, v) => (typeof v === 'bigint' ? String(v) : v)) !==
      JSON.stringify(b, (_, v) => (typeof v === 'bigint' ? String(v) : v))
    )
      throw new Error('Same-block reserve conflict.');
    const p = this.profile;
    let price = rational(1n, 1n);
    const legs: { price: Rational; output: Rational }[] = [];
    for (let i = 1; i < p.route.length; i++) {
      const from = p.route[i - 1]!,
        to = p.route[i]!;
      const n = p.pools.findIndex(
        (pool) =>
          [pool.token0, pool.token1].includes(from) && [pool.token0, pool.token1].includes(to),
      );
      const pool = p.pools[n]!,
        r = a[n]!;
      const input = pool.token0 === from ? r.reserve0 : r.reserve1,
        output = pool.token0 === to ? r.reserve0 : r.reserve1;
      if (!input || !output) throw new Error('Zero reserves.');
      const f = 10n ** BigInt(p.tokens.find((t) => t.address === from)!.decimals),
        t = 10n ** BigInt(p.tokens.find((t) => t.address === to)!.decimals);
      const ratio = rational(output * f, input * t);
      legs.push({ price: ratio, output: rational(output, t) });
      price = rational(price.numerator * ratio.numerator, price.denominator * ratio.denominator);
    }
    let suffix = rational(1n, 1n);
    for (const leg of [...legs].reverse()) {
      if (
        leg.output.numerator * suffix.numerator <
        BigInt(p.minimumAnchorUnits) * leg.output.denominator * suffix.denominator
      )
        throw new Error('Insufficient route depth.');
      suffix = rational(
        suffix.numerator * leg.price.numerator,
        suffix.denominator * leg.price.denominator,
      );
    }
    return price;
  }
  value(
    a: ReturnType<typeof decodeReserves>[],
    b: ReturnType<typeof decodeReserves>[],
  ): PriceValue {
    const usdPerHex = displayRatio(this.ratio(a, b), 24);
    if (usdPerHex === '0') throw new Error('Price display underflow.');
    return { usdPerHex, valuation: 'peg_assumed', kind: 'spot_estimate' };
  }
}
