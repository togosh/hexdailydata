import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { dayBoundaryPlan, prefixFixture, prefixEnvironment } from './prefix-fixture.mjs';
import { inputs } from './fixture.mjs';
import { A, hash } from '../sync/fixture.mjs';
import { connect, databaseConfig } from '../../dist/db/connect.js';
import { beginAuditSnapshot, inspectAuditTarget } from '../../dist/operator/canary-audit.js';
import { canaryPlanSchema, pinnedAuditAdmissionSchema } from '../../dist/operator/canary-plan.js';
import { profileBinding } from '../../dist/worker/sync/profile.js';
import { totalColumns } from '../../dist/services/projections/reduce.js';
import { digest, hex } from '../../dist/services/projections/input.js';
import { runCanary } from '../../dist/operator/canary.js';

export const START = '355',
  END = '1380';
export const inherited = Array.from(
  { length: 12 },
  (_, i) => '0x' + (i + 1).toString(16).padStart(40, '0'),
);
export const added = '0x' + '33'.repeat(20);
const word = (n) => BigInt(n).toString(16).padStart(64, '0');
export function continuationFixture(plan, clock) {
  const fixture = prefixFixture(plan, clock),
    f = fixture.f;
  for (const [n, state] of f.states) f.states.set(n, structuredClone(state));
  f.logs.get(132)[0].data = '0x' + word(BigInt(f.logs.get(132)[0].data) + 10000n);
  for (const [n, state] of f.states)
    if (n >= 132) {
      state.supply += 10000n;
      state.balances.set(A, state.balances.get(A) + 10000n);
    }
  function transfer(n, from, to, value) {
    const logs = f.logs.get(n),
      template = f.logs.get(132)[0];
    logs.push({
      ...template,
      blockNumber: '0x' + n.toString(16),
      blockHash: hash(n),
      transactionHash: hash(n * 100),
      transactionIndex: '0x0',
      logIndex: '0x' + logs.length.toString(16),
      topics: [
        template.topics[0],
        '0x' + from.slice(2).padStart(64, '0'),
        '0x' + to.slice(2).padStart(64, '0'),
      ],
      data: '0x' + word(value),
    });
    f.headers.get(n).transactions = [hash(n * 100)];
    for (const [number, state] of f.states)
      if (number >= n) {
        state.balances.set(from, (state.balances.get(from) ?? 0n) - value);
        state.balances.set(to, (state.balances.get(to) ?? 0n) + value);
      }
  }
  for (const address of inherited) transfer(196, A, address, 1n);
  transfer(197, inherited[0], A, 1n);
  transfer(600, A, added, 3n);
  return fixture;
}
export async function newPrefix(root, through = END) {
  const p = dayBoundaryPlan(root + '/' + randomUUID());
  p.phases[0].through = p.ranges[0].to = through;
  await inputs(p);
  return p;
}
export async function admission(plan) {
  const reader = await connect(databaseConfig('api')),
    owner = await connect(databaseConfig('worker'));
  try {
    await owner.query('SET default_transaction_read_only=on');
    await beginAuditSnapshot(reader, 3600000);
    const current = (await reader.query('SELECT * FROM hdd.current_state WHERE chain_id=1'))
      .rows[0];
    const cursor = (await reader.query('SELECT * FROM hdd.sync_state WHERE chain_id=1')).rows[0];
    const header = (
      await reader.query('SELECT * FROM hdd.blocks_recent WHERE chain_id=1 AND number=$1', [
        cursor.block_number,
      ])
    ).rows[0];
    const counts = {};
    for (const table of Object.keys(pinnedAuditAdmissionSchema.shape.counts.shape))
      counts[table] = (
        await reader.query('SELECT count(*)::text AS n FROM hdd.' + table)
      ).rows[0].n;
    const expected = {
      volume: process.env.HDD_V2_PROJECT + '_db_data',
      checkpoint: {
        number: header.number,
        hash: hex(header.hash),
        parentHash: hex(header.parent_hash),
        timestamp: header.timestamp,
      },
      revision: cursor.revision,
      sourceBindingDigest: digest(profileBinding(plan.profile, 1)),
      counts,
      current: Object.fromEntries(['contract_day', ...totalColumns].map((k) => [k, current[k]])),
    };
    return { expected, observed: await inspectAuditTarget(reader, owner, plan.profile, expected) };
  } finally {
    await reader.end();
    await owner.end();
  }
}
export async function newContinuation(root, prior, to = END) {
  const start = await admission(prior),
    old = JSON.parse(await readFile(prior.sessionPath, 'utf8'));
  const storage = root + '/' + randomUUID();
  const p = canaryPlanSchema.parse({
    ...prior,
    session: randomUUID(),
    storagePath: storage,
    quotaPath: storage + '/quota',
    sessionPath: storage + '/canary.json',
    ranges: [{ chain: 1, from: start.expected.checkpoint.number, to }],
    methods: ['eth_chainId', 'eth_getBlockByNumber', 'eth_getCode', 'eth_getLogs', 'eth_call'],
    phases: [
      {
        kind: 'common-continue',
        purpose: 'TEST separately authorized populated continuation',
        admission: start.expected,
        inventoryDigest: start.observed.inventoryDigest,
        canonicalDigest: start.observed.canonical.digest,
        priorSession: prior.session,
        priorStorageIdentity: old.storage,
        priorQuotaIdentity: old.quota,
        priorDispatchFloor: old.highWater,
        through: to,
        finalityHeaders: prior.phases[0].finalityHeaders,
        cadence: prior.phases[0].cadence,
        endpoints: prior.phases[0].endpoints,
      },
    ],
  });
  await inputs(p);
  return p;
}
export function execute(p, command, fixture, clock, options = {}) {
  return runCanary(
    [command, p.storagePath + '/plan.json', p.storagePath + '/approval.json'],
    options.signal ?? new AbortController().signal,
    { env: prefixEnvironment(p), clock, transport: fixture.transport, ...options },
  );
}
