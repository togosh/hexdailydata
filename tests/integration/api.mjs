// Compiled API modules, normal SQL/download dependencies, injected internal raw transport.
import assert from 'node:assert/strict';
import { writeFile, readFile } from 'node:fs/promises';
import { createApp } from '../../dist/api/app.js';
import { openDependencies, sqlBaseline } from '../../dist/api/dependencies.js';
import { AddressService } from '../../dist/services/live/address.js';
import { ProviderBudget } from '../../dist/providers/budget.js';
import { RpcClient } from '../../dist/providers/rpc.js';
import { cooldownFiles } from '../../dist/providers/cooldown.js';
import { control, clockFor, CONTRACT, CODE_HASH, meterBudget } from './fixture.mjs';
assert.equal(process.env.HDD_V2_ALLOW_LIVE_RPC, 'false');
const c = control(),
  clock = clockFor(c),
  deps = await openDependencies();
const cooldown = await cooldownFiles('/provider', 'api');
const budgetEvidence = meterBudget();
const budget = new ProviderBudget('api', cooldown, clock);
const transport = async (body, signal) => {
  const response = await fetch('http://worker:4444/rpc', {
    method: 'POST',
    body,
    signal,
    redirect: 'error',
  });
  return { status: response.status, retryAfter: null, body: response.body };
};
const addresses = new AddressService(
  new RpcClient('synthetic-369-1', 'synthetic-1', 369, CONTRACT, transport, budget),
  CODE_HASH,
  sqlBaseline(deps.db),
);
deps.addresses = addresses;
const app = createApp({
  dependencies: deps,
  webRoot: '/app/dist/web',
  mode: 'production',
  now: clock.now,
});
await app.listen({ host: '0.0.0.0', port: 4320 });
process.once('SIGTERM', async () => {
  await app.close();
  await writeFile(
    '/evidence/api-mixed.json',
    JSON.stringify(
      {
        budget: budget.counters,
        dispatch: budgetEvidence(),
        addresses: addresses.counters,
        cache: {
          bytes: addresses.cache.bytes,
          entries: addresses.cache.size,
          maximum: addresses.cache.maximum,
          evictions: addresses.cache.evictions,
        },
        rss: process.memoryUsage().rss,
        memory: {
          current: await readFile('/sys/fs/cgroup/memory.current', 'utf8'),
          peak: await readFile('/sys/fs/cgroup/memory.peak', 'utf8'),
          events: await readFile('/sys/fs/cgroup/memory.events', 'utf8'),
        },
      },
      null,
      2,
    ),
  );
  await cooldown.close();
});
