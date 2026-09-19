import { readFile, stat } from 'node:fs/promises';
import { connect, databaseConfig } from '../db/connect.ts';
import { migrateCurrent } from '../db/migrate.ts';
import { runWorker } from '../worker/main.ts';
import { backup, restore } from './backup.ts';
import { operatorStatus } from './status.ts';
import { operatorError } from './errors.ts';

const [command, ...args] = process.argv.slice(2);
const controller = new AbortController();
for (const sig of ['SIGINT', 'SIGTERM'] as const)
  process.once(sig, () => controller.abort(new Error('Operator cancelled.')));
try {
  if (command === 'doctor' || command === 'status') {
    const result = await operatorStatus();
    console.log(JSON.stringify(result));
    process.exitCode =
      result.runtime === 'supported' && result.database === 'ready'
        ? result.backup.state === 'healthy' &&
          Object.values(result.paths).every((path) => path !== 'unavailable_or_low_reserve')
          ? 0
          : 2
        : 3;
  } else if (command === 'migrate') {
    const c = await connect(databaseConfig('migrator'));
    try {
      await migrateCurrent(c);
      console.log(
        JSON.stringify({
          schemaVersions: (
            await c.query('SELECT version FROM hdd.schema_migrations ORDER BY version')
          ).rows.map((r) => r.version),
        }),
      );
    } finally {
      await c.end();
    }
  } else if (command === 'backup') console.log(JSON.stringify(await backup(controller.signal)));
  else if (command === 'restore') {
    if (!args[0] || !args[1] || (await stat(args[1])).size > 4096)
      throw new Error('restore <archive.age> <expectation.json> required.');
    console.log(
      JSON.stringify(
        await restore(args[0], JSON.parse(await readFile(args[1], 'utf8')), controller.signal),
      ),
    );
  } else if (command === 'sync') {
    if (args[0] !== '--once' && args[0] !== '--watch')
      throw new Error('sync --once | --watch required.');
    await runWorker([args[0].slice(2)]);
  } else if (
    command &&
    ['rebuild', 'repair-range', 'seed-export', 'seed-import', 'exports'].includes(command)
  )
    await runWorker([command === 'exports' ? 'export' : command, ...args]);
  else
    throw new Error(
      'Commands: doctor | status | migrate | rebuild | sync --once/--watch | repair-range <block> | exports | seed-export <path> | seed-import <path> <expectation.json> | backup | restore <path> <expectation.json>.',
    );
} catch (error) {
  console.error(
    JSON.stringify({
      event: 'operator_failed',
      command: command ?? 'missing',
      reason: operatorError(error),
    }),
  );
  process.exitCode = 1;
}
