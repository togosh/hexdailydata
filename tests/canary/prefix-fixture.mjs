import { fixture, FakeClock, LARGE, A, B, hash } from '../sync/fixture.mjs';
import { plan, environment } from './fixture.mjs';
import { sharedProfile } from '../sync/shared-profile.mjs';
export const endpoints = ['https://rpc.pulsechain.com', 'https://rpc-pulsechain.g4mm4.io'];
const word = (n) => BigInt(n).toString(16).padStart(64, '0');
const quantity = (n) => '0x' + BigInt(n).toString(16);
const stretch = (n) => 100 + (n - 100) * 32;
const longHeader = (n) => ({
  number: String(n),
  hash: hash(n),
  parentHash: hash(n - 1),
  timestamp: String(1575331201n + (BigInt(n - 100) * 10800n) / 32n),
});
export function dayBoundaryPlan(root, overrides = {}) {
  const short = prefixPlan(root),
    profile = structuredClone(short.profile);
  profile.fork = { parent: longHeader(3000), entry: longHeader(3001) };
  profile.target = longHeader(3010);
  return plan(root, {
    ...short,
    profile,
    ranges: [{ chain: 1, from: '100', to: '1380' }],
    phases: [
      {
        ...short.phases[0],
        through: '1380',
        finalityHeaders: { minimum: '3010', maximum: '100000000' },
      },
    ],
    caps: {
      milliseconds: 3600000,
      http: 600,
      logical: 12000,
      bytes: 268435456,
      responseBytes: 4194304,
    },
    ...overrides,
  });
}

