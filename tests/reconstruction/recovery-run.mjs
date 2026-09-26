import assert from 'node:assert/strict';
import {
  mkdirSync,
  writeFileSync,
  readFileSync,
  existsSync,
  unlinkSync,
  readdirSync,
  cpSync,
} from 'node:fs';
import { join, dirname } from 'node:path';
import { randomUUID } from 'node:crypto';
import { spawn, spawnSync } from 'node:child_process';
import { sqlAdapter } from './recovery-adapter.mjs';
import { connect, databaseConfig } from '../../dist/db/connect.js';
import { migrateCurrent } from '../../dist/db/migrate.js';
import { digest } from '../../dist/services/projections/input.js';
import { seeded, newPlan, clockAt, executeBulk, json, admin } from './fixture.mjs';
import { collect } from '../../scripts/operator/reconstruction-collect.mjs';
import { coordinate } from '../../scripts/operator/reconstruction-job.mjs';
import {
  recover,
  capture,
  sha,
  jsonBytes,
  readJson,
  checkedState,
  verifyRecovery,
} from '../../scripts/operator/reconstruction-recovery.mjs';
import { recoveryMutex } from '../../scripts/operator/reconstruction-recovery-mutex.mjs';
import { pause } from '../../scripts/operator/reconstruction-job.mjs';
globalThis.fetch = () => {
  throw Error('Real network forbidden');
};
const root = '/canary-test/recovery-' + randomUUID();
mkdirSync(root);
const results = [],
  put = (p, x) => writeFileSync(p, jsonBytes(x));
const save = () =>
  put('/evidence/recovery-results.json', { results, realProviderCalls: 0, retainedAccess: false });
async function test(name, fn) {
  const start = performance.now();
  try {
    const evidence = await fn();
    results.push({ name, status: 'PASS', elapsedMs: performance.now() - start, evidence });
    save();
    console.log('PASS', name);
  } catch (e) {
    results.push({ name, status: 'FAIL', error: e.stack });
    save();
    throw e;
  }
}
const migrator = await connect(databaseConfig('migrator'));
await migrateCurrent(migrator);
await migrator.end();
const clock = clockAt(),
  prior = await seeded(root, clock),
  plan = await newPlan(root, prior, { target: '1500', milestones: ['611', '1500'] });
await executeBulk(plan, 'prepare', clock);
const env = dirname(plan.storagePath),
  out = join(env, 'output');
mkdirSync(join(env, 'input'));
mkdirSync(out);
put(join(env, 'input/plan.json'), plan);
function supervisor(mode) {
  const r = spawnSync(
    process.execPath,
    ['tests/reconstruction/recovery-child.mjs', join(env, 'plan.json'), 'supervisor-' + mode],
    { encoding: 'utf8', timeout: 200000, maxBuffer: 4 * 1024 * 1024 },
  );
  writeFileSync('/evidence/supervisor-' + mode + '.log', r.stdout + r.stderr);
  return { exit: r.status, pid: r.pid };
}
const first = supervisor('first');
assert.equal(first.exit, 3);
const snap = join(out, 'snapshot-00001');
mkdirSync(snap);
for (const n of ['reconstruction.json', 'comparisons.jsonl', 'audit-result.json'])
  writeFileSync(join(snap, n), readFileSync(join(plan.storagePath, n)));
await collect(env, snap, out);
const base = readJson(join(plan.storagePath, 'reconstruction.json'));
const crash = supervisor('crash');
assert.equal(crash.exit, 89, readFileSync('/evidence/supervisor-crash.log', 'utf8'));
const raw = readFileSync(join(plan.storagePath, 'reconstruction.json')),
  state = checkedState(raw);
assert.equal(BigInt(state.accepted.revision) - BigInt(base.accepted.revision), 6n);
const dead = spawnSync(process.execPath, ['-e', 'process.exit(0)']);
const binding = digest({ synthetic: plan.run }),
  owner = randomUUID();
