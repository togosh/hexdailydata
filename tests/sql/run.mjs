import assert from 'node:assert/strict';
import pg from 'pg';
import { readFileSync, writeFileSync, statfsSync } from 'node:fs';
import { performance } from 'node:perf_hooks';
import { connect, databaseConfig } from '../../src/db/connect.ts';
import { migrate, initialMigration } from '../../src/db/migrate.ts';
import { CanonicalWriter } from '../../src/services/projections/writer.ts';
import { reconcile } from '../../src/services/projections/initialize.ts';
import { currentStakeStatus, totalColumns } from '../../src/services/projections/reduce.ts';
import { validateBatch } from '../../src/services/projections/input.ts';
import {
  A,
  B,
  C,
  ZERO,
  CONTRACT,
  CODE,
  hash,
  header,
  sources,
  initial,
  transfer,
  start,
  end,
  batch,
} from './fixtures.mjs';
import { scale } from './scale.mjs';

const results = [];
async function test(name, fn) {
  const t = performance.now();
  try {
    await fn();
    results.push({ name, result: 'PASS', ms: performance.now() - t });
    console.log('PASS', name);
  } catch (e) {
    results.push({ name, result: 'FAIL', error: e.message, ms: performance.now() - t });
    throw e;
  }
}
async function denied(
  client,
  sql,
  params = [],
  pattern = /permission denied|read-only|must be owner|not permitted/,
) {
  try {
    await client.query(sql, params);
    assert.fail('Unexpected SQL success');
  } catch (e) {
    assert.match(e.message, pattern);
    console.log('Expected SQL rejection:', e.code ?? '', e.message);
  }
}
const config = databaseConfig('worker');
const admin = new pg.Client({
  host: 'db',
  database: config.database,
  user: 'hdd_v2_admin',
  password: process.env.HDD_V2_ADMIN_PASSWORD,
});
const clients = [];
async function db(role) {
  const c = await connect(databaseConfig(role));
  clients.push(c);
  return c;
}
let writer;
async function snapshot() {
  const output = {};
  for (const table of [
    'chains',
    'accounts',
    'stakes',
    'current_state',
    'share_schedule',
    'daily_stats',
    'events',
    'transfers_recent',
    'blocks_recent',
    'sync_state',
  ]) {
    const expression = table === 'sync_state' ? "to_jsonb(t)-'revision'" : 'to_jsonb(t)';
    const { rows } = await api.query(
      `SELECT ${expression}::text AS value FROM hdd.${table} t ORDER BY ${expression}::text`,
    );
    output[table] = rows.map((r) => r.value);
  }
  return output;
}
let api, worker, migrator;
try {
  await admin.connect();
  console.log(
    'Node',
    process.version,
    'pg client',
    JSON.parse(readFileSync('node_modules/pg/package.json', 'utf8')).version,
  );
  console.log((await admin.query('SELECT version()')).rows[0]);
  console.log('Runner cgroup', {
    cpu: readFileSync('/sys/fs/cgroup/cpu.max', 'utf8').trim(),
    memory: readFileSync('/sys/fs/cgroup/memory.max', 'utf8').trim(),
  });
  migrator = await db('migrator');
  const sql = await initialMigration();
  await test('target guard, unrelated target refusal, fresh migration and repeat checksum', async () => {
    assert.throws(() => databaseConfig('worker', {}), /Explicit/);
    await assert.rejects(() => connect({ ...config, host: 'localhost' }), /target/);
    await assert.rejects(
      () => connect({ ...config, instance: '00000000-0000-0000-0000-000000000000' }),
      /identity/,
    );
    await migrator.query('CREATE SCHEMA unrelated_test');
    await assert.rejects(() => migrate(migrator, sql), /unrelated/);
    await migrator.query('DROP SCHEMA unrelated_test');
    await migrate(migrator, sql);
    await migrate(migrator, sql);
    await assert.rejects(() => migrate(migrator, sql + '\n-- changed'), /checksum/);
    await admin.query('UPDATE hdd.schema_migrations SET version=2');
    await assert.rejects(() => migrate(migrator, sql), /version/);
    await admin.query('UPDATE hdd.schema_migrations SET version=1');
  });
  api = await db('api');
  worker = await db('worker');
  await test('actual API/worker/migrator role privileges and SQL type constraints', async () => {
    for (const c of [api, worker, migrator]) {
      const {
        rows: [r],
      } = await c.query(
        'SELECT rolsuper,rolcreatedb,rolcreaterole FROM pg_roles WHERE rolname=current_user',
      );
      assert.deepEqual(r, { rolsuper: false, rolcreatedb: false, rolcreaterole: false });
      await denied(c, 'CREATE ROLE prohibited_test');
    }
    await api.query('SELECT * FROM hdd.accounts');
    await api.query('SET default_transaction_read_only=off');
    await denied(
      api,
      "INSERT INTO hdd.chains VALUES(1,decode(repeat('00',20),'hex'),decode(repeat('00',32),'hex'),'constructor',1,NULL,NULL,NULL,NULL)",
    );
    await denied(api, 'DELETE FROM hdd.sync_state');
    await denied(api, 'CREATE TABLE hdd.prohibited(id int)');
    await denied(worker, 'CREATE TABLE hdd.prohibited(id int)');
    await denied(worker, 'ALTER TABLE hdd.accounts ADD COLUMN prohibited int');
    await denied(worker, 'UPDATE hdd.schema_migrations SET version=9');
    await denied(worker, 'UPDATE hdd_identity.instance SET singleton=false');
    await denied(worker, 'SET ROLE hdd_v2_migrator');
    await migrator.query('BEGIN');
    await migrator.query('CREATE TABLE hdd.ddl_test(id int)');
    await migrator.query('ROLLBACK');
    await denied(worker, "SELECT decode('00','hex')::hdd.address", [], /violates check/);
    await denied(worker, "SELECT decode('00','hex')::hdd.hash", [], /violates check/);
    await denied(worker, 'SELECT (-1)::hdd.amount', [], /violates check/);
    await denied(worker, 'SELECT power(10::numeric,102)::hdd.total', [], /violates check/);
    await denied(worker, 'SELECT 1.5::hdd.amount', [], /violates check/);
    await assert.rejects(() => migrate(worker, sql), /authority/);
  });
  writer = await CanonicalWriter.acquire(worker, 1);
  await assert.rejects(() => CanonicalWriter.acquire(worker, 1), /already belongs/);
  await test('constructor requires explicit nonzero mint and exact supply; no partial initialization', async () => {
    await assert.rejects(
      () => writer.initialize('constructor', sources({ ...initial, circulating: '3001' })),
      /supply/,
    );
    await assert.rejects(() =>
      writer.initialize('constructor', sources({ ...initial, balances: [] })),
    );
    assert.equal((await api.query('SELECT count(*) FROM hdd.chains')).rows[0].count, '0');
    await writer.initialize('constructor', sources(initial));
    await reconcile(worker, 1);
    await assert.rejects(() => writer.initialize('constructor', sources(initial)), /empty/);
  });
  const first = await batch(api, [
    transfer(A, ZERO, 100),
    start(1, A, 100, 50, 10),
    transfer(A, ZERO, 300),
    start(2, A, 300, 150, 30),
    transfer(B, ZERO, 900),
    start(3, B, 900, 450, 10),
    end(3, B, 0, 0, 0),
    transfer(ZERO, B, 900),
    transfer(A, A, 77),
    transfer(A, C, 0),
    transfer(A, C, 1600),
    transfer(ZERO, A, 50),
    transfer(B, ZERO, 1000),
  ]);
  // Exact duplicates inside both normalized responses are accepted once.
  first.sources.forEach((s) => s.events.splice(1, 0, structuredClone(s.events[0])));
  await test('atomic lifecycle/transfer integration, threshold counts and exact duplicate replay', async () => {
    await writer.commit(first);
    const before = await snapshot();
    assert.equal((await writer.commit(first)).replayed, true);
    assert.deepEqual(await snapshot(), before);
    const {
      rows: [s],
    } = await api.query('SELECT * FROM hdd.current_state WHERE chain_id=1');
    for (const [key, value] of Object.entries({
      circulating_hearts: '1650',
      locked_hearts: '400',
      accounted_hearts: '400',
      weighted_days: '10000',
      queued_shares: '200',
      active_shares: '0',
      holder_count: '2',
      staker_count: '1',
      starts: '3',
      ends: '1',
    }))
      assert.equal(s[key], value, key);
    assert.equal(
      (await api.query('SELECT lifecycle FROM hdd.stakes WHERE stake_id=3')).rows[0].lifecycle,
      'cancelled',
    );
    await reconcile(worker, 1);
  });
  await test('payload conflict, source omission, identity/order and negative-balance rejection', async () => {
    const before = await snapshot();
    const conflict = structuredClone(first);
    conflict.sources.forEach((s) => (s.events[0].value.hearts = '99'));
    await assert.rejects(() => writer.commit(conflict), /Conflicting duplicate/);
    const committedConflict = structuredClone(first);
    committedConflict.sources.forEach((s) => (s.events.at(-1).value.hearts = '999'));
    await assert.rejects(() => writer.commit(committedConflict), /Conflicting duplicate batch/);
    const missing = await batch(api, [transfer(C, A, 100)]);
    missing.sources[1].events = [];
    await assert.rejects(() => writer.commit(missing), /disagreement/);
    const wrong = await batch(api, [transfer(C, A, 100)]);
    wrong.sources.forEach((s) => (s.events[0].contract = ZERO));
    await assert.rejects(() => writer.commit(wrong), /mismatch/);
    const badOrder = await batch(api, [transfer(C, A, 1), transfer(C, A, 2)]);
    badOrder.sources.forEach((s) => s.events.reverse());
    await assert.rejects(() => writer.commit(badOrder), /order/);
    assert.deepEqual(await snapshot(), before);
    const negative = await batch(api, [transfer(A, B, 51)]);
    await assert.rejects(() => writer.commit(negative), /Negative/);
    const self = await batch(api, [transfer(B, B, 1)]);
    await assert.rejects(() => writer.commit(self), /Self-transfer/);
    assert.deepEqual(await snapshot(), before);
    const sameBackend = await batch(api);
    sameBackend.sources[1].operator = sameBackend.sources[0].operator;
    assert.throws(() => validateBatch(sameBackend), /upstreams/);
    // Correlated identical omissions are not detectable by set agreement. Never claim otherwise.
  });
  await test('failure before commit, concurrent writer exclusion, bounded reader and injected lost ack', async () => {
    const other = await db('worker');
    await assert.rejects(() => CanonicalWriter.acquire(other, 1), /already active/);
    const b = await batch(api, [transfer(C, A, 100)]),
      before = await snapshot();
    await assert.rejects(
      () =>
        writer.commit(b, {
          beforeCommit: async () => {
            throw new Error('injected before commit');
          },
        }),
      /injected/,
    );
    assert.deepEqual(await snapshot(), before);
    await assert.rejects(
      () =>
        writer.commit(b, {
          beforeCommit: async () => {
            const started = performance.now();
            assert.deepEqual(await snapshot(), before);
            const ms = performance.now() - started;
            assert.ok(ms < 2000);
            console.log('Reader while write open ms', ms);
          },
          afterCommit: async () => {
            throw new Error('injected lost acknowledgement after COMMIT');
          },
        }),
      /lost acknowledgement/,
    );
    await writer.close();
    worker = await db('worker');
    writer = await CanonicalWriter.acquire(worker, 1);
    const committed = await snapshot();
    assert.equal((await writer.commit(b)).replayed, true);
    assert.deepEqual(await snapshot(), committed);
    const stale = await batch(api);
    stale.expected.revision = '0';
    await assert.rejects(() => writer.commit(stale), /CAS/);
  });
  await test('queued activation, end-on-lock, empty days and delayed payout ownership', async () => {
    const b = await batch(api, [end(2, A, 0, 12, 0), transfer(ZERO, A, 288)], 11);
    const wrongSample = structuredClone(b);
    wrongSample.sources.forEach((s) => (s.closes[0].balances[0].hearts = '999'));
    await assert.rejects(() => writer.commit(wrongSample), /sample mismatch/);
    await writer.commit(b);
    const {
      rows: [s],
    } = await api.query('SELECT * FROM hdd.current_state WHERE chain_id=1');
    assert.equal(s.circulating_hearts, '1938');
    assert.equal(s.locked_hearts, '100');
    assert.equal(s.active_shares, '50');
    assert.equal(s.queued_shares, '0');
    assert.equal(s.penalty_hearts, '12');
    const stake = (await api.query('SELECT * FROM hdd.stakes WHERE stake_id=2')).rows[0];
    assert.equal(currentStakeStatus(stake, 11), 'ended');
    assert.equal(
      (await api.query('SELECT payout_status FROM hdd.daily_stats WHERE contract_day=10')).rows[0]
        .payout_status,
      'pending',
    );
    const dailyBefore = (
      await api.query(
        "SELECT (to_jsonb(d)-ARRAY['payout_status','payout_hearts','payout_shares','payout_block','payout_hash'])::text AS value FROM hdd.daily_stats d WHERE contract_day=10",
      )
    ).rows[0].value;
    const materialize = await batch(
      api,
      [
        transfer(A, ZERO, 50),
        start(5, A, 50, 20, 1),
        transfer(A, ZERO, 20),
        start(6, A, 20, 4, 100),
      ],
      12,
    );
    materialize.sources.forEach(
      (s) =>
        (s.payouts = [
          {
            day: 10,
            payout: '17',
            shares: '19',
            blockNumber: s.headers[0].number,
            blockHash: s.headers[0].hash,
          },
        ]),
    );
    await writer.commit(materialize);
    const dailyAfter = (
      await api.query(
        "SELECT (to_jsonb(d)-ARRAY['payout_status','payout_hearts','payout_shares','payout_block','payout_hash'])::text AS value FROM hdd.daily_stats d WHERE contract_day=10",
      )
    ).rows[0].value;
    assert.equal(dailyAfter, dailyBefore);
    await writer.commit(await batch(api, [], 21));
    assert.equal(
      currentStakeStatus(
        (await api.query('SELECT * FROM hdd.stakes WHERE stake_id=1')).rows[0],
        21,
      ),
      'mature_open',
    );
    await writer.commit(await batch(api, [], 42));
    await writer.commit(
      await batch(
        api,
        [{ kind: 'good_accounting', stakeId: '1', address: A, payout: '30', penalty: '5' }],
        62,
      ),
    );
    const state = (await api.query('SELECT * FROM hdd.current_state WHERE chain_id=1')).rows[0];
    assert.equal(state.locked_hearts, '170');
    assert.equal(state.accounted_hearts, '70');
    assert.equal(state.staker_count, '1');
    assert.equal(state.penalty_hearts, '5');
    assert.equal(state.payout_recorded, '30');
    assert.equal(state.circulating_hearts, '1868');
    await reconcile(worker, 1);
  });
  await test('fork inherits ended, cancelled, GA and queued rows without duplicating common events', async () => {
    await writer.commit(await batch(api, [transfer(A, ZERO, 10), start(4, A, 10, 8, 10)], 62));
    const state = (await api.query('SELECT * FROM hdd.current_state WHERE chain_id=1')).rows[0];
    const s = (await api.query('SELECT * FROM hdd.sync_state WHERE chain_id=1')).rows[0];
    const value = {
      checkpoint: header(BigInt(s.block_number) + 1n, 63, BigInt(s.block_number)),
      parent: {
        number: s.block_number,
        hash: '0x' + s.block_hash.toString('hex'),
        parentHash: hash(BigInt(s.block_number) - 1n),
        timestamp: s.block_time,
      },
      contract: CONTRACT,
      codeHash: CODE,
      finality: 'confirmed',
      shareRate: state.raw_share_rate,
      expected: Object.fromEntries(totalColumns.map((k) => [k, state[k]])),
    };
    value.checkpoint.parentHash = value.parent.hash;
    await writer.close();
    worker = await db('worker');
    writer = await CanonicalWriter.acquire(worker, 369);
    const wrong = structuredClone(value);
    wrong.expected.locked_hearts = '0';
    await assert.rejects(() => writer.initialize('fork', sources(wrong)), /aggregate/);
    await writer.initialize('fork', sources(value));
    assert.equal(
      (await api.query('SELECT count(*) FROM hdd.stakes WHERE chain_id=369')).rows[0].count,
      '6',
    );
    assert.equal(
      (await api.query('SELECT count(*) FROM hdd.events WHERE origin_chain_id=369')).rows[0].count,
      '0',
    );
    assert.equal(
      (await api.query('SELECT starts FROM hdd.current_state WHERE chain_id=369')).rows[0].starts,
      '1',
    );
    await reconcile(worker, 369);
    const inherited = (
      await api.query('SELECT * FROM hdd.stakes WHERE chain_id=369 ORDER BY stake_id')
    ).rows;
    assert.deepEqual(
      inherited.map((s) => currentStakeStatus(s, 62)),
      ['good_accounted', 'ended', 'cancelled', 'queued', 'mature_open', 'open'],
    );
    const branch = (await api.query('SELECT * FROM hdd.sync_state WHERE chain_id=369')).rows[0];
    assert.equal(branch.block_number, s.block_number);
    const wrongEntry = await batch(api, [], 63, 369);
    wrongEntry.sources.forEach((source) => (source.headers[0].hash = hash(999999)));
    await assert.rejects(() => writer.commit(wrongEntry), /fork entry/);
    const parentClient = await db('worker'),
      parentWriter = await CanonicalWriter.acquire(parentClient, 1);
    try {
      await assert.rejects(
        () => batch(api, [], 62, 1).then((b) => parentWriter.commit(b)),
        /parent history is frozen/,
      );
      await assert.rejects(
        () =>
          parentWriter.rewind(s.rewind_floor, {
            blockNumber: s.block_number,
            blockHash: '0x' + s.block_hash.toString('hex'),
            revision: s.revision,
          }),
        /parent history is frozen/,
      );
    } finally {
      await parentWriter.close();
    }
  });
  await test('rewind restores exact rows, deleted schedules, accumulators and checkpoint progress; replay equality', async () => {
    const before = await snapshot();
    const beforeSync = (await api.query('SELECT * FROM hdd.sync_state WHERE chain_id=369')).rows[0];
    const cap = await batch(api, [end(4, A, 0, 999, 0)], 63, 369);
    await assert.rejects(
      () =>
        writer.commit(cap, {
          beforeCommit: async () => {
            assert.equal(
              (
                await worker.query(
                  'SELECT penalty_hearts FROM hdd.current_state WHERE chain_id=369',
                )
              ).rows[0].penalty_hearts,
              '10',
            );
            throw new Error('rollback cap witness');
          },
        }),
      /cap witness/,
    );
    assert.deepEqual(await snapshot(), before);
    const b = await batch(
      api,
      [
        end(1, A, 30, 5, 10, true),
        transfer(ZERO, A, 125),
        transfer(ZERO, C, '900719925474099312345678901234567890'),
      ],
      63,
      369,
    );
    await writer.commit(b);
    assert.equal(
      (await api.query('SELECT penalty_hearts FROM hdd.current_state WHERE chain_id=369')).rows[0]
        .penalty_hearts,
      '0',
    );
    const after = await snapshot();
    let s = (await api.query('SELECT * FROM hdd.sync_state WHERE chain_id=369')).rows[0];
    await writer.rewind(beforeSync.block_number, {
      blockNumber: s.block_number,
      blockHash: '0x' + s.block_hash.toString('hex'),
      revision: s.revision,
    });
    assert.deepEqual(await snapshot(), before);
    assert.equal(
      (await api.query('SELECT revision FROM hdd.sync_state WHERE chain_id=369')).rows[0].revision,
      String(BigInt(s.revision) + 1n),
    );
    b.expected.revision = String(BigInt(s.revision) + 1n);
    await writer.commit(b);
    assert.deepEqual(await snapshot(), after);
    await reconcile(worker, 369);
    s = (await api.query('SELECT * FROM hdd.sync_state WHERE chain_id=369')).rows[0];
    await assert.rejects(
      () =>
        writer.rewind('0', {
          blockNumber: s.block_number,
          blockHash: '0x' + s.block_hash.toString('hex'),
          revision: s.revision,
        }),
      /window/,
    );
  });
  await test('real server-side lock connection termination cancels writer; fresh explicit session recovers', async () => {
    const pid = (await worker.query('SELECT pg_backend_pid() AS pid')).rows[0].pid;
    const before = await snapshot();
    const b = await batch(api, [transfer(C, A, 1)], 63, 369);
    await assert.rejects(() =>
      writer.commit(b, {
        beforeCommit: async () => {
          await admin.query('SELECT pg_terminate_backend($1)', [pid]);
        },
      }),
    );
    assert.deepEqual(await snapshot(), before);
    await writer.close().catch(() => {});
    worker = await db('worker');
    writer = await CanonicalWriter.acquire(worker, 369);
    await writer.commit(b);
    await reconcile(worker, 369);
  });
  await test('retention pressure stops without deleting protected input; finalized rewind denied; seed schema mapping', async () => {
    const receipt = (
      await api.query(
        'SELECT revision,undo_bytes FROM hdd.checkpoints_recent WHERE chain_id=369 ORDER BY revision LIMIT 1',
      )
    ).rows[0];
    await admin.query(
      'UPDATE hdd.checkpoints_recent SET undo_bytes=134217729 WHERE chain_id=369 AND revision=$1',
      [receipt.revision],
    );
    const before = await snapshot();
    await assert.rejects(
      () => batch(api, [], 63, 369).then((b) => writer.commit(b)),
      /retention capacity/,
    );
    assert.deepEqual(await snapshot(), before);
    await admin.query(
      'UPDATE hdd.checkpoints_recent SET undo_bytes=$2 WHERE chain_id=369 AND revision=$1',
      [receipt.revision, receipt.undo_bytes],
    );
    await admin.query("UPDATE hdd.sync_state SET finality='finalized' WHERE chain_id=369");
    const s = (await api.query('SELECT * FROM hdd.sync_state WHERE chain_id=369')).rows[0];
    await assert.rejects(
      () =>
        writer.rewind(s.rewind_floor, {
          blockNumber: s.block_number,
          blockHash: '0x' + s.block_hash.toString('hex'),
          revision: s.revision,
        }),
      /Finalized/,
    );
    await admin.query("UPDATE hdd.sync_state SET finality='confirmed' WHERE chain_id=369");
    const schema = JSON.parse(readFileSync('src/contracts/seed.schema.json', 'utf8'));
    const tables = (
      await api.query(
        "SELECT tablename FROM pg_tables WHERE schemaname='hdd' AND tablename<>'schema_migrations' ORDER BY tablename",
      )
    ).rows.map((r) => r.tablename);
    assert.deepEqual([...schema.properties.files.items.properties.table.enum].sort(), tables);
    for (const name of ['revision', 'blockTime', 'rewindFloor'])
      assert.ok(schema.properties.checkpoint.required.includes(name));
    console.log(
      'SQL/manifest table and checkpoint alignment verified; no seed archive/import proof claimed.',
    );
  });
  await writer.close();
  writer = null;
  if (process.env.HDD_V2_SQL_SCALE !== '0')
    await test('million-row SQL/query/size baseline', () => scale({ admin, api, db }));
  console.log(`PASS ${results.length} SQL groups`);
} finally {
  writeFileSync('/evidence/sql-results.json', JSON.stringify(results, null, 2) + '\n');
  await writer?.close().catch(() => {});
  for (const client of clients) await client.end().catch(() => {});
  await admin.end().catch(() => {});
}
