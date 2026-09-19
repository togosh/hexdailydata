import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import type pg from 'pg';

export async function migrate(client: pg.Client, sql: string, additions: string[] = []) {
  const hash = createHash('sha256').update(sql).digest('hex');
  await client.query('BEGIN');
  try {
    await client.query('SELECT pg_advisory_xact_lock(369,0)');
    const {
      rows: [role],
    } = await client.query('SELECT current_user AS name');
    if (role.name !== 'hdd_v2_migrator') throw new Error('Migration authority required.');
    const {
      rows: [schema],
    } = await client.query("SELECT to_regnamespace('hdd') AS name");
    if (schema.name) {
      const { rows } = await client.query(
        'SELECT version,sha256 FROM hdd.schema_migrations ORDER BY version',
      );
      const expected = [
        hash,
        ...additions.map((s) => createHash('sha256').update(s).digest('hex')),
      ];
      if (
        !rows.length ||
        rows.length > expected.length ||
        rows.some((r, i) => r.version !== i + 1 || r.sha256 !== expected[i])
      )
        throw new Error('Incompatible migration version/checksum; target left unchanged.');
    } else {
      const { rows } =
        await client.query(`SELECT nspname FROM pg_namespace WHERE nspname NOT LIKE 'pg_%'
        AND nspname NOT IN ('information_schema','public','hdd_identity')
        UNION ALL SELECT tablename FROM pg_tables WHERE schemaname='public'`);
      if (rows.length) throw new Error('Refusing nonempty unrelated target.');
      await client.query(sql);
      await client.query('INSERT INTO hdd.schema_migrations VALUES(1,$1)', [hash]);
    }
    const { rows: installed } = await client.query(
      'SELECT version FROM hdd.schema_migrations ORDER BY version',
    );
    for (let i = installed.length - 1; i < additions.length; i++) {
      await client.query(additions[i]!);
      await client.query('INSERT INTO hdd.schema_migrations VALUES($1,$2)', [
        i + 2,
        createHash('sha256').update(additions[i]!).digest('hex'),
      ]);
    }
    await client.query('COMMIT');
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {});
    throw error;
  }
}
export function initialMigration() {
  return readFile(new URL('../../migrations/0001_initial.sql', import.meta.url), 'utf8');
}
export async function migrateCurrent(client: pg.Client) {
  return migrate(client, await initialMigration(), [
    await readFile(new URL('../../migrations/0002_recovery.sql', import.meta.url), 'utf8'),
    await readFile(new URL('../../migrations/0003_live.sql', import.meta.url), 'utf8'),
  ]);
}
