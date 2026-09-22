import { fixture, FakeClock, LARGE, A, CODE_HASH, hash } from '../sync/fixture.mjs';
import { plan, environment } from './fixture.mjs';
import { sharedProfile } from '../sync/shared-profile.mjs';
export const endpoints = ['https://rpc.pulsechain.com', 'https://rpc-pulsechain.g4mm4.io'];
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
  for (let n = 100; n <= 107; n++) {
    const s = f.states.get(n);
    s.dailyCount = 1;
    if (n > 100) {
      s.supply -= LARGE - amount;
      s.balances.set(A, s.balances.get(A) - LARGE + amount);
    }
  }
  const raw = { http: 0, logical: 0, bytes: 0, active: 0, peak: 0, starts: [], calls: [] };
  let injected = false;
  return {
    f,
    raw,
    clock,
    transport(endpoint) {
      const index = endpoints.indexOf(endpoint);
      if (index < 0) throw Error('Unexpected TEST endpoint');
      const t = f.source(369, 'prefix-' + index, clock, (rows, calls) =>
        rows.map((row, i) => {
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
        if (!injected && mode === 'retry') {
          injected = true;
          response = { ...response, status: 503 };
        }
        if (
          !injected &&
          mode === 'split' &&
          calls.some(
            (c) => c.method === 'eth_getLogs' && c.params[0].fromBlock !== c.params[0].toBlock,
          )
        ) {
          injected = true;
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
