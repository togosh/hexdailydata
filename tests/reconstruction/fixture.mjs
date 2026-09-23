import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdir, writeFile, readFile } from 'node:fs/promises';
import pg from 'pg';
import {
  newPrefix,
  admission,
  continuationFixture,
  execute,
  START,
} from '../canary/continuation-fixture.mjs';
import { dayBoundaryPlan, endpoints } from '../canary/prefix-fixture.mjs';
import { FakeClock } from '../sync/fixture.mjs';
import { reconstructionPlanSchema } from '../../dist/operator/reconstruction-plan.js';
import { digest } from '../../dist/services/projections/input.js';
import { runReconstruction } from '../../dist/operator/reconstruction.js';

export const json = async (path) => JSON.parse(await readFile(path, 'utf8'));
export const save = (name, value) =>
  writeFile('/evidence/' + name + '.json', JSON.stringify(value, null, 2));
export async function admin(work) {
  const c = new pg.Client({
    host: 'db',
    database: 'hexdailydata_v2',
    user: 'hdd_v2_admin',
    password: process.env.HDD_V2_ADMIN_PASSWORD,
  });
  await c.connect();
  try {
    return await work(c);
  } finally {
    await c.end();
  }
}
export function environment(p) {
  const env = {
    ...process.env,
    HDD_V2_PROJECT: p.project,
    HDD_V2_DB_INSTANCE: p.instance,
    HDD_V2_RECONSTRUCTION_RELEASE: p.release,
    HDD_V2_REVIEWED_COMMIT: p.reviewedCommit,
    HDD_V2_STORAGE_PATH: p.storagePath,
    HDD_V2_PROVIDER_STATE: p.quotaPath,
    HDD_V2_RECONSTRUCTION_OPT_IN: p.run,
    HDD_V2_ALLOW_LIVE_RPC: 'true',
  };
  p.profile.ethereum.forEach((s, i) => (env[s.endpointEnv] = p.endpoints[i]));
  return env;
}
export async function inputs(p) {
  await mkdir(p.storagePath, { recursive: true });
  await mkdir(p.quotaPath, { recursive: true });
  await writeFile(p.storagePath + '/../plan.json', JSON.stringify(p));
  await writeFile(
    p.storagePath + '/../approval.json',
    JSON.stringify({
      run: p.run,
      planDigest: digest(p),
      release: p.release,
      reviewedCommit: p.reviewedCommit,
      instance: p.instance,
      decision: 'owner-approved-bounded-reconstruction',
      resumePolicy: p.resumePolicy,
    }),
  );
}
export function fixture(p, clock, mode = 'normal') {
  const old = dayBoundaryPlan('/synthetic-input-only');
  const f = continuationFixture(old, clock);
  const attempts = [];
  let injected = false;
  return {
    f,
    attempts,
    transport(endpoint) {
      const index = p.endpoints.indexOf(endpoint);
      if (index < 0) throw Error('Unexpected synthetic endpoint');
      const raw = f.transport(endpoints[index]);
      return async (body, signal, deadline) => {
        const calls = JSON.parse(body);
        const record = {
          source: p.profile.ethereum[index].id,
          at: clock.now(),
          deadline,
          logical: calls.length,
          methods: calls.map((c) => c.method),
          ...(p.target === '357' ? { calls: structuredClone(calls) } : {}),
          bytes: 0,
          complete: false,
        };
        attempts.push(record);
        let response = await raw(body, signal, deadline);
        if (!injected && mode === 'retry') {
          injected = true;
          response = { ...response, status: 503 };
        }
        if (!injected && mode === 'cooldown') {
          injected = true;
          response = { ...response, status: 429, retryAfter: '120' };
        }
        if (
          !injected &&
          ((mode === 'size-a' && index === 0) || (mode === 'size-b' && index === 1)) &&
          calls.some(
            (c) => c.method === 'eth_getLogs' && c.params[0].fromBlock !== c.params[0].toBlock,
          )
        ) {
          injected = true;
          response = {
            status: 200,
            retryAfter: null,
            body: (async function* () {
              yield Buffer.alloc(2097153, 32);
              yield Buffer.from('ignored');
            })(),
          };
        }
        if (mode === 'hard-size')
          response = {
            status: 200,
            retryAfter: null,
            body: (async function* () {
              yield Buffer.alloc(4194305, 32);
            })(),
          };
        if (
          mode === 'mismatch' &&
          calls.length === 10 &&
          calls.every((c) => c.method === 'eth_call' && c.params[0].data.startsWith('0x70a08231'))
        ) {
          const chunks = [];
          for await (const chunk of response.body) chunks.push(chunk);
          const rows = JSON.parse(Buffer.concat(chunks));
          rows[0].result = '0x' + 'f'.repeat(64);
          response = {
            ...response,
            body: (async function* () {
              yield Buffer.from(JSON.stringify(rows));
            })(),
          };
        }
        const original = response;
        return {
          ...response,
          body: (async function* () {
            for await (const chunk of original.body) {
              record.bytes += chunk.length;
              yield chunk;
            }
            record.complete = true;
          })(),
        };
      };
    },
  };
}
export function executeBulk(p, action, clock, options = {}) {
  const f = options.fixture ?? fixture(p, clock);
  return runReconstruction(
    [action, p.storagePath + '/../plan.json', p.storagePath + '/../approval.json'],
    new AbortController().signal,
    { env: environment(p), clock, transport: f.transport, ...options },
  );
}
export async function seeded(root, clock, through = START) {
  const prior = await newPrefix(root, through),
    f = continuationFixture(prior, clock);
  await execute(prior, 'prepare', f, clock);
  const result = await execute(prior, 'run', f, clock);
  assert.equal(result.status, 'complete', result.reason);
  return prior;
}
export async function newPlan(root, prior, overrides = {}) {
  const seen = await admission(prior),
    old = await json(prior.sessionPath),
    path = root + '/' + randomUUID();
  const p = reconstructionPlanSchema.parse({
    version: 1,
    kind: 'common-history-reconstruction',
    run: randomUUID(),
    release: prior.release,
    reviewedCommit: prior.reviewedCommit,
    project: prior.project,
    instance: prior.instance,
    storagePath: path + '/state',
    quotaPath: path + '/quota',
    profile: prior.profile,
    origin: 1,
    transport: 369,
    endpoints: ['https://source-a.synthetic.invalid', 'https://source-b.synthetic.invalid'],
    admission: seen.expected,
    canonicalDigest: seen.observed.canonical.digest,
    inventoryDigest: seen.observed.inventoryDigest,
    excludedRootIdentities: [old.storage, old.quota],
    target: '1380',
    milestones: ['611', '1123', '1380'],
    finalityHeaders: prior.phases[0].finalityHeaders,
    methods: ['eth_chainId', 'eth_getBlockByNumber', 'eth_getCode', 'eth_getLogs', 'eth_call'],
    caps: {
      milliseconds: 86400000,
      http: 20000,
      logical: 200000,
      bytes: 2147483648,
      responseBytes: 4194304,
    },
    segment: { milliseconds: 3600000, http: 600, logical: 12000, bytes: 268435456 },
    expiresAt: null,
    resumePolicy: 'same-operation-clean-or-proven-quiescent',
    cost: prior.cost,
    ...overrides,
  });
  await inputs(p);
  return p;
}
export function clockAt(n = Date.now()) {
  const c = new FakeClock();
  c.time = n;
  return c;
}
