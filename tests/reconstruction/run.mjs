import assert from 'node:assert/strict';
import { mkdir, readFile, writeFile, copyFile, appendFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import { connect, databaseConfig } from '../../dist/db/connect.js';
import { migrateCurrent } from '../../dist/db/migrate.js';
import { tables } from '../../dist/worker/bootstrap/manifest.js';
import { digest, hex } from '../../dist/services/projections/input.js';
import { reconstructionPlanSchema } from '../../dist/operator/reconstruction-plan.js';
import { ReconstructionPause } from '../../dist/operator/reconstruction-state.js';
import { dailyRow } from '../../dist/services/queries/home.js';
import {
  admin,
  seeded,
  newPlan,
  clockAt,
  executeBulk,
  fixture,
  json,
  save,
  inputs,
} from './fixture.mjs';
import { faultTests } from './faults.mjs';
import { supervisorSmoke } from './supervisor.mjs';
import { preparationTests } from './preparation.mjs';
import { balancePagingTests } from './balance-paging.mjs';
import { clockSqlTests } from './clock-sql.mjs';
globalThis.fetch = () => {
  throw Error('REAL NETWORK FORBIDDEN');
};
const root = '/canary-test/' + randomUUID();
await mkdir(root);
const results = [];
async function test(name, fn) {
  const start = performance.now();
  try {
    await fn();
    results.push({ name, status: 'PASS', ms: performance.now() - start });
    console.log('PASS', name);
  } catch (e) {
    results.push({ name, status: 'FAIL', error: e.stack });
    throw e;
  }
}
async function reset() {
  await admin((c) =>
    c.query(
      'TRUNCATE ' +
        [...Object.keys(tables), 'live_metrics', 'export_bundles']
          .map((t) => 'hdd.' + t)
          .join(',') +
        ' CASCADE',
    ),
  );
}
async function semantic(label) {
  const c = await connect(databaseConfig('api'));
  try {
    const value = {};
    const observations = [];
    for (const table of [
      'current_state',
      'accounts',
      'stakes',
      'share_schedule',
      'daily_stats',
      'events',
      'transfers_recent',
    ]) {
      value[table] = (
        await c.query('SELECT * FROM hdd.' + table + ' ORDER BY ' + tables[table].join(','))
      ).rows;
      for (const row of value[table]) {
        for (const k of ['updated_at', 'observed_at', 'created_at']) delete row[k];
        if (table === 'daily_stats') {
          observations.push({
            day: row.contract_day,
            status: row.payout_status,
            block: row.payout_block,
            hash: row.payout_hash ? hex(row.payout_hash) : null,
          });
          if (row.payout_status === 'pending') {
            assert.equal(row.payout_block, null);
            assert.equal(row.payout_hash, null);
          } else {
            const receipt = (
              await c.query(
                'SELECT 1 FROM hdd.checkpoints_recent WHERE chain_id=1 AND block_number=$1',
                [row.payout_block],
              )
            ).rows;
            assert.equal(
              receipt.length,
              1,
              'Materialized payout observation belongs to an accepted checkpoint',
            );
            assert.equal(
              hex(row.payout_hash),
              '0x' + BigInt(row.payout_block).toString(16).padStart(64, '0'),
            );
          }
          delete row.payout_block;
          delete row.payout_hash;
        }
      }
    }
    const receipts = (
      await c.query(
        "SELECT previous_sync->>'block_number' previous,block_number,revision FROM hdd.checkpoints_recent WHERE chain_id=1 ORDER BY block_number",
      )
    ).rows;
    let previous = '100';
    for (const receipt of receipts) {
      assert.equal(receipt.previous, previous);
      previous = receipt.block_number;
    }
    if (label) await save(label + '-observations', { observations, receipts });
    return value;
  } finally {
    await c.end();
  }
}
let serial = 0;
async function child(p, action, mode = 'normal') {
  const id = ++serial,
    trace = '/evidence/process-' + id + '-attempts.json';
  const c = spawn(
    'node',
    ['tests/reconstruction/child.mjs', p.storagePath + '/../plan.json', action, mode, trace],
    { stdio: ['ignore', 'pipe', 'pipe'] },
  );
  let out = '';
  for (const stream of [c.stdout, c.stderr]) stream.on('data', (b) => (out += b));
  const code = await new Promise((r, j) => {
    c.on('error', j);
    c.on('close', r);
  });
  await writeFile('/evidence/process-' + id + '.log', out);
  return {
    code,
    state: await json(p.storagePath + '/reconstruction.json'),
    attempts: await json(trace),
    id,
  };
}
const clock = clockAt();
try {
  const c = await connect(databaseConfig('migrator'));
  try {
    await migrateCurrent(c);
  } finally {
    await c.end();
  }
  await clockSqlTests({ root, test, reset, semantic });
  if (process.argv.includes('--clock-only')) {
    await save('results', { results, realProviderCalls: 0 });
    process.exit(0); // All fixture sessions/connections have already closed.
  }
  await balancePagingTests({ root, test, reset });
  await reset();
  let control;
  await test('plan authority finite exact bounds and mandatory ordered final milestones', async () => {
    const prior = await seeded(root, clock),
      p = await newPlan(root, prior);
    for (const patch of [
      { caps: { ...p.caps, http: Infinity } },
      { caps: { ...p.caps, logical: Number.MAX_SAFE_INTEGER + 1 } },
      { caps: { ...p.caps, bytes: 0 } },
      { milestones: ['611', '611', '1380'] },
      { milestones: ['611', '610', '1380'] },
      { milestones: ['355', '1380'] },
      { milestones: ['611'] },
      { target: '3001', milestones: ['3001'] },
      { transport: 1 },
      { origin: 369 },
    ])
      assert.equal(
        reconstructionPlanSchema.safeParse({ ...p, ...patch }).success,
        false,
        JSON.stringify(patch),
      );
    const result = await executeBulk(p, 'check', clock);
    assert.equal(result.authorization, 'NOT_AUTHORIZED');
    await executeBulk(p, 'prepare', clock);
    await assert.rejects(executeBulk(p, 'run', clock, { env: {} }));
    await save('plan-check', { result, plan: p });
  });
  await preparationTests({ root, test, reset, child });
  await test('common history with declared milestone pauses: complete exact semantic control', async () => {
    await reset();
    const prior = await seeded(root, clock),
      p = await newPlan(root, prior),
      f = fixture(p, clock),
      audits = [];
    await executeBulk(p, 'prepare', clock);
    const activation = [];
    const options = {
      fixture: f,
      afterMilestone: async (r) => audits.push(r),
      hooks: {
        afterCommit: async () => {
          const c = await connect(databaseConfig('api'));
          try {
            activation.push(
              (
                await c.query(
                  'SELECT contract_day,active_shares,queued_shares FROM hdd.current_state WHERE chain_id=1',
                )
              ).rows[0],
            );
          } finally {
            await c.end();
          }
        },
      },
    };
    let state = await executeBulk(p, 'run', clock, options);
    for (let i = 1; i < p.milestones.length && state.status === 'paused'; i++)
      state = await executeBulk(p, 'resume', clock, options);
    assert.equal(state.status, 'complete', JSON.stringify(state));
    assert.equal(audits.length, 3);
    control = await semantic('control');
    assert.deepEqual(
      control.daily_stats.map((r) => [
        r.contract_day,
        r.payout_status,
        r.payout_hearts,
        r.payout_shares,
      ]),
      [
        [0, 'materialized', '0', '0'],
        [1, 'materialized', '0', '0'],
        [2, 'materialized', '50', '250'],
        [3, 'pending', null, null],
        [4, 'pending', null, null],
      ],
    );
    assert.equal(dailyRow(control.daily_stats[0]).payout.hexPerTShare, null);
    assert.equal(control.current_state[0].active_shares, '150');
    assert.equal(control.current_state[0].queued_shares, '0');
    assert.equal((50n * 50n) / 250n, 10n);
    assert.equal(control.stakes.find((s) => s.stake_id === '4').payout_hearts, '10');
    assert.equal(p.admission.current.queued_shares, '250');
    assert.equal(p.admission.current.active_shares, '0');
    assert(
      activation.some(
        (s) => s.contract_day === 2 && s.active_shares === '250' && s.queued_shares === '0',
      ),
    );
    assert.deepEqual(
      control.stakes.map((s) => [
        s.stake_id,
        s.lifecycle,
        s.locked_day,
        s.payout_hearts,
        s.penalty_hearts,
      ]),
      [
        ['1', 'good_accounted', 2, '10', '0'],
        ['2', 'unsettled', 2, null, null],
        ['3', 'cancelled', 2, '0', '0'],
        ['4', 'ended', 2, '10', '0'],
        ['8', 'unsettled', 2, null, null],
      ],
    );
    assert(control.accounts.some((a) => BigInt(a.liquid_hearts) > 2n ** 53n));
    await save('control', {
      semantic: control,
      state,
      audits,
      attempts: f.attempts,
      activation,
      excluded: [
        'updated_at/observed_at/created_at: observation clock metadata',
        'daily_stats.payout_block/payout_hash: accepted materialization observation varies with partition; amounts/status/close blocks retained',
      ],
    });
  });
  await test('real process checkpoint pauses plus SQL commit lost acknowledgement preserve semantic equality and cumulative totals', async () => {
    await reset();
    const prior = await seeded(root, clock),
      p = await newPlan(root, prior);
    await executeBulk(p, 'prepare', clock);
    const refusals = [];
    const refuse = async (action, state) => {
      const before = await readFile(p.storagePath + '/reconstruction.json');
      const refusalClock = clockAt(state.highWater + 1),
        f = fixture(p, refusalClock);
      await assert.rejects(
        executeBulk(p, action, refusalClock, { fixture: f }),
        /Operation cannot run\/resume/,
      );
      const after = await readFile(p.storagePath + '/reconstruction.json');
      assert.deepEqual(after, before, 'Refused mode must preserve the entire saved record');
      assert.equal(f.attempts.length, 0);
      refusals.push({
        action,
        status: state.status,
        before: before.toString(),
        after: after.toString(),
      });
    };
    await refuse('resume', await json(p.storagePath + '/reconstruction.json'));
    const processResults = [];
    let r = await child(p, 'run', 'commit-crash');
    assert.equal(r.code, 77);
    processResults.push(r);
    for (let i = 0; i < 30; i++) {
      r = await child(p, 'resume', i < 5 ? 'one-commit' : 'normal');
      processResults.push(r);
      assert([0, 3].includes(r.code), JSON.stringify(r));
      if (i === 0) {
        assert.equal(r.state.status, 'paused');
        await refuse('run', r.state);
      }
      if (r.state.status === 'complete') break;
    }
    assert.equal(r.state.status, 'complete', r.state.reason);
    await refuse('resume', r.state);
    await refuse('run', r.state);
    await save('mode-refusals', refusals);
    const continued = await semantic('segmented');
    assert.deepEqual(continued, control);
    const attempts = processResults.flatMap((r) => r.attempts);
    assert.equal(r.state.http, attempts.length);
    assert.equal(
      r.state.logical,
      attempts.reduce((n, a) => n + a.logical, 0),
    );
    assert.equal(
      r.state.observedBytes,
      attempts.reduce((n, a) => n + a.bytes, 0),
    );
    assert.equal(
      r.state.chargedBytes,
      attempts.reduce((n, a) => n + (a.complete ? a.bytes : Math.max(8388608, a.bytes)), 0),
    );
    assert(processResults.filter((r) => r.state.status === 'paused').length > 3);
    assert(
      processResults.every(
        (r) =>
          r.state.start === processResults[0].state.start &&
          r.state.deadline === processResults[0].state.deadline,
      ),
    );
    await save('segmented', { semantic: continued, processResults, attempts });
  });
  await test('both-source early byte pressure uses existing splitter and exact state', async () => {
    for (const mode of ['size-a', 'size-b']) {
      await reset();
      const prior = await seeded(root, clock),
        p = await newPlan(root, prior),
        f = fixture(p, clock, mode);
      await executeBulk(p, 'prepare', clock);
      let s = await executeBulk(p, 'run', clock, { fixture: f });
      for (let i = 1; i < p.milestones.length && s.status === 'paused'; i++)
        s = await executeBulk(p, 'resume', clock, { fixture: f });
      assert.equal(s.status, 'complete', JSON.stringify(s));
      assert.deepEqual(await semantic(), control);
      assert(f.attempts.some((a) => !a.complete && a.bytes === 2097153));
      assert.equal(
        s.chargedBytes,
        f.attempts.reduce((n, a) => n + (a.complete ? a.bytes : Math.max(8388608, a.bytes)), 0),
      );
      await save(mode, { state: s, attempts: f.attempts });
    }
  });
  await faultTests({ root, test, reset, child });
  await test('host supervisor launches compiled operator with fake providers and retains original deadline', async () => {
    await reset();
    const prior = await seeded(root, clock),
      p = await newPlan(root, prior, { target: '611', milestones: ['611'] });
    await executeBulk(p, 'prepare', clock);
    supervisorSmoke(p);
  });
  await test('10037-account paired audit across fresh processes, uncommitted tail and durable page crash', async () => {
    await reset();
    const prior = await seeded(root, clock, '1380');
    await admin((c) =>
      c.query(
        "INSERT INTO hdd.accounts SELECT 1,decode(lpad(to_hex(n),40,'0'),'hex'),0,0,0,0,0 FROM generate_series(100000,110021) n",
      ),
    );
    const p = await newPlan(root, prior, { target: '1381', milestones: ['1381'] });
    await executeBulk(p, 'prepare', clock);
    const processResults = [];
    let r = await child(p, 'run', 'append-crash');
    assert.equal(r.code, 78);
    assert.equal(r.state.audit.sources[0].count, 0);
    processResults.push(r);
    r = await child(p, 'resume', 'page-crash');
    assert.equal(r.code, 79);
    assert.equal(r.state.audit.sources[0].count, 10);
    processResults.push(r);
    r = await child(p, 'resume', 'page-pause');
    assert.equal(r.code, 3);
    assert.equal(r.state.audit.sources[0].count, 30);
    processResults.push(r);
    for (let i = 0; i < 10; i++) {
      r = await child(p, 'resume');
      processResults.push(r);
      assert([0, 3].includes(r.code), JSON.stringify(r));
      if (r.state.status === 'complete') break;
    }
    assert.equal(r.state.status, 'complete', r.state.reason);
    const lines = (await readFile(p.storagePath + '/comparisons.jsonl', 'utf8'))
      .trim()
      .split('\n')
      .map(JSON.parse);
    assert.equal(lines.length, 2008);
    const coverage = {};
    for (const source of p.profile.ethereum) {
      const pages = lines.filter((l) => l.source === source.id),
        rows = pages.flatMap((l) => l.rows);
      assert.equal(pages.length, 1004);
      assert.equal(rows.length, 10037);
      assert.equal(pages.at(-1).rows.length, 7);
      assert.equal(new Set(rows.map((r) => r.address)).size, 10037);
      assert(rows.some((r) => r.expected === '0'));
      let offset = 0;
      for (const page of pages) {
        assert.equal(page.offset, offset);
        offset += page.rows.length;
      }
      coverage[source.id] = {
        count: rows.length,
        pages: pages.length,
        zero: rows.filter((r) => r.expected === '0').length,
      };
    }
    const attempts = processResults.flatMap((r) => r.attempts);
    assert.equal(r.state.http, attempts.length);
    assert.equal(
      r.state.logical,
      attempts.reduce((n, a) => n + a.logical, 0),
    );
    assert.equal(
      r.state.chargedBytes,
      attempts.reduce((n, a) => n + (a.complete ? a.bytes : 8388608), 0),
    );
    assert(
      processResults.some(
        (r) => r.state.audit?.sources[0].count > 0 && r.state.audit.sources[0].count < 10037,
      ),
    );
    assert(
      processResults.some(
        (r) => r.state.audit?.sources[1].count > 0 && r.state.audit.sources[1].count < 10037,
      ),
    );
    assert(r.state.highWater - r.state.start > 3600000);
    await copyFile(p.storagePath + '/comparisons.jsonl', '/evidence/large-comparisons.jsonl');
    await copyFile(p.storagePath + '/audit-result.json', '/evidence/large-audit-result.json');
    await save('large-audit', {
      coverage,
      processResults,
      stateBytes: (await readFile(p.storagePath + '/reconstruction.json')).length,
    });
  });
} finally {
  await save('results', { results, realProviderCalls: 0 });
}
