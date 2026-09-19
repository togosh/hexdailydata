import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { connect, databaseConfig } from '../../src/db/connect.ts';
import { migrateCurrent } from '../../src/db/migrate.ts';
import { CanonicalWriter } from '../../src/services/projections/writer.ts';
import { SyncEngine } from '../../src/worker/sync/engine.ts';
import { exportSeed, importSeed, fileHash } from '../../src/worker/bootstrap/seed.ts';
import { tables } from '../../src/worker/bootstrap/manifest.ts';
import { validateBatch } from '../../src/services/projections/input.ts';
import { sparseFixture } from './sparse-fixture.mjs';
import { fixture, CONTRACT, CODE_HASH, hash, LARGE } from './fixture.mjs';

const signal = new AbortController().signal,
  phase = process.env.HDD_V2_SYNC_PHASE;
const clients = [],
  results = [],
  started = performance.now();
let writer;
async function db(role) {
  const c = await connect(databaseConfig(role));
  clients.push(c);
  return c;
}
async function test(name, fn) {
  const t = performance.now();
  try {
    await fn();
    results.push({ name, status: 'PASS', ms: performance.now() - t });
    console.log('PASS', name);
  } catch (e) {
    results.push({ name, status: 'FAIL', error: e.message });
    throw e;
  }
}
try {
  await migrateCurrent(await db('migrator'));
  const api = await db('api'),
    worker = await db('worker');
  const f = sparseFixture({ spacing: 8192 });
  const sources = [f.source('one'), f.source('two')];
  const seed = '/evidence/sparse.seed.tar.gz';
  async function snapshot() {
    const result = {};
    for (const [table, keys] of Object.entries(tables)) {
      const expression =
        table === 'checkpoints_recent' ? "to_jsonb(t)-'undo_bytes'-'tail_bytes'" : 'to_jsonb(t)';
      const { rows } = await api.query(
        `SELECT ${expression}::text AS row FROM hdd.${table} t ORDER BY ${keys.join(',')}`,
      );
      result[table] = createHash('sha256')
        .update(rows.map((r) => r.row).join('\n'))
        .digest('hex');
    }
    return result;
  }
  if (phase === 'sparse-import') {
    await test('separate empty destination imports sparse seed and audits every retained rewind', async () => {
      const r = await importSeed(
        worker,
        seed,
        {
          instance: databaseConfig('worker').instance,
          sha256: await fileHash(seed, signal),
          contract: CONTRACT,
          codeHash: CODE_HASH,
          checkpointHash: f.plain(f.number(132)).hash,
        },
        signal,
      );
      assert.ok(r.recoveryCheckpoints > 4);
      console.log('SPARSE_IMPORT', r);
    });
  }
  writer = await CanonicalWriter.acquire(worker, 1);
  let sync = new SyncEngine(writer, api, sources, '/evidence');
  if (phase === 'busy') {
    const busy = fixture({ last: 205, holdersPerBlock: 300 });
    sync = new SyncEngine(writer, api, [busy.source(1, 'one'), busy.source(1, 'two')], '/evidence');
    await test('busy relevant events split bounded ranges and commit exact final state', async () => {
      await sync.initializeConstructor(busy.plain(100), hash(10000), [], signal);
      await sync.once(signal, busy.plain(204));
      await sync.audit(signal);
      assert.ok(sync.progress.splits > 0);
      assert.ok(sync.sources.every((s) => s.counters.eventsPeak <= 2000));
      assert.equal(
        (await api.query('SELECT count(*) FROM hdd.accounts')).rows[0].count,
        String(3 + 23 * 300),
      );
    });
  } else if (phase === 'sparse-build') {
    await sync.initializeConstructor(f.plain(100), hash(10000), [], signal);
    await test('raw omitted self-transfer, malformed sets, identities and floating boundaries leave all SQL/undo unchanged', async () => {
      const before = await snapshot(),
        expected = { blockNumber: '100', blockHash: hash(100), revision: '0' };
      for (const mode of [
        'omit',
        'missing',
        'removed',
        'order',
        'duplicate',
        'tx-index',
        'tx-hash',
        'header',
        'floating',
      ]) {
        let boundaryReads = 0;
        const bad = f.source('bad-' + mode, (rows, calls) =>
          rows.map((row, i) => {
            const copy = structuredClone(row);
            if (calls[i].method === 'eth_getLogs') {
              if (mode === 'missing') delete copy.result;
              if (mode === 'omit')
                copy.result = copy.result.filter(
                  (e) => BigInt(e.blockNumber) !== BigInt(f.number(107)),
                );
              if (mode === 'removed') copy.result.forEach((e) => (e.removed = true));
              if (mode === 'order') copy.result.reverse();
              if (mode === 'duplicate')
                copy.result.splice(1, 0, { ...copy.result[0], data: '0x' + '0'.repeat(64) });
              if (mode === 'tx-index') copy.result[1].transactionIndex = '0x1';
              if (mode === 'tx-hash') copy.result[1].transactionHash = hash(999999);
              if (mode === 'header') copy.result[0].blockHash = hash(999999);
            }
            if (
              mode === 'floating' &&
              calls[i].method === 'eth_getBlockByNumber' &&
              BigInt(calls[i].params[0]) === 100n &&
              ++boundaryReads > 1
            )
              copy.result.hash = hash(999999);
            return copy;
          }),
        );
        await assert.rejects(async () => {
          const a = await f
            .source('good-' + mode)
            .acquire(expected, String(f.number(108)), [], null, signal);
          const b = await bad.acquire(expected, String(f.number(108)), [], null, signal);
          await writer.commit({
            chainId: 1,
            contract: CONTRACT,
            expected,
            range: { fromBlock: '101', toBlock: a.headers.at(-1).number },
            sources: [a, b],
          });
        });
        assert.deepEqual(await snapshot(), before);
      }
      // A shared, supply-preserving omission is outside the selected policy's proof.
      const omit = (rows, calls) =>
        rows.map((r, i) =>
          calls[i].method === 'eth_getLogs'
            ? {
                ...r,
                result: r.result.filter((e) => BigInt(e.blockNumber) !== BigInt(f.number(107))),
              }
            : r,
        );
      const pair = [];
      for (const id of ['unknown-one', 'unknown-two'])
        pair.push(
          await f.source(id, omit, null).acquire(expected, String(f.number(108)), [], null, signal),
        );
      const accepted = validateBatch({
        chainId: 1,
        contract: CONTRACT,
        expected,
        range: { fromBlock: '101', toBlock: pair[0].headers.at(-1).number },
        sources: pair,
      });
      assert.equal(accepted.events.length, 14);
      assert.deepEqual(await snapshot(), before);
    });
    await test('sparse raw history closes exact UTC boundaries, empty days, activations, maturities and delayed payouts', async () => {
      await sync.once(signal, f.plain(f.number(132)));
      await sync.audit(signal);
      const { rows } = await api.query(
        'SELECT contract_day,close_block,payout_status FROM hdd.daily_stats ORDER BY contract_day',
      );
      assert.deepEqual(
        rows.map((r) => r.close_block),
        [108, 116, 124, 132].map((n) => String(f.number(n) - 1)),
      );
      assert.deepEqual(
        rows.map((r) => r.payout_status),
        ['materialized', 'materialized', 'pending', 'pending'],
      );
      const current = (await api.query('SELECT * FROM hdd.current_state')).rows[0];
      assert.equal(current.active_shares, '150');
      assert.equal(current.queued_shares, '0');
      assert.equal(current.circulating_hearts, (LARGE + 10000n + 20n - 400n).toString());
      assert.ok(
        Number((await api.query('SELECT count(*) FROM hdd.blocks_recent')).rows[0].count) < 100,
      );
      assert.ok(sync.progress.headers < 100);
      assert.ok(f.generatedHeaders() < 1000);
      await exportSeed(await db('worker'), seed, signal);
    });
  }
  if (phase !== 'busy') {
    await test('sparse forward sync equality including exact current, daily and nested recovery values', async () => {
      await sync.once(signal, f.plain(f.number(135)));
      await sync.audit(signal);
      const actual = await snapshot();
      if (phase === 'sparse-build')
        writeFileSync('/evidence/sparse-expected.json', JSON.stringify(actual));
      else
        assert.deepEqual(
          actual,
          JSON.parse(readFileSync('/evidence/sparse-expected.json', 'utf8')),
        );
    });
    if (phase === 'sparse-import')
      await test('sparse checkpoint rewind and raw replay preserve exact domain results', async () => {
        const before = (await api.query('SELECT to_jsonb(t)::text AS row FROM hdd.current_state t'))
          .rows;
        const s = await sync.cursor(),
          target = String(f.number(124) - 1);
        await writer.rewind(target, {
          blockNumber: s.block_number,
          blockHash: '0x' + s.block_hash.toString('hex'),
          revision: s.revision,
        });
        await sync.once(signal, f.plain(f.number(135)));
        await sync.audit(signal);
        assert.deepEqual(
          (await api.query('SELECT to_jsonb(t)::text AS row FROM hdd.current_state t')).rows,
          before,
        );
      });
  }
  const report = {
    phase,
    realElapsedMs: performance.now() - started,
    progress: sync.progress,
    virtualQuotaMs: f.clock.now(),
    generatedHeaders: f.generatedHeaders(),
    sources: (phase === 'busy' ? sync.sources : f.observed).map((s) => ({
      id: s.rpc.id,
      rpc: s.rpc.counters,
      acquisition: s.counters,
    })),
    memory: process.memoryUsage(),
    runnerCgroupPeakBytes: readFileSync('/sys/fs/cgroup/memory.peak', 'utf8').trim(),
    storage: (
      await api.query(
        "SELECT pg_database_size(current_database())::text AS database_bytes,pg_total_relation_size('hdd.undo_recent')::text AS undo_bytes,(SELECT wal_bytes::text FROM pg_stat_wal) AS wal_bytes",
      )
    ).rows[0],
  };
  writeFileSync(`/evidence/${phase}-measurements.json`, JSON.stringify(report, null, 2));
  console.log('ACQUISITION_SQL', JSON.stringify(report));
} finally {
  writeFileSync(`/evidence/${phase}-results.json`, JSON.stringify(results, null, 2));
  await writer?.close();
  for (const client of clients) await client.end();
}
