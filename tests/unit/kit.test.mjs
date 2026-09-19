import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { spawnSync } from 'node:child_process';

const read = file => JSON.parse(fs.readFileSync(file, 'utf8'));

test('task graph has unique IDs and no cycles', () => {
  const { tasks } = read('config/tasks.json');
  assert.equal(new Set(tasks.map(task => task.id)).size, 11);
  const visit = (id, trail = []) => {
    assert.ok(!trail.includes(id), 'cycle');
    const task = tasks.find(item => item.id === id);
    assert.ok(task);
    for (const dependency of task.dependsOn) visit(dependency, [...trail, id]);
  };
  for (const task of tasks) {
    visit(task.id);
    assert.ok(['pending', 'in_progress', 'passed', 'blocked'].includes(task.status));
  }
});

test('task emitter refuses skipped prerequisites', () => {
  const result = spawnSync(process.execPath, ['scripts/task.mjs', '11'], {
    encoding: 'utf8', timeout: 5_000,
  });
  const preceding = read('config/tasks.json').tasks.find(task => task.id === '10');
  if (preceding.status !== 'passed') {
    assert.equal(result.status, 2);
    assert.match(result.stderr, /prerequisites/);
  }
});

test('five datasets preserve their approved headers and documented units', () => {
  const data = read('src/contracts/datasets.json');
  // Check the actual public contract, not an arbitrary maximum column count.
  const headers = {
    daily: [
      'date_utc', 'display_day', 'origin_chain_id',
      'payout_hex_per_tshare', 'payout_status', 'tshare_rate_hex',
      'staked_percent', 'weighted_stake_length_days', 'circulating_hex',
      'staked_hex', 'liquid_holders', 'active_stakers',
      'stakes_started', 'stakes_ended', 'penalties_hex',
    ],
    stakes: [
      'stake_id', 'address', 'principal_hex',
      'tshares', 'locked_day', 'staked_days',
      'maturity_utc', 'status', 'started_utc',
      'ended_utc', 'payout_hex', 'penalty_hex',
      'origin_chain_id',
    ],
    holders: [
      'address', 'liquid_hex', 'accounted_staked_hex',
      'total_hex', 'stake_count', 'liquid_rank',
      'staker_rank', 'rank_date_utc',
    ],
    maturities: [
      'date_utc', 'display_day', 'stake_count',
      'principal_hex', 'tshares',
    ],
    markets: [
      'date_utc', 'price_open_usd', 'price_high_usd',
      'price_low_usd', 'price_close_usd', 'volume_usd',
      'liquidity_usd', 'source', 'method',
      'coverage',
    ],
  };
  assert.deepEqual(data.datasets.map(dataset => dataset.name), Object.keys(headers));
  for (const dataset of data.datasets) {
    assert.deepEqual(dataset.columns.map(column => column.name), headers[dataset.name]);
    assert.equal(new Set(dataset.columns.map(column => column.name)).size, dataset.columns.length);
    assert.ok(dataset.columns.every(column => typeof column.unit === 'string' && column.unit.length > 0));
  }
});

test('stake export distinguishes cancelled from ended', () => {
  const stake = read('src/contracts/datasets.json').datasets.find(item => item.name === 'stakes');
  assert.equal(stake.columns.find(column => column.name === 'status').unit,
    'queued/open/mature_open/good_accounted/ended/cancelled');
  // Actual before-lock cancellation -> CSV behavior is qualified by Tasks02/05.
});

test('provider lane quotas and concurrency fit one whole-application budget', () => {
  const { provider, addressReads, liveCanary } = read('config/limits.json');
  const budget = provider.aggregateBudget;
  assert.equal(budget.windowSeconds, 60);
  assert.deepEqual(Object.keys(budget.lanes), ['address', 'metrics', 'sync']);
  for (const field of ['httpAttempts', 'logicalRpcCalls']) {
    const values = Object.values(budget.lanes).map(lane => lane[field]);
    assert.ok(values.every(value => Number.isSafeInteger(value) && value > 0));
    assert.ok(values.reduce((a, b) => a + b, 0) <= budget[field]);
  }
  assert.equal(provider.apiMaximumConcurrentHttp + provider.workerMaximumConcurrentHttp,
    provider.maximumConcurrentHttp);
  assert.equal(provider.maximumQueuedHttpPerProcess, 8);
  assert.equal(addressReads.maximumHttpAttemptsPerRequest, 4);
  assert.equal(addressReads.maximumLogicalRpcCallsPerRequest, 128);
  assert.equal(liveCanary.maximumHttpRequests, 2500);
  assert.equal(liveCanary.maximumLogicalRpcCalls, 20000);
});

test('safe configuration and owner budget', () => {
  const config = read('config/limits.json');
  assert.equal(config.liveEnabledByDefault, false);
  assert.equal(config.currentMetrics.refreshSeconds, 60);
  assert.equal(config.retention.exportBundles, 2);
  assert.equal(config.resources.monthlyBudgetCeilingUsd, 60);
});

test('pure domain imports no external I/O', () => {
  for (const file of fs.readdirSync('src/domain')) {
    const source = fs.readFileSync(`src/domain/${file}`, 'utf8');
    assert.doesNotMatch(source, /from\s+['"](?:node:|pg|fastify|viem)/);
  }
});

test('preflight runs without application or database action', () => {
  const result = spawnSync(process.execPath, ['scripts/preflight.mjs'], {
    encoding: 'utf8', timeout: 15_000,
  });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /WORKSPACE_CHECKED/);
  assert.match(result.stdout, /"databaseAccess": false/);
});

test('worker refuses fake sync success', () => {
  const result = spawnSync(process.execPath, [
    '--experimental-strip-types', 'src/worker/main.ts', 'sync',
  ], { encoding: 'utf8', timeout: 5_000 });
  assert.equal(result.status, 2);
  assert.match(result.stderr, /not implemented/);
});
