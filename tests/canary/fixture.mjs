import { randomUUID } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import { fixture, FakeClock, CONTRACT, CODE_HASH, hash } from '../sync/fixture.mjs';
import { canaryPlanSchema, planDigest } from '../../dist/operator/canary-plan.js';

export const release = 'sha256:' + 'a'.repeat(64);
export function plan(root, overrides = {}) {
  const f = fixture({ last: 220 });
  const provider = (chain, n) => ({
    id: `fixture-${chain}-${n}`,
    operator: `fixture-${n}`,
    accountGroup: 'fixture-only',
    endpointEnv: `HDD_V2_PROVIDER_${chain}_${n}`,
  });
  return canaryPlanSchema.parse({
    version: 1,
    session: randomUUID(),
    release,
    reviewedCommit: 'b'.repeat(40),
    project: process.env.HDD_V2_PROJECT,
    instance: process.env.HDD_V2_DB_INSTANCE,
    storagePath: root,
    quotaPath: root + '/quota',
    sessionPath: root + '/canary.json',
    identityStatus: 'declared-unverified',
    correlation: 'declared-distinct',
    profile: {
      contract: CONTRACT,
      codeHash: CODE_HASH,
      policy: { mode: 'confirmed', confirmations: 1, rollbackBlocks: 128 },
      ethereum: [provider(1, 1), provider(1, 2)],
      pulsechain: [provider(369, 1), provider(369, 2)],
      constructor: { checkpoint: f.plain(100), transactionHash: hash(10000), balances: [] },
      fork: { parent: f.plain(180), entry: f.plain(181) },
      target: f.plain(188),
    },
    price: null,
    ranges: [
      { chain: 1, from: '100', to: '220' },
      { chain: 369, from: '100', to: '220' },
    ],
    methods: [
      'eth_chainId',
      'eth_getBlockByNumber',
      'eth_getCode',
      'eth_getLogs',
      'eth_getTransactionReceipt',
      'eth_call',
    ],
    allowHeadObservation: true,
    phases: [
      {
        kind: 'replay',
        purpose: 'Exact raw fixture replay and audit',
        basis: 'constructor-prefix',
      },
    ],
    notConfigured: ['Synthetic fixture; never a live input.'],
    cost: {
      policy: 'no-paid-overage',
      maximumUsd: 0,
      basis: 'Offline synthetic transport; zero real provider calls.',
    },
    caps: {
      milliseconds: 3600000,
      http: 2500,
      logical: 20000,
      bytes: 536870912,
      responseBytes: 1048576,
    },
    ...overrides,
  });
}
export function environment(p) {
  const env = {
    ...process.env,
    HDD_V2_CANARY_RELEASE: p.release,
    HDD_V2_PROJECT: p.project,
    HDD_V2_DB_INSTANCE: p.instance,
    HDD_V2_STORAGE_PATH: p.storagePath,
    HDD_V2_PROVIDER_STATE: p.quotaPath,
    HDD_V2_ALLOW_LIVE_RPC: 'true',
    HDD_V2_CANARY_OPT_IN: p.session,
  };
  for (const s of [...p.profile.ethereum, ...p.profile.pulsechain])
    env[s.endpointEnv] = 'https://' + s.id + '.invalid';
  return env;
}
export async function inputs(p) {
  await mkdir(p.quotaPath, { recursive: true });
  await writeFile(p.storagePath + '/plan.json', JSON.stringify(p));
  await writeFile(
    p.storagePath + '/approval.json',
    JSON.stringify({
      session: p.session,
      planDigest: planDigest(p),
      release: p.release,
      instance: p.instance,
      decision: 'owner-approved-bounded-canary',
    }),
  );
}
export function rawFixture(p, clock = new FakeClock(), rangeFailure = false) {
  const f = fixture({ last: 220 });
  f.setHead(189);
  const raw = { http: 0, logical: 0, bytes: 0, active: 0, peak: 0 };
  const transports = new Map();
  for (const [chain, pair] of [
    [1, p.profile.ethereum],
    [369, p.profile.pulsechain],
  ])
    for (const s of pair) {
      const transport = f.source(chain, s.id, clock).rpc.transport;
      transports.set('https://' + s.id + '.invalid', async (body, signal) => {
        raw.http++;
        raw.logical += JSON.parse(body).length;
        raw.active++;
        raw.peak = Math.max(raw.peak, raw.active);
        const requested = JSON.parse(body);
        const rejectRange =
          rangeFailure &&
          requested.some(
            (c) => c.method === 'eth_getLogs' && c.params[0].fromBlock !== c.params[0].toBlock,
          );
        if (rejectRange) rangeFailure = false;
        const response = rejectRange
          ? {
              status: 200,
              retryAfter: null,
              body: (async function* () {
                yield Buffer.from(
                  JSON.stringify(
                    requested.map((c) => ({ jsonrpc: '2.0', id: c.id, error: { code: -32005 } })),
                  ),
                );
              })(),
            }
          : await transport(body, signal);
        return {
          ...response,
          body: (async function* () {
            try {
              for await (const chunk of response.body) {
                raw.bytes += chunk.length;
                yield chunk;
              }
            } finally {
              raw.active--;
            }
          })(),
        };
      });
    }
  return {
    f,
    clock,
    raw,
    transport: (endpoint) => {
      if (!transports.has(endpoint)) throw Error('Real transport forbidden.');
      return transports.get(endpoint);
    },
  };
}
