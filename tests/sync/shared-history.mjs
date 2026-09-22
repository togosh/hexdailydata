import assert from 'node:assert/strict';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { createHash, randomUUID } from 'node:crypto';
import { connect, databaseConfig } from '../../dist/db/connect.js';
import { migrateCurrent } from '../../dist/db/migrate.js';
import { runWorker } from '../../dist/worker/main.js';
import { profileSchema, profileSources, profileBinding } from '../../dist/worker/sync/profile.js';
import { CanonicalWriter } from '../../dist/services/projections/writer.js';
import { SyncEngine } from '../../dist/worker/sync/engine.js';
import { digest } from '../../dist/services/projections/input.js';
import { validateSourceCheckpoints } from '../../dist/services/projections/provenance.js';
import { exportSeed, importSeed, fileHash } from '../../dist/worker/bootstrap/seed.js';
import { packArchive, readArchive } from '../../dist/worker/bootstrap/archive.js';
import { tableNames, tables } from '../../dist/worker/bootstrap/manifest.js';
import { ProviderBudget } from '../../dist/providers/budget.js';
import { liveSelectors } from '../../dist/providers/live-abi.js';
import { MetricsService } from '../../dist/worker/metrics/service.js';
import { SqlMetricStore } from '../../dist/worker/metrics/store.js';
import {
  fixture,
  FakeClock,
  memoryCooldown,
  LARGE,
  CONTRACT,
  CODE_HASH,
  hash,
  C,
} from './fixture.mjs';
import { sharedProfile } from './shared-profile.mjs';

globalThis.fetch = () => {
  throw Error('REAL NETWORK FORBIDDEN');
};
const phase = process.env.HDD_V2_SYNC_PHASE,
  signal = new AbortController().signal;
const mode = phase === 'shared-control' ? 'ethereum' : 'pulsechain';
const profile = profileSchema.parse(sharedProfile(mode)),
  f = fixture({ last: 220 });
const root = '/canary-test/shared',
  clock = new FakeClock();
clock.time = Date.now();
const clients = [],
  results = [],
  raw = { http: 0, logical: 0, chain1: 0, chain369: 0, metricsBeyondParent: 0 };
