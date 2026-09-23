import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdir, readFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import { connect, databaseConfig } from '../../dist/db/connect.js';
import { migrateCurrent } from '../../dist/db/migrate.js';
import { tables } from '../../dist/worker/bootstrap/manifest.js';
import { digest } from '../../dist/services/projections/input.js';
import { newPrefix, continuationFixture, execute } from '../canary/continuation-fixture.mjs';
import { A, B, hash } from '../sync/fixture.mjs';
import { admin, newPlan, clockAt, executeBulk, fixture, save } from './fixture.mjs';

globalThis.fetch = () => {
  throw Error('REAL NETWORK FORBIDDEN');
};
const inherited = Array.from(
  { length: 30 },
  (_, i) => '0x' + (i + 1).toString(16).padStart(40, '0'),
);
const sample = [...inherited, A, B].sort();
const isBalance = (c) => c.method === 'eth_call' && c.params[0].data.startsWith('0x70a08231');
const word = (n) => BigInt(n).toString(16).padStart(64, '0');

async function snapshot() {
  const reader = await connect(databaseConfig('api'));
  try {
    const rows = {},
      receipts = {};
    for (const [table, keys] of Object.entries(tables)) {
      const normalize = (v) =>
        Buffer.isBuffer(v) ? '0x' + v.toString('hex') : Array.isArray(v) ? v.map(normalize) : v;
      // Read numeric columns through pg's exact string parsers, not JSON numbers.
      const data = (
        await reader.query(`SELECT * FROM hdd.${table} ORDER BY ${keys.join(',')}`)
      ).rows.map((r) => Object.fromEntries(Object.entries(r).map(([k, v]) => [k, normalize(v)])));
      receipts[table] = { count: data.length, digest: digest(data) };
      if (
        ['sync_state', 'current_state', 'accounts', 'daily_stats', 'checkpoints_recent'].includes(
          table,
        )
      )
        rows[table] = data;
    }
    return { receipts, rows };
  } finally {
    await reader.end();
  }
}

