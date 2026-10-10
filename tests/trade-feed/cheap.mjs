import assert from 'node:assert/strict';
import { readFile, writeFile, mkdir, mkdtemp } from 'node:fs/promises';
import { join } from 'node:path';
import { ProductDailyStore } from '../../dist/services/product-daily/store.js';
import { composed } from './composed.mjs';
import { createBudget } from './budget.mjs';
import { parseCommand, atomicCommand, readCommand, closeOwned } from './control.mjs';
const R = process.env.HDD_TASK_ROOT,
  C = join(R, 'continuation-r1');
const profile = JSON.parse(await readFile(join(R, 'SELECTED_PROFILE.json')));
const save = (name, value) =>
  writeFile(join(C, 'evidence', name + '.json'), JSON.stringify(value, null, 2) + '\n');
const store = new ProductDailyStore(profile.productRoot, profile.pair);
await store.load();
const budget = createBudget(join(C, 'evidence'));
const fake = { productDaily: store, root: profile.participantRoot };
const checks = [];
try {
  for (const prefix of ['', '\uFEFF'])
    assert.equal(
      parseCommand(Buffer.from(prefix + '{"ordinal":1,"command":"offline"}'), 0).command,
      'offline',
    );
  for (const raw of [
    '{',
    '[]',
    '{"ordinal":0,"command":"trial"}',
    '{"ordinal":2,"command":"trial"}',
    '{"ordinal":1,"command":"run"}',
    '{"ordinal":1,"command":"trial","extra":true}',
  ])
    assert.throws(() => parseCommand(Buffer.from(raw), 0));
  checks.push('BOM/no-BOM, malformed/partial, exact schema and ordinal refusal');
  const commands = await mkdtemp(join(C, 'fixtures/commands-'));
  await writeFile(join(commands, 'COMMAND.json'), '{');
  assert((await readCommand(commands, 0)).refusal);
  await atomicCommand(commands, { ordinal: 1, command: 'offline' });
  assert((await readCommand(commands, 0)).command);
  assert.equal((await readCommand(commands, 1)).command, null);
  await atomicCommand(commands, { ordinal: 2, command: 'close' });
  assert.equal((await readCommand(commands, 1)).command.command, 'close');
  const freshOwnerCommands = join(commands, 'fresh-owner');
  assert.equal((await readCommand(freshOwnerCommands, 0)).command, null);
  await atomicCommand(freshOwnerCommands, { ordinal: 1, command: 'offline' });
  assert.equal((await readCommand(freshOwnerCommands, 0)).command.command, 'offline');
  checks.push('atomic complete replacement, refusal recovery and repeat no-op');
  const normal = await composed({ R: C, real: fake, base: null, save, budget, setupOnly: true });
  assert(normal.distinctReferences);
  await assert.rejects(
    composed({ R: C, real: fake, base: null, save, budget, failAfterSetup: true }),
    /INJECTED_SETUP_FAILURE/,
  );
  checks.push(
    'actual compact clone relocation/distinct references; held export/app/reader cleanup on injected setup failure',
  );
  const order = [];
  const closed = await closeOwned([
    [
      'bad',
      async () => {
        order.push(1);
        throw Error('injected');
      },
    ],
    ['good', async () => order.push(2)],
  ]);
  assert.deepEqual(order, [1, 2]);
  assert.equal(closed.known, false);
  checks.push('foreground cleanup attempts remaining resources after one close error');
  await save('CHEAP_HARNESS', {
    status: 'PASS',
    checks,
    realBaseAdmissions: 0,
    publicRequests: 0,
    synthetic: true,
  });
  console.log('CHEAP_HARNESS_PASS_NO_BASE_ADMISSIONS');
} catch (e) {
  await save('CHEAP_FAILURE_' + Date.now(), { error: String(e), stack: e.stack, checks });
  throw e;
}
