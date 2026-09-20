import { createHash } from 'node:crypto';
import { setImmediate as turn } from 'node:timers/promises';
import { q, word, selectors } from '../../src/providers/abi.ts';
import { liveSelectors as s } from '../../src/providers/live-abi.ts';
import { ProviderBudget } from '../../src/providers/budget.ts';
import { RpcClient } from '../../src/providers/rpc.ts';
import { priceTargets } from '../../src/services/live/price.ts';

export const addr = (n) => '0x' + BigInt(n).toString(16).padStart(40, '0');
export const hash = (n) => '0x' + BigInt(n).toString(16).padStart(64, '0');
export const HEX = addr(1),
  ANCHOR = addr(2),
  WRAPPED = addr(3),
  FACTORY = addr(4),
  POOL = addr(5),
  POOL2 = addr(6),
  A = addr(100),
  B = addr(101);
export const CODE = '0x6001600055';
export const CODE_HASH =
  '0x' +
  createHash('sha256')
    .update(Buffer.from(CODE.slice(2), 'hex'))
    .digest('hex');
export const EPOCH = (1575331200 + 400 * 86400) * 1000;
export const signal = new AbortController().signal;
export class SequentialClock {
  time = EPOCH;
  now() {
    return this.time;
  }
  async sleep(ms, signal) {
    signal.throwIfAborted();
    this.time += ms;
    await turn();
    signal.throwIfAborted();
  }
}
export class ManualClock {
  time = EPOCH;
  waits = [];
  now() {
    return this.time;
  }
  sleep(ms, signal) {
    return new Promise((resolve, reject) => {
      signal.throwIfAborted();
      const row = {
        at: this.time + ms,
        done: () => {
          signal.removeEventListener('abort', abort);
          resolve();
        },
      };
      const abort = () => {
        this.waits = this.waits.filter((x) => x !== row);
        reject(signal.reason);
      };
      signal.addEventListener('abort', abort, { once: true });
      this.waits.push(row);
    });
  }
  async advance(ms) {
    const end = this.time + ms;
    while (this.time < end) {
      this.time = Math.min(end, this.time + 100);
      const due = this.waits.filter((x) => x.at <= this.time);
      this.waits = this.waits.filter((x) => x.at > this.time);
      due.forEach((x) => x.done());
      for (let i = 0; i < 4; i++) await turn();
    }
  }
  async drive(promise, max = 180000) {
    let done = false,
      error,
      value;
    promise.then(
      (v) => {
        done = true;
        value = v;
      },
      (e) => {
        done = true;
        error = e;
      },
    );
    for (let n = 0; !done && n < max; n += 100) await this.advance(100);
    if (!done) throw new Error('Virtual fixture did not settle.');
    if (error) throw error;
    return value;
  }
}
export const cooldown = () => ({
  until: 0,
  async read() {
    return this.until;
  },
  async extend(until) {
    this.until = Math.max(this.until, until);
  },
});
export function profile({ reverse = false, via = false } = {}) {
  const token = (address, decimals) => ({ address, decimals, codeHash: CODE_HASH });
  const pool = (address, a, b) => ({
    address,
    token0: reverse ? b : a,
    token1: reverse ? a : b,
    codeHash: CODE_HASH,
  });
  return {
    chain: 369,
    tokens: via
      ? [token(HEX, 8), token(WRAPPED, 18), token(ANCHOR, 6)]
      : [token(HEX, 8), token(ANCHOR, 6)],
    factory: { address: FACTORY, codeHash: CODE_HASH },
    pools: via
      ? [pool(POOL, HEX, WRAPPED), pool(POOL2, WRAPPED, ANCHOR)]
      : [pool(POOL, HEX, ANCHOR)],
    route: via ? [HEX, WRAPPED, ANCHOR] : [HEX, ANCHOR],
    minimumAnchorUnits: '100',
    anchor: { token: ANCHOR, valuation: 'peg_assumed' },
    metadataRecheckSeconds: 3600,
  };
}
export function fixture({
  clock = new SequentialClock(),
  price = profile(),
  store = cooldown(),
} = {}) {
  const snapshots = new Map(),
    attempts = [];
  const state = {
    count: 3,
    byAddress: new Map(),
    dayCount: 400,
    penalty: 77n,
    nextShares: 50n,
    shares: 100n,
    shareRate: 123456n,
    dailyPayoutHearts: 42n,
    dailyPayoutShares: 100n,
    reserves: null,
    supply: 1004489950000n,
    locked: 0n,
    stalled: null,
    list: null,
    hint: null,
    update: BigInt(EPOCH / 1000 - 3600),
    change: null,
    fail: null,
    delay: null,
  };
  let active = 0,
    peak = 0;
  function header(number) {
    if (number === 'latest') {
      const n = state.stalled ?? Math.floor((clock.now() - EPOCH) / 1000) + 100;
      if (!snapshots.has(n))
        snapshots.set(n, {
          number: q(n),
          hash: hash(n),
          parentHash: hash(n - 1),
          timestamp: q(BigInt(EPOCH / 1000 + n - 100)),
          transactions: [],
        });
      return snapshots.get(n);
    }
    return snapshots.get(Number(BigInt(number))) ?? null;
  }
  function count(address) {
    return state.byAddress.get(address) ?? state.count;
  }
  function result(call) {
    if (call.method === 'eth_chainId') return '0x171';
    if (call.method === 'eth_getBlockByNumber') return header(call.params[0]);
    if (call.method === 'eth_getCode') return CODE;
    if (call.method !== 'eth_call') throw new Error('Unexpected fixture method');
    const { to, data } = call.params[0],
      sel = data.slice(0, 10),
      args = data.slice(10);
    const h =
      call.params[1] === 'latest'
        ? header('latest')
        : [...snapshots.values()].find((h) => h.hash === call.params[1].blockHash);
    if (!h) throw new Error('Fixture missing pin');
    const address = '0x' + args.slice(24, 64);
    if (sel === s.stakeCount)
      return (
        '0x' + word(call.params[1] === 'latest' ? (state.hint ?? count(address)) : count(address))
      );
    if (sel === selectors.balanceOf) return '0x' + word(9007199254740993123n);
    if (sel === s.stakeLists) {
      const i = Number(BigInt('0x' + args.slice(64)));
      if (i >= count(address)) return { error: { code: 3 } };
      const id = state.list?.[i] ?? BigInt(i + 1);
      return (
        '0x' + [id, 9007199254740993123n, 9007199254740993001n, 390, 365, 0, 0].map(word).join('')
      );
    }
    if (sel === selectors.totalSupply) return '0x' + word(state.supply);
    if (sel === s.currentDay) return '0x' + word((BigInt(h.timestamp) - 1575331200n) / 86400n);
    if (sel === selectors.globalInfo)
      return (
        '0x' +
        [
          state.locked,
          state.nextShares,
          state.shareRate,
          state.penalty,
          state.dayCount,
          state.shares,
          1099511627775n,
          0,
          0,
          0,
          BigInt(h.timestamp),
          state.supply,
          0,
        ]
          .map(word)
          .join('')
      );
    if (sel === selectors.dailyDataRange) {
      const begin = Number(BigInt('0x' + args.slice(0, 64))),
        end = Number(BigInt('0x' + args.slice(64)));
      return (
        '0x' +
        [
          32,
          end - begin,
          ...Array.from(
            { length: end - begin },
            () => state.dailyPayoutHearts + (state.dailyPayoutShares << 72n),
          ),
        ]
          .map(word)
          .join('')
      );
    }
    if (sel === s.decimals) return '0x' + word(price.tokens.find((t) => t.address === to).decimals);
    if (sel === s.getPair) {
      const tokens = ['0x' + args.slice(24, 64), '0x' + args.slice(88, 128)];
      return (
        '0x' +
        word(
          BigInt(
            price.pools.find((p) => tokens.includes(p.token0) && tokens.includes(p.token1)).address,
          ),
        )
      );
    }
    const pool = price.pools.find((p) => p.address === to);
    if (sel === s.factory) return '0x' + word(BigInt(FACTORY));
    if (sel === s.token0) return '0x' + word(BigInt(pool.token0));
    if (sel === s.token1) return '0x' + word(BigInt(pool.token1));
    if (sel === s.getReserves) {
      const reserve = (token) =>
        state.reserves?.[token] ??
        (token === HEX
          ? 1000n * 10n ** 8n
          : token === WRAPPED
            ? 1000n * 10n ** 18n
            : 25000n * 10n ** 6n);
      return '0x' + [reserve(pool.token0), reserve(pool.token1), state.update].map(word).join('');
    }
    throw new Error('Unexpected fixture selector ' + sel);
  }
  function transport(id) {
    return async (body, signal) => {
      signal.throwIfAborted();
      const calls = JSON.parse(body);
      const event = {
        at: clock.now(),
        id,
        calls: calls.length,
        methods: calls.map((c) => c.method),
        selectors: calls
          .filter((c) => c.method === 'eth_call')
          .map((c) => c.params[0].data.slice(0, 10)),
        bytes: 0,
      };
      attempts.push(event);
      active++;
      peak = Math.max(peak, active);
      try {
        if (state.delay) await state.delay(signal);
        const failure = state.fail?.(id, calls);
        if (failure instanceof Error) throw failure;
        const rows = calls.map((call) => {
          const value = result(call);
          return value?.error
            ? { jsonrpc: '2.0', id: call.id, ...value }
            : { jsonrpc: '2.0', id: call.id, result: value };
        });
        const changed = state.change?.(rows, calls, id) ?? rows;
        const bytes = Buffer.from(JSON.stringify(changed));
        event.bytes = bytes.length;
        return {
          status: failure ?? 200,
          retryAfter: failure === 429 ? '60' : null,
          body: (async function* () {
            yield bytes;
          })(),
        };
      } finally {
        active--;
      }
    };
  }
  const worker = new ProviderBudget('worker', store, clock),
    api = new ProviderBudget('api', store, clock);
  const rpc = (id, budget = worker) =>
    new RpcClient(id, null, 369, HEX, transport(id), budget, priceTargets(price));
  return {
    clock,
    state,
    price,
    worker,
    api,
    store,
    rpc,
    attempts,
    header,
    get peak() {
      return peak;
    },
  };
}
export class MemoryMetrics {
  rows = {};
  writes = 0;
  async read() {
    return structuredClone(this.rows);
  }
  async put(chain, key, row) {
    this.rows[key] = structuredClone(row);
    this.writes++;
  }
}
export const emptyBaseline = {
  async address() {
    return null;
  },
  async stake() {
    return null;
  },
};
