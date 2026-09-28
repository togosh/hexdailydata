import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import { mkdirSync, writeFileSync, readFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { connect, databaseConfig } from '../../dist/db/connect.js';
import { migrateCurrent } from '../../dist/db/migrate.js';
import { digest } from '../../dist/services/projections/input.js';
import { ReconstructionPause } from '../../dist/operator/reconstruction-state.js';
import { admin, seeded, clockAt, executeBulk, json, inputs } from './fixture.mjs';
import { admission } from '../canary/continuation-fixture.mjs';
import { auditPlan, auditFixture, readOnlyWitness } from './audit-only-fixture.mjs';
import { supervise } from '../../scripts/operator/reconstruction-segment.mjs';
import { collect } from '../../scripts/operator/reconstruction-collect.mjs';
import { verify } from '../../scripts/operator/reconstruction-seal.mjs';
import { coordinate } from '../../scripts/operator/reconstruction-job.mjs';
import { auditOnlyFaults } from './audit-only-faults.mjs';

globalThis.fetch = () => {
  throw Error('REAL NETWORK FORBIDDEN');
};
const root = '/canary-test/audit-' + randomUUID();
mkdirSync(root);
const results = [];
const put = (name, v) => fs.writeFile('/evidence/' + name + '.json', JSON.stringify(v, null, 2));
async function test(name, work) {
  const begin = performance.now();
  try {
    const evidence = await work();
    results.push({ name, status: 'PASS', ms: performance.now() - begin, evidence });
  } catch (e) {
    results.push({ name, status: 'FAIL', error: e.stack });
    throw e;
  } finally {
    await put('audit-only-results', { results, realProviderCalls: 0, retainedAccess: false });
  }
  console.log('PASS', name);
}
const migrator = await connect(databaseConfig('migrator'));
await migrateCurrent(migrator);
await migrator.end();
const clock = clockAt(),
  prior = await seeded(root, clock);
const original = await admission(prior);
const expectedSmall = original.observed.inventory;
assert(expectedSmall.some((a) => a.hearts === '0'));
assert(expectedSmall.some((a) => BigInt(a.hearts) > 2n ** 53n));
let serial = 0;
function child(p, action, mode = 'normal') {
  const name = 'child-' + ++serial,
    trace = '/evidence/' + name + '-trace.json';
  const r = spawnSync(
    process.execPath,
    [
      'tests/reconstruction/audit-only-child.mjs',
      p.storagePath + '/../plan.json',
      action,
      mode,
      trace,
    ],
    {
      encoding: 'utf8',
      timeout: 550000,
      maxBuffer: 8 * 1024 * 1024,
      env: { ...process.env, NODE_OPTIONS: '--max-old-space-size=512' },
    },
  );
  writeFileSync('/evidence/' + name + '.log', r.stdout + r.stderr);
  assert(!r.error, String(r.error));
  return {
    exit: r.status,
    signal: r.signal,
    trace: JSON.parse(readFileSync(trace)),
    name,
    output: r.stdout + r.stderr,
  };
}
async function audited(p, action, options = {}) {
  const f = options.fixture ?? auditFixture(p, clock),
    w = readOnlyWitness();
  try {
    return {
      state: await executeBulk(p, action, clock, { ...options, fixture: f }),
      calls: f.calls,
      attempts: f.attempts,
    };
  } finally {
    w.close();
    await put('sql-window-' + ++serial, { clients: w.clients, statements: w.statements });
  }
}
async function fresh(overrides = {}) {
  const p = await auditPlan(root, prior, overrides);
  await audited(p, 'prepare');
  return p;
}
async function unchanged(p) {
  const after = await admission(prior);
  assert.equal(after.observed.canonical.digest, p.canonicalDigest);
  assert.equal(after.observed.inventoryDigest, p.inventoryDigest);
  assert.deepEqual(after.expected.checkpoint, p.admission.checkpoint);
  assert.equal(after.expected.revision, p.admission.revision);
  return after.observed.canonical;
}
async function verifyStream(p, expected) {
  const state = await json(p.storagePath + '/reconstruction.json');
  assert.equal(state.status, 'complete', state.reason);
  assert.equal(state.phase, 'complete');
  assert.equal(state.milestone, 1);
  assert.deepEqual(state.accepted, {
    header: p.admission.checkpoint,
    revision: p.admission.revision,
  });
  assert.deepEqual(state.audited, state.accepted);
  const output = await json(p.storagePath + '/audit-result.json');
  assert.equal(output.before, p.canonicalDigest);
  assert.equal(output.after, p.canonicalDigest);
  const lines = (await fs.readFile(p.storagePath + '/comparisons.jsonl', 'utf8'))
    .trim()
    .split('\n')
    .map(JSON.parse);
  for (const source of p.profile.ethereum) {
    const pages = lines.filter((l) => l.source === source.id),
      rows = pages.flatMap((l) => l.rows);
    assert.deepEqual(
      rows,
      expected.map((a) => ({ address: a.address, expected: a.hearts, observed: a.hearts })),
    );
    assert.equal(pages.length, Math.ceil(expected.length / 10));
    assert.equal(pages.at(-1).rows.length, expected.length % 10 || 10);
  }
  assert.equal(
    output.coverage.commitment,
    lines.reduce((prior, page) => digest({ prior, page }), digest([])),
  );
  return { state, output, rows: lines.flatMap((p) => p.rows).length };
}

if (!process.argv.includes('--large-only')) {
  await test('actual compiled check/prepare/run/resume/status and SQL read-only exact small inventory', async () => {
    const p = await auditPlan(root, prior);
    for (const action of ['check', 'prepare']) {
      const r = child(p, action);
      assert.equal(r.exit, 0, r.output);
      assert.equal(r.trace.attempts.length, 0);
    }
    const first = child(p, 'run', 'page-pause');
    assert.equal(first.exit, 3, first.output);
    const before = await json(p.storagePath + '/reconstruction.json');
    assert.equal(before.audit.sources[0].count, 10);
    assert.equal(before.audited, null);
    await unchanged(p);
    const next = child(p, 'resume');
    assert.equal(next.exit, 0, next.output);
    const proof = await verifyStream(p, expectedSmall);
    assert.equal(proof.state.start, before.start);
    assert.equal(proof.state.deadline, before.deadline);
    assert(proof.state.http > before.http);
    assert(proof.state.chargedBytes > before.chargedBytes);
    assert.equal(child(p, 'status').exit, 0);
    assert(next.trace.attempts[0].at >= before.highWater + 1234 + 60000);
    await unchanged(p);
    await put('small-complete', proof);
    return {
      count: expectedSmall.length,
      zeros: expectedSmall.filter((a) => a.hearts === '0').length,
      first: first.name,
      next: next.name,
      pin: proof.state.accepted,
    };
  });
  await test('uncommitted append from a dead process is discarded and charged again', async () => {
    const p = await fresh();
    const dead = child(p, 'run', 'append-crash');
    assert.equal(dead.exit, 78, dead.output);
    const before = await json(p.storagePath + '/reconstruction.json');
    assert.equal(before.audit.bytes, 0);
    assert((await fs.stat(p.storagePath + '/comparisons.jsonl')).size > 0);
    const next = child(p, 'resume');
    assert.equal(next.exit, 0, next.output);
    const proof = await verifyStream(p, expectedSmall);
    await unchanged(p);
    assert(proof.state.http > before.http);
    return { dead: dead.name, next: next.name, uncredited: before.audit, complete: proof.output };
  });
  await test('committed corruption, pending SQL, pending response and forged pin refuse', async () => {
    const outcomes = [];
    for (const kind of [
      'truncate',
      'same-length',
      'pendingSql',
      'pending',
      'revision',
      'header',
      'inventory',
    ]) {
      const p = await fresh();
      const paused = await audited(p, 'run', {
        auditHooks: {
          afterPage: async () => {
            throw new ReconstructionPause('fixture pause');
          },
        },
      });
      assert.equal(paused.state.status, 'paused');
      const file = p.storagePath + '/reconstruction.json',
        s = await json(file);
      delete s.checksum;
      if (kind === 'truncate')
        await fs.truncate(p.storagePath + '/comparisons.jsonl', s.audit.bytes - 1);
      if (kind === 'same-length') {
        const b = await fs.readFile(p.storagePath + '/comparisons.jsonl');
        const at = b.indexOf(Buffer.from('"expected":"0"'));
        assert(at >= 0);
        b[at + 12] = 49;
        await fs.writeFile(p.storagePath + '/comparisons.jsonl', b);
      }
      if (kind === 'pendingSql')
        s.pendingSql = {
          previous: s.accepted,
          next: { ...s.accepted, revision: '999' },
          batchDigest: 'f'.repeat(64),
        };
      if (kind === 'pending') {
        s.pending = true;
        s.chargedBytes += 8388608;
      }
      if (kind === 'revision') s.accepted.revision = '999';
      if (kind === 'header') s.accepted.header.hash = '0x' + 'f'.repeat(64);
      if (kind === 'inventory') s.audit.inventory = 'f'.repeat(64);
      await fs.writeFile(file, JSON.stringify({ ...s, checksum: digest(s) }));
      const f = auditFixture(p, clock);
      let outcome;
      try {
        outcome = (await audited(p, 'resume', { fixture: f })).state;
      } catch (e) {
        outcome = { refusal: e.message };
      }
      if (!outcome.refusal) {
        assert.equal(outcome.status, 'blocked');
        assert.equal(outcome.audited, null);
      }
      assert.equal(f.attempts.length, 0);
      await unchanged(p);
      outcomes.push({ kind, outcome });
    }
    return outcomes;
  });
  await test('mismatch and transport failure remain terminal without complete credit or renewed charges', async () => {
    const outcomes = [];
    for (const mode of ['mismatch', 'transport']) {
      const p = await fresh(),
        f = auditFixture(p, clock, mode);
      if (mode === 'transport')
        f.transport = () => async () => {
          throw Error('synthetic fetch failed');
        };
      const { state } = await audited(p, 'run', { fixture: f });
      assert.equal(state.status, 'blocked');
      assert.equal(state.audited, null);
      if (mode === 'transport') assert(state.chargedBytes >= 8388608);
      const before = await fs.readFile(p.storagePath + '/reconstruction.json');
      for (const action of ['run', 'resume'])
        await assert.rejects(audited(p, action), /cannot run\/resume/);
      assert.deepEqual(await fs.readFile(p.storagePath + '/reconstruction.json'), before);
      await unchanged(p);
      outcomes.push({ mode, state });
    }
    return outcomes;
  });
  await test('segment HTTP, logical, byte and elapsed limits pause; whole deadline never renews', async () => {
    const outcomes = [];
    for (const kind of ['http', 'logical', 'bytes', 'milliseconds']) {
      const segment = { milliseconds: 3600000, http: 600, logical: 12000, bytes: 268435456 };
      segment[kind] = { http: 1, logical: 3, bytes: 8388608, milliseconds: 75000 }[kind];
      const p = await fresh({ segment });
      const first = (await audited(p, 'run')).state;
      assert.equal(first.status, 'paused', first.reason);
      assert.equal(first.audited, null);
      const second = (await audited(p, 'resume')).state;
      assert.equal(second.status, 'paused', second.reason);
      assert.equal(second.start, first.start);
      assert.equal(second.deadline, first.deadline);
      assert(second.http >= first.http);
      clock.time = second.deadline;
      const end = (await audited(p, 'resume')).state;
      assert.equal(end.status, 'blocked');
      assert.equal(end.audited, null);
      await unchanged(p);
      outcomes.push({ kind, first, second, end });
    }
    return outcomes;
  });
}

if (!process.argv.includes('--large-only'))
  await auditOnlyFaults({ test, fresh, clock, audited, unchanged });

if (!process.argv.includes('--small-only')) {
  await test('10037 accounts, 20074 matches, actual subprocess segments, supervisor, collector and stop-at', async () => {
    const size = 10037,
      extra = size - expectedSmall.length;
    await admin((c) =>
      c.query(
        `INSERT INTO hdd.accounts SELECT 1,decode(lpad(to_hex(n),'40','0'),'hex'),0,0,0,355,355 FROM generate_series(1000,$1) n`,
        [999 + extra],
      ),
    );
    const p = await auditPlan(root, prior, {
      segment: { milliseconds: 3600000, http: 500, logical: 12000, bytes: 268435456 },
    });
    assert.equal(p.admission.counts.accounts, String(size));
    const expected = [
      ...expectedSmall,
      ...Array.from({ length: extra }, (_, i) => ({
        address: '0x' + (1000 + i).toString(16).padStart(40, '0'),
        hearts: '0',
      })),
    ].sort((a, b) => a.address.localeCompare(b.address));
    const prep = child(p, 'prepare');
    assert.equal(prep.exit, 0, prep.output);
    const env = dirname(p.storagePath),
      out = join(env, 'output');
    mkdirSync(join(env, 'input'));
    mkdirSync(out);
    writeFileSync(join(env, 'input/plan.json'), JSON.stringify(p));
    let now = (await json(p.storagePath + '/reconstruction.json')).highWater + 1234,
      latest,
      native;
    const receipts = [];
    const adapter = {
      admit: async () => ({ state: await json(p.storagePath + '/reconstruction.json') }),
      boundary: async () => {},
      async launch(action, number) {
        const r = supervise(
          env,
          p,
          action,
          () => {
            latest = child(p, action);
            now = JSON.parse(readFileSync(p.storagePath + '/reconstruction.json')).highWater + 1234;
            writeFileSync(join(env, 'reconstruction-output.log'), latest.output);
            return { status: latest.exit };
          },
          () => now,
        );
        native = { exit: r.status, signal: null };
        receipts.push({ number, action, child: latest.name, exit: latest.exit });
        return native;
      },
      async snapshot(number) {
        const s = await json(p.storagePath + '/reconstruction.json'),
          snapshot = join(out, 'snapshot-' + number);
        mkdirSync(snapshot);
        await fs.copyFile(
          p.storagePath + '/reconstruction.json',
          join(snapshot, 'reconstruction.json'),
        );
        if (s.audit) {
          await fs.copyFile(
            p.storagePath + '/comparisons.jsonl',
            join(snapshot, 'comparisons-PARTIAL.jsonl'),
          );
          writeFileSync(
            join(snapshot, 'PARTIAL.json'),
            JSON.stringify({ classification: 'PARTIAL_NOT_A_COMPLETED_AUDIT', audit: s.audit }),
          );
        } else
          for (const n of ['comparisons.jsonl', 'audit-result.json'])
            await fs.copyFile(join(p.storagePath, n), join(snapshot, n));
        await unchanged(p);
        receipts.at(-1).state = s;
        return {
          state: s,
          host: await json(join(env, 'reconstruction-host.json')),
          hostResult: await json(join(env, 'reconstruction-host-result.json')),
          snapshot,
        };
      },
      collect: (snapshot) => collect(env, snapshot, out),
    };
    const coordinator = await coordinate(
      {
        root: out,
        lockRoot: env,
        operation: p.run,
        plan: p,
        action: 'run',
        binding: digest({ synthetic: p.run }),
        stopAt: p.target,
      },
      adapter,
      { now: () => now },
    );
    assert.equal(coordinator.outcome, 'SCOPED_INTERVAL_COMPLETE', JSON.stringify(coordinator));
    const proof = await verifyStream(p, expected);
    await unchanged(p);
    assert(receipts.length >= 5);
    assert(receipts.some((r) => r.state.audit?.sources[1].count > 0));
    assert.equal(proof.rows, 20074);
    for (let i = 1; i < receipts.length; i++) {
      const a = receipts[i - 1].state,
        b = receipts[i].state;
      assert.equal(a.start, b.start);
      assert.equal(a.deadline, b.deadline);
      assert(b.http > a.http);
    }
    const seal = await verify(join(out, 'milestone-355'));
    await fs.copyFile(
      join(p.storagePath, 'comparisons.jsonl'),
      '/evidence/large-comparisons.jsonl',
    );
    await put('large-proof', {
      plan: p,
      expected,
      proof,
      receipts,
      coordinator,
      seal,
      zeroAccounts: expected.filter((a) => a.hearts === '0').length,
    });
    return {
      count: size,
      matches: proof.rows,
      segments: receipts.length,
      zeroAccounts: expected.filter((a) => a.hearts === '0').length,
      canonical: proof.output.before,
    };
  });
}
await put('runtime-bounds', {
  cpu: await fs.readFile('/sys/fs/cgroup/cpu.max', 'utf8'),
  memory: await fs.readFile('/sys/fs/cgroup/memory.max', 'utf8'),
  swap: await fs.readFile('/sys/fs/cgroup/memory.swap.max', 'utf8'),
});