await mkdir(root, { recursive: true });
await mkdir(root + '/quota');
const budget = new ProviderBudget('worker', memoryCooldown(), clock);
async function db(role = 'worker') {
  const c = await connect(databaseConfig(role));
  clients.push(c);
  return c;
}
async function test(name, fn) {
  const at = performance.now();
  try {
    await fn();
    results.push({ name, status: 'PASS', ms: performance.now() - at });
    console.log('PASS', name);
  } catch (e) {
    results.push({ name, status: 'FAIL', error: e.stack });
    throw e;
  }
}
const transports = new Map();
for (const s of [...profile.ethereum, ...profile.pulsechain]) {
  const endpoint = 'https://' + s.endpointEnv.toLowerCase() + '.invalid';
  process.env[s.endpointEnv] = endpoint;
  const network = s.endpointEnv.includes('COMMON') ? 1 : 369;
  const transport = f.source(
    network,
    s.id,
    clock,
    (responses, calls) =>
      responses.map((r, i) => {
        const call = calls[i];
        if (call.method === 'eth_call' && call.params[0].data === liveSelectors.currentDay) {
          const h = [...f.headers.values()].find((h) => h.hash === call.params[1].blockHash);
          return {
            ...r,
            result:
              '0x' + ((BigInt(h.timestamp) - 1575331200n) / 86400n).toString(16).padStart(64, '0'),
          };
        }
        return r;
      }),
    budget,
  ).rpc.transport;
  transports.set(endpoint, async (body, sig) => {
    const requests = JSON.parse(body);
    raw.http++;
    raw.logical += requests.length;
    for (const r of requests) {
      if (r.method === 'eth_chainId') raw[network === 1 ? 'chain1' : 'chain369']++;
      if (r.method === 'eth_call' && r.params[0].data === liveSelectors.currentDay)
        raw.metricsBeyondParent++;
    }
    return transport(body, sig);
  });
}
const transport = (endpoint) => {
  assert.ok(transports.has(endpoint), endpoint);
  return transports.get(endpoint);
};
process.env.HDD_V2_SOURCE_PROFILE = root + '/profile.json';
process.env.HDD_V2_PROVIDER_STATE = root + '/quota';
process.env.HDD_V2_STORAGE_PATH = root;
process.env.HDD_V2_EXPORT_PATH = root + '/exports';
process.env.HDD_V2_ALLOW_LIVE_RPC = 'false';
await writeFile(process.env.HDD_V2_SOURCE_PROFILE, JSON.stringify(profile));
let reader, writer;
const coreTables = [
  'chains',
  'source_history',
  'sync_state',
  'current_state',
  'accounts',
  'stakes',
  'share_schedule',
  'daily_stats',
  'blocks_recent',
  'events',
  'transfers_recent',
  'checkpoints_recent',
  'undo_recent',
];
async function snapshot(normalize = false) {
  const result = {};
  for (const table of coreTables) {
    let expression =
      table === 'checkpoints_recent' ? "to_jsonb(t)-'undo_bytes'-'tail_bytes'" : 'to_jsonb(t)';
    const params = [];
    if (normalize && ['source_history', 'sync_state', 'checkpoints_recent'].includes(table)) {
      // Only the two declared transport identities and their acceptance digests differ.
      // Raw SQL JSON stays text: canonical NUMERIC and before-images never pass through Number.
      const direct = profileSchema.parse(sharedProfile('ethereum'));
      const a = profileBinding(direct, 1),
        b = profileBinding(direct, 369);
      if (table === 'source_history') {
        params.push(JSON.stringify(a), JSON.stringify(b));
        expression = `jsonb_set(${expression},'{sources,binding}',CASE WHEN chain_id=1 THEN $1::jsonb ELSE $2::jsonb END)`;
        expression = `CASE WHEN chain_id=1 THEN jsonb_set(jsonb_set(${expression},'{sources,providers,0,endpointAlias}','"HDD_V2_PROVIDER_COMMON_1"'),'{sources,providers,1,endpointAlias}','"HDD_V2_PROVIDER_COMMON_2"') ELSE ${expression} END`;
      } else {
        params.push(digest(a), digest(b));
        const path =
          table === 'sync_state'
            ? 'acceptance,bindingDigest'
            : 'previous_sync,acceptance,bindingDigest';
        expression = `jsonb_set(${expression},'{${path}}',to_jsonb(CASE WHEN chain_id=1 THEN $1::text ELSE $2::text END))`;
      }
    }
    result[table] = (
      await reader.query(
        `SELECT (${expression})::text AS row FROM hdd.${table} t ORDER BY ${tables[table].join(',')}`,
        params,
      )
    ).rows.map((r) => r.row);
  }
  return result;
}
async function expectedState() {
  const parent = (await reader.query('SELECT * FROM hdd.current_state WHERE chain_id=1')).rows[0];
  assert.equal(parent.locked_hearts, '1100');
  assert.equal(parent.accounted_hearts, '1000');
  // Stake6 starts on day9 and activates on parent day10; stake7 starts on day10.
  assert.equal(parent.active_shares, '300');
  assert.equal(parent.queued_shares, '200');
  assert.equal(
    (await reader.query('SELECT lifecycle FROM hdd.stakes WHERE chain_id=1 AND stake_id=1')).rows[0]
      .lifecycle,
    'good_accounted',
  );
  const {
    rows: [s],
  } = await reader.query('SELECT * FROM hdd.current_state WHERE chain_id=369');
  assert.equal(s.circulating_hearts, (LARGE + 10000n + 30n - 1000n).toString());
  assert.equal(s.locked_hearts, '1000');
  assert.equal(s.accounted_hearts, '1000');
  assert.equal(s.active_shares, '500');
  assert.equal(s.queued_shares, '0');
  assert.equal(
    (
      await reader.query(
        'SELECT liquid_hearts FROM hdd.accounts WHERE chain_id=369 AND address=$1',
        [Buffer.from(C.slice(2), 'hex')],
      )
    ).rows[0].liquid_hearts,
    '11',
  );
  assert.equal(
    (
      await reader.query(
        'SELECT count(*) FROM hdd.events WHERE origin_chain_id=369 AND block_number<=180',
      )
    ).rows[0].count,
    '0',
  );
  assert.equal(
    (await reader.query('SELECT block_number FROM hdd.sync_state WHERE chain_id=1')).rows[0]
      .block_number,
    '180',
  );
  assert.deepEqual(
    (
      await reader.query(
        'SELECT stake_id,lifecycle FROM hdd.stakes WHERE chain_id=369 ORDER BY stake_id',
      )
    ).rows,
    [
      { stake_id: '1', lifecycle: 'ended' },
      { stake_id: '2', lifecycle: 'unsettled' },
      { stake_id: '3', lifecycle: 'cancelled' },
      { stake_id: '4', lifecycle: 'ended' },
      { stake_id: '6', lifecycle: 'unsettled' },
      { stake_id: '7', lifecycle: 'unsettled' },
      { stake_id: '8', lifecycle: 'unsettled' },
    ],
  );
  assert.equal(
    (
      await reader.query(
        "SELECT count(*) FROM hdd.daily_stats WHERE chain_id=369 AND payout_status='pending'",
      )
    ).rows[0].count,
    '2',
  );
}
async function engine(p = profile, hooks = {}, mutate) {
  const pair = profileSources(
    p,
    369,
    (s) =>
      mutate
        ? f.source(369, s.id, clock, mutate, budget).rpc.transport
        : transport(process.env[s.endpointEnv]),
    budget,
  );
  return new SyncEngine(writer, reader, pair, root, hooks);
}
async function corruptSeed(edit) {
  const members = [];
  await readArchive(
    '/evidence/shared.seed.tar.gz',
    ['seed.json', ...tableNames.map((t) => `tables/${t}.ndjson`)],
    async (name, size, chunks) => {
      const parts = [];
      for await (const b of chunks) parts.push(b);
      members.push({ name, data: Buffer.concat(parts) });
    },
    signal,
  );
  const manifest = JSON.parse(members[0].data.toString());
  const member = members.find((m) => m.name === 'tables/source_history.ndjson');
  const rows = member.data.toString().trim().split('\n').map(JSON.parse);
  edit(rows);
  member.data = Buffer.from(rows.map(JSON.stringify).join('\n') + '\n');
  const entry = manifest.files.find((f) => f.table === 'source_history');
  entry.bytes = String(member.data.length);
  entry.sha256 = createHash('sha256').update(member.data).digest('hex');
  members[0].data = Buffer.from(JSON.stringify(manifest));
  const path = root + '/tampered-' + randomUUID() + '.tar.gz';
  await packArchive(
    path,
    members.map((m) => ({ ...m, size: m.data.length })),
    signal,
  );
  return path;
}
async function checkRetainedIdentity(chain, number) {
  await validateSourceCheckpoints(reader);
  for (const [field, value, error] of [
    ['block_hash', '\\x' + hash(999).slice(2), /Source binding checkpoint mismatch/],
    [
      'block_time',
      (BigInt(f.plain(number).timestamp) + 1n).toString(),
      /Source binding checkpoint mismatch/,
    ],
    ['block_hash', 'invalid', /Malformed retained source checkpoint/],
    ['block_time', null, /Invalid input/],
  ]) {
    await reader.query('BEGIN');
    try {
      const changed = await reader.query(
        `UPDATE hdd.checkpoints_recent SET previous_sync=jsonb_set(previous_sync,ARRAY[$3::text],$4::jsonb)
        WHERE chain_id=$1 AND previous_sync->>'block_number'=$2`,
        [chain, String(number), field, JSON.stringify(value)],
      );
      assert.equal(changed.rowCount, 1, `retained ${chain}:${number}`);
      await assert.rejects(validateSourceCheckpoints(reader), error);
    } finally {
      await reader.query('ROLLBACK');
    }
    await validateSourceCheckpoints(reader);
  }
}
try {
  await migrateCurrent(await db('migrator'));
  reader = await db();
  if (phase === 'shared-import') {
    const expected = {
      instance: process.env.HDD_V2_DB_INSTANCE,
      contract: CONTRACT,
      codeHash: CODE_HASH,
      checkpointHash: hash(188),
    };
    await test('tampered/missing/unsupported transport or fork provenance rejected atomically with valid archive hashes', async () => {
      for (const edit of [
        (r) => delete r[0].sources.binding,
        (r) => (r[0].sources.binding.version = 2),
        (r) => (r[0].sources.binding.originChainId = 369),
        (r) => {
          r[0].sources.binding.networkChainId = 1;
          r[0].sources.binding.common.transportChainId = 1;
        },
        (r) => (r[0].sources.binding.common.parent.hash = hash(999)),
        (r) => {
          r[0].sources.binding.common.parent.number = '181';
          r[0].sources.binding.common.entry.number = '182';
        },
      ]) {
        const path = await corruptSeed(edit);
        await assert.rejects(
          importSeed(reader, path, { ...expected, sha256: await fileHash(path, signal) }, signal),
        );
        assert.equal((await reader.query('SELECT count(*) FROM hdd.chains')).rows[0].count, '0');
      }
    });
    await test('real seed stream into fresh destination audits retained inherited-parent checkpoints', async () => {
      const receipt = await importSeed(
        reader,
        '/evidence/shared.seed.tar.gz',
        { ...expected, sha256: await fileHash('/evidence/shared.seed.tar.gz', signal) },
        signal,
      );
      assert.ok(receipt.recoveryCheckpoints > 2);
      results.push({ import: receipt });
      assert.deepEqual(
        await snapshot(),
        JSON.parse(await readFile('/evidence/shared-at188.json', 'utf8')),
      );
    });
  } else {
    await test('compiled constructor and first commit retain a valid cursor; restore rejects its hash/time contradictions', async () => {
      const commonWriter = await CanonicalWriter.acquire(await db(), 1);
      try {
        const sources = profileSources(
          profile,
          1,
          (s) => transport(process.env[s.endpointEnv]),
          budget,
        );
        const common = new SyncEngine(commonWriter, reader, sources, root);
        await common.initializeConstructor(
          profile.constructor.checkpoint,
          profile.constructor.transactionHash,
          profile.constructor.balances,
          signal,
        );
        await common.once(signal, f.plain(101));
        await checkRetainedIdentity(1, 100);
      } finally {
        await commonWriter.close();
      }
    });
    await test('compiled worker resumes constructor through common/fork/native rebuild with injected honest networks', async () => {
      assert.equal(await runWorker(['rebuild'], { transport, clock }), undefined);
      await expectedState();
      if (mode === 'pulsechain') {
        assert.equal(raw.chain1, 0);
        assert.ok(raw.chain369 >= 4);
      }
      const history = (
        await reader.query('SELECT chain_id,sources FROM hdd.source_history ORDER BY chain_id')
      ).rows;
      for (const row of history)
        assert.deepEqual(row.sources.binding, profileBinding(profile, row.chain_id));
      await validateSourceCheckpoints(reader);
    });
    await test('common control equality includes exact SQL and finite acquisition provenance differences', async () => {
      const state = await snapshot(true);
      if (mode === 'ethereum')
        await writeFile('/evidence/control-at188.json', JSON.stringify(state));
      else {
        assert.deepEqual(state, JSON.parse(await readFile('/evidence/control-at188.json', 'utf8')));
        await writeFile('/evidence/shared-at188.json', JSON.stringify(await snapshot()));
        const receipt = await exportSeed(reader, '/evidence/shared.seed.tar.gz', signal);
        results.push({ seed: receipt });
      }
    });
  }
  f.setHead(197);
  await test('new compiled worker once resumes to196 preserving exact accepted source binding', async () => {
    assert.equal(await runWorker(['once'], { transport, clock }), undefined);
    await expectedState();
    const state = await snapshot(true);
    if (mode === 'ethereum') await writeFile('/evidence/control-at196.json', JSON.stringify(state));
    else
      assert.deepEqual(state, JSON.parse(await readFile('/evidence/control-at196.json', 'utf8')));
  });
  if (phase === 'shared-build') {
    await test('current native metric client reads beyond common parent on honest369', async () => {
      const sources = profileSources(
        profile,
        369,
        (s) => transport(process.env[s.endpointEnv]),
        budget,
      );
      const metrics = new MetricsService(
        sources.map((s) => s.rpc),
        CODE_HASH,
        null,
        new SqlMetricStore(reader),
      );
      await metrics.tick(signal);
      assert.ok(raw.metricsBeyondParent > 0);
      const stored = await new SqlMetricStore(reader).read(369);
      assert.equal(stored.shareRate.asOf.chainId, 369);
      assert.equal(stored.shareRate.asOf.blockNumber, '197');
    });
    writer = await CanonicalWriter.acquire(await db(), 369);
    await test('resume refuses changed transport, parent number/hash and code before canonical mutation', async () => {
      const before = await snapshot();
      for (const edit of [
        (p) => (p.commonHistory = 'ethereum'),
        (p) => {
          p.fork.parent.hash = hash(999);
          p.fork.entry.parentHash = hash(999);
        },
        (p) => {
          p.fork.parent.number = '179';
          p.fork.entry.number = '180';
        },
        (p) => (p.codeHash = hash(888)),
      ]) {
        const p = structuredClone(profile);
        edit(p);
        await assert.rejects((await engine(profileSchema.parse(p))).once(signal), /binding/);
        assert.deepEqual(await snapshot(), before);
      }
    });
    await writer.close();
    writer = undefined;
    await test('compiled repair-range verifies provenance then restores inherited parent; common parent remains frozen', async () => {
      assert.equal(await runWorker(['repair-range', '180'], { transport, clock }), undefined);
      assert.equal(
        (await reader.query('SELECT block_number FROM hdd.sync_state WHERE chain_id=369')).rows[0]
          .block_number,
        '180',
      );
      const commonWriter = await CanonicalWriter.acquire(await db(), 1);
      try {
        const s = (await reader.query('SELECT * FROM hdd.sync_state WHERE chain_id=1')).rows[0];
        const expected = {
          blockNumber: s.block_number,
          blockHash: hash(180),
          revision: s.revision,
        };
        // An otherwise valid raw-decoded direct batch cannot bypass the persisted fence.
        const outside = [];
        for (const id of ['outside-a', 'outside-b'])
          outside.push(
            await f
              .source(1, id, clock, undefined, budget)
              .acquire(expected, '181', [], null, signal),
          );
        await assert.rejects(
          commonWriter.commit({
            chainId: 1,
            contract: CONTRACT,
            expected,
            range: { fromBlock: '181', toBlock: '181' },
            sources: outside,
          }),
          /outside source binding/,
        );
        await assert.rejects(
          commonWriter.rewind('179', {
            blockNumber: s.block_number,
            blockHash: hash(180),
            revision: s.revision,
          }),
          /frozen/,
        );
      } finally {
        await commonWriter.close();
      }
    });
    writer = await CanonicalWriter.acquire(await db(), 369);
    await test('first-native disagreement, cancellation and precommit failure preserve inherited cursor; lost ack recovers once', async () => {
      const before = await snapshot();
      const disagree = profileSources(
        profile,
        369,
        (s) =>
          f.source(
            369,
            s.id,
            clock,
            (rows, calls) =>
              rows.map((r, i) =>
                s.id.endsWith('2') && calls[i].method === 'eth_getLogs' ? { ...r, result: [] } : r,
              ),
            budget,
          ).rpc.transport,
        budget,
      );
      await assert.rejects(
        new SyncEngine(writer, reader, disagree, root).once(signal, f.plain(181)),
        /disagreement|Incomplete/,
      );
      const cancelled = new AbortController();
      cancelled.abort(Error('synthetic cancellation'));
      await assert.rejects((await engine()).once(cancelled.signal, f.plain(181)), /cancellation/);
      await assert.rejects(
        (
          await engine(profile, {
            beforeCommit: async () => {
              throw Error('precommit');
            },
          })
        ).once(signal, f.plain(181)),
        /precommit/,
      );
      assert.deepEqual(await snapshot(), before);
      await assert.rejects(
        (
          await engine(profile, {
            afterCommit: async () => {
              throw Error('lost ack');
            },
          })
        ).once(signal, f.plain(181)),
        /lost ack/,
      );
      assert.equal(
        (await reader.query('SELECT block_number FROM hdd.sync_state WHERE chain_id=369')).rows[0]
          .block_number,
        '181',
      );
      const resumed = await engine();
      await resumed.once(signal, f.plain(188));
      await resumed.once(signal, f.plain(196));
      await resumed.audit(signal);
      await expectedState();
      assert.equal(
        (
          await reader.query(
            'SELECT count(*) FROM hdd.events WHERE origin_chain_id=369 AND block_number=181',
          )
        ).rows[0].count,
        '1',
      );
    });
    await test('actual restore binding validator accepts valid metadata and rejects changed retained checkpoint digest', async () => {
      await validateSourceCheckpoints(reader);
      await reader.query('BEGIN');
      try {
        await reader.query(
          `UPDATE hdd.checkpoints_recent SET previous_sync=jsonb_set(previous_sync,'{acceptance,bindingDigest}','"tampered"') WHERE chain_id=369`,
        );
        await assert.rejects(validateSourceCheckpoints(reader), /Retained source binding/);
      } finally {
        await reader.query('ROLLBACK');
      }
      await validateSourceCheckpoints(reader);
    });
    await test('restore checks retained inherited parent and entry hashes/times plus malformed identities', async () => {
      await checkRetainedIdentity(369, 180);
      await checkRetainedIdentity(369, 181);
    });
    await writer.close();
    writer = undefined;
    await test('compiled worker and explicit stop reject contradictory finalized identity without mutation; coherent finalized forward passes', async () => {
      // This disposable DB now tests the finalized policy, as in recoveryCases.
      const finalized = profileSchema.parse({ ...profile, policy: { mode: 'finalized' } });
      await reader.query("UPDATE hdd.sync_state SET finality='finalized' WHERE chain_id=369");
      await reader.query(
        `UPDATE hdd.source_history SET finality_policy='{"mode":"finalized"}' WHERE chain_id=369`,
      );
      await writeFile(process.env.HDD_V2_SOURCE_PROFILE, JSON.stringify(finalized));
      const before = await snapshot();
      const disagree = (rows, calls) =>
        rows.map((r, i) =>
          calls[i].method === 'eth_getBlockByNumber' && calls[i].params[0] === 'finalized'
            ? { ...r, result: { ...r.result, hash: hash(999) } }
            : r,
        );
      const badTransports = new Map(
        finalized.pulsechain.map((s) => [
          process.env[s.endpointEnv],
          f.source(369, s.id, clock, disagree, budget).rpc.transport,
        ]),
      );
      const refused = await runWorker(['once'], {
        clock,
        transport: (endpoint) => {
          assert.ok(badTransports.has(endpoint));
          return badTransports.get(endpoint);
        },
      });
      assert.ok(refused instanceof Error);
      assert.match(refused.message, /Finality target identity disagreement/);
      assert.equal(process.exitCode, 1);
      process.exitCode = 0; // The compiled CLI failure above was the expected witness.
      assert.deepEqual(await snapshot(), before);
      writer = await CanonicalWriter.acquire(await db(), 369);
      await assert.rejects(
        (await engine(finalized, {}, disagree)).once(signal, f.plain(197)),
        /Finality target identity disagreement/,
      );
      assert.deepEqual(await snapshot(), before);
      await writer.close();
      writer = undefined;
      assert.equal(await runWorker(['once'], { transport, clock }), undefined);
      const current = (
        await reader.query(
          'SELECT block_number,block_hash,finality FROM hdd.sync_state WHERE chain_id=369',
        )
      ).rows[0];
      assert.equal(current.block_number, '197');
      assert.equal('0x' + current.block_hash.toString('hex'), hash(197));
      assert.equal(current.finality, 'finalized');
    });
  }
  console.log(
    JSON.stringify({
      phase,
      raw,
      mode,
      note: 'FAKE RPC; actual isolated SQL. No live qualification.',
    }),
  );
} finally {
  await writer?.close();
  for (const c of clients) await c.end().catch(() => {});
  await writeFile(
    `/evidence/${phase}-results.json`,
    JSON.stringify({ results, raw, phase }, null, 2),
  );
}
