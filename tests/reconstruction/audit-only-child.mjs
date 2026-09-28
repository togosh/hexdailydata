import { writeFile } from 'node:fs/promises';
import { runOperator } from '../../dist/operator/main.js';
import { ReconstructionPause } from '../../dist/operator/reconstruction-state.js';
import { ReconstructionClock } from '../../dist/operator/reconstruction-clock.js';
import { environment, json } from './fixture.mjs';
import { readOnlyWitness, auditFixture } from './audit-only-fixture.mjs';
globalThis.fetch = () => {
  throw Error('REAL NETWORK FORBIDDEN');
};
const [path, action, mode, trace] = process.argv.slice(2);
const p = await json(path);
const saved =
  action === 'prepare' || action === 'check'
    ? null
    : await json(p.storagePath + '/reconstruction.json');
let wall = (saved?.highWater ?? Date.now()) + 1234,
  mono = 0n;
const clock = new ReconstructionClock({
  wall: () => wall,
  monotonic: () => mono,
  sleep: async (ms, signal) => {
    signal.throwIfAborted();
    wall += ms;
    mono += BigInt(ms) * 1000000n;
  },
});
const f = auditFixture(p, clock, mode),
  witness = readOnlyWitness();
const save = () =>
  writeFile(
    trace,
    JSON.stringify({
      calls: f.calls,
      attempts: f.attempts,
      clients: witness.clients,
      statements: witness.statements,
      clock: clock.snapshot(),
    }),
  );
let pages = 0;
try {
  await runOperator(
    ['reconstruct', action, path, p.storagePath + '/../approval.json'],
    {},
    {
      env: environment(p),
      clock,
      transport: f.transport,
      auditHooks: {
        afterAppend: async () => {
          if (mode === 'append-crash') {
            await save();
            process.exit(78);
          }
        },
        afterPage: async () => {
          if (mode === 'page-pause' && ++pages === 1)
            throw new ReconstructionPause('Synthetic committed page pause');
        },
      },
    },
  );
} finally {
  witness.close();
  await save();
}
