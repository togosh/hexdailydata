import { connect, databaseConfig } from './connect.ts';
import { migrateCurrent } from './migrate.ts';

const command = process.argv[2];
if (command !== 'migrate')
  throw new Error('Usage: db.ts migrate (explicit private v2 target required)');
const client = await connect(databaseConfig('migrator'));
try {
  await migrateCurrent(client);
  console.log('v2 schema 3 checked/applied.');
} finally {
  await client.end();
}
