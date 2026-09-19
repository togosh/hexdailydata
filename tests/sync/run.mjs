import assert from 'node:assert/strict';
import { readFileSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { connect, databaseConfig } from '../../src/db/connect.ts';
import { migrateCurrent, initialMigration, migrate } from '../../src/db/migrate.ts';
import { CanonicalWriter } from '../../src/services/projections/writer.ts';
import { SyncEngine, diskReserve } from '../../src/worker/sync/engine.ts';
import { exportSeed, importSeed, fileHash } from '../../src/worker/bootstrap/seed.ts';
import { tableNames, tables } from '../../src/worker/bootstrap/manifest.ts';
import { ProviderBudget } from '../../src/providers/budget.ts';
import { packArchive, readArchive } from '../../src/worker/bootstrap/archive.ts';
import { recoveryCases } from './recovery.mjs';
import {
  fixture,
  FakeClock,
  memoryCooldown,
  CONTRACT,
  CODE_HASH,
  hash,
  LARGE,
} from './fixture.mjs';

const signal = new AbortController().signal,
  phase = process.env.HDD_V2_SYNC_PHASE;
const clients = [],
  results = [];
let writer;
async function db(role) {
  const c = await connect(databaseConfig(role));
  clients.push(c);
  return c;
}
async function test(name, fn) {
  const start = performance.now();
  try {
    await fn();
    results.push({ name, status: 'PASS', ms: performance.now() - start });
    console.log('PASS', name);
  } catch (error) {
    results.push({ name, status: 'FAIL', error: error.message });
    throw error;
  }
}
const chain = fixture({ holdersPerBlock: 64 });
const clock = new FakeClock(),
  budget = new ProviderBudget('worker', memoryCooldown(), clock);
const pair = (id) => [
  chain.source(id, 'fixture-one', clock, undefined, budget),
  chain.source(id, 'fixture-two', clock, undefined, budget),
];
const seed = '/evidence/fixture.seed.tar.gz';
async function corruptSeed(table, edit, sourcePath = seed) {
  const members = [];
  await readArchive(
    sourcePath,
    ['seed.json', ...tableNames.map((t) => `tables/${t}.ndjson`)],
    async (name, size, chunks) => {
      const parts = [];
      for await (const part of chunks) parts.push(part);
      members.push({ name, data: Buffer.concat(parts) });
    },
    signal,
  );
  const manifest = JSON.parse(members[0].data.toString()),
    entry = manifest.files.find((f) => f.table === table),
    member = members.find((m) => m.name === entry.path);
  member.data = Buffer.from(edit(member.data.toString()));
  entry.bytes = String(member.data.length);
  entry.rows = String(member.data.toString().split('\n').length - 1);
  entry.sha256 = createHash('sha256').update(member.data).digest('hex');
  members[0].data = Buffer.from(JSON.stringify(manifest));
  const path = `/evidence/malicious-${table}-${Date.now()}.tar.gz`;
  await packArchive(
    path,
    members.map((m) => ({ ...m, size: m.data.length })),
    signal,
  );
  return path;
}
let api, worker;
async function engine(id) {
  worker = await db('worker');
  writer = await CanonicalWriter.acquire(worker, id);
  return new SyncEngine(writer, api, pair(id), '/evidence');
}
async function snapshot({ semantic = false } = {}) {
  const output = {};
  for (const table of tableNames) {
    if (
      semantic &&
      ['checkpoints_recent', 'undo_recent', 'blocks_recent', 'transfers_recent'].includes(table)
    )
      continue;
    const expression =
      table === 'checkpoints_recent'
        ? "to_jsonb(t)-'undo_bytes'-'tail_bytes'"
        : semantic && table === 'sync_state'
          ? "to_jsonb(t)-'revision'-'acceptance'"
          : 'to_jsonb(t)';
    const digest = createHash('sha256');
    let count = 0;
    await api.query('BEGIN READ ONLY');
    try {
      await api.query(
        `DECLARE digest_rows CURSOR FOR SELECT ${expression}::text AS row FROM hdd.${table} t ORDER BY ${tables[table].join(',')}`,
      );
      for (;;) {
        const { rows } = await api.query('FETCH FORWARD 128 FROM digest_rows');
        if (!rows.length) break;
        for (const row of rows) {
          digest.update(row.row + '\n');
          count++;
        }
      }
      await api.query('CLOSE digest_rows');
      await api.query('COMMIT');
    } catch (error) {
      await api.query('ROLLBACK');
      throw error;
    }
    output[table] = { rows: count, sha256: digest.digest('hex') };
  }
  return output;
}
try {
  const migrator = await db('migrator');
  await test('fresh/repeated schema2 plus ordered schema1 upgrade preserves ledger', async () => {
    if (phase === 'build') await migrate(migrator, await initialMigration());
    await migrateCurrent(migrator);
    await migrateCurrent(migrator);
    assert.deepEqual(
      (await migrator.query('SELECT version FROM hdd.schema_migrations ORDER BY version')).rows.map(
        (r) => r.version,
      ),
      [1, 2],
    );
  });
  api = await db('api');
  console.log(
    'Runner cgroup:',
    readFileSync('/sys/fs/cgroup/cpu.max', 'utf8').trim(),
    readFileSync('/sys/fs/cgroup/memory.max', 'utf8').trim(),
  );
  console.log('Disk reserve:', await diskReserve('/evidence'));
  let sync;
  if (phase === 'build') {
    sync = await engine(1);
    await test('raw zero-supply constructor, shared history, inherited lifecycle and first native events', async () => {
      await sync.initializeConstructor(chain.plain(100), hash(10000), [], signal);
      assert.equal(
        (await api.query('SELECT circulating_hearts FROM hdd.current_state')).rows[0]
          .circulating_hearts,
        '0',
      );
      await sync.once(signal, chain.plain(180));
      await sync.audit(signal);
      await writer.close();
      sync = await engine(369);
      await sync.fork(chain.plain(180), chain.plain(181), signal);
      const inherited = (
        await api.query(
          'SELECT stake_id,lifecycle FROM hdd.stakes WHERE chain_id=369 ORDER BY stake_id',
        )
      ).rows;
      assert.deepEqual(inherited, [
        { stake_id: '1', lifecycle: 'good_accounted' },
        { stake_id: '2', lifecycle: 'unsettled' },
        { stake_id: '3', lifecycle: 'cancelled' },
        { stake_id: '4', lifecycle: 'ended' },
        { stake_id: '6', lifecycle: 'unsettled' },
        { stake_id: '7', lifecycle: 'unsettled' },
        { stake_id: '8', lifecycle: 'unsettled' },
      ]);
      assert.equal((await sync.cursor()).block_number, '180');
      await sync.once(signal, chain.plain(181));
      assert.equal(
        (
          await api.query(
            "SELECT liquid_hearts FROM hdd.accounts WHERE chain_id=369 AND address=decode(repeat('33',20),'hex')",
          )
        ).rows[0].liquid_hearts,
        '11',
      );
      assert.equal(
        (
          await api.query(
            'SELECT count(*) FROM hdd.events WHERE origin_chain_id=369 AND block_number<=180',
          )
        ).rows[0].count,
        '0',
      );
      const exporter = await db('worker');
      await exportSeed(exporter, '/evidence/early.seed.tar.gz', signal);
    });
    await test('multi-day once, automatic replay-age pruning and independent exact totals', async () => {
      await sync.once(signal, chain.plain(296));
      await sync.audit(signal);
      const current = (await api.query('SELECT * FROM hdd.current_state WHERE chain_id=369'))
        .rows[0];
      assert.equal(current.circulating_hearts, (LARGE + 10000n + 30n - 1000n).toString());
      assert.equal(current.locked_hearts, '1000');
      assert.equal(current.accounted_hearts, '1000');
      assert.equal(current.staker_count, '1');
      assert.equal(current.active_shares, '500');
      assert.equal(current.queued_shares, '0');
      assert.equal(
        (
          await api.query(
            "SELECT count(*) FROM hdd.daily_stats WHERE chain_id=369 AND payout_status='pending'",
          )
        ).rows[0].count,
        '2',
      );
      const s = await sync.cursor();
      assert.ok(BigInt(s.rewind_floor) > 180n);
      assert.ok(BigInt(s.rewind_floor) < 296n);
      assert.equal(
        (await api.query('SELECT min(number)::text AS n FROM hdd.blocks_recent WHERE chain_id=369'))
          .rows[0].n,
        s.rewind_floor,
      );
    });
    await test('streamed consistent seed, active snapshot prune pin and interrupted export preserves previous artifact', async () => {
      const exporter = await db('worker');
      const result = await exportSeed(exporter, seed, signal, {
        afterSnapshot: async () => {
          assert.equal((await writer.prune()).blocker, 'active snapshot');
        },
      });
      writeFileSync(
        '/evidence/seed-identity.json',
        JSON.stringify({
          sha256: result.sha256,
          checkpointHash: chain.plain(296).hash,
          sourceInstance: databaseConfig('worker').instance,
        }),
      );
      const before = result.sha256;
      await assert.rejects(
        () =>
          exportSeed(exporter, seed, signal, {
            beforeRename: async () => {
              throw new Error('injected export interruption');
            },
          }),
        /injected/,
      );
      assert.equal(await fileHash(seed, signal), before);
      console.log(
        'Seed counts/bytes:',
        result.manifest.files.map((f) => ({ table: f.table, rows: f.rows, bytes: f.bytes })),
        'exportMs',
        result.ms,
      );
    });
    await test('forward sync fixed checkpoint and full at-block address reconciliation', async () => {
      await sync.once(signal, chain.plain(360));
      await sync.audit(signal);
      writeFileSync(
        '/evidence/expected-checkpoint.json',
        JSON.stringify({ exact: await snapshot(), semantic: await snapshot({ semantic: true }) }),
      );
    });
  } else if (phase === 'early-import') {
    worker = await db('worker');
    await test('fresh first-native seed validates exact inherited boundary, then commits, rewinds and replays', async () => {
      const path = '/evidence/early.seed.tar.gz';
      const expected = {
        instance: databaseConfig('worker').instance,
        sha256: await fileHash(path, signal),
        contract: CONTRACT,
        codeHash: CODE_HASH,
        checkpointHash: chain.plain(181).hash,
      };
      const corrupt = await corruptSeed(
        'source_history',
        (text) =>
          text
            .split('\n')
            .map((row) =>
              row.includes('"chain_id": 369')
                ? row.replace(
                    /"start_hash": "[^"]+"/,
                    '"start_hash": "' + '\\\\x' + 'ff'.repeat(32) + '"',
                  )
                : row,
            )
            .join('\n'),
        path,
      );
      const corruptHash = await fileHash(corrupt, signal);
      await assert.rejects(
        () =>
          importSeed(
            worker,
            corrupt,
            {
              ...expected,
              sha256: corruptHash,
            },
            signal,
          ),
        /cursor\/header/,
      );
      assert.equal((await api.query('SELECT count(*) FROM hdd.chains')).rows[0].count, '0');
      const imported = await importSeed(worker, path, expected, signal);
      assert.ok(imported.recoveryCheckpoints > 0);
      sync = await engine(369);
      await sync.audit(signal);
      const s = await sync.cursor();
      assert.equal(s.block_number, '181');
      await writer.rewind('180', {
        blockNumber: s.block_number,
        blockHash: '0x' + s.block_hash.toString('hex'),
        revision: s.revision,
      });
      assert.equal((await sync.cursor()).block_number, '180');
      await sync.once(signal, chain.plain(181));
      await sync.audit(signal);
      assert.equal((await sync.cursor()).block_number, '181');
      assert.ok(BigInt((await sync.cursor()).revision) > BigInt(s.revision));
    });
  } else if (phase === 'unpruned') {
    sync = await engine(1);
    await sync.initializeConstructor(chain.plain(100), hash(10000), [], signal);
    await sync.once(signal, chain.plain(180));
    await writer.close();
    sync = await engine(369);
    await sync.fork(chain.plain(180), chain.plain(181), signal);
    await writer.setRecoveryPin('transfer_consumer', '180');
    await test('lagging transfer consumer retains ancient replay input; daily/current equals pruned rebuild', async () => {
      // Match acquisition checkpoints so first materialized payout observation identity
      // is identical; this comparison varies only retention, not observation timing.
      await sync.once(signal, chain.plain(181));
      await sync.once(signal, chain.plain(296));
      await sync.once(signal, chain.plain(360));
      await sync.audit(signal);
      assert.equal((await sync.cursor()).rewind_floor, '180');
      const expected = JSON.parse(
        readFileSync('/evidence/expected-checkpoint.json', 'utf8'),
      ).semantic;
      const actual = await snapshot({ semantic: true });
      for (const key of Object.keys(expected))
        if (!['sync_state', 'recovery_pins'].includes(key))
          assert.deepEqual(actual[key], expected[key]);
      assert.equal(
        (
          await api.query(
            'SELECT min(block_number)::text AS n FROM hdd.transfers_recent WHERE origin_chain_id=369',
          )
        ).rows[0].n,
        '181',
      );
    });
    await test('prune crash is atomic; clearing consumer pin safely converges and cannot reopen floor', async () => {
      await writer.setRecoveryPin('transfer_consumer', null);
      const before = await snapshot();
      await assert.rejects(
        () =>
          writer.prune({
            beforeCommit: async () => {
              throw new Error('injected prune crash');
            },
          }),
        /prune crash/,
      );
      assert.deepEqual(await snapshot(), before);
      const result = await writer.prune();
      assert.ok(result.pruned > 0);
      assert.ok(BigInt(result.floor) > 180n);
      await assert.rejects(() => writer.setRecoveryPin('transfer_consumer', '180'), /outside/);
      assert.equal(
        (await api.query('SELECT min(number)::text AS n FROM hdd.blocks_recent WHERE chain_id=369'))
          .rows[0].n,
        result.floor,
      );
      assert.equal(
        (
          await api.query(
            "SELECT count(*) FROM hdd.daily_stats WHERE chain_id=369 AND payout_status='pending'",
          )
        ).rows[0].count,
        '2',
      );
    });
  } else {
    worker = await db('worker');
    const identity = JSON.parse(readFileSync('/evidence/seed-identity.json', 'utf8'));
    const expected = {
      ...identity,
      instance: databaseConfig('worker').instance,
      contract: CONTRACT,
      codeHash: CODE_HASH,
    };
    assert.notEqual(identity.sourceInstance, expected.instance);
    await test('unrelated table, view, or user schema refuses import without any mutation', async () => {
      for (const [create, drop] of [
        [
          "CREATE TABLE hdd.unrelated_import_witness(value text); INSERT INTO hdd.unrelated_import_witness VALUES('synthetic')",
          'DROP TABLE hdd.unrelated_import_witness',
        ],
        ['CREATE VIEW hdd.unrelated_view AS SELECT 1 AS value', 'DROP VIEW hdd.unrelated_view'],
        ['CREATE SCHEMA unrelated_import_witness', 'DROP SCHEMA unrelated_import_witness'],
      ]) {
        await migrator.query(create);
        const before = await snapshot();
        await assert.rejects(() => importSeed(worker, seed, expected, signal), /unrelated/);
        assert.deepEqual(await snapshot(), before);
        if (create.startsWith('CREATE TABLE'))
          assert.deepEqual(
            (await migrator.query('SELECT * FROM hdd.unrelated_import_witness')).rows,
            [{ value: 'synthetic' }],
          );
        await migrator.query(drop);
      }
    });
    await test('rehashed malicious seed fails independent totals, column and undo identity checks without partial target', async () => {
      for (const [table, edit, pattern] of [
        [
          'current_state',
          (text) =>
            text.replace(
              /"circulating_hearts": (\d+)/,
              (_, n) => '"circulating_hearts": ' + (BigInt(n) + 1n),
            ),
          /reconciliation/,
        ],
        ['chains', (text) => text.replace('{', '{"unexpected_column": 1,'), /columns/],
        [
          'undo_recent',
          (text) => text.replace(/"row_key": \{/, '"row_key": {"unexpected_identity": 1,'),
          /undo identity/,
        ],
      ]) {
        const path = await corruptSeed(table, edit);
        const sha256 = await fileHash(path, signal);
        await assert.rejects(
          () => importSeed(worker, path, { ...expected, sha256 }, signal),
          pattern,
        );
        assert.equal((await api.query('SELECT count(*) FROM hdd.chains')).rows[0].count, '0');
      }
    });
    await test('rehashed historical before-image and previous cursor corruption are rejected atomically', async () => {
      const corruptions = [
        [
          'undo_recent',
          (text) => {
            // Earliest effective account A before-image in the latest retained revision.
            const rows = text.trimEnd().split('\n');
            const latest = rows
              .filter((r) => /"chain_id": 369/.test(r))
              .reduce((n, r) => Math.max(n, Number(r.match(/"revision": (\d+)/)[1])), 0);
            const index = rows.findIndex(
              (r) =>
                r.includes('"relation_name": "accounts"') &&
                r.includes('"revision": ' + latest + ',') &&
                r.includes('11'.repeat(20)) &&
                /"liquid_hearts": 900719925474099/.test(r),
            );
            assert.ok(index >= 0);
            rows[index] = rows[index].replace(
              /"liquid_hearts": (\d+)/,
              (_, n) => '"liquid_hearts": ' + (BigInt(n) + 1n),
            );
            return rows.join('\n') + '\n';
          },
          /reconciliation/,
        ],
        [
          'checkpoints_recent',
          (text) =>
            text.replace(
              /"previous_sync": \{([^\n]*?)"block_hash": "[^"]+"/,
              (_, prefix) =>
                '"previous_sync": {' + prefix + '"block_hash": "' + '\\\\x' + 'ff'.repeat(32) + '"',
            ),
          /cursor\/header/,
        ],
      ];
      for (const [table, edit, pattern] of corruptions) {
        const path = await corruptSeed(table, edit);
        const sha256 = await fileHash(path, signal);
        await assert.rejects(
          () => importSeed(worker, path, { ...expected, sha256 }, signal),
          pattern,
        );
        assert.equal((await api.query('SELECT count(*) FROM hdd.chains')).rows[0].count, '0');
        assert.equal((await api.query('SELECT count(*) FROM hdd.undo_recent')).rows[0].count, '0');
      }
    });
    await test('interrupted import rolls back all rows, then fresh import keeps destination identity', async () => {
      await assert.rejects(
        () =>
          importSeed(worker, seed, expected, signal, {
            beforeCommit: async () => {
              throw new Error('injected import interruption');
            },
          }),
        /injected/,
      );
      assert.equal((await api.query('SELECT count(*) FROM hdd.chains')).rows[0].count, '0');
      const imported = await importSeed(worker, seed, expected, signal);
      assert.ok(imported.recoveryCheckpoints > 1);
      console.log('Seed import recovery audit:', imported);
      assert.equal(
        (await api.query('SELECT instance::text FROM hdd_identity.instance')).rows[0].instance,
        expected.instance,
      );
    });
    await test('initialized target refused without mutation', async () => {
      const before = await snapshot();
      await assert.rejects(() => importSeed(worker, seed, expected, signal), /empty/);
      assert.deepEqual(await snapshot(), before);
    });
    sync = await engine(369);
    await test('import then normal forward sync equals independent rebuild including exact nested undo JSON', async () => {
      await sync.once(signal, chain.plain(360));
      await sync.audit(signal);
      const expected = JSON.parse(readFileSync('/evidence/expected-checkpoint.json', 'utf8'));
      assert.deepEqual(await snapshot(), expected.exact);
      const nested = (
        await api.query(
          "SELECT previous_value::text AS v FROM hdd.undo_recent WHERE relation_name='accounts' AND previous_value->>'address'=$1 LIMIT 1",
          ['\\x' + '11'.repeat(20)],
        )
      ).rows[0].v;
      assert.ok(nested.includes('900719925474099'));
    });
    await test('post-import rewind/replay advances fence and preserves retained floor and semantic equality', async () => {
      const s = await sync.cursor();
      await writer.rewind('355', {
        blockNumber: s.block_number,
        blockHash: '0x' + s.block_hash.toString('hex'),
        revision: s.revision,
      });
      assert.equal((await sync.cursor()).rewind_floor, s.rewind_floor);
      await sync.once(signal, chain.plain(360));
      await sync.audit(signal);
      const expected = JSON.parse(readFileSync('/evidence/expected-checkpoint.json', 'utf8'));
      assert.deepEqual(await snapshot({ semantic: true }), expected.semantic);
      assert.ok(BigInt((await sync.cursor()).revision) > BigInt(s.revision));
    });
    await recoveryCases({ test, writer, reader: api, db, chain, pair, budget, clock, snapshot });
  }
  console.log(
    'Progress:',
    sync.progress,
    'Budget:',
    budget.counters,
    'RPC:',
    sync.sources.map((s) => ({ rpc: s.rpc.counters, source: s.counters })),
  );
  console.log(
    'Memory:',
    process.memoryUsage(),
    'cgroup peak:',
    readFileSync('/sys/fs/cgroup/memory.peak', 'utf8').trim(),
  );
  console.log(
    'SQL storage:',
    (
      await api.query(
        "SELECT pg_database_size(current_database())::text AS db_bytes,pg_total_relation_size('hdd.undo_recent')::text AS undo_bytes,pg_total_relation_size('hdd.accounts')::text AS account_bytes",
      )
    ).rows[0],
  );
  const measurements = {
    phase,
    progress: sync.progress,
    budget: budget.counters,
    simulatedElapsedMs: clock.now(),
    sources: chain.observedSources.map((s) => ({
      id: s.rpc.id,
      chain: s.rpc.chain,
      rpc: s.rpc.counters,
      acquisition: s.counters,
    })),
    memory: process.memoryUsage(),
    runnerCgroupPeakBytes: readFileSync('/sys/fs/cgroup/memory.peak', 'utf8').trim(),
    storage: (
      await api.query(`SELECT pg_database_size(current_database())::text AS database_bytes,
      (SELECT coalesce(sum(pg_relation_size(c.oid)),0)::text FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='hdd' AND c.relkind='r') AS heap_bytes,
      (SELECT coalesce(sum(pg_indexes_size(c.oid)),0)::text FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='hdd' AND c.relkind='r') AS index_bytes,
      (SELECT coalesce(sum(pg_total_relation_size(c.reltoastrelid)),0)::text FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='hdd' AND c.relkind='r' AND c.reltoastrelid<>0) AS toast_bytes,
      (SELECT temp_bytes::text FROM pg_stat_database WHERE datname=current_database()) AS cumulative_temp_bytes,
      (SELECT wal_bytes::text FROM pg_stat_wal) AS cumulative_wal_bytes`)
    ).rows[0],
    tails: (
      await api.query(
        'SELECT chain_id,count(*)::text AS checkpoints,sum(undo_bytes)::text AS undo_tuple_bytes,sum(tail_bytes)::text AS tail_tuple_bytes FROM hdd.checkpoints_recent GROUP BY chain_id ORDER BY chain_id',
      )
    ).rows,
  };
  writeFileSync(`/evidence/${phase}-measurements.json`, JSON.stringify(measurements, null, 2));
} finally {
  writeFileSync(`/evidence/${phase}-results.json`, JSON.stringify(results, null, 2));
  await writer?.close().catch(() => {});
  for (const client of clients) await client.end().catch(() => {});
}
