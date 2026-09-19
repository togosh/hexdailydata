import assert from 'node:assert/strict';
import pg from 'pg';
import {
  readFile,
  writeFile,
  stat,
  readdir,
  truncate,
  symlink,
  unlink,
  chmod,
  rm,
} from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { connect, databaseConfig } from '../../dist/db/connect.js';
import { backup, restore, backupStatus } from '../../dist/operator/backup.js';
import { reserve } from '../../dist/operator/files.js';
import { tables } from '../../dist/worker/bootstrap/manifest.js';
import { validateState, validateRecovery, fileHash } from '../../dist/worker/bootstrap/seed.js';
import { packArchive, readArchive } from '../../dist/worker/bootstrap/archive.js';
import { toolFile } from '../../dist/operator/process.js';
import { configureMarket, importMarketBars } from '../../dist/worker/daily/market.js';
const signal = new AbortController().signal;
const action = process.argv[2],
  c = await connect(databaseConfig('worker'));
c.on('error', () => {});
try {
  if (action === 'resources') {
    const admin = new pg.Client({
      host: 'db',
      database: 'hexdailydata_v2',
      user: 'hdd_v2_admin',
      password: (await readFile(process.env.HDD_V2_ADMIN_PASSWORD_FILE, 'utf8')).trim(),
    });
    await admin.connect();
    try {
      const result = (
        await admin.query(
          `SELECT pg_database_size(current_database())::text AS db_bytes,pg_current_wal_lsn()::text AS wal_lsn,temp_files::text,temp_bytes::text,(SELECT sum(size)::text FROM pg_ls_waldir()) AS allocated_wal_bytes FROM pg_stat_database WHERE datname=current_database()`,
        )
      ).rows[0];
      await writeFile(
        '/evidence/' + process.argv[3] + '-resources.json',
        JSON.stringify(result, null, 2),
      );
      console.log(JSON.stringify(result));
    } finally {
      await admin.end();
    }
  } else if (action === 'snapshot') {
    const output = {};
    await c.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
    for (const [table, keys] of Object.entries(tables)) {
      const digest = createHash('sha256');
      let rows = 0;
      // Physical byte counters are deliberately recalculated after logical restore.
      const expr =
        table === 'checkpoints_recent' ? "to_jsonb(t)-'undo_bytes'-'tail_bytes'" : 'to_jsonb(t)';
      await c.query(
        `DECLARE rows CURSOR FOR SELECT (${expr})::text AS r FROM hdd.${table} t ORDER BY ${keys.join(',')}`,
      );
      for (;;) {
        const batch = (await c.query('FETCH FORWARD 128 FROM rows')).rows;
        if (!batch.length) break;
        for (const r of batch) {
          digest.update(r.r + '\n');
          rows++;
        }
      }
      await c.query('CLOSE rows');
      output[table] = { rows, sha256: digest.digest('hex') };
    }
    output.exact = (
      await c.query(
        'SELECT liquid_hearts::text FROM hdd.accounts WHERE liquid_hearts>9007199254740992 ORDER BY liquid_hearts DESC LIMIT 2',
      )
    ).rows;
    output.cutoffs = (
      await c.query('SELECT chain_id,block_number,revision FROM hdd.sync_state ORDER BY chain_id')
    ).rows;
    await c.query('COMMIT');
    await writeFile('/evidence/' + process.argv[3] + '.json', JSON.stringify(output, null, 2));
    console.log(
      JSON.stringify({ snapshot: process.argv[3], cutoffs: output.cutoffs, exact: output.exact }),
    );
  } else if (action === 'market') {
    const minute = Number(process.argv[3] ?? 0);
    await configureMarket(c, 369, 'synthetic-market', 'source-reported', 23);
    await importMarketBars(
      c,
      {
        chain: 369,
        source: 'synthetic-market',
        bars: [
          {
            time: 1575331200 + 23 * 86400 + minute * 60,
            revision: '0',
            open: '1.000000000000000003',
            high: '2',
            low: '1',
            close: '1.5',
            volume: null,
            liquidity: null,
          },
        ],
      },
      Math.floor(Date.now() / 1000),
      signal,
    );
    console.log('Pending synthetic market consumer input recorded.');
  } else if (action === 'audit') {
    await c.query('BEGIN');
    await validateState(c, signal);
    const checkpoints = await validateRecovery(c, signal);
    await c.query('ROLLBACK');
    console.log(JSON.stringify({ semanticSeedAudit: 'PASS', recoveryCheckpoints: checkpoints }));
  } else if (action === 'consistent-backup') {
    const result = await backup(signal, process.env, {
      afterSnapshot: async () => {
        await importMarketBars(
          c,
          {
            chain: 369,
            source: 'synthetic-market',
            bars: [
              {
                time: 1575331200 + 23 * 86400 + 60,
                revision: '0',
                open: '2',
                high: '3',
                low: '1',
                close: '2.5',
                volume: null,
                liquidity: null,
              },
            ],
          },
          Math.floor(Date.now() / 1000),
          signal,
        );
      },
    });
    await writeFile('/evidence/backup.json', JSON.stringify(result, null, 2));
    console.log(JSON.stringify(result));
  } else if (action === 'backup-failures') {
    const before = await readFile('/backup/current.age'),
      digest = createHash('sha256').update(before).digest('hex');
    // This is the SMALL fault fixture only, never the scale archive/driver.
    const accepted = await readFile('/backup/verified.json', 'utf8');
    for (let i = 0; i < 2; i++)
      await assert.rejects(
        backup(signal, process.env, {
          beforePromote: () => {
            throw Error('injected transfer failure');
          },
        }),
      );
    await assert.rejects(
      backup(signal, process.env, {
        afterTransfer: async () => {
          await truncate('/backup/candidate.age', 100);
        },
      }),
      /age failed/,
    );
    await assert.rejects(
      backup(signal, process.env, {
        afterTransfer: async () => {
          const bytes = await readFile('/backup/candidate.age');
          bytes[bytes.length - 50] ^= 1;
          await writeFile('/backup/candidate.age', bytes);
        },
      }),
      /age failed/,
    );
    await chmod('/backup', 0o500);
    try {
      await assert.rejects(backup(signal));
    } finally {
      await chmod('/backup', 0o700);
    }
    await assert.rejects(
      backup(signal, process.env, {
        beforePromote: async () => {
          await chmod('/maintenance/backup', 0o500);
          throw Error('initiating failure');
        },
      }),
      /initiating failure/,
    );
    await chmod('/maintenance/backup', 0o700);
    await rm('/maintenance/backup', { recursive: true });
    assert.equal(
      createHash('sha256')
        .update(await readFile('/backup/current.age'))
        .digest('hex'),
      digest,
    );
    assert.equal(await readFile('/backup/verified.json', 'utf8'), accepted);
    assert.ok(
      (await readdir('/backup')).every((n) =>
        ['current.age', 'candidate.age', 'verified.json'].includes(n),
      ),
    );
    assert.deepEqual(await readdir('/maintenance'), []);
    await assert.rejects(reserve('/maintenance', Number.MAX_SAFE_INTEGER), /reserve/);
    await symlink('/backup', '/maintenance/link');
    await assert.rejects(
      backup(signal, { ...process.env, HDD_V2_MAINTENANCE_PATH: '/maintenance/link' }),
      /Symlink/,
    );
    await unlink('/maintenance/link');
    console.log(
      'PASS failed replacement retains last good + unchanged age; bounded candidate/staging; actual path low-space and symlink refusal.',
    );
  } else if (action === 'restore-failure') {
    const expected = JSON.parse(await readFile('/input/expectation.json', 'utf8'));
    await assert.rejects(
      restore('/input/recovery.age', expected, signal, {
        ...process.env,
        HDD_V2_BACKUP_IDENTITY_FILE: '/run/secrets/backup',
      }),
      /age failed/,
    );
    await toolFile(
      'age',
      ['-d', '-i', process.env.HDD_V2_BACKUP_IDENTITY_FILE, '/input/recovery.age'],
      '/maintenance/fault.tar.gz',
      signal,
    );
    // Small fixture mutation only. Never buffer the scale dump.
    const members = [];
    await readArchive(
      '/maintenance/fault.tar.gz',
      ['backup.json', 'database.sql'],
      async (name, _size, chunks) => {
        const parts = [];
        for await (const b of chunks) parts.push(b);
        members.push({ name, data: Buffer.concat(parts) });
      },
      signal,
      'backup.json',
    );
    for (const kind of ['schema', 'sql']) {
      const copy = members.map((m) => ({ ...m, data: Buffer.from(m.data) })),
        manifest = JSON.parse(copy[0].data);
      if (kind === 'schema') manifest.schema = 99;
      else {
        copy[1].data = Buffer.concat([copy[1].data, Buffer.from('SELECT 1;\n')]);
        manifest.dumpBytes = copy[1].data.length;
        manifest.dumpSha256 = createHash('sha256').update(copy[1].data).digest('hex');
      }
      copy[0].data = Buffer.from(JSON.stringify(manifest));
      const packed = '/maintenance/' + kind + '.tar.gz',
        cipher = '/maintenance/' + kind + '.age';
      await packArchive(
        packed,
        copy.map((m) => ({ ...m, size: m.data.length })),
        signal,
      );
      await toolFile(
        'age',
        ['-e', '-i', process.env.HDD_V2_BACKUP_IDENTITY_FILE, packed],
        cipher,
        signal,
      );
      await assert.rejects(
        restore(cipher, { ...expected, sha256: await fileHash(cipher, signal) }, signal),
      );
      await unlink(packed);
      await unlink(cipher);
    }
    await unlink('/maintenance/fault.tar.gz');
    const migrator = await connect(databaseConfig('migrator'));
    try {
      await migrator.query('CREATE SCHEMA unrelated_test');
      await assert.rejects(restore('/input/recovery.age', expected, signal), /unrelated/);
      await migrator.query('DROP SCHEMA unrelated_test');
    } finally {
      await migrator.end();
    }
    await assert.rejects(
      restore(
        '/input/recovery.age',
        { ...expected, destinationInstance: '00000000-0000-0000-0000-000000000000' },
        signal,
      ),
      /identity/,
    );
    await assert.rejects(
      restore('/input/recovery.age', expected, signal, process.env, {
        beforeCommit: () => {
          throw Error('injected restore failure');
        },
      }),
      /injected/,
    );
    assert.equal((await c.query('SELECT count(*)::text AS n FROM hdd.chains')).rows[0].n, '0');
    console.log(
      'PASS wrong identity refusal and failed restore transaction rollback; target remains empty.',
    );
  } else if (action === 'health') console.log(JSON.stringify(await backupStatus()));
  else if (action === 'hold-backup')
    await backup(signal, process.env, {
      afterSnapshot: async () => {
        console.log('SNAPSHOT_HELD');
        await new Promise(() => {});
      },
    });
  else throw Error('Unknown probe.');
} finally {
  await c.end();
}
