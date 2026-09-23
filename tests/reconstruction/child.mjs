import { writeFile } from 'node:fs/promises';
import { runOperator } from '../../dist/operator/main.js';
import { ReconstructionPause } from '../../dist/operator/reconstruction-state.js';
import { environment, fixture, clockAt, json } from './fixture.mjs';
globalThis.fetch = () => {
  throw Error('REAL NETWORK FORBIDDEN');
};
const [path, action, mode = 'normal', trace] = process.argv.slice(2);
const p = await json(path),
  state = await json(p.storagePath + '/reconstruction.json');
const clock = clockAt(state.highWater + 1234),
  f = fixture(p, clock, mode);
let base = state.accepted.header.number,
  pages = 0;
const options = {
  env: environment(p),
  clock,
  transport: f.transport,
  boundary: async (s) => {
    if (mode === 'one-commit' && s.state.accepted.header.number !== base)
      throw new ReconstructionPause('Synthetic accepted checkpoint pause');
  },
  hooks:
    mode === 'commit-crash'
      ? {
          afterCommit: async () => {
            await writeFile(trace, JSON.stringify(f.attempts));
            process.exit(77);
          },
        }
      : undefined,
  auditHooks:
    mode === 'append-crash'
      ? {
          afterAppend: async () => {
            await writeFile(trace, JSON.stringify(f.attempts));
            process.exit(78);
          },
        }
      : mode === 'page-crash'
        ? {
            afterPage: async () => {
              await writeFile(trace, JSON.stringify(f.attempts));
              process.exit(79);
            },
          }
        : mode === 'page-pause'
          ? {
              afterPage: async () => {
                if (++pages === 2) throw new ReconstructionPause('Synthetic verified page pause');
              },
            }
          : undefined,
};
await runOperator(['reconstruct', action, path, p.storagePath + '/../approval.json'], {}, options);
await writeFile(trace, JSON.stringify(f.attempts));
