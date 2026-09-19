import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import type pg from 'pg';

export async function migrate(client: pg.Client, sql: string) {
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
      if (rows.length !== 1 || rows[0].version !== 1 || rows[0].sha256 !== hash)
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
    await client.query('COMMIT');
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {});
    throw error;
  }
}
export function initialMigration() {
  return readFile(new URL('../../migrations/0001_initial.sql', import.meta.url), 'utf8');
}
