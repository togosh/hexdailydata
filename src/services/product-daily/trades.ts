import { parse, isLosslessNumber } from 'lossless-json';
import { ReadingSchema, type ProductReading } from '../../contracts/product-daily.ts';

export type TradeReading = Extract<ProductReading, { kind: 'trade' }>;
export const tradeMethod = 'bitstamp-recent-trade-usd-1' as const;
export const tradeDisclosure =
  'BTC/ETH recent-trade references: Bitstamp spot USD transactions; greatest reported second then numeric trade ID as a deterministic tie-break, not execution order. Each asset retains its own trade time. Not a guaranteed executable or global price; later samples are not daily closes. Local technical candidate; commercial rights unresolved.';
const text = (v: unknown): string => {
  if (typeof v === 'string') return v;
  if (isLosslessNumber(v)) return v.value;
  throw Error('TRADE_EXACT_TOKEN');
};
export function decimalToken(v: unknown) {
  const s = text(v);
  if (s.length > 160 || !/^\d+(?:\.\d+)?(?:[eE][+-]?\d+)?$/.test(s)) throw Error('TRADE_PRICE');
  const [mantissa, exponent = '0'] = s.toLowerCase().split('e'),
    e = Number(exponent);
  if (!Number.isInteger(e) || Math.abs(e) > 100) throw Error('TRADE_PRICE');
  const [whole, fraction = ''] = mantissa!.split('.'),
    digits = whole! + fraction;
  const point = whole!.length + e;
  let value =
    point <= 0
      ? '0.' + '0'.repeat(-point) + digits
      : point >= digits.length
        ? digits + '0'.repeat(point - digits.length)
        : digits.slice(0, point) + '.' + digits.slice(point);
  value = value
    .replace(/^0+(?=\d)/, '')
    .replace(/(\.\d*?)0+$/, '$1')
    .replace(/\.$/, '');
  if (value.length > 160 || !/[1-9]/.test(value)) throw Error('TRADE_PRICE');
  return value;
}
function integer(v: unknown, positive: boolean) {
  const s = text(v);
  if (!/^\d{1,80}$/.test(s)) throw Error('TRADE_INTEGER');
  const n = BigInt(s);
  if (positive && n === 0n) throw Error('TRADE_INTEGER');
  return n.toString();
}
export function parseTradeBody(body: string) {
  const data = parse(body, undefined, {
    onDuplicateKey: () => {
      throw Error('DUPLICATE_JSON_KEY');
    },
  });
  let objects = 0;
  const stack: unknown[] = [data];
  while (stack.length) {
    const v = stack.pop();
    if (v && typeof v === 'object' && !isLosslessNumber(v)) {
      if (++objects > 20000) throw Error('SOURCE_OBJECT_BOUND');
      stack.push(...Object.values(v));
    }
  }
  return { data, objects };
}
export function qualifyMarkets(body: string) {
  const { data, objects } = parseTradeBody(body);
  if (!Array.isArray(data)) throw Error('MARKETS_ARRAY');
  const selected = ['BTC', 'ETH'].map((asset) => {
    const found = data.filter((r) => r && r.market_symbol === asset.toLowerCase() + 'usd');
    if (found.length !== 1) throw Error('MARKET_IDENTITY');
    const r = found[0];
    if (
      r.base_currency !== asset ||
      r.counter_currency !== 'USD' ||
      r.market_type !== 'SPOT' ||
      r.trading !== 'Enabled'
    )
      throw Error('MARKET_IDENTITY');
    return r;
  });
  return { objects, selected };
}
export function tradeIdentity(r: TradeReading) {
  return `${r.exchange}:${r.market}:${r.tradeId}`;
}
export function assertTradeIdentities(readings: readonly ProductReading[]) {
  const found = new Map<string, string>();
  for (const r of readings)
    if (r.kind === 'trade') {
      const key = tradeIdentity(r),
        tuple = r.observedAtUtc + ':' + r.value;
      if (found.has(key) && found.get(key) !== tuple) throw Error('TRADE_IDENTITY_CONFLICT');
      found.set(key, tuple);
    }
}
/** Source time first; numeric ID is only a within-second deterministic tie-break. */
export function compareTrades(a: TradeReading, b: TradeReading) {
  if (a.asset !== b.asset || a.market !== b.market) throw Error('TRADE_MARKET_SWAP');
  assertTradeIdentities([a, b]);
  return (
    Math.sign(Date.parse(a.observedAtUtc) - Date.parse(b.observedAtUtc)) ||
    (BigInt(a.tradeId) > BigInt(b.tradeId) ? 1 : BigInt(a.tradeId) < BigInt(b.tradeId) ? -1 : 0)
  );
}
export function sampleTrades(
  body: string,
  asset: 'BTC' | 'ETH',
  retained: readonly ProductReading[] = [],
  now = Date.now(),
) {
  const { data, objects } = parseTradeBody(body);
  const rows = Array.isArray(data)
    ? data
    : data &&
        typeof data === 'object' &&
        !isLosslessNumber(data) &&
        'date' in data &&
        'tid' in data &&
        'price' in data
      ? [data]
      : null;
  if (!rows) throw Error('TRANSACTIONS_SHAPE');
  const readings: TradeReading[] = rows.map((r) => {
    if (!r || typeof r !== 'object' || Array.isArray(r)) throw Error('TRADE_TUPLE');
    if ('error' in r || 'errors' in r) throw Error('TRADE_ERROR_ENVELOPE');
    const second = BigInt(integer(r.date, false));
    if (second > BigInt(Math.floor(now / 1000))) throw Error('FUTURE_TRADE');
    const observedAtUtc = new Date(Number(second) * 1000).toISOString();
    return ReadingSchema.parse({
      kind: 'trade',
      asset,
      quote: 'USD',
      exchange: 'Bitstamp',
      market: asset.toLowerCase() + 'usd',
      method: tradeMethod,
      tradeId: integer(r.tid, true),
      value: decimalToken(r.price),
      observedAtUtc,
    }) as TradeReading;
  });
  assertTradeIdentities([...retained, ...readings]);
  let selected: TradeReading | null = null;
  for (const r of readings) if (!selected || compareTrades(r, selected) > 0) selected = r;
  const newest = selected ? readings.filter((r) => r.observedAtUtc === selected.observedAtUtc) : [];
  return {
    objects,
    shape: Array.isArray(data) ? 'array' : 'single-tuple',
    records: rows.length,
    readings,
    selected,
    newestSecondCandidates: newest.length,
    newestSecondDistinctPrices: new Set(newest.map((r) => r.value)).size,
  };
}
export function freshTradePair(readings: readonly ProductReading[], now = Date.now()) {
  return (
    readings.length === 2 &&
    new Set(readings.map((r) => (r.kind === 'trade' ? r.asset : ''))).size === 2 &&
    readings.every(
      (r) =>
        r.kind === 'trade' &&
        now >= Date.parse(r.observedAtUtc) &&
        now - Date.parse(r.observedAtUtc) <= 300000,
    )
  );
}
