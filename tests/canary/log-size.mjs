import assert from 'node:assert/strict';
import { randomUUID, createHash } from 'node:crypto';
import { readFile, writeFile, rename } from 'node:fs/promises';
import pg from 'pg';
import { runCanary } from '../../dist/operator/canary.js';
import { CanarySession } from '../../dist/operator/canary-session.js';
import { maintenanceLease } from '../../dist/operator/lease.js';
import { profileSources } from '../../dist/worker/sync/profile.js';
import { SyncEngine } from '../../dist/worker/sync/engine.js';
import { CanonicalWriter } from '../../dist/services/projections/writer.js';
import { RpcClient, LocalLogSizeError } from '../../dist/providers/rpc.js';
import { rpcDiagnostic } from '../../dist/providers/rpc-diagnostic.js';
import { ProviderBudget } from '../../dist/providers/budget.js';
import { connect, databaseConfig } from '../../dist/db/connect.js';
import { tables } from '../../dist/worker/bootstrap/manifest.js';
import { dailyRow } from '../../dist/services/queries/home.js';
import { dayBoundaryPlan, prefixEnvironment, prefixFixture, endpoints } from './prefix-fixture.mjs';
import { inputs } from './fixture.mjs';
import { exactSnapshot } from './diagnostics.mjs';
import { FakeClock, memoryCooldown } from '../sync/fixture.mjs';
const MIB = 1024 * 1024;
const sha = (value) => createHash('sha256').update(JSON.stringify(value)).digest('hex');