const options = {
  environment: env,
  root: out,
  plan,
  binding,
  identities: { synthetic: digest(plan) },
};
const active = {
  version: 1,
  owner,
  operation: plan.run,
  binding,
  coordinatorPid: dead.pid,
  child: { pid: crash.pid, kind: 'owned-supervisor', segment: 2 },
  segment: 2,
  phase: 'segment-running',
  lastSettled: { segment: 1, accepted: base.accepted },
  currentSegment: { segment: 2, evidence: 'UNVERIFIED', reported: null },
  originalDeadline: state.deadline,
  resultFile: null,
  observedWallUtc: state.highWater,
  effectiveTime: state.highWater,
};
put(join(out, 'status.json'), active);
put(join(env, 'reconstruction-job-binding.json'), { operation: plan.run, root: out, binding });
const lock = { owner, operation: plan.run, root: out, pid: dead.pid };
for (const dir of [env, out]) put(join(dir, '.reconstruction-job.lock'), lock);
const observed = {
  now: state.highWater + 2000,
  boot: state.highWater + 1000,
  processes: [
    { pid: dead.pid, absent: true },
    { pid: crash.pid, absent: true },
  ],
  operatorAbsent: true,
  volumesIdle: true,
};
const makeAdapter = async (patch = {}) => sqlAdapter(plan, env, { ...observed, ...patch });
await test('red: existing collect and ordinary coordinator reject missing crash settlement, even without synthetic stale locks', async () => {
  const originalCoordinate = existsSync('/evidence/before-job.mjs')
    ? (await import('/evidence/before-job.mjs')).coordinate
    : coordinate;
  const folder = join(out, 'crash-snapshot');
  mkdirSync(folder);
  writeFileSync(join(folder, 'reconstruction.json'), raw);
  await assert.rejects(collect(env, folder, out));
  let entered = false;
  const adapter = {
    admit: async () => {
      entered = true;
    },
  };
  const opts = { root: out, lockRoot: env, operation: plan.run, plan, action: 'resume', binding };
  await assert.rejects(originalCoordinate(opts, adapter));
  for (const dir of [env, out]) unlinkSync(join(dir, '.reconstruction-job.lock'));
  await assert.rejects(originalCoordinate(opts, adapter), /clean paused/);
  assert.equal(entered, false);
  for (const dir of [env, out]) put(join(dir, '.reconstruction-job.lock'), lock);
  return {
    base: base.accepted,
    crashed: state.accepted,
    revisionAdvance: 6,
    supervisor: first,
    crash,
    realProviderCalls: 0,
  };
});
if (process.argv.includes('--red-only')) process.exit(0);
const originalFiles = new Map();
for (const path of [
  join(plan.storagePath, 'reconstruction.json'),
  join(env, 'reconstruction-host.json'),
  join(out, 'status.json'),
  join(env, '.reconstruction-host.lock'),
  join(env, '.reconstruction-job.lock'),
  join(out, '.reconstruction-job.lock'),
])
  originalFiles.set(path, readFileSync(path));
