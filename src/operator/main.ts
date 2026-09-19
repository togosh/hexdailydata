import { readFile, stat } from 'node:fs/promises';
import { connect, databaseConfig } from '../db/connect.ts';
import { migrateCurrent } from '../db/migrate.ts';
import { runWorker } from '../worker/main.ts';
import { backup, restore } from './backup.ts';
import { operatorStatus } from './status.ts';
import { operatorError } from './errors.ts';
import { runCanary, canaryHelp } from './canary.ts';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';

export async function runOperator(
  argv = process.argv.slice(2),
  canaryOptions: Parameters<typeof runCanary>[2] = {},
) {
  const [command, ...args] = argv;
  const controller = new AbortController();
  const onSignal = () => controller.abort(new Error('Operator cancelled.'));
  for (const sig of ['SIGINT', 'SIGTERM'] as const) process.once(sig, onSignal);
  try {
    if (command === 'canary') {
      const result = await runCanary(args, controller.signal, canaryOptions);
      console.log(JSON.stringify(result));
      if ('status' in result && result.status === 'stopped') process.exitCode = 2;
      if ('state' in result && result.state === 'NOT_CONFIGURED') process.exitCode = 2;
    } else if (command === 'help' || command === '--help') {
      console.log(
        'Operator: doctor | status | migrate | sync | rebuild | exports | backup | restore | ' +
          canaryHelp,
      );
    } else if (command === 'doctor' || command === 'status') {
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
        'Commands: doctor | status | migrate | rebuild | sync --once/--watch | repair-range <block> | exports | seed-export <path> | seed-import <path> <expectation.json> | backup | restore <path> <expectation.json> | canary help.',
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
  } finally {
    for (const sig of ['SIGINT', 'SIGTERM'] as const) process.off(sig, onSignal);
  }
}
if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1]))
  await runOperator();
