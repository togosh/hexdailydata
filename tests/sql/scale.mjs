import assert from 'node:assert/strict';
import { performance } from 'node:perf_hooks';
import { readFileSync, writeFileSync, statfsSync } from 'node:fs';
import { CanonicalWriter } from '../../src/services/projections/writer.ts';
import { reconcile } from '../../src/services/projections/initialize.ts';
import { batch, transfer, start, CONTRACT, hash } from './fixtures.mjs';

export async function scale({ admin, api, db }) {
  const worker = await db('worker');
  await worker.query('SET statement_timeout=120000');
  const result = {
    shape:
      '1,000,000 stakes; 500,000 accounts; fixed numeric/modulo generation; 1% of stakes concentrated at address 1',
    limits: { dbCpu: 1.5, dbGiB: 3, runnerCpu: 0.5, runnerGiB: 1, combinedCpu: 2, combinedGiB: 4 },
    phases: [],
    queries: {},
    storage: [],
    cycles: [],
  };
  const sample = async (label) => {
    await admin.query('CREATE TEMP TABLE IF NOT EXISTS disk_probe(line text)');
    await admin.query('TRUNCATE disk_probe');
    await admin.query("COPY disk_probe FROM PROGRAM 'df -Pk /var/lib/postgresql/data'");
    const diskLines = (await admin.query('SELECT line FROM disk_probe')).rows.map((r) => r.line);
    const diskFields = diskLines.at(-1).trim().split(/\s+/);
    const dbAvailable = BigInt(diskFields[3]) * 1024n,
      dbTotal = BigInt(diskFields[1]) * 1024n;
    assert.ok(
      dbAvailable > 8n * 1024n ** 3n && dbAvailable * 5n > dbTotal,
      'DB volume 20%/8 GiB reserve',
    );
    const dbCgroup = (
      await admin.query(
        "SELECT pg_read_file('/sys/fs/cgroup/memory.current') AS memory_current,pg_read_file('/sys/fs/cgroup/memory.peak') AS memory_peak,pg_read_file('/sys/fs/cgroup/cpu.max') AS cpu_max,pg_read_file('/sys/fs/cgroup/memory.max') AS memory_max",
      )
    ).rows[0];
    await admin.query('SELECT pg_stat_clear_snapshot()');
    const { rows: relations } =
      await admin.query(`SELECT c.relname,pg_relation_size(c.oid)::text AS heap_bytes,
   pg_indexes_size(c.oid)::text AS index_bytes,CASE WHEN c.reltoastrelid=0 THEN '0' ELSE pg_total_relation_size(c.reltoastrelid)::text END AS toast_bytes,
   pg_total_relation_size(c.oid)::text AS total_bytes FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='hdd' AND c.relkind='r' ORDER BY c.relname`);
    const {
      rows: [stats],
    } = await admin.query(`SELECT pg_database_size(current_database())::text AS database_bytes,
   pg_current_wal_lsn()::text AS wal_lsn,temp_files::text,temp_bytes::text FROM pg_stat_database WHERE datname=current_database()`);
    const {
      rows: [wal],
    } = await admin.query('SELECT sum(size)::text AS allocated_wal_bytes FROM pg_ls_waldir()');
    const disk = statfsSync('/app', { bigint: true });
    assert.ok(
      disk.bavail * disk.bsize > 8n * 1024n ** 3n && disk.bavail * 5n > disk.blocks,
      '20%/8 GiB reserve',
    );
    const memory = {
      current: readFileSync('/sys/fs/cgroup/memory.current', 'utf8').trim(),
      peak: readFileSync('/sys/fs/cgroup/memory.peak', 'utf8').trim(),
      rss: process.memoryUsage().rss,
    };
    result.storage.push({
      label,
      time: new Date().toISOString(),
      relations,
      ...stats,
      ...wal,
      runnerMemory: memory,
      dbCgroup,
      dbFilesystem: { totalBytes: String(dbTotal), availableBytes: String(dbAvailable) },
      filesystem: {
        totalBytes: String(disk.blocks * disk.bsize),
        availableBytes: String(disk.bavail * disk.bsize),
      },
    });
  };
  async function phase(name, fn) {
    const t = performance.now();
    await fn();
    result.phases.push({ name, ms: performance.now() - t });
  }
  await sample('before fixture');
  // Direct SQL fixture construction is test data, NOT an accepted acquisition or seed import.
  await phase('replace small fixture with deterministic scale state', async () => {
    await admin.query(
      `TRUNCATE hdd.undo_recent,hdd.checkpoints_recent,hdd.blocks_recent,hdd.events,hdd.transfers_recent,hdd.daily_stats,hdd.share_schedule,hdd.stakes,hdd.accounts,hdd.current_state,hdd.sync_state,hdd.chains RESTART IDENTITY`,
    );
    await worker.query(
      `INSERT INTO hdd.chains(chain_id,contract_address,code_hash,initialization,origin_chain_id) VALUES(1,decode($1,'hex'),decode(repeat('cd',32),'hex'),'constructor',1)`,
      [CONTRACT.slice(2)],
    );
    await worker.query(
      `INSERT INTO hdd.sync_state VALUES(1,100,decode($1,'hex'),1576195210,0,'confirmed',100,'{"fixture":"scale-direct-SQL"}',NULL)`,
      [hash(100).slice(2)],
    );
    await worker.query(
      `INSERT INTO hdd.blocks_recent VALUES(1,100,decode($1,'hex'),decode($2,'hex'),1576195210)`,
      [hash(100).slice(2), hash(99).slice(2)],
    );
    await worker.query(
      `INSERT INTO hdd.accounts SELECT 1,decode(lpad(to_hex(i),40,'0'),'hex'),(100000000000000::numeric+i*100000003::numeric),0,0,100,100 FROM generate_series(1,500000) i`,
    );
    await worker.query(`INSERT INTO hdd.stakes(chain_id,stake_id,address,origin_chain_id,start_block,start_log,start_day,locked_day,staked_days,principal_hearts,stake_shares,is_auto_stake,lifecycle,last_block)
    SELECT 1,i,decode(lpad(to_hex(CASE WHEN i%100=0 THEN 1 ELSE (i-1)%500000+1 END),40,'0'),'hex'),1,90,0,9,10,1+i%5555,
      100000000000::numeric+(i%10000)*100000000::numeric,
      1000000000000::numeric+(i%10000)*300000007::numeric,false,'unsettled',100 FROM generate_series(1,1000000) i`);
    await worker.query(`UPDATE hdd.accounts a SET accounted_hearts=s.principal,stake_count=s.count FROM
    (SELECT address,sum(principal_hearts) AS principal,count(*) AS count FROM hdd.stakes WHERE chain_id=1 GROUP BY address) s WHERE a.chain_id=1 AND a.address=s.address`);
    await worker.query(`INSERT INTO hdd.current_state SELECT 1,10,
    (SELECT sum(liquid_hearts) FROM hdd.accounts),sum(principal_hearts),sum(principal_hearts),sum(principal_hearts*staked_days),sum(stake_shares),0,
    500000,(SELECT count(*) FROM hdd.accounts WHERE stake_count>0),100000,0,0,0,0 FROM hdd.stakes`);
    // 100k compact historical normalized records, separate from the recent replay tail.
    await worker.query(
      `INSERT INTO hdd.events SELECT 1,90,i,decode($1,'hex'),decode(lpad(to_hex(i),64,'0'),'hex'),i,1576108810,'stake_start',i,
    ARRAY[decode(repeat('aa',32),'hex')],decode(repeat('01',64),'hex'),jsonb_build_object('fixture','scale-history','stakeId',i::text) FROM generate_series(1,100000) i`,
      [hash(90).slice(2)],
    );
  });
  await phase('analyze fixture', () => admin.query('ANALYZE'));
  await phase('full SQL aggregate/owner/schedule audit', () => reconcile(worker, 1));
  await sample('loaded/analyzed');
  const {
    rows: [counts],
  } = await api.query(
    'SELECT (SELECT count(*) FROM hdd.stakes)::text AS stakes,(SELECT count(*) FROM hdd.accounts)::text AS accounts,(SELECT count(*) FROM hdd.events)::text AS events',
  );
  assert.deepEqual(counts, { stakes: '1000000', accounts: '500000', events: '100000' });
  result.counts = counts;
  const queries = {
    address: {
      sql: 'SELECT liquid_hearts,accounted_hearts,stake_count FROM hdd.accounts WHERE chain_id=1 AND address=$1',
      params: [Buffer.from('1'.padStart(40, '0'), 'hex')],
    },
    ownerPage: {
      sql: 'SELECT stake_id,principal_hearts,stake_shares FROM hdd.stakes WHERE chain_id=1 AND address=$1 AND stake_id>$2 ORDER BY stake_id LIMIT 100',
      params: [Buffer.from('1'.padStart(40, '0'), 'hex'), '0'],
    },
    stake: { sql: 'SELECT * FROM hdd.stakes WHERE chain_id=1 AND stake_id=$1', params: ['876543'] },
    maturity: {
      sql: "SELECT stake_id,principal_hearts FROM hdd.stakes WHERE chain_id=1 AND lifecycle='unsettled' AND locked_day+staked_days BETWEEN 100 AND 110 ORDER BY locked_day+staked_days,stake_id LIMIT 100",
      params: [],
    },
    history: {
      sql: 'SELECT kind,stake_id FROM hdd.events WHERE origin_chain_id=1 AND stake_id=$1 ORDER BY block_number,log_index',
      params: ['12345'],
    },
  };
  for (const [name, q] of Object.entries(queries)) {
    const plan = await api.query('EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON) ' + q.sql, q.params);
    writeFileSync(
      `/evidence/plan-${name}.json`,
      JSON.stringify(plan.rows[0]['QUERY PLAN'], null, 2) + '\n',
    );
    const samples = [];
    for (let i = 0; i < 101; i++) {
      const t = performance.now();
      await api.query(q.sql, q.params);
      samples.push(performance.now() - t);
    }
    const sorted = [...samples].sort((a, b) => a - b);
    result.queries[name] = {
      samples: 101,
      p50Ms: sorted[50],
      p95Ms: sorted[95],
      minMs: sorted[0],
      maxMs: sorted[100],
      warmSequentialSamplesMs: samples,
    };
  }
  const writer = await CanonicalWriter.acquire(worker, 1);
  async function churnSnapshot() {
    return (
      await api.query(`SELECT 'stakes' AS relation,count(*)::text AS rows,sum(xmin::text::bigint)::text AS xmin_sum FROM hdd.stakes UNION ALL
    SELECT 'accounts',count(*)::text,sum(xmin::text::bigint)::text FROM hdd.accounts`)
    ).rows;
  }
  try {
    const before = await churnSnapshot();
    await phase('ten same-day no-change commits', async () => {
      for (let i = 0; i < 10; i++) await writer.commit(await batch(api));
    });
    assert.deepEqual(await churnSnapshot(), before);
    await phase('empty day boundary', async () => {
      await writer.commit(await batch(api, [], 11));
    });
    assert.deepEqual(await churnSnapshot(), before);
    result.cycles.push({
      kind: '10 no-change and 1 empty day boundary',
      stakeAccountRowsRewritten: 0,
      verifiedBy: 'count and xmin sum equality',
    });
    const addr = (i) => '0x' + BigInt(i).toString(16).padStart(40, '0');
    const values = Array.from({ length: 100 }, (_, i) =>
      transfer(addr(i + 1), addr(i + 101), 100000000n + BigInt(i)),
    );
    await phase('100 changed transfers', () => batch(api, values).then((b) => writer.commit(b)));
    const changed = (
      await api.query(
        `SELECT count(*)::text AS count FROM hdd.accounts WHERE last_block=(SELECT block_number FROM hdd.sync_state WHERE chain_id=1)`,
      )
    ).rows[0].count;
    assert.equal(changed, '200');
    result.cycles.push({ kind: '100 transfers', accountsChanged: changed, stakesChanged: 0 });
    await phase('100 new stakes', () =>
      batch(
        api,
        Array.from({ length: 100 }, (_, i) =>
          start(1000001 + i, addr(i + 1), 10000000000n, 100000000000n, 365),
        ),
      ).then((b) => writer.commit(b)),
    );
    const beforeActivation = await churnSnapshot();
    await phase('queued activation at day boundary without stake/account rewrites', async () => {
      await writer.commit(await batch(api, [], 12));
    });
    assert.deepEqual(await churnSnapshot(), beforeActivation);
    await phase('post-cycle aggregate audit', () => reconcile(worker, 1));
    result.cycles.push({
      kind: '100 starts and next-day activation',
      newStakes: 100,
      activationStakeAccountRewrites: 0,
    });
  } finally {
    await writer.close();
  }
  await sample('after bounded cycles');
  const first = result.storage[0],
    last = result.storage.at(-1);
  result.walGeneratedBytes = (
    await admin.query('SELECT pg_wal_lsn_diff($1,$2)::text AS bytes', [last.wal_lsn, first.wal_lsn])
  ).rows[0].bytes;
  result.limitations =
    'Warm sequential database round trips, not mixed API/load or cold cache. Direct generated fixture is not acquired history. DB temp counters are cumulative; WAL LSN difference covers fixture through cycles, WAL allocation and disk are sampled, not continuous peaks. No exports/backups/provider work; full Task09/10 acceptance not attempted.';
  writeFileSync('/evidence/scale-results.json', JSON.stringify(result, null, 2) + '\n');
  console.log('Scale timings', result.phases);
  console.log(
    'Scale queries',
    Object.fromEntries(
      Object.entries(result.queries).map(([k, v]) => [k, { p50Ms: v.p50Ms, p95Ms: v.p95Ms }]),
    ),
  );
  console.log(
    'Scale DB bytes',
    last.database_bytes,
    'WAL generated',
    result.walGeneratedBytes,
    'temp cumulative',
    last.temp_bytes,
  );
}
