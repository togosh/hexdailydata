import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const tests = fs
  .readdirSync(path.join(root, 'tests/unit'))
  .filter((file) => file.endsWith('.test.mjs'))
  .sort()
  .map((file) => path.join(root, 'tests/unit', file));
tests.push(
  ...fs
    .readdirSync(path.join(root, 'tests/live'))
    .filter((file) => file.endsWith('.test.mjs'))
    .sort()
    .map((file) => path.join(root, 'tests/live', file)),
);
if (!tests.length) throw new Error('No starter tests.');

// Discovery is confined to this new repository's starter unit tests.
const result = spawnSync(process.execPath, ['--experimental-strip-types', '--test', ...tests], {
  cwd: root,
  stdio: 'inherit',
  env: { ...process.env, HDD_V2_MODE: 'development', HDD_V2_ALLOW_LIVE_RPC: 'false' },
});
if (result.error) throw result.error;
process.exitCode = result.status ?? 1;
