import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const root = fs.realpathSync(path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..'));

if (fs.realpathSync(process.cwd()) !== root) {
  throw new Error('Run from the new v2 repository root.');
}

const marker = JSON.parse(fs.readFileSync(path.join(root, '.hdd-v2.json'), 'utf8'));
if (marker.generation !== 2 || marker.product !== 'HEXDailyData') {
  throw new Error('Wrong workspace marker.');
}

const oldFolderNames = ['hexstakeexplorer-pulsechain', 'hexdailydata', 'hexdailydata-collab'];
if (oldFolderNames.includes(path.basename(root).toLowerCase())) {
  throw new Error('Use a new v2 folder, not a development/publishing/collaboration v1 folder.');
}

const [major, minor] = process.versions.node.split('.').map(Number);
if (major !== 24 || minor < 21) {
  throw new Error('Use the supported Node24.21+ runtime; see README prerequisites.');
}

// Reading Git identity does not execute application code or package scripts.
const git = spawnSync('git', ['-C', root, 'rev-parse', '--show-toplevel'], {
  encoding: 'utf8',
  timeout: 10_000,
});
if (git.status === 0 && fs.realpathSync(git.stdout.trim()) !== root) {
  throw new Error('The new folder is inside another Git repository.');
}

console.log(
  JSON.stringify(
    {
      status: 'WORKSPACE_CHECKED',
      root,
      targetNode: '24 LTS',
      observedNode: process.versions.node,
      databaseAccess: false,
      providerAccess: false,
      productionReady: false,
    },
    null,
    2,
  ),
);
console.log(
  'Use scripts/task.mjs next for build progress. This checks the workspace, not chain validity.',
);