// Each case owns a distinct journal/output; the same disposable SQL checkpoint
// is unchanged by recovery and therefore reused under fresh locks/snapshots.
let caseIndex = 0;
async function exercise(stageName) {
  for (const [p, b] of originalFiles) writeFileSync(p, b);
  const caseOut = join(env, 'case-' + ++caseIndex);
  cpSync(out, caseOut, { recursive: true });
  const caseActive = { ...active };
  const caseLock = { ...lock, root: caseOut };
  put(join(caseOut, 'status.json'), caseActive);
  put(join(env, 'reconstruction-job-binding.json'), {
    operation: plan.run,
    root: caseOut,
    binding,
  });
  for (const dir of [env, caseOut]) put(join(dir, '.reconstruction-job.lock'), caseLock);
  const opts = { ...options, root: caseOut };
  let adapter = await makeAdapter();
  try {
    if (stageName === 'process-state') {
      const path = join(caseOut, 'process-input.json');
      put(path, { options: opts, observed });
      const killed = spawnSync(
        process.execPath,
        ['tests/reconstruction/recovery-process.mjs', path, 'state'],
        { encoding: 'utf8', timeout: 120000 },
      );
      assert.equal(killed.status, 91, killed.stderr);
      const retry = spawnSync(
        process.execPath,
        ['tests/reconstruction/recovery-process.mjs', path],
        { encoding: 'utf8', timeout: 120000 },
      );
      assert.equal(retry.status, 0, retry.stderr);
      put('/evidence/recovery-process-exits.json', {
        interrupted: killed.status,
        retried: retry.status,
        child: readJson(path + '.child.json'),
      });
    } else if (stageName)
      await assert.rejects(
        recover(opts, adapter, async (stage) => {
          if (stage === stageName) throw Error('Injected second crash');
        }),
        /Injected second crash/,
      );
  } finally {
    await adapter.close();
  }
  adapter = await makeAdapter();
  let recovered;
  try {
    recovered = await recover(opts, adapter);
  } finally {
    await adapter.close();
  }
  const after = readFileSync(join(plan.storagePath, 'reconstruction.json')),
    post = checkedState(after);
  for (const key of [
    'accepted',
    'audited',
    'milestone',
    'http',
    'logical',
    'chargedBytes',
    'observedBytes',
    'uncertainAttempts',
    'start',
    'deadline',
    'highWater',
    'pausedMs',
  ])
    assert.deepEqual(post[key], state[key]);
  assert.equal(post.segment.ended, null);
  assert.equal(post.lastEnded, null);
  await verifyRecovery({
    stateBytes: readFileSync(join(plan.storagePath, 'reconstruction.json')),
    ...opts,
    state: post,
    result: recovered,
  });
  const hashes = () =>
    Object.fromEntries(
      ['seed.json', 'intent.json', 'manifest.json'].map((n) => [
        n,
        sha(readFileSync(join(caseOut, 'recovery-00002', n))),
      ]),
    );
  const beforeRepeat = hashes();
  adapter = await makeAdapter();
  try {
    assert.deepEqual(await recover(opts, adapter), recovered);
  } finally {
    await adapter.close();
  }
  assert.deepEqual(hashes(), beforeRepeat);
  cpSync(join(caseOut, 'recovery-00002'), '/evidence/recovery-case-' + caseIndex, {
    recursive: true,
  });
  return { opts, recovered, post, hashes: hashes(), beforeHash: sha(raw), afterHash: sha(after) };
}
let happy;
await test('recovery preserves six durable commits and repeat is idempotent', async () => {
  happy = await exercise();
  return {
    accepted: happy.post.accepted,
    ...happy.hashes,
    before: happy.beforeHash,
    after: happy.afterHash,
  };
});
for (const stage of [
  'capture',
  'proof',
  'intent',
  'state',
  'host',
  'seal',
  'result',
  'status',
  'hostLock',
  'jobOutput',
  'jobEnvironment',
  'process-state',
])
  await test('recovery retry after ' + stage, async () => {
    const r = await exercise(stage);
    return { before: r.beforeHash, after: r.afterHash, hashes: r.hashes };
  });