async function semantic(snapshot) {
  const sql = await snapshot(),
    db = await connect(databaseConfig('worker'));
  try {
    const value = Object.fromEntries(
      ['current_state', 'accounts', 'stakes', 'share_schedule', 'daily_stats'].map((table) => [
        table,
        sql[table],
      ]),
    );
    // Partition-dependent observation identities are metadata; every amount, event,
    // lifecycle, owner, close block and daily/payout status is compared exactly.
    value.daily_stats = value.daily_stats.map(({ payout_block, payout_hash, ...row }) => row);
    for (const table of ['events', 'transfers_recent'])
      value[table] = (
        await db.query(`SELECT * FROM hdd.${table} ORDER BY ${tables[table].join(',')}`)
      ).rows;
    return value;
  } finally {
    await db.end();
  }
}
async function receipts() {
  const db = await connect(databaseConfig('worker'));
  try {
    const rows = (
      await db.query(
        "SELECT previous_sync->>'block_number' AS previous,block_number FROM hdd.checkpoints_recent ORDER BY block_number",
      )
    ).rows;
    let previous = '100';
    for (const row of rows) {
      assert.equal(row.previous, previous);
      assert(BigInt(row.block_number) > BigInt(previous));
      previous = row.block_number;
    }
    return rows;
  } finally {
    await db.end();
  }
}
async function loseWriter() {
  const db = new pg.Client({
    host: 'db',
    database: 'hexdailydata_v2',
    user: 'hdd_v2_admin',
    password: process.env.HDD_V2_ADMIN_PASSWORD,
  });
  await db.connect();
  try {
    const rows = (
      await db.query(
        "SELECT pg_terminate_backend(pid) AS stopped FROM pg_locks WHERE locktype='advisory' AND classid=4242 AND objid=1 AND granted",
      )
    ).rows;
    assert.equal(rows.length, 1);
    assert.equal(rows[0].stopped, true);
    await new Promise((r) => setTimeout(r, 30));
  } finally {
    await db.end();
  }
}
export async function byteAwareTests({ root, test, reset, snapshot }) {
  assert.equal(process.env.HDD_V2_ALLOW_LIVE_RPC, 'false');
  let expected;
  await test('byte-aware control: compiled two-source session/writer with <=128-block targets and exact nonempty multiday state', async () => {
    const p = dayBoundaryPlan(root + '/' + randomUUID());
    await inputs(p);
    const clock = new FakeClock();
    clock.time = Date.now();
    const f = prefixFixture(p, clock),
      signal = new AbortController().signal;
    const release = await maintenanceLease([p.storagePath, p.quotaPath], signal);
    const session = await CanarySession.prepare(p, clock);
    const db = await connect(databaseConfig('worker'));
    const writer = await CanonicalWriter.acquire(await connect(databaseConfig('worker')), 1);
    try {
      await session.start(false);
      const pair = profileSources(
        p.profile,
        1,
        (s) => session.transport(1, f.transport(prefixEnvironment(p)[s.endpointEnv]), s.id),
        new ProviderBudget('worker', memoryCooldown(), clock),
      );
      const engine = new SyncEngine(writer, db, pair, p.storagePath);
      await engine.initializeConstructor(
        p.profile.constructor.checkpoint,
        p.profile.constructor.transactionHash,
        [],
        session.controller.signal,
      );
      for (let n = 228; n < 1380; n += 128)
        await engine.once(session.controller.signal, f.f.plain(n));
      await engine.once(session.controller.signal, f.f.plain(1380));
      await engine.audit(session.controller.signal);
      assert.equal(engine.progress.splits, 0);
      assert.equal(engine.progress.events, 20);
      assert(
        f.raw.calls
          .filter((c) => c.method === 'eth_getLogs')
          .every((c) => BigInt(c.params[0].toBlock) - BigInt(c.params[0].fromBlock) < 128n),
      );
      expected = await semantic(snapshot);
      assert.equal(
        dailyRow(expected.daily_stats[0]).payout.hexPerTShare,
        null,
        'zero preclaim words are not a usable payout',
      );
      assert.equal(
        dailyRow(expected.daily_stats[3]).payout.hexPerTShare,
        null,
        'pending stays unavailable',
      );
      assert.equal(expected.stakes.length, 5);
      assert.equal(expected.accounts.length, 2);
      assert.equal(expected.current_state[0].contract_day, 5);
      assert.deepEqual(
        expected.daily_stats.map((d) => [
          d.contract_day,
          d.payout_status,
          d.payout_hearts,
          d.payout_shares,
        ]),
        [
          [0, 'materialized', '0', '0'],
          [1, 'materialized', '0', '0'],
          [2, 'materialized', '50', '250'],
          [3, 'pending', null, null],
          [4, 'pending', null, null],
        ],
      );
      await session.finish('complete', 'TEST smaller-range control with final two-source audit.');
      await writeFile(
        '/evidence/byte-control.json',
        JSON.stringify(
          {
            synthetic: true,
            semantic: expected,
            semanticSha256: sha(expected),
            receipts: await receipts(),
            progress: engine.progress,
            state: session.state,
            raw: { http: f.raw.http, logical: f.raw.logical, bytes: f.raw.bytes, peak: f.raw.peak },
          },
          null,
          2,
        ),
      );
    } finally {
      await session.close();
      await writer.close();
      await db.end();
      await release();
    }
    await reset();
  });
  await test('byte-aware compiled SQL: source A or B local overflow splits without partial acceptance; row splitting remains separate', async () => {
    for (const mode of ['source-a', 'source-b', 'rows']) {
      const result = await execute(mode);
      assert.equal(result.state.status, 'complete', result.state.reason);
      assert.equal(result.state.results[0].result.audit, 'all-prefix-addresses');
      assert(result.state.results[0].result.progress.splits > 0);
      assert.equal(result.state.results[0].result.progress.events, 20);
      assert.deepEqual(result.semantic, expected);
      assert.equal(result.raw.peak, 1);
      assert.equal(result.raw.http, result.state.http);
      assert.equal(result.raw.logical, result.state.logical);
      assert.equal(result.raw.bytes, result.state.observedBytes);
      assert.equal(
        result.state.prefix.accounting.reduce((n, a) => n + a.rpc.retries, 0),
        0,
      );
      assert.equal(
        result.state.prefix.accounting.reduce((n, a) => n + a.rpc.bytes, 0),
        result.raw.bytes,
      );
      assert.equal(
        result.state.chargedBytes,
        result.raw.bytes +
          result.parents.reduce((n, p) => n + (p.complete ? 0 : 8 * MIB - p.observedBytes), 0),
      );
      if (mode !== 'rows') {
        assert.equal(result.localDiagnostics.length, result.parents.length);
        assert.equal(result.localDiagnostics[0].reason, 'local-size');
        assert.equal(result.localDiagnostics[0].streamComplete, false);
        assert.equal(result.localDiagnostics[0].digestScope, 'observed-prefix');
        assert.equal(result.state.uncertainAttempts, result.parents.length);
        assert.equal(result.parents[0].observedBytes, 2 * MIB + 65536);
      } else {
        assert.equal(result.localDiagnostics.length, 0);
        assert.equal(result.state.uncertainAttempts, 0);
      }
      if (mode !== 'rows')
        assert(
          result.raw.logs.some(
            (r) =>
              r.afterFailure &&
              r.from === result.parents[0].from &&
              BigInt(r.to) < BigInt(result.parents[0].to),
          ),
        );
      await writeFile(`/evidence/byte-${mode}.json`, JSON.stringify(result, null, 2));
      await reset();
    }
  });
  await test('byte-aware terminal SQL: hard cap, cancellation, deadline, quota, settlement, cleanup and lost writer keep accepted state', async () => {
    for (const mode of [
      'hard',
      'cancel',
      'deadline',
      'quota',
      'settlement',
      'cleanup',
      'lost-writer',
    ]) {
      const result = await execute(mode);
      assert.equal(result.state.status, 'stopped', mode);
      assert.equal(result.state.results.length, 0);
      assert.equal(result.raw.afterTerminal, 0);
      assert.equal(result.beforeSha256, result.afterSha256, mode);
      assert.equal(
        result.state.prefix.accounting.reduce((n, a) => n + a.rpc.retries, 0),
        0,
      );
      if (mode === 'hard') assert.equal(result.state.rpcDiagnostic.reason, 'response-size');
      await writeFile(`/evidence/byte-terminal-${mode}.json`, JSON.stringify(result, null, 2));
      await reset();
    }
  });

  async function execute(mode) {
    const p = dayBoundaryPlan(root + '/' + randomUUID());
    await inputs(p);
    const clock = new FakeClock();
    clock.time = Date.now();
    const f = prefixFixture(p, clock),
      env = prefixEnvironment(p),
      controller = new AbortController();
    const args = [p.storagePath + '/plan.json', p.storagePath + '/approval.json'];
    await runCanary(['prepare', ...args], controller.signal, { env, clock });
    const raw = { http: 0, logical: 0, bytes: 0, active: 0, peak: 0, logs: [], afterTerminal: 0 };
    const parents = [],
      localDiagnostics = [];
    let injected = false,
      terminal = false,
      before,
      afterEarly;
    const original = RpcClient.prototype.calls;
    RpcClient.prototype.calls = async function (...args) {
      try {
        return await original.apply(this, args);
      } catch (error) {
        if (error instanceof LocalLogSizeError) {
          localDiagnostics.push(rpcDiagnostic(error));
          afterEarly = await exactSnapshot();
          assert.deepEqual(afterEarly, before, 'discarded parent does not commit any SQL field');
        }
        throw error;
      }
    };
    const transport = (endpoint) => {
      const normal = f.transport(endpoint),
        index = endpoints.indexOf(endpoint);
      return async (body, active, deadline) => {
        if (terminal) raw.afterTerminal++;
        raw.http++;
        const calls = JSON.parse(body);
        raw.logical += calls.length;
        raw.active++;
        raw.peak = Math.max(raw.peak, raw.active);
        const call = calls.length === 1 && calls[0].method === 'eth_getLogs' ? calls[0] : null;
        const range = call
          ? {
              source: index,
              from: BigInt(call.params[0].fromBlock).toString(),
              to: BigInt(call.params[0].toBlock).toString(),
              afterFailure: injected,
            }
          : null;
        if (range) raw.logs.push(range);
        const chosen = mode === 'source-b' ? 1 : 0;
        const inject =
          (!injected || ['source-a', 'source-b'].includes(mode)) &&
          index === chosen &&
          range &&
          range.from === '356' &&
          BigInt(range.to) - BigInt(range.from) >= 128n;
        const response = await normal(body, active, deadline);
        if (!inject)
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
        injected = true;
        before = await exactSnapshot();
        assert.equal(before.sync_state[0].block_number, '355');
        const prior = [];
        for await (const chunk of response.body) prior.push(chunk);
        const base = Buffer.concat(prior);
        let payload;
        if (mode === 'rows') {
          const rows = JSON.parse(base);
          const example = f.f.logs.get(132)[0];
          // 2001 well-shaped rows exercise only Source's count check; children use real fixture logs.
          rows[0].result = Array.from({ length: 2001 }, () => example);
          payload = Buffer.from(JSON.stringify(rows));
          assert(payload.length < 2 * MIB);
        } else payload = Buffer.concat([base, Buffer.alloc(3 * MIB - base.length, 32)]);
        const parent = { ...range, complete: false, observedBytes: 0 };
        parents.push(parent);
        if (mode === 'source-b')
          assert(
            raw.logs.some((r) => r.source === 0 && r.from === range.from && r.to === range.to),
          );
        if (mode === 'settlement') await rename(p.storagePath, p.storagePath + '-moved');
        if (mode === 'lost-writer') {
          terminal = true;
          await loseWriter();
        }
        if (mode === 'quota') {
          // Keep current charged work; exhaust only this new TEST session before children.
          const originalSave = CanarySession.prototype.save;
          CanarySession.prototype.save = async function () {
            if (this.plan.session === p.session && !this.state.pending) {
              this.state.chargedBytes = p.caps.bytes - 8 * MIB + 1;
              CanarySession.prototype.save = originalSave;
            }
            return originalSave.call(this);
          };
        }
        let released = false;
        const releaseRaw = () => {
          if (!released) {
            released = true;
            raw.active--;
          }
        };
        return {
          status: 200,
          retryAfter: null,
          close: async () => {
            releaseRaw();
            if (mode === 'cleanup') {
              terminal = true;
              throw Error('TEST real cleanup failure');
            }
          },
          body: (async function* () {
            try {
              if (mode === 'hard') payload = Buffer.alloc(4 * MIB + 1, 32);
              if (mode === 'cancel') {
                terminal = true;
                controller.abort(Error('TEST cancellation'));
              }
              if (mode === 'deadline') {
                terminal = true;
                clock.time += p.caps.milliseconds;
              }
              if (['settlement', 'quota'].includes(mode)) terminal = true;
              const step = mode === 'hard' ? payload.length : 65536;
              for (let offset = 0; offset < payload.length; offset += step) {
                const chunk = payload.subarray(offset, offset + step);
                raw.bytes += chunk.length;
                parent.observedBytes += chunk.length;
                yield chunk;
              }
              parent.complete = true;
            } finally {
              releaseRaw();
            }
          })(),
        };
      };
    };
    let state;
    try {
      state = await runCanary(['run', ...args], controller.signal, { env, clock, transport });
    } finally {
      RpcClient.prototype.calls = original;
    }
    assert(injected, mode);
    assert.equal(raw.active, 0);
    const after = await exactSnapshot();
    const storedPath = mode === 'settlement' ? p.storagePath + '-moved/canary.json' : p.sessionPath;
    const retained = await readFile(storedPath);
    if (state.status === 'complete') {
      await assert.rejects(
        runCanary(['run', ...args], new AbortController().signal, { env, clock, transport }),
        /spent|empty|complete/,
      );
      assert.equal((await readFile(storedPath)).toString(), retained.toString());
    }
    return {
      synthetic: true,
      mode,
      padding: 'Valid JSON trailing whitespace, synthetic byte pressure only',
      state,
      raw,
      parents,
      localDiagnostics,
      semantic: await semantic(snapshot),
      semanticSha256: sha(await semantic(snapshot)),
      receipts: await receipts(),
      beforeSha256: sha(before),
      afterSha256: sha(after),
      earlySqlUnchanged: afterEarly ? sha(afterEarly) === sha(before) : null,
    };
  }
}