export async function balancePagingTests({ root, test, reset }) {
  for (const mode of [
    'success',
    'retry-b',
    'persistent-a',
    'persistent-b',
    'invalid-abi-b',
    'mismatch-b',
  ]) {
    await test('32-account pinned replay balance paging: ' + mode, async () => {
      await reset();
      const clock = clockAt();
      const prior = await newPrefix(root, '355');
      const seed = continuationFixture(prior, clock, inherited);
      await execute(prior, 'prepare', seed, clock);
      assert.equal((await execute(prior, 'run', seed, clock)).status, 'complete');
      const before = await snapshot();
      assert.equal(before.rows.sync_state[0].block_number, '355');
      assert.deepEqual(
        before.rows.current_state[0].sampled_addresses.map((a) => a.replace('\\x', '0x')),
        sample,
      );
      assert.equal(before.rows.accounts.length, 32);
      const p = await newPlan(root, prior, { target: '356', milestones: ['356'] });
      const f = fixture(p, clock, 'normal', inherited);
      const traces = [],
        pages = [[], []];
      let retried = false;
      const abort = new AbortController();
      const transport = (endpoint) => {
        const source = p.endpoints.indexOf(endpoint);
        assert.ok(source === 0 || source === 1);
        const raw = f.transport(endpoint);
        return async (body, signal, deadline) => {
          const calls = JSON.parse(body);
          const record = {
            source: p.profile.ethereum[source].id,
            calls,
            bytes: 0,
            complete: false,
          };
          traces.push(record);
          const replayPage = calls.every(isBalance) && calls[0].params[1].blockHash === hash(355);
          if (replayPage) {
            pages[source].push(record);
            assert.ok(calls.length <= 10, 'Size-sensitive SYNTHETIC transport requires <=10');
            for (const c of calls)
              assert.deepEqual(c.params[1], { blockHash: hash(355), requireCanonical: true });
            const secondPage = '0x' + calls[0].params[0].data.slice(-40) === sample[10];
            if (
              secondPage &&
              ((mode === 'persistent-a' && source === 0) ||
                (mode === 'persistent-b' && source === 1))
            )
              throw Error('Synthetic network failure on later balance page');
            if (secondPage && mode === 'retry-b' && source === 1 && !retried) {
              retried = true;
              throw Error('Synthetic network failure on later balance page');
            }
          }
          const response = await raw(body, signal, deadline);
          const parts = [];
          for await (const part of response.body) parts.push(part);
          const rows = JSON.parse(Buffer.concat(parts));
          const laterB =
            replayPage && source === 1 && '0x' + calls[0].params[0].data.slice(-40) === sample[10];
          if (laterB && mode === 'invalid-abi-b') rows[0].result = '0x01';
          if (laterB && mode === 'mismatch-b')
            rows[0].result = '0x' + word(BigInt(rows[0].result) + 1n);
          if (replayPage) record.returned = rows.map((r) => ({ id: r.id, raw: r.result }));
          return {
            ...response,
            body: (async function* () {
              const bytes = Buffer.from(JSON.stringify(rows));
              record.bytes = bytes.length;
              yield bytes;
              record.complete = true;
            })(),
          };
        };
      };
      await executeBulk(p, 'prepare', clock);
      const result = await executeBulk(p, 'run', clock, {
        transport,
        signal: abort.signal,
      });
      const after = await snapshot();
      const shapes = pages.map((ps) => ps.map((r) => r.calls.length));
      const succeeds = mode === 'success' || mode === 'retry-b';
      // The transport trace is independent of the gate's durable accounting.
      assert.equal(result.http, traces.length);
      assert.equal(
        result.logical,
        traces.reduce((n, r) => n + r.calls.length, 0),
      );
      assert.equal(
        result.observedBytes,
        traces.reduce((n, r) => n + r.bytes, 0),
      );
      assert.equal(
        result.chargedBytes,
        traces.reduce((n, r) => n + (r.complete ? r.bytes : 8388608), 0),
      );
      if (succeeds) {
        assert.equal(result.status, 'complete', result.reason);
        assert.deepEqual(shapes, [
          [10, 10, 10, 2],
          mode === 'retry-b' ? [10, 10, 10, 10, 2] : [10, 10, 10, 2],
        ]);
        const expectedState = f.f.f.states.get(356);
        const expectedBalances = [...expectedState.balances]
          .sort(([a], [b]) => a.localeCompare(b))
          .map(([address, hearts]) => ({ address, hearts: hearts.toString() }));
        assert.deepEqual(
          after.rows.accounts.map((r) => ({
            address: r.address.replace('\\x', '0x'),
            hearts: r.liquid_hearts,
          })),
          expectedBalances,
        );
        const current = after.rows.current_state[0];
        assert.equal(current.circulating_hearts, expectedState.supply.toString());
        assert.equal(current.locked_hearts, '500');
        assert.equal(current.queued_shares, '250');
        assert.equal(current.active_shares, '0');
        assert.equal(current.holder_count, '31');
        assert.equal(current.staker_count, '2');
        assert.equal(current.contract_day, 1);
        assert.deepEqual(current.sampled_addresses, []);
        assert.equal(after.rows.sync_state[0].block_number, '356');
        assert.equal(
          BigInt(after.rows.sync_state[0].revision),
          BigInt(before.rows.sync_state[0].revision) + 1n,
        );
        assert.equal(after.rows.daily_stats.length, 1);
        const day = after.rows.daily_stats[0];
        assert.equal(day.contract_day, 0);
        assert.equal(day.close_block, '355');
        assert.equal(day.circulating_hearts, expectedState.supply.toString());
        assert.equal(day.locked_hearts, '500');
        assert.equal(day.payout_status, 'materialized');
        assert.equal(day.payout_hearts, '0');
        const comparisons = (await readFile(p.storagePath + '/comparisons.jsonl', 'utf8'))
          .trim()
          .split('\n')
          .map(JSON.parse);
        for (const source of p.profile.ethereum) {
          const ps = comparisons.filter((r) => r.source === source.id);
          assert.deepEqual(
            ps.map((r) => r.rows.length),
            [10, 10, 10, 2],
          );
          assert.deepEqual(
            ps.flatMap((r) => r.rows.map((v) => v.address)),
            sample,
          );
          assert.equal(ps.flatMap((r) => r.rows).filter((r) => r.expected === '0').length, 1);
        }
        await save('balance-paging-' + mode + '-audit', comparisons);
      } else {
        assert.equal(result.status, 'blocked', result.reason);
        assert.equal(result.terminal, true);
        assert.equal(result.accepted.header.number, '355');
        assert.equal(result.accepted.revision, before.rows.sync_state[0].revision);
        assert.equal(result.audited, null);
        assert.equal(result.pendingSql, null);
        assert.deepEqual(
          after,
          before,
          'Failed complete sample must not enter the canonical writer',
        );
        if (mode.startsWith('persistent')) {
          assert.match(result.reason, /Synthetic network failure/);
          assert.deepEqual(
            shapes,
            mode === 'persistent-a'
              ? [[10, 10, 10, 10, 10], []]
              : [
                  [10, 10, 10, 2],
                  [10, 10, 10, 10, 10],
                ],
          );
          assert.equal(result.uncertainAttempts, 4);
        }
        if (mode === 'invalid-abi-b') {
          assert.match(result.reason, /Malformed ABI/);
          assert.deepEqual(shapes, [
            [10, 10, 10, 2],
            [10, 10],
          ]);
        }
        if (mode === 'mismatch-b') {
          assert.match(result.reason, /Native source disagreement/);
          assert.deepEqual(shapes, [
            [10, 10, 10, 2],
            [10, 10, 10, 2],
          ]);
        }
        const stateBytes = await readFile(p.storagePath + '/reconstruction.json');
        const count = traces.length;
        await assert.rejects(executeBulk(p, 'resume', clock, { transport }), /cannot run\/resume/);
        assert.equal(traces.length, count);
        assert.deepEqual(await readFile(p.storagePath + '/reconstruction.json'), stateBytes);
      }
      await save('balance-paging-' + mode, {
        mode,
        shapes,
        sample,
        before,
        after,
        result,
        traces,
        realProviderCalls: 0,
        liveEfficacy: 'UNMEASURED',
      });
    });
  }
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  const root = '/canary-test/' + randomUUID();
  await mkdir(root);
  const c = await connect(databaseConfig('migrator'));
  try {
    await migrateCurrent(c);
  } finally {
    await c.end();
  }
  const results = [];
  try {
    await balancePagingTests({
      root,
      reset: () =>
        admin((db) =>
          db.query(
            'TRUNCATE ' +
              [...Object.keys(tables), 'live_metrics', 'export_bundles']
                .map((t) => 'hdd.' + t)
                .join(',') +
              ' CASCADE',
          ),
        ),
      test: async (name, fn) => {
        await fn();
        results.push({ name, status: 'PASS' });
        console.log('PASS', name);
      },
    });
  } finally {
    await save('balance-paging-results', { results, realProviderCalls: 0 });
  }
}