const refusalCases = {
  'live process': { observation: (o) => (o.processes[0] = { pid: dead.pid, absent: false }) },
  'same boot': { observation: (o) => (o.boot = state.highWater - 1) },
  'unknown reused PID': { observation: (o) => (o.processes[0] = { pid: dead.pid, started: null }) },
  'operator present': { observation: (o) => (o.operatorAbsent = false) },
  'volume active': { observation: (o) => (o.volumesIdle = false) },
  'pending SQL': {
    state: (s) =>
      (s.pendingSql = {
        previous: s.accepted,
        next: { ...s.accepted, revision: String(BigInt(s.accepted.revision) + 1n) },
        batchDigest: 'a'.repeat(64),
      }),
  },
  'pending attempt': { state: (s) => (s.pending = true) },
  'audit phase': { state: (s) => (s.phase = 'audit') },
  'milestone pending': { state: (s) => (s.phase = 'milestone-pending') },
  'partial audit': {
    state: (s) =>
      (s.audit = {
        pin: s.accepted,
        canonical: 'a'.repeat(64),
        schema: 'a'.repeat(64),
        inventory: 'a'.repeat(64),
        count: 1,
        binding: 'a'.repeat(64),
        sources: [
          { source: 'a', count: 0, after: null, pages: 0 },
          { source: 'b', count: 0, after: null, pages: 0 },
        ],
        bytes: 0,
        commitment: 'a'.repeat(64),
        finalizing: false,
      }),
  },
  terminal: { state: (s) => (s.terminal = true) },
  blocked: { state: (s) => (s.status = 'blocked') },
  complete: { state: (s) => (s.status = 'complete') },
  'decreased charges': { state: (s) => (s.chargedBytes = base.chargedBytes - 1) },
  'exhausted HTTP': { state: (s) => (s.http = plan.caps.http) },
  'unsealed audit': { state: (s) => (s.audited = s.accepted) },
  'wrong segment': { state: (s) => s.segment.number++ },
  'wrong plan digest': { state: (s) => (s.digest = 'a'.repeat(64)) },
  'wrong root identity': { state: (s) => (s.storage = '1:2') },
  'expired deadline': { observation: (o) => (o.now = state.deadline) },
  'SQL ahead of control': {
    state: (s) => (s.accepted.revision = String(BigInt(s.accepted.revision) - 1n)),
  },
  'SQL behind control': {
    state: (s) => (s.accepted.revision = String(BigInt(s.accepted.revision) + 1n)),
  },
  'corrupt checksum': {
    file: (opts) => {
      const p = join(plan.storagePath, 'reconstruction.json'),
        s = readJson(p);
      s.checksum = 'a'.repeat(64);
      put(p, s);
    },
  },
  'missing prior seal': {
    file: (opts) => unlinkSync(join(opts.root, 'segment-00001', 'manifest.json')),
  },
  'missing milestone seal': {
    file: (opts) => unlinkSync(join(opts.root, 'milestone-611', 'manifest.json')),
  },
  'corrupt prior seal': {
    file: (opts) =>
      writeFileSync(join(opts.root, 'segment-00001', 'reconstruction.json'), 'corrupt'),
  },
  'manually absent locks': {
    file: (opts) => unlinkSync(join(opts.root, '.reconstruction-job.lock')),
  },
  'canonical reconciliation': {
    sql: async () =>
      admin((c) =>
        c.query(
          'UPDATE hdd.accounts SET liquid_hearts=liquid_hearts+1 WHERE chain_id=1 AND address=(SELECT address FROM hdd.accounts WHERE chain_id=1 ORDER BY address LIMIT 1)',
        ),
      ),
    undo: async () =>
      admin((c) =>
        c.query(
          'UPDATE hdd.accounts SET liquid_hearts=liquid_hearts-1 WHERE chain_id=1 AND address=(SELECT address FROM hdd.accounts WHERE chain_id=1 ORDER BY address LIMIT 1)',
        ),
      ),
  },
};
for (const [name, mutate] of Object.entries(refusalCases))
  await test('refuse ' + name, async () => {
    for (const [p, b] of originalFiles) writeFileSync(p, b);
    const caseOut = join(env, 'refusal-' + ++caseIndex);
    cpSync(out, caseOut, { recursive: true });
    const opts = { ...options, root: caseOut };
    put(join(env, 'reconstruction-job-binding.json'), {
      operation: plan.run,
      root: caseOut,
      binding,
    });
    for (const dir of [env, caseOut])
      put(join(dir, '.reconstruction-job.lock'), { ...lock, root: caseOut });
    if (mutate.state) {
      const s = checkedState(raw);
      mutate.state(s);
      put(join(plan.storagePath, 'reconstruction.json'), { ...s, checksum: digest(s) });
    }
    mutate.file?.(opts);
    const observation = structuredClone(observed);
    mutate.observation?.(observation);
    await mutate.sql?.();
    const adapter = await makeAdapter(observation),
      beforeHash = sha(readFileSync(join(plan.storagePath, 'reconstruction.json')));
    let error, close;
    try {
      await assert.rejects(recover(opts, adapter), (e) => {
        error = e.message;
        return true;
      });
    } finally {
      try {
        await adapter.close();
        close = 0;
      } catch {
        close = 1;
      }
      await mutate.undo?.();
    }
    assert.equal(sha(readFileSync(join(plan.storagePath, 'reconstruction.json'))), beforeHash);
    assert(!existsSync(join(caseOut, 'result-' + owner + '.json')));
    return { beforeHash, afterHash: beforeHash, reason: error, sqlHelperExit: close };
  });
