import { readFileSync, writeFileSync } from 'node:fs';
import { recover } from '../../scripts/operator/reconstruction-recovery.mjs';
import { recoveryMutex } from '../../scripts/operator/reconstruction-recovery-mutex.mjs';
import { sqlAdapter } from './recovery-adapter.mjs';
const [path, fault] = process.argv.slice(2),
  { options, observed } = JSON.parse(readFileSync(path));
const release = await recoveryMutex(options.environment),
  adapter = sqlAdapter(options.plan, options.environment, observed);
try {
  const result = await recover(options, adapter, async (stage) => {
    if (stage === fault) {
      writeFileSync(
        path + '.child.json',
        JSON.stringify({ stage, pid: process.pid, sqlPid: adapter.pid, nativeExit: 91 }),
      );
      process.exit(91);
    }
  });
  console.log(JSON.stringify(result));
} finally {
  await adapter.close();
  await release();
}
