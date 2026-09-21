// Reuses the raw sync and live fixtures. Bulk SQL is shape data, never a seed oracle.
import {
  fixture as syncFixture,
  A,
  B,
  C,
  CONTRACT,
  CODE,
  CODE_HASH,
  hash,
} from '../sync/fixture.mjs';
import { fixture as liveFixture, profile as priceProfile, ANCHOR } from '../live/fixture.mjs';
import { realClock, ProviderBudget } from '../../dist/providers/budget.js';
import { RpcClient } from '../../dist/providers/rpc.js';
import { readFileSync } from 'node:fs';

export { A, B, C, CONTRACT, CODE, CODE_HASH, hash };
export const baseBlock = 296;
export const finalBlock = baseBlock + 30 * 8;
export const bulkAddress = (i) => '0x' + (1000000n + BigInt(i)).toString(16).padStart(40, '0');
export const principal = (i) => 100000000000n + BigInt(i % 10000) * 100000000n;
export const shares = (i) => 1000000000000n + BigInt(i % 10000) * 300000007n;
// Ordinary varying balances plus ONE >2^53 precision case. Repeating the old
// extreme balance 500k times made the synthetic daily payout exceed uint72.
export const liquid = (i) =>
  i === 1 ? 900719925474099312345n : 1000000000000n + BigInt(i) * 100000003n;