await test('kernel recovery ownership excludes a second invocation', async () => {
  const release = await recoveryMutex(env);
  try {
    await assert.rejects(recoveryMutex(env));
  } finally {
    await release();
  }
});
// The final case is a valid recovered boundary for the next coordinator proof.
happy = await exercise();
await test('recovered boundary without intact seal is never admitted', async () => {
  const path = join(happy.opts.root, 'recovery-00002', 'manifest.json'),
    bytes = readFileSync(path);
  unlinkSync(path);
  await assert.rejects(
    verifyRecovery({
      stateBytes: readFileSync(join(plan.storagePath, 'reconstruction.json')),
      ...happy.opts,
      state: happy.post,
      result: happy.recovered,
    }),
  );
  writeFileSync(path, bytes);
  const changed = { ...happy.post, canonicalAtPause: 'a'.repeat(64) };
  await assert.rejects(
    verifyRecovery({
      stateBytes: readFileSync(join(plan.storagePath, 'reconstruction.json')),
      ...happy.opts,
      state: changed,
      result: happy.recovered,
    }),
  );
  return { missingSeal: 'REFUSED', canonicalMismatch: 'REFUSED' };
});
await test('ordinary synthetic supervisor resumes recovered state then cleanly pauses/seals', async () => {
  const before = readJson(join(plan.storagePath, 'reconstruction.json'));
  let next;
  const savedClock = clockAt(before.highWater + 1234);
  const adapter = {
    admit: async () => ({
      state: checkedState(readFileSync(join(plan.storagePath, 'reconstruction.json'))),
    }),
    recovery: async (state, result) =>
      verifyRecovery({
        stateBytes: readFileSync(join(plan.storagePath, 'reconstruction.json')),
        ...happy.opts,
        state,
        result,
      }),
    boundary: async (state) => {
      if (state.segment.ended === null)
        await verifyRecovery({
          stateBytes: readFileSync(join(plan.storagePath, 'reconstruction.json')),
          ...happy.opts,
          state,
          result: happy.recovered,
        });
    },
    launch: async (action, number, onChild) => {
      assert.equal(action, 'resume');
      assert.equal(number, 3);
      next = supervisor('next');
      assert.equal(next.exit, 3, readFileSync('/evidence/supervisor-next.log', 'utf8'));
      onChild({ pid: next.pid, kind: 'synthetic-supervisor', segment: number });
      pause(happy.opts.root, plan.run);
      return { exit: next.exit, signal: null };
    },
    snapshot: async () => {
      const state = checkedState(readFileSync(join(plan.storagePath, 'reconstruction.json')));
      savedClock.time = state.highWater + 1234;
      const folder = join(happy.opts.root, 'next-snapshot');
      mkdirSync(folder);
      writeFileSync(
        join(folder, 'reconstruction.json'),
        readFileSync(join(plan.storagePath, 'reconstruction.json')),
      );
      return {
        state,
        host: readJson(join(env, 'reconstruction-host.json')),
        hostResult: readJson(join(env, 'reconstruction-host-result.json')),
        snapshot: folder,
      };
    },
    collect: async (folder) => collect(env, folder, happy.opts.root),
  };
  const coordinated = await coordinate(
    { root: happy.opts.root, lockRoot: env, operation: plan.run, plan, action: 'resume', binding },
    adapter,
    savedClock,
  );
  assert.equal(coordinated.outcome, 'PAUSED_AT_BOUNDARY', JSON.stringify(coordinated));
  const after = readJson(join(plan.storagePath, 'reconstruction.json'));
  assert.equal(after.segment.number, 3);
  assert.equal(after.pausedMs, before.pausedMs);
  assert.equal(after.start, before.start);
  assert.equal(after.deadline, before.deadline);
  assert(BigInt(after.accepted.revision) > BigInt(before.accepted.revision));
  return {
    next,
    coordinator: coordinated.outcome,
    before: before.accepted,
    after: after.accepted,
    originalDeadline: after.deadline,
    pausedMs: after.pausedMs,
  };
});
console.log(JSON.stringify({ results: results.length, realProviderCalls: 0 }));
