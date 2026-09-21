import { createHash } from 'node:crypto';
import { ProviderBudget } from '../../src/providers/budget.ts';
import { RpcClient } from '../../src/providers/rpc.ts';
import { Source } from '../../src/providers/source.ts';

export const A = '0x' + '11'.repeat(20),
  B = '0x' + '22'.repeat(20),
  C = '0x' + '33'.repeat(20),
  ZERO = '0x' + '00'.repeat(20),
  CONTRACT = '0x' + 'ab'.repeat(20);
export const CODE = '0x60006000',
  CODE_HASH =
    '0x' +
    createHash('sha256')
      .update(Buffer.from(CODE.slice(2), 'hex'))
      .digest('hex');
export const LARGE = 900719925474099312345678n;
export const hash = (n) => '0x' + BigInt(n).toString(16).padStart(64, '0');
const qty = (n) => '0x' + BigInt(n).toString(16),
  word = (n) => BigInt(n).toString(16).padStart(64, '0'),
  addr = (a) => '0x' + a.slice(2).padStart(64, '0');
// Frozen literal interface identities, independent of the production signature function.
const TOPIC = {
  transfer: '0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef',
  start: '0x14872dc760f33532684e68e1b6d5fd3f71ba7b07dee76bdb2b084f28b74233ef',
  end: '0x72d9c5a7ab13846e08d9c838f9e866a1bb4a66a2fd3ba3c9e7da3cf9e394dfd7',
  ga: '0xd824970a2cf19cc2b630c87ce5b00f67301cac3ac60513d027c7a39129f93b46',
};
export class FakeClock {
  time = 0;
  now = () => this.time;
  async sleep(ms, signal) {
    signal.throwIfAborted();
    this.time += ms;
    await new Promise((resolve) => setImmediate(resolve));
  }
}
export function memoryCooldown() {
  let until = 0;
  return {
    read: async () => until,
    extend: async (value) => {
      until = Math.max(until, value);
    },
  };
}
export function fixture({ last = 364, holdersPerBlock = 0, startDay = 0, mutateBlock } = {}) {
  const observedSources = [];
  const headers = new Map(),
    logs = new Map(),
    states = new Map(),
    receipts = new Map();
  const balances = new Map(),
    stakes = new Map();
  let supply = 0n,
    locked = 0n;
  for (let number = 100; number <= last; number++) {
    const day = startDay + Math.floor((number - 100) / 8),
      timestamp = 1575331200n + BigInt(day) * 86400n + BigInt((number - 100) % 8) * 10800n + 1n;
    const h = {
      number: String(number),
      hash: hash(number),
      parentHash: hash(number - 1),
      timestamp: String(timestamp),
    };
    const events = [];
    function push(topics, data) {
      events.push({
        address: CONTRACT,
        blockNumber: qty(number),
        blockHash: h.hash,
        transactionHash: hash(number * 100),
        transactionIndex: '0x0',
        logIndex: qty(events.length),
        removed: false,
        topics,
        data,
      });
    }
    function transfer(from, to, amount) {
      amount = BigInt(amount);
      push([TOPIC.transfer, addr(from), addr(to)], '0x' + word(amount));
      if (from === ZERO) supply += amount;
      else balances.set(from, (balances.get(from) ?? 0n) - amount);
      if (to === ZERO) supply -= amount;
      else balances.set(to, (balances.get(to) ?? 0n) + amount);
    }
    function start(id, owner, amount, shares, days) {
      transfer(owner, ZERO, amount);
      push(
        [TOPIC.start, addr(owner), hash(id)],
        '0x' +
          word(
            timestamp + (BigInt(amount) << 40n) + (BigInt(shares) << 112n) + (BigInt(days) << 184n),
          ),
      );
      stakes.set(id, {
        owner,
        principal: BigInt(amount),
        shares: BigInt(shares),
        lockedDay: Math.max(day + 1, 2),
        days,
        status: 'unsettled',
      });
      locked += BigInt(amount);
    }
    function end(id, payout, served, ga = false, prev = false) {
      const s = stakes.get(id);
      push(
        [ga ? TOPIC.ga : TOPIC.end, addr(s.owner), hash(id), ...(ga ? [addr(A)] : [])],
        '0x' +
          word(timestamp + (s.principal << 40n) + (s.shares << 112n) + (BigInt(payout) << 184n)) +
          word((BigInt(served) << 72n) + (prev ? 1n << 88n : 0n)),
      );
      s.status = ga ? 'ga' : 'ended';
      if (!ga) {
        locked -= s.principal;
        transfer(ZERO, s.owner, s.principal + BigInt(payout));
      }
    }
    if (number === 101) {
      transfer(ZERO, A, LARGE);
      transfer(ZERO, B, 10000);
    }
    if (number === 102) start(1, A, 100, 50, 1);
    if (number === 103) start(2, B, 200, 100, 100);
    if (number === 104) {
      start(3, B, 100, 50, 1);
      end(3, 0, 0);
    }
    if (number === 105) start(4, B, 100, 50, 1);
    if (number === 106) start(8, B, 100, 50, 1);
    if (number === 125) end(1, 10, 0, true);
    if (number === 126) end(4, 20, 1);
    if (number === 179) start(6, B, 300, 150, 100);
    if (number === 180) start(7, B, 400, 200, 100);
    if (number === 181) {
      end(1, 10, 1, false, true);
      transfer(A, C, 11);
    }
    if (number > 181) {
      for (let i = 0; i < holdersPerBlock; i++) {
        const owner = '0x' + (BigInt(number) * 1000n + BigInt(i)).toString(16).padStart(40, '0');
        transfer(A, owner, 1);
      }
    }
    mutateBlock?.({ number, day, transfer, start, end });
    const txs = events.length || number === 100 ? [hash(number * 100)] : [];
    headers.set(number, { ...h, transactions: txs });
    logs.set(number, events);
    for (const tx of txs)
      receipts.set(tx, {
        transactionHash: tx,
        transactionIndex: '0x0',
        blockHash: h.hash,
        blockNumber: qty(number),
        contractAddress: number === 100 ? CONTRACT : null,
        status: '0x1',
        logs: events,
      });
    let active = 0n,
      queued = 0n;
    for (const s of stakes.values())
      if (s.status === 'unsettled') {
        if (s.lockedDay <= day) active += s.shares;
        else queued += s.shares;
      }
    states.set(number, {
      supply,
      locked,
      active,
      queued,
      dailyCount: Math.max(0, day - 2),
      balances: new Map(balances),
    });
  }
  let head = last;
  function rpc(request) {
    const p = request.params;
    if (request.method === 'eth_chainId') return '0x1';
    if (request.method === 'eth_getCode') return CODE;
    if (request.method === 'eth_getBlockByNumber') {
      const n = ['latest', 'finalized'].includes(p[0]) ? head : Number(BigInt(p[0]));
      const h = headers.get(n);
      return h ? { ...h, number: qty(n), timestamp: qty(h.timestamp) } : null;
    }
    if (request.method === 'eth_getTransactionReceipt') return receipts.get(p[0]) ?? null;
    if (request.method === 'eth_getLogs') {
      const result = [];
      for (let i = Number(BigInt(p[0].fromBlock)); i <= Number(BigInt(p[0].toBlock)); i++)
        result.push(...(logs.get(i) ?? []));
      return result;
    }
    if (request.method === 'eth_call') {
      const h = [...headers.values()].find((x) => x.hash === p[1].blockHash);
      if (!h) throw new Error('fixture unknown pinned block');
      const s = states.get(Number(h.number));
      const data = p[0].data,
        selector = data.slice(0, 10);
      if (selector === '0x18160ddd') return '0x' + word(s.supply);
      if (selector === '0xf04b5fa0')
        return (
          '0x' +
          [
            s.locked,
            s.queued,
            100000,
            0,
            s.dailyCount,
            s.active,
            8,
            0,
            0,
            0,
            h.timestamp,
            s.supply,
            0,
          ]
            .map(word)
            .join('')
        );
      if (selector === '0x70a08231')
        return '0x' + word(s.balances.get('0x' + data.slice(-40)) ?? 0n);
      if (selector === '0x6a210a0e') {
        const a = Number(BigInt('0x' + data.slice(10, 74))),
          b = Number(BigInt('0x' + data.slice(74)));
        return (
          '0x' +
          [
            32,
            b - a,
            ...Array.from(
              { length: b - a },
              (_, i) => BigInt((a + i + 1) * 100) + (BigInt((a + i + 1) * 50) << 72n),
            ),
          ]
            .map(word)
            .join('')
        );
      }
      throw new Error('fixture unknown selector ' + selector);
    }
    throw new Error('fixture unknown method ' + request.method);
  }
  function source(
    chain,
    id,
    clock = new FakeClock(),
    mutate = (x) => x,
    budget = new ProviderBudget('worker', memoryCooldown(), clock),
  ) {
    const transport = async (body, signal) => {
      signal.throwIfAborted();
      let responses = JSON.parse(body).map((r) => ({
        jsonrpc: '2.0',
        id: r.id,
        result: r.method === 'eth_chainId' ? qty(chain) : rpc(r),
      }));
      responses = mutate(responses, JSON.parse(body));
      return {
        status: 200,
        retryAfter: null,
        body: (async function* () {
          yield Buffer.from(JSON.stringify(responses.reverse()));
        })(),
      };
    };
    const source = new Source(new RpcClient(id, id, chain, CONTRACT, transport, budget), {
      codeHash: CODE_HASH,
      finality: { mode: 'confirmed', confirmations: 1, rollbackBlocks: 128 },
      completeness: 'filtered-ranges',
    });
    observedSources.push(source);
    return source;
  }
  const plain = (n) => {
    const { transactions, ...h } = headers.get(n);
    return h;
  };
  return {
    headers,
    logs,
    states,
    receipts,
    observedSources,
    source,
    plain,
    setHead: (n) => {
      head = n;
    },
    last,
  };
}
