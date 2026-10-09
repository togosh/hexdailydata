// Explicit OFFLINE maintenance only. No imports of collectors/provider clients.
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  inspectStorage,
  planRetention,
  applyRetention,
  planRollback,
  applyRollback,
  backupStorage,
  restoreStorage,
  reconcileAcknowledgement,
  auditJournal,
} from '../dist/services/product-daily/storage.js';
export async function main(args = process.argv.slice(2)) {
  const [mode, root, arg, identity] = args;
  if (
    !root ||
    ![
      'inspect',
      'plan-retention',
      'apply-retention',
      'plan-rollback',
      'apply-rollback',
      'backup',
      'restore',
      'reconcile-ack',
    ].includes(mode)
  ) {
    console.log(
      'Offline only: inspect ROOT | plan-retention ROOT | apply-retention ROOT PLAN.json | plan-rollback ROOT | apply-rollback ROOT PLAN.json | backup ROOT NEW_BUNDLE | restore BUNDLE NEW_ROOT SHA256 | reconcile-ack ROOT. No default writes or requests.',
    );
    return 2;
  }
  let result;
  if (mode === 'inspect')
    result = {
      ...(await inspectStorage(root)),
      journal: await auditJournal(root).catch((e) => ({ status: 'BLOCKED', error: String(e) })),
    };
  else if (mode === 'plan-retention') result = await planRetention(root);
  else if (mode === 'plan-rollback') result = await planRollback(root);
  else if (mode === 'apply-retention')
    result = await applyRetention(root, JSON.parse(await readFile(arg, 'utf8')));
  else if (mode === 'apply-rollback')
    result = await applyRollback(root, JSON.parse(await readFile(arg, 'utf8')));
  else if (mode === 'backup') result = await backupStorage(root, arg);
  else if (mode === 'restore') result = await restoreStorage(root, arg, identity);
  else result = await reconcileAcknowledgement(root);
  console.log(JSON.stringify(result, null, 2));
  return result.status === 'BLOCKED' ? 2 : 0;
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url))
  process.exitCode = await main();
