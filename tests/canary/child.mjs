import { readFile, writeFile } from 'node:fs/promises';
import { setTimeout as pause } from 'node:timers/promises';
import { runOperator } from '../../dist/operator/main.js';
import { CanarySession } from '../../dist/operator/canary-session.js';
import { maintenanceLease } from '../../dist/operator/lease.js';
import { rawFixture, environment } from './fixture.mjs';
import { FakeClock } from '../sync/fixture.mjs';
import { prefixEnvironment, prefixFixture } from './prefix-fixture.mjs';

globalThis.fetch = () => {
  throw Error('NETWORK FORBIDDEN');
};
const [action, path, mode = 'normal'] = process.argv.slice(2),
  p = JSON.parse(await readFile(path, 'utf8'));
const isPrefix = p.phases[0].kind === 'common-prefix';
const env = isPrefix ? prefixEnvironment(p) : environment(p),
  clock = new FakeClock();
try {
  clock.time = JSON.parse(await readFile(p.sessionPath, 'utf8')).highWater;
} catch {
  clock.time = Date.now();
}
if (action === 'lease') {
  const release = await maintenanceLease(
    [p.storagePath, p.quotaPath],
    new AbortController().signal,
  );
  const session = await CanarySession.load(p, clock, {
    beforeDispatch:
      mode === 'reserved'
        ? async () => {
            await writeFile(p.storagePath + '/stage.txt', 'reserved');
            await pause(120000);
          }
        : undefined,
    beforeSettlement:
      mode === 'delivered'
        ? async () => {
            await writeFile(p.storagePath + '/stage.txt', 'delivered');
            await pause(120000);
          }
        : undefined,
  });
  await session.start(mode === 'resume');
  const wrapped = session.transport(1, async () => {
    await writeFile(p.storagePath + '/stage.txt', 'dispatched');
    return {
      status: 200,
      retryAfter: null,
      body: (async function* () {
        yield Buffer.from('[]');
      })(),
    };
  });
  const response = await wrapped(
    '[{"method":"eth_chainId","params":[]}]',
    new AbortController().signal,
  );
  if (mode === 'delivered') for await (const chunk of response.body) void chunk;
  else await pause(120000);
  await release();
} else {
  const f = isPrefix ? prefixFixture(p, clock, mode) : rawFixture(p, clock, mode === 'split');
  let committed = false;
  await runOperator(['canary', action, path, p.storagePath + '/approval.json'], {
    env,
    clock,
    transport: f.transport,
    hooks:
      mode === 'signal' || mode === 'lost-ack'
        ? {
            afterCommit: async () => {
              if (committed) return;
              committed = true;
              if (mode === 'lost-ack') throw Error('Injected lost commit acknowledgement.');
              process.kill(process.pid, 'SIGTERM');
              await pause(10);
            },
          }
        : undefined,
  });
  console.log(JSON.stringify({ fixtureTransport: f.raw, realProviderCalls: 0 }));
}