// Reuse the small lifecycle fixture, inserting empty blocks between its observations.
// Events keep their original timestamps/days; this is not another reducer or seed.
function stretchDays(f) {
  // One earning day at 50 hearts / 250 shares gives each 50-share stake 10 hearts.
  // Match the existing GA payout and correct stake4's synthetic settlement to 10.
  const settlement = f.logs.get(126);
  settlement[0].data =
    '0x' +
    word((BigInt('0x' + settlement[0].data.slice(2, 66)) & ((1n << 184n) - 1n)) + (10n << 184n)) +
    settlement[0].data.slice(66);
  settlement[1].data = '0x' + word(110);
  for (const [n, s] of f.states) {
    if (n >= 126) {
      s.supply -= 10n;
      s.balances.set(B, s.balances.get(B) - 10n);
    }
    if (n >= 132) {
      s.balances.set(A, s.balances.get(A) - 11n);
      s.balances.set(B, s.balances.get(B) + 11n);
    }
  }
  for (const [n, begin, end] of [
    [132, 1, 2],
    [140, 2, 3],
  ]) {
    const timestamp = BigInt(f.headers.get(n).timestamp);
    const logs = [
      {
        ...f.logs.get(101)[0],
        topics: [
          '0xb8d6eb541ded1720cc657b719f57abcb1fe4711cb7ead82751b135f5d94bc944',
          '0x' + A.slice(2).padStart(64, '0'),
        ],
        data: '0x' + word(timestamp + (BigInt(begin) << 40n) + (BigInt(end) << 56n)),
      },
    ];
    if (n === 132)
      logs.push({
        ...f.logs.get(101)[0],
        topics: [
          f.logs.get(101)[0].topics[0],
          '0x' + A.slice(2).padStart(64, '0'),
          '0x' + B.slice(2).padStart(64, '0'),
        ],
        data: '0x' + word(11),
      });
    f.logs.set(n, logs);
  }
  const originalStates = new Map(f.states),
    originalLogs = new Map(f.logs);
  f.headers.clear();
  f.logs.clear();
  f.states.clear();
  f.receipts.clear();
  for (let n = 100; n <= 3011; n++) {
    const old = 100 + Math.floor((n - 100) / 32);
    const logs = (n === stretch(old) ? originalLogs.get(old) : []).map((l, i) => ({
      ...l,
      blockNumber: quantity(n),
      blockHash: hash(n),
      transactionHash: hash(n * 100),
      transactionIndex: '0x0',
      logIndex: quantity(i),
    }));
    const transactions = logs.length || n === 100 ? [hash(n * 100)] : [];
    f.headers.set(n, { ...longHeader(n), transactions });
    f.logs.set(n, logs);
    f.states.set(n, originalStates.get(old));
    if (n === 100)
      f.receipts.set(hash(10000), {
        transactionHash: hash(10000),
        transactionIndex: '0x0',
        blockHash: hash(100),
        blockNumber: '0x64',
        contractAddress: originalLogs.get(101)[0].address,
        status: '0x1',
        logs: [],
      });
  }
  f.setHead(3011);
}
export function prefixPlan(root, overrides = {}) {
  const profile = sharedProfile();
  profile.policy = { mode: 'finalized' };
  for (const pair of [profile.ethereum, profile.pulsechain])
    for (let i = 0; i < 2; i++)
      pair[i].endpointEnv = ['HDD_V2_PROVIDER_PULSE_OFFICIAL', 'HDD_V2_PROVIDER_PULSE_G4MM4'][i];
  return plan(root, {
    profile,
    ranges: [{ chain: 1, from: '100', to: '103' }],
    phases: [
      {
        kind: 'common-prefix',
        purpose: 'TEST day-zero literal nonempty prefix',
        through: '103',
        finalityHeaders: { minimum: '188', maximum: '100000000' },
        cadence: {
          rollingMilliseconds: 60000,
          http: 12,
          logical: 360,
          spacingMilliseconds: 2100,
          quarantineMilliseconds: 60000,
        },
        endpoints,
      },
    ],
    caps: {
      milliseconds: 1800000,
      http: 250,
      logical: 5000,
      bytes: 134217728,
      responseBytes: 4194304,
    },
    ...overrides,
  });
}
export function prefixEnvironment(p) {
  const env = environment(p);
  p.profile.ethereum.forEach((s, i) => (env[s.endpointEnv] = endpoints[i]));
  return env;
}
export function prefixFixture(p, clock = new FakeClock(), mode = 'normal') {
  const f = fixture({ last: 220 });
  f.setHead(189);
  const amount = 9007199254740993n;
  f.logs.get(101)[0].data = '0x' + amount.toString(16).padStart(64, '0');
  for (const [n, s] of f.states) {
    s.dailyCount = Math.max(1, s.dailyCount);
    if (n > 100) {
      s.supply -= LARGE - amount;
      s.balances.set(A, s.balances.get(A) - LARGE + amount);
    }
  }
  const multiDay = BigInt(p.phases[0].through) > 180n;
  if (multiDay) stretchDays(f);
  const raw = { http: 0, logical: 0, bytes: 0, active: 0, peak: 0, starts: [], calls: [] };
  let retryInjected = false,
    splitInjected = false;
  return {
    f,
    raw,
    clock,
    transport(endpoint) {
      const index = endpoints.indexOf(endpoint);
      if (index < 0) throw Error('Unexpected TEST endpoint');
      const t = f.source(369, 'prefix-' + index, clock, (rows, calls) =>
        rows.map((row, i) => {
          const call = calls[i];
          if (multiDay && call.method === 'eth_call') {
            const data = call.params[0].data;
            if (data.startsWith('0x6a210a0e')) {
              const begin = Number(BigInt('0x' + data.slice(10, 74))),
                end = Number(BigInt('0x' + data.slice(74)));
              const ledger = [0n, 0n, 50n + (250n << 72n)];
              if (end > ledger.length) throw Error('TEST unmaterialized ledger requested');
              if (index === 1 && mode === 'ledger-disagree') ledger[2] += 1n;
              return {
                ...row,
                result: '0x' + [32, end - begin, ...ledger.slice(begin, end)].map(word).join(''),
              };
            }
            if (
              mode === 'day-close' &&
              data === '0xf04b5fa0' &&
              call.params[1].blockHash === hash(355)
            )
              return { ...row, result: '0x' + word(501) + row.result.slice(66) };
          }
          if (
            index === 1 &&
            mode === 'disagree' &&
            calls[i].method === 'eth_getLogs' &&
            row.result.length &&
            calls[i].params[0].fromBlock !== '0x64'
          ) {
            const result = structuredClone(row.result);
            result[0].data = '0x' + (BigInt(result[0].data) + 1n).toString(16).padStart(64, '0');
            return { ...row, result };
          }
          return row;
        }),
      ).rpc.transport;
      return async (body, signal) => {
        const calls = JSON.parse(body);
        raw.http++;
        raw.logical += calls.length;
        raw.active++;
        raw.peak = Math.max(raw.peak, raw.active);
        raw.starts.push({ at: clock.now(), logical: calls.length });
        raw.calls.push(...calls);
        let response = await t(body, signal);
        if (!retryInjected && ['retry', 'split-retry'].includes(mode)) {
          retryInjected = true;
          response = { ...response, status: 503 };
        }
        if (
          !splitInjected &&
          ['split', 'split-retry'].includes(mode) &&
          calls.some(
            (c) => c.method === 'eth_getLogs' && c.params[0].fromBlock !== c.params[0].toBlock,
          )
        ) {
          splitInjected = true;
          response = {
            status: 200,
            retryAfter: null,
            body: (async function* () {
              yield Buffer.from(
                JSON.stringify(
                  calls.map((c) => ({ jsonrpc: '2.0', id: c.id, error: { code: -32005 } })),
                ),
              );
            })(),
          };
        }
        const original = response;
        return {
          ...response,
          body: (async function* () {
            try {
              for await (const chunk of original.body) {
                raw.bytes += chunk.length;
                yield chunk;
              }
            } finally {
              raw.active--;
            }
          })(),
        };
      };
    },
  };
}
