// Process-local immutable-admission seam ONLY. No application/profile/pair/API substitution.
import './deny-network.mjs';
import { readFileSync, appendFileSync } from 'node:fs';
import { resolve, dirname, join } from 'node:path';
import { SavedSourceGenerations } from '../../dist/services/source-update/generation.js';
import { syntheticBase } from './fixture.mjs';
const root = resolve(process.env.HDD_SYNTHETIC_ROOT ?? '');
const task = resolve(process.env.HDD_TASK_ROOT ?? '');
if (!root.startsWith(task + '\\') || !task.endsWith('mainline-consolidation-r1'))
  throw Error('SYNTHETIC_ROOT_REQUIRED');
const NativeDate = Date;
globalThis.Date = class extends NativeDate {
  constructor(...a) {
    super(...(a.length ? a : [Number(readFileSync(join(root, 'clock.txt'), 'utf8'))]));
  }
  static now() {
    return Number(readFileSync(join(root, 'clock.txt'), 'utf8'));
  }
};
// Test-only graceful Windows shutdown of the actual main module's signal handler.
process.on('message', (message) => {
  if (message === 'mainline-test-close') {
    process.emit('SIGTERM');
    process.disconnect();
  }
});
process.channel?.unref();
SavedSourceGenerations.activate = async (options) => {
  if (
    dirname(options.root) !== root ||
    options.holdersRoot !== join(root, 'holders') ||
    options.stakesRoot !== join(root, 'stakes')
  )
    throw Error('SYNTHETIC_ADMISSION_SCOPE');
  appendFileSync(
    join(root, 'admissions.ndjson'),
    JSON.stringify({ syntheticOnly: true, action: 'open' }) + '\n',
  );
  const base = syntheticBase(root);
  base.admit = async (directory, options) => {
    if (options.readOnly !== true) throw Error('ORDINARY_WRITER_FORBIDDEN');
    return { localHolderRows: 664435, localStakeRows: 954715 };
  };
  base.loadSelection = async () => {};
  const close = base.close.bind(base);
  base.close = async () => {
    await close();
    appendFileSync(
      join(root, 'admissions.ndjson'),
      JSON.stringify({ syntheticOnly: true, action: 'close' }) + '\n',
    );
  };
  return base;
};