export const isOpen = (i) => i % 10 >= 3;
export const owner = (i) => (i <= 10000 ? 1 : ((i - 1) % 500000) + 1);
export function control() {
  return JSON.parse(readFileSync('/input/control.json', 'utf8'));
}
export function clockFor(c) {
  const epoch = c.epoch;
  return {
    now: () => epoch + Date.now() - c.started,
    sleep: realClock.sleep,
  };
}
// Observe dispatch inside the actual scheduler; preserve its work, callbacks and decisions.
export function meterBudget() {
  const dispatches = [],
    budgets = new Set(),
    clients = new Set();
  const calls = RpcClient.prototype.calls;
  RpcClient.prototype.calls = function (...args) {
    clients.add(this);
    return calls.apply(this, args);
  };
  let inflight = 0,
    inflightPeak = 0;
  const run = ProviderBudget.prototype.run;
  ProviderBudget.prototype.run = function (lane, logical, deadline, signal, work, onDispatch) {
    budgets.add(this);
    let row;
    return run.call(
      this,
      lane,
      logical,
      deadline,
      signal,
      async () => {
        inflightPeak = Math.max(inflightPeak, ++inflight);
        try {
          return await work();
        } finally {
          inflight--;
          row.ended = this.clock.now();
        }
      },
      () => {
        row = { at: this.clock.now(), lane, logical };
        dispatches.push(row);
        onDispatch?.();
      },
    );
  };
  return () => ({
    dispatches,
    inflightPeak,
    counters: [...budgets].map((b) => ({ role: b.role, ...b.counters })),
    rpc: [...clients].map((r) => ({ id: r.id, ...r.counters })),
  });
}
export function model(c, withBulk = true) {
  const f = syncFixture({
    last: finalBlock + 512,
    startDay: c.startDay,
    mutateBlock({ number, transfer, start, end }) {
      const cycle = (number - baseBlock) / 8;
      if (Number.isInteger(cycle) && cycle >= 1 && cycle <= 30 && cycle % 3 !== 0) {
        transfer(A, C, 7);
        const id = 2000000 + cycle;
        start(id, A, 1000, 500, cycle === 4 || cycle % 2 ? 1 : 30);
        if (cycle % 5 === 0) end(id, 0, 0);
      }
      if (number === baseBlock + 6 * 8 + 1) end(2000004, 10, 0, true);
      if (number === baseBlock + 6 * 8 + 2) end(2000004, 10, 1, false, true);
      if (number > finalBlock) transfer(A, C, 1);
    },
  });
  // Tiny independent sums over a repeated 10,000-row pattern, not SQL-derived expectations.
  let locked = 0n,
    accounted = 0n,
    earning = 0n,
    queued = 0n;
  for (let i = 1; i <= 10000; i++) {
    if (i % 10 === 1 || isOpen(i)) locked += principal(i) * 100n;
    if (isOpen(i)) {
      accounted += principal(i) * 100n;
      if (i % 2) queued += shares(i) * 100n;
      else earning += shares(i) * 100n;
    }
  }
  const supply =
    500000n * 1000000000000n +
    (100000003n * 500000n * 500001n) / 2n +
    900719925474099312345n -
    (1000000000000n + 100000003n);
  const fixed = { ...f.states.get(finalBlock) };
  for (const [n, h] of f.headers) {
    if (n > finalBlock) {
      h.timestamp =
        c.label === 'mixed'
          ? String(Math.floor(c.epoch / 1000) + (n - finalBlock - 1) * 3)
          : String(BigInt(f.headers.get(finalBlock).timestamp) + BigInt(n - finalBlock));
      const state = f.states.get(n);
      state.active = fixed.active;
      state.queued = fixed.queued;
      state.dailyCount = c.startDay + 54;
    }
    if (withBulk && n >= baseBlock) {
      const s = f.states.get(n);
      s.supply += supply;
      s.locked += locked;
      s.active += earning + (n >= baseBlock + 8 ? queued : 0n);
      s.queued += n >= baseBlock + 8 ? 0n : queued;
    }
  }
  const price = priceProfile();
  price.tokens[0].address = CONTRACT;
  for (const token of price.tokens) token.codeHash = CODE_HASH;
  for (const pool of price.pools) {
    pool.token0 = CONTRACT;
    pool.codeHash = CODE_HASH;
  }
  price.factory.codeHash = CODE_HASH;
  price.route[0] = CONTRACT;
  const clock = clockFor(c);
  const live = liveFixture({ clock, price });
  live.state.reserves = { [CONTRACT]: 1000n * 10n ** 8n, [ANCHOR]: 25000n * 10n ** 6n };
  const baseTransport = f.source(369, 'raw-model').rpc.transport;
  const priceTransport = live.rpc('price-model').transport;
  const word = (n) => BigInt(n).toString(16).padStart(64, '0');
  function ids(address) {
    const i = Number(BigInt(address) - 1000000n);
    if (i < 1 || i > 500000) return [];
    const candidates =
      i === 1
        ? Array.from({ length: 10000 }, (_, k) => k + 1).concat(500001)
        : [i, i + 500000].filter((n) => n > 10000);
    return candidates.filter((n) => isOpen(n) || n % 10 === 1);
  }
  async function raw(body, signal, head, chain = 369) {
    f.setHead(head);
    const h = f.headers.get(head);
    const requests = JSON.parse(body),
      answers = [];
    for (const r of requests) {
      const data = r.params[0]?.data,
        selector = data?.slice(0, 10);
      let value;
      if (r.method === 'eth_chainId') value = '0x' + chain.toString(16);
      else if (['cycle-12', 'cycle-13'].includes(c.label) && selector === '0x0902f1ac')
        value = '0x'; // Two simulated days of malformed market input; native work continues.
      else if (r.method === 'eth_call' && r.params[0].to !== CONTRACT) {
        const pin = r.params[1];
        const pinned = typeof pin === 'object' ? f.headers.get(Number(BigInt(pin.blockHash))) : h;
        live.state.update = BigInt(pinned.timestamp) - 10n;
        live.header('latest');
        const response = await priceTransport(
          JSON.stringify([{ ...r, params: [r.params[0], 'latest'] }]),
          signal,
        );
        let bytes = '';
        for await (const chunk of response.body) bytes += Buffer.from(chunk).toString();
        value = JSON.parse(bytes)[0].result;
      } else if (r.method === 'eth_getCode') value = CODE;
      else if (selector === '0x313ce567') value = '0x' + word(8);
      else if (selector === '0x5c9302c9')
        value = '0x' + word(Math.floor((Number(h.timestamp) - 1575331200) / 86400));
      else if (selector === '0x33060d90' || selector === '0x2607443b') {
        const address = '0x' + data.slice(34, 74),
          list = ids(address);
        if (selector === '0x33060d90') value = '0x' + word(list.length);
        else {
          const index = Number(BigInt('0x' + data.slice(74))),
            id = list[index];
          if (id === undefined) throw new Error('Synthetic list index out of range');
          value =
            '0x' +
            [
              1000000 + id,
              principal(id),
              shares(id),
              c.startDay + 24 + (id % 10 === 1 ? -2 : id % 2),
              id % 10 === 1 ? 1 : 1 + (id % 5555),
              id % 10 === 1 ? c.startDay + 24 : 0,
              0,
            ]
              .map(word)
              .join('');
        }
      } else if (
        selector === '0x70a08231' &&
        BigInt('0x' + data.slice(-40)) >= 1000001n &&
        BigInt('0x' + data.slice(-40)) <= 1500000n
      ) {
        value = '0x' + word(liquid(Number(BigInt('0x' + data.slice(-40)) - 1000000n)));
      } else {
        const response = await baseTransport(JSON.stringify([r]), signal);
        let bytes = '';
        for await (const chunk of response.body) bytes += Buffer.from(chunk).toString();
        value = JSON.parse(bytes)[0].result;
      }
      answers.push({ jsonrpc: '2.0', id: r.id, result: value });
    }
    return Buffer.from(JSON.stringify(answers));
  }
  return { f, price, clock, raw, bulk: { locked, accounted, earning, queued, supply } };
}
