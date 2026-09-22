import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import fs from 'node:fs/promises';
import { syncBuiltinESMExports } from 'node:module';
import { setTimeout as pause } from 'node:timers/promises';
import pg from 'pg';
import {
  newPrefix,
  newContinuation,
  continuationFixture,
  admission,
  execute,
  START,
  END,
  inherited,
  added,
} from './continuation-fixture.mjs';
import { inputs } from './fixture.mjs';
import { endpoints } from './prefix-fixture.mjs';
import { FakeClock, A, hash } from '../sync/fixture.mjs';
import { connect, databaseConfig } from '../../dist/db/connect.js';
import { tables } from '../../dist/worker/bootstrap/manifest.js';
import { digest } from '../../dist/services/projections/input.js';
import { SyncEngine } from '../../dist/worker/sync/engine.js';
import { Source } from '../../dist/providers/source.js';
import { dailyRow } from '../../dist/services/queries/home.js';
const json = async (path) => JSON.parse(await readFile(path, 'utf8'));
const save = (name, value) =>
  writeFile('/evidence/' + name + '.json', JSON.stringify(value, null, 2));
async function admin(work) {
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
async function semantic(snapshot) {
  const all = await snapshot(),
    c = await connect(databaseConfig('api'));
  try {
    const value = Object.fromEntries(
      ['current_state', 'accounts', 'stakes', 'share_schedule', 'daily_stats'].map((k) => [
        k,
        all[k],
      ]),
    );
    value.daily_stats = value.daily_stats.map(({ payout_block, payout_hash, ...row }) => row);
    for (const row of all.daily_stats) {
      if (row.payout_status === 'pending') {
        assert.equal(row.payout_block, null);
        assert.equal(row.payout_hash, null);
      } else {
        assert(BigInt(row.payout_block) <= BigInt(END));
        assert.equal('0x' + row.payout_hash.toString('hex'), hash(BigInt(row.payout_block)));
        const receipt = (
          await c.query('SELECT 1 FROM hdd.checkpoints_recent WHERE block_number=$1', [
            row.payout_block,
          ])
        ).rows;
        assert.equal(receipt.length, 1, 'Materialization is tied to an accepted checkpoint');
      }
    }
    for (const table of ['events', 'transfers_recent'])
      value[table] = (
        await c.query('SELECT * FROM hdd.' + table + ' ORDER BY ' + tables[table].join(','))
      ).rows;
    return value;
  } finally {
    await c.end();
  }
}
async function receipts() {
  const c = await connect(databaseConfig('api'));
  try {
    const rows = (
      await c.query(
        "SELECT previous_sync->>'block_number' AS previous,block_number,revision FROM hdd.checkpoints_recent ORDER BY block_number",
      )
    ).rows;
    let previous = '100';
    for (const r of rows) {
      assert.equal(r.previous, previous);
      assert(BigInt(r.block_number) > BigInt(previous));
      previous = r.block_number;
    }
    return rows;
  } finally {
    await c.end();
  }
}
export async function continuationTests({ root, test, reset, snapshot }) {
  assert.equal(process.env.HDD_V2_ALLOW_LIVE_RPC, 'false');
  const clock = new FakeClock();
  clock.time = Date.now();
  let control, controlReceipts;
  async function seeded() {
    await reset();
    const p = await newPrefix(root, START),
      f = continuationFixture(p, clock);
    await execute(p, 'prepare', f, clock);
    const result = await execute(p, 'run', f, clock);
    assert.equal(result.status, 'complete', result.reason);
    const seen = await admission(p);
    assert.equal(seen.observed.inventory.length, 14);
    assert.equal(seen.expected.current.queued_shares, '250');
    assert.equal(seen.expected.current.active_shares, '0');
    assert(BigInt(seen.observed.inventory.find((a) => a.address === A).hearts) > 2n ** 53n);
    return { p, f, seen };
  }
  await test('continuation uninterrupted compiled control: inherited/zero/new accounts, queued activation, exact later payout and pending rows', async () => {
    const p = await newPrefix(root),
      f = continuationFixture(p, clock);
    await execute(p, 'prepare', f, clock);
    const result = await execute(p, 'run', f, clock);
    assert.equal(result.status, 'complete', result.reason);
    control = await semantic(snapshot);
    controlReceipts = await receipts();
    assert.equal(control.accounts.length, 15);
    assert.equal(control.stakes.length, 5);
    assert.equal(control.current_state[0].contract_day, 5);
    assert.equal(control.current_state[0].active_shares, '150');
    assert.equal(control.current_state[0].queued_shares, '0');
    assert.deepEqual(
      control.daily_stats.map((d) => [
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
    assert.equal(dailyRow(control.daily_stats[0]).payout.hexPerTShare, null);
    assert.equal(dailyRow(control.daily_stats[3]).payout.hexPerTShare, null);
    const payout = (50n * 50n) / 250n;
    assert.equal(payout, 10n, 'Independent exact earning vector');
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
    assert.equal(BigInt(control.stakes[3].principal_hearts) + payout, 110n);
    assert.equal(control.current_state[0].locked_hearts, '400');
    assert.equal(control.current_state[0].accounted_hearts, '300');
    assert.equal(control.current_state[0].weighted_days, '20100');
    assert.deepEqual(control.share_schedule, []);
    await save('control', {
      synthetic: true,
      semantic: control,
      digest: digest(control),
      receipts: controlReceipts,
      state: result,
      expectedPayout: payout.toString(),
    });
  });
  await test('compiled populated continuation ends admission snapshot, commits S+1..T and audits every resulting account in ten-call batches', async () => {
    const { p: prior, f, seen } = await seeded(),
      p = await newContinuation(root, prior);
    const old = await readFile(prior.sessionPath, 'utf8');
    await execute(p, 'prepare', f, clock);
    const initialize = SyncEngine.prototype.initializeConstructor,
      fork = SyncEngine.prototype.fork;
    SyncEngine.prototype.initializeConstructor = SyncEngine.prototype.fork = async () => {
      throw Error('Continuation must not initialize');
    };
    let result;
    const activation = [];
    try {
      result = await execute(p, 'run', f, clock, {
        hooks: {
          afterCommit: async () => {
            const reader = await connect(databaseConfig('api'));
            try {
              const row = (
                await reader.query(
                  'SELECT s.block_number,c.contract_day,c.active_shares,c.queued_shares FROM hdd.sync_state s JOIN hdd.current_state c USING(chain_id) WHERE chain_id=1',
                )
              ).rows[0];
              activation.push(row);
              if (row.contract_day === 2) {
                assert.equal(row.active_shares, '250');
                assert.equal(row.queued_shares, '0');
              }
            } finally {
              await reader.end();
            }
          },
        },
      });
    } finally {
      SyncEngine.prototype.initializeConstructor = initialize;
      SyncEngine.prototype.fork = fork;
    }
    assert.equal(result.status, 'complete', result.reason);
    assert.equal(result.replay.reachedTarget, true);
    assert.equal(result.replay.checkpoint.number, END);
    assert.equal(result.audit.unchanged, true);
    assert.notEqual(result.audit.before, seen.observed.canonical.digest);
    assert.equal(result.audit.checkpoint.number, END);
    assert(
      activation.some((r) => r.contract_day === 2),
      'Inherited queued shares activate during the continuation',
    );
    for (const source of result.audit.progress) {
      assert.equal(source.verifiedAccounts, 15);
      assert.equal(source.completedBatches, 2);
      assert(source.complete && source.probeComplete);
    }
    const comparisons = (await readFile(p.storagePath + '/audit-comparisons.jsonl', 'utf8'))
      .trim()
      .split('\n')
      .map(JSON.parse);
    assert.deepEqual(
      comparisons.filter((c) => !c.probe).map((c) => c.rows.length),
      [10, 5, 10, 5],
    );
    for (const source of p.profile.ethereum) {
      const rows = comparisons
        .filter((c) => c.source === source.id && !c.probe)
        .flatMap((c) => c.rows);
      assert(rows.some((r) => r.address === inherited[0] && r.observed === '0'));
      assert(rows.some((r) => r.address === inherited[1] && r.observed === '1'));
      assert(rows.some((r) => r.address === added && r.observed === '3'));
    }
    assert.deepEqual(await semantic(snapshot), control);
    const chain = await receipts(),
      newRows = chain.filter((r) => BigInt(r.block_number) > BigInt(START));
    assert.equal(newRows[0].previous, START);
    assert.equal(newRows.at(-1).block_number, END);
    assert.equal((await snapshot()).chains.length, 1);
    assert.equal(await readFile(prior.sessionPath, 'utf8'), old);
    const spent = await readFile(p.sessionPath, 'utf8');
    for (const command of ['run', 'resume'])
      await assert.rejects(execute(p, command, f, clock), /spent|resume/);
    assert.equal(await readFile(p.sessionPath, 'utf8'), spent);
    await save('continued', {
      state: result,
      semantic: await semantic(snapshot),
      digest: digest(control),
      receipts: chain,
      comparisons,
      activation,
      start: seen.expected,
      canonicalBeforeAudit: await json(p.storagePath + '/audit-before.json'),
      canonicalAfterAudit: await json(p.storagePath + '/audit-after.json'),
      metadataExclusions: [
        'snapshot helper observation timestamps/progress/physical undo bytes/rewind floor',
        'daily payout_block/payout_hash may reflect different accepted partitions',
        'receipt/revision/undo identities depend on atomic partitions; contiguous receipts are separately checked',
      ],
    });
  });
  await test('exact continuation admission rejects changed plan or changed SQL after prepare before constructing a provider', async () => {
    const { p: prior, f } = await seeded();
    for (const change of [
      (p) => (p.instance = randomUUID()),
      (p) => (p.phases[0].admission.revision = '999'),
      (p) => (p.phases[0].admission.checkpoint.parentHash = hash(999)),
      (p) => (p.phases[0].admission.counts.stakes = '999'),
      (p) => (p.profile.ethereum[0].accountGroup = 'wrong'),
      (p) => (p.phases[0].admission.checkpoint.hash = hash(999)),
      (p) => (p.phases[0].admission.checkpoint.timestamp = '1575331201'),
      (p) => (p.phases[0].admission.sourceBindingDigest = 'a'.repeat(64)),
      (p) => (p.phases[0].inventoryDigest = 'a'.repeat(64)),
      (p) => (p.phases[0].canonicalDigest = 'a'.repeat(64)),
      (p) => (p.phases[0].admission.current.locked_hearts = '999'),
    ]) {
      const p = await newContinuation(root, prior);
      change(p);
      await inputs(p);
      const before = (await admission(prior)).observed.canonical.digest;
      let constructed = 0;
      await assert.rejects(
        execute(p, 'prepare', f, clock, {
          transport: () => {
            constructed++;
            throw Error('forbidden');
          },
        }),
      );
      assert.equal(constructed, 0);
      assert.equal((await admission(prior)).observed.canonical.digest, before);
    }
    for (const change of [
      "UPDATE hdd.accounts SET liquid_hearts=liquid_hearts+1 WHERE address=decode('" +
        A.slice(2) +
        "','hex')",
      'UPDATE hdd.sync_state SET block_number=block_number+1',
      "UPDATE hdd.schema_migrations SET sha256='changed' WHERE version=5",
    ]) {
      const p = await newContinuation(root, prior);
      await execute(p, 'prepare', f, clock);
      const db = new pg.Client({
        host: 'db',
        database: 'hexdailydata_v2',
        user: 'hdd_v2_admin',
        password: process.env.HDD_V2_ADMIN_PASSWORD,
      });
      await db.connect();
      // Restore from the exact scalar values; only this new disposable fixture is changed.
      const account = (
        await db.query('SELECT liquid_hearts FROM hdd.accounts WHERE address=$1', [
          Buffer.from(A.slice(2), 'hex'),
        ])
      ).rows[0];
      const migration = (await db.query('SELECT sha256 FROM hdd.schema_migrations WHERE version=5'))
        .rows[0];
      await db.query(change);
      let constructed = 0;
      try {
        await assert.rejects(
          execute(p, 'run', f, clock, {
            transport: () => {
              constructed++;
              throw Error('forbidden');
            },
          }),
        );
        assert.equal(constructed, 0);
      } finally {
        await db.query('UPDATE hdd.accounts SET liquid_hearts=$1 WHERE address=$2', [
          account.liquid_hearts,
          Buffer.from(A.slice(2), 'hex'),
        ]);
        await db.query('UPDATE hdd.sync_state SET block_number=$1', [START]);
        await db.query('UPDATE hdd.schema_migrations SET sha256=$1 WHERE version=5', [
          migration.sha256,
        ]);
        await db.end();
      }
    }
    const ordinary = await newPrefix(root);
    await assert.rejects(execute(ordinary, 'prepare', f, clock), /empty/);
    const native = await newContinuation(root, prior);
    await admin((db) =>
      db.query(
        "INSERT INTO hdd.chains SELECT 369,contract_address,code_hash,'fork',369,355,$1,356,$2 FROM hdd.chains WHERE chain_id=1",
        [Buffer.from(hash(355).slice(2), 'hex'), Buffer.from(hash(356).slice(2), 'hex')],
      ),
    );
    try {
      await assert.rejects(execute(native, 'prepare', f, clock), /only constructor-origin1/);
    } finally {
      await admin((db) => db.query('DELETE FROM hdd.chains WHERE chain_id=369'));
    }
    const empty = await newContinuation(root, prior);
    await reset();
    let constructed = 0;
    await assert.rejects(
      execute(empty, 'prepare', f, clock, {
        transport: () => {
          constructed++;
          throw Error('forbidden');
        },
      }),
    );
    assert.equal(constructed, 0);
  });
  await test('continuation sourceB early byte overflow invalidates both caches and reacquires before an atomic commit', async () => {
    const { p: prior, f } = await seeded(),
      p = await newContinuation(root, prior);
    const calls = [],
      invalidations = [],
      invalidate = Source.prototype.invalidateAfter;
    let injected = false,
      before;
    Source.prototype.invalidateAfter = function (n) {
      invalidations.push([this.identity.id, n]);
      return invalidate.call(this, n);
    };
    const transport = (endpoint) => {
      const raw = f.transport(endpoint);
      return async (body, ...args) => {
        const call = JSON.parse(body)[0],
          response = await raw(body, ...args);
        if (call.method !== 'eth_getLogs') return response;
        const from = BigInt(call.params[0].fromBlock).toString(),
          to = BigInt(call.params[0].toBlock).toString();
        calls.push({ source: endpoints.indexOf(endpoint), from, to, afterFailure: injected });
        if (injected) {
          if (from === '356')
            assert.equal(
              (await admission(prior)).observed.canonical.digest,
              before,
              'Discarded parent cannot enter SQL before both child acquisitions',
            );
          return response;
        }
        if (endpoint !== endpoints[1]) return response;
        injected = true;
        before = (await admission(prior)).observed.canonical.digest;
        const chunks = [];
        for await (const b of response.body) chunks.push(b);
        const bytes = Buffer.concat(chunks),
          padded = Buffer.concat([bytes, Buffer.alloc(3 * 1024 * 1024 - bytes.length, 32)]);
        return {
          ...response,
          body: (async function* () {
            for (let offset = 0; offset < padded.length; offset += 65536)
              yield padded.subarray(offset, offset + 65536);
          })(),
        };
      };
    };
    let result;
    try {
      await execute(p, 'prepare', f, clock);
      result = await execute(p, 'run', f, clock, { transport });
    } finally {
      Source.prototype.invalidateAfter = invalidate;
    }
    assert.equal(result.status, 'complete', result.reason);
    assert(injected);
    assert(result.replay.progress.splits > 0);
    assert.equal(result.uncertainAttempts, 1);
    assert(result.chargedBytes - result.observedBytes > 5 * 1024 * 1024);
    assert.deepEqual(
      new Set(invalidations.filter((v) => v[1] === START).map((v) => v[0])),
      new Set(p.profile.ethereum.map((v) => v.id)),
    );
    for (const source of [0, 1])
      assert(
        calls.some(
          (c) => c.source === source && c.afterFailure && c.from === '356' && BigInt(c.to) < 483n,
        ),
      );
    assert.deepEqual(await semantic(snapshot), control);
    await save('byte-split', {
      state: result,
      calls,
      invalidations,
      before,
      semanticSha256: digest(await semantic(snapshot)),
      receipts: await receipts(),
    });
  });
  await test('interrupted continuation preserves the accepted SQL checkpoint; a distinct TEST grant completes without repeating events', async () => {
    for (const mode of ['rejected-source', 'after-commit']) {
      const { p: prior, f } = await seeded(),
        p = await newContinuation(root, prior);
      await execute(p, 'prepare', f, clock);
      let committed = 0,
        rejected = false,
        before;
      const options =
        mode === 'after-commit'
          ? {
              hooks: {
                afterCommit: async () => {
                  throw Error('Synthetic lost post-commit progress');
                },
              },
            }
          : {
              hooks: {
                afterCommit: async () => {
                  committed++;
                },
              },
              transport: (endpoint) => {
                const raw = f.transport(endpoint);
                return async (body, ...args) => {
                  assert(!rejected, 'No dispatch after terminal malformed reply');
                  const calls = JSON.parse(body);
                  if (committed && endpoint === endpoints[1] && calls[0].method === 'eth_getLogs') {
                    before = (await admission(prior)).observed.canonical.digest;
                    rejected = true;
                    return {
                      status: 200,
                      retryAfter: null,
                      body: (async function* () {
                        yield Buffer.from('{malformed');
                      })(),
                    };
                  }
                  return raw(body, ...args);
                };
              },
            };
      const result = await execute(p, 'run', f, clock, options);
      assert.equal(result.status, 'stopped');
      assert(result.terminal);
      assert.equal(result.replay.reachedTarget, false);
      const accepted = await admission(prior);
      assert.equal(accepted.expected.checkpoint.number, '483');
      assert.equal(result.replay.checkpoint.number, '483');
      const stale = await newContinuation(root, p);
      stale.phases[0].admission = (await json(p.storagePath + '/plan.json')).phases[0].admission;
      stale.ranges[0].from = START;
      await inputs(stale);
      let staleConstructed = 0;
      await assert.rejects(
        execute(stale, 'prepare', f, clock, {
          transport: () => {
            staleConstructed++;
            throw Error('forbidden');
          },
        }),
      );
      assert.equal(staleConstructed, 0);
      if (mode === 'rejected-source') {
        assert(result.rpcDiagnostic);
        assert.equal(accepted.observed.canonical.digest, before);
      } else
        assert.equal(result.replay.progress.commits, 0, 'SQL committed before in-memory progress');
      const old = await readFile(p.sessionPath, 'utf8');
      for (const command of ['run', 'resume'])
        await assert.rejects(execute(p, command, f, clock), /spent|resume/);
      const next = await newContinuation(root, p);
      next.phases[0].priorDispatchFloor = clock.now() + 70000;
      await inputs(next);
      const startTime = clock.now(),
        dispatchIndex = f.raw.starts.length;
      await execute(next, 'prepare', f, clock);
      const startIndex = f.raw.calls.length,
        nextResult = await execute(next, 'run', f, clock);
      assert.equal(nextResult.status, 'complete', nextResult.reason);
      assert(f.raw.starts.slice(dispatchIndex).every((r) => r.at >= startTime + 70000));
      assert(
        f.raw.calls
          .slice(startIndex)
          .filter((c) => c.method === 'eth_getLogs')
          .every((c) => BigInt(c.params[0].fromBlock) > 483n),
      );
      assert.equal(await readFile(p.sessionPath, 'utf8'), old);
      assert.deepEqual(await semantic(snapshot), control);
      await save('interruption-' + mode, {
        stopped: result,
        admittedCheckpoint: accepted.expected,
        next: nextResult,
        semanticSha256: digest(await semantic(snapshot)),
        receipts: await receipts(),
      });
    }
  });
  await test('final audit mismatch preserves reached T and partial coverage; final-save failure never reports completion', async () => {
    for (const mode of ['audit-mismatch', 'audit-malformed', 'final-save']) {
      const { p: prior, f } = await seeded(),
        p = await newContinuation(root, prior);
      await execute(p, 'prepare', f, clock);
      let mismatch = false;
      const options =
        mode === 'final-save'
          ? {
              sessionHooks: {
                beforeFinalSave: async () => {
                  throw Error('Synthetic final save failure');
                },
              },
            }
          : {
              transport: (endpoint) => {
                const raw = f.transport(endpoint);
                return async (body, ...args) => {
                  const calls = JSON.parse(body),
                    response = await raw(body, ...args);
                  if (
                    endpoint !== endpoints[1] ||
                    calls.length !== 10 ||
                    !calls.every(
                      (c) => c.method === 'eth_call' && c.params[0].data.startsWith('0x70a08231'),
                    ) ||
                    calls[0].params[1].blockHash !== hash(Number(END))
                  )
                    return response;
                  assert(!mismatch, 'No retry or fallback after terminal audit response');
                  if (mode === 'audit-malformed') {
                    mismatch = true;
                    return {
                      ...response,
                      body: (async function* () {
                        yield Buffer.from('{malformed');
                      })(),
                    };
                  }
                  const chunks = [];
                  for await (const chunk of response.body) chunks.push(chunk);
                  const rows = JSON.parse(Buffer.concat(chunks));
                  rows[0].result = '0x' + 999n.toString(16).padStart(64, '0');
                  mismatch = true;
                  return {
                    ...response,
                    body: (async function* () {
                      yield Buffer.from(JSON.stringify(rows));
                    })(),
                  };
                };
              },
            };
      const result = await execute(p, 'run', f, clock, options);
      assert.equal(result.status, 'stopped');
      assert(result.replay.reachedTarget);
      assert.equal(result.replay.checkpoint.number, END);
      assert.equal(result.audit.unchanged, true);
      assert.deepEqual(await semantic(snapshot), control);
      if (mode === 'audit-mismatch') {
        assert(mismatch);
        assert.equal(result.audit.progress[0].verifiedAccounts, 15);
        assert.equal(result.audit.progress[1].verifiedAccounts, 0);
        assert(result.audit.progress[1].mismatch);
      }
      if (mode === 'audit-malformed') {
        assert(mismatch);
        assert(result.rpcDiagnostic);
        assert.equal(result.audit.progress[0].verifiedAccounts, 15);
        assert.equal(result.audit.progress[1].verifiedAccounts, 0);
        assert.equal(result.audit.progress[1].pending.count, 10);
      }
      await save(mode, {
        state: result,
        semanticSha256: digest(await semantic(snapshot)),
        receipts: await receipts(),
      });
    }
    await reset();
  });
  await test('continuation preserves hard bytes, original deadlines, cancellation, ownership, durable reservation and both disk floors', async () => {
    const { p: prior, f, seen } = await seeded(),
      evidence = [];
    for (const mode of [
      'hard-response',
      'session-bytes',
      'request-wait',
      'session-deadline',
      'cancel',
      'ownership',
      'persistence',
      'storagePath-absolute',
      'storagePath-percent',
      'quotaPath-absolute',
      'quotaPath-percent',
    ]) {
      const p = await newContinuation(root, prior);
      if (mode === 'session-bytes') p.caps.bytes = 8388608;
      if (mode === 'request-wait' || mode.includes('Path-'))
        p.phases[0].priorDispatchFloor = clock.now() + (mode === 'request-wait' ? 90000 : 70000);
      await inputs(p);
      await execute(p, 'prepare', f, clock);
      let sends = 0,
        armed = false,
        checkedAt,
        armedAt;
      const cancel = new AbortController(),
        statfs = fs.statfs,
        rename = fs.rename;
      const rootKey = mode.startsWith('storagePath') ? 'storagePath' : 'quotaPath';
      fs.statfs = async (path, ...args) => {
        if (armed && mode.includes('Path-') && path === p[rootKey]) {
          checkedAt = clock.now();
          // One observation violates 8GiB only, the other 20% only.
          return {
            bsize: 1n,
            bavail: mode.endsWith('absolute') ? 7n * 1024n ** 3n : 10n * 1024n ** 3n,
            blocks: mode.endsWith('absolute') ? 20n * 1024n ** 3n : 100n * 1024n ** 3n,
          };
        }
        return statfs(path, ...args);
      };
      fs.rename = async (from, to) => {
        if (
          mode === 'persistence' &&
          to === p.sessionPath &&
          JSON.parse(await readFile(from, 'utf8')).pending
        )
          throw Error('Synthetic durable reservation failure');
        return rename(from, to);
      };
      syncBuiltinESMExports();
      let result;
      try {
        result = await execute(p, 'run', f, clock, {
          signal: cancel.signal,
          sessionHooks: {
            beforeDispatch: async () => {
              armed = true;
              armedAt = clock.now();
              if (mode === 'session-deadline') clock.time += p.caps.milliseconds;
              if (mode === 'cancel')
                cancel.abort(Error('Synthetic cancellation while awaiting dispatch'));
            },
          },
          transport: (endpoint) => {
            const raw = f.transport(endpoint);
            return async (body, ...args) => {
              sends++;
              assert.equal(sends, 1, 'Terminal failure cannot dispatch children or retries');
              if (mode === 'hard-response')
                return {
                  status: 200,
                  retryAfter: null,
                  body: (async function* () {
                    yield Buffer.alloc(4194305, 32);
                  })(),
                };
              const response = await raw(body, ...args);
              if (mode === 'ownership') {
                await admin((db) =>
                  db.query(
                    "SELECT pg_terminate_backend(pid) FROM pg_locks WHERE locktype='advisory' AND classid=4242 AND objid=369 AND granted",
                  ),
                );
                await pause(30);
              }
              return response;
            };
          },
        });
      } finally {
        fs.statfs = statfs;
        fs.rename = rename;
        syncBuiltinESMExports();
      }
      assert.equal(result.status, 'stopped', mode);
      assert(result.terminal);
      assert(!result.replay.reachedTarget);
      assert.equal(
        (await admission(prior)).observed.canonical.digest,
        seen.observed.canonical.digest,
        mode,
      );
      assert.equal(
        sends,
        ['hard-response', 'ownership', 'session-bytes'].includes(mode) ? 1 : 0,
        mode,
      );
      assert.equal(result.deadline, result.start + p.caps.milliseconds);
      if (mode === 'session-bytes') {
        assert.equal(result.http, 1);
        assert(result.chargedBytes > 0 && result.chargedBytes < 8388608);
        assert.equal(result.chargedBytes, result.observedBytes);
        assert.match(result.reason, /byte reservation unavailable/);
      } else {
        assert.equal(result.http, 1);
        assert.equal(result.chargedBytes, 8388608);
      }
      if (mode === 'request-wait') assert.match(result.reason, /original request deadline/);
      if (mode === 'hard-response') {
        assert(result.rpcDiagnostic);
        assert.equal(result.observedBytes, 4194305);
        assert.equal(result.uncertainAttempts, 1);
      }
      if (mode.includes('Path-')) {
        assert.match(result.reason, /8GiB AND 20%/);
        assert(checkedAt > armedAt);
      }
      const saved = await json(p.sessionPath);
      if (mode === 'persistence') {
        assert.equal(saved.status, 'running');
        assert.equal(saved.start, result.start);
      }
      for (const command of ['run', 'resume'])
        await assert.rejects(execute(p, command, f, clock), /spent|resume/);
      evidence.push({ mode, sends, state: result, persistedStatus: saved.status });
    }
    await save('guards', {
      cases: evidence,
      canonicalDigest: seen.observed.canonical.digest,
      unchanged: true,
    });
    await reset();
  });
}
