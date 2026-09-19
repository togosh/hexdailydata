import { connect, databaseConfig } from './connect.ts';
import { migrateCurrent } from './migrate.ts';

const command = process.argv[2];
if (command !== 'migrate')
  throw new Error('Usage: db.ts migrate (explicit private v2 target required)');
const client = await connect(databaseConfig('migrator'));
try {
  await migrateCurrent(client);
  console.log(
    JSON.stringify({
      schemaVersions: (
        await client.query('SELECT version FROM hdd.schema_migrations ORDER BY version')
      ).rows.map((r) => r.version),
    }),
  );
} finally {
  await client.end();
}
