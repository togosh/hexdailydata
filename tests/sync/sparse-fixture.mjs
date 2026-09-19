import {
  fixture,
  FakeClock,
  memoryCooldown,
  CONTRACT,
  CODE,
  CODE_HASH,
  hash,
  A,
} from './fixture.mjs';
import { Source } from '../../src/providers/source.ts';
import { RpcClient } from '../../src/providers/rpc.ts';
import { ProviderBudget } from '../../src/providers/budget.ts';
import { q, word } from '../../src/providers/abi.ts';

// A bounded 37-block event/state oracle; skipped headers and unrelated transactions
// are generated only for an actual request. Integer-second timestamps strictly grow.
export function sparseFixture({ spacing = 1, unrelated = 0 } = {}) {
  if (![1, 64, 8192].includes(spacing)) throw new Error('Unsupported fixture spacing.');
  const base = fixture({ last: 136 });
  const number = (n) => 100 + (n - 100) * spacing;
  const original = (n) => 100 + Math.floor((n - 100) / spacing);
  const timestamp = (n) => 1575331201n + BigInt(Math.floor(((n - 100) * 10800) / spacing));
  const plain = (n) => ({
    number: String(n),
    hash: hash(n),
    parentHash: hash(n - 1),
    timestamp: String(timestamp(n)),
  });
  const logs = [...base.logs.entries()].flatMap(([n, events]) =>
    events.map((event) => ({
      ...event,
      blockNumber: q(number(n)),
      blockHash: hash(number(n)),
      transactionHash: hash(number(n) * 100),
    })),
  );
  const self = structuredClone(logs[0]);
  Object.assign(self, {
    blockNumber: q(number(107)),
    blockHash: hash(number(107)),
    transactionHash: hash(number(107) * 100),
    logIndex: '0x0',
    data: '0x' + word(1),
  });
  self.topics = [
    self.topics[0],
    '0x' + A.slice(2).padStart(64, '0'),
    '0x' + A.slice(2).padStart(64, '0'),
  ];
  logs.push(self);
  logs.sort(
    (a, b) =>
      Number(BigInt(a.blockNumber) - BigInt(b.blockNumber)) ||
      Number(BigInt(a.logIndex) - BigInt(b.logIndex)),
  );
  const clock = new FakeClock(),
    budget = new ProviderBudget('worker', memoryCooldown(), clock);
  const observed = [];
  let generatedHeaders = 0;
  function rpc(call) {
    const p = call.params;
    if (call.method === 'eth_chainId') return '0x1';
    if (call.method === 'eth_getCode') return CODE;
    if (call.method === 'eth_getTransactionReceipt') return { ...base.receipts.get(hash(10000)) };
    if (call.method === 'eth_getBlockByNumber') {
      const n = ['latest', 'finalized'].includes(p[0]) ? number(136) : Number(BigInt(p[0]));
      if (n < 100 || n > number(136)) return null;
      generatedHeaders++;
      const h = plain(n),
        hasEvents = logs.some((e) => e.blockNumber === q(n));
      return {
        ...h,
        number: q(n),
        timestamp: q(h.timestamp),
        transactions: [
          ...(hasEvents || n === 100 ? [hash(n * 100)] : []),
          ...Array.from({ length: unrelated }, (_, i) =>
            hash(100000000000n + BigInt(n) * 10000n + BigInt(i)),
          ),
        ],
      };
    }
    if (call.method === 'eth_getLogs')
      return logs.filter(
        (e) =>
          BigInt(e.blockNumber) >= BigInt(p[0].fromBlock) &&
          BigInt(e.blockNumber) <= BigInt(p[0].toBlock),
      );
    if (call.method === 'eth_call') {
      const n = Number(BigInt(p[1].blockHash)),
        s = base.states.get(original(n));
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
            timestamp(n),
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
    }
    throw new Error('Unexpected sparse fixture request ' + call.method);
  }
  const source = (id, mutate = (rows) => rows, operator = id) => {
    const transport = async (body, signal) => {
      signal.throwIfAborted();
      const calls = JSON.parse(body),
        rows = mutate(
          calls.map((c) => ({ jsonrpc: '2.0', id: c.id, result: rpc(c) })),
          calls,
        );
      return {
        status: 200,
        retryAfter: null,
        body: (async function* () {
          yield Buffer.from(JSON.stringify(rows));
        })(),
      };
    };
    const s = new Source(new RpcClient(id, operator, 1, CONTRACT, transport, budget), {
      codeHash: CODE_HASH,
      finality: { mode: 'confirmed', confirmations: 1, rollbackBlocks: 100000 },
      completeness: 'filtered-ranges',
    });
    observed.push(s);
    return s;
  };
  return {
    number,
    plain,
    source,
    clock,
    budget,
    observed,
    generatedHeaders: () => generatedHeaders,
    logs,
  };
}
