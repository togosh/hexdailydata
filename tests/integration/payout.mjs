// Cheap raw large-input witness before SQL scale. Virtual time is not throughput.
import assert from 'node:assert/strict';
import { model, CONTRACT, CODE_HASH } from './fixture.mjs';
import { payoutInputs, checkHome } from './oracle.mjs';
import { FakeClock, memoryCooldown } from '../sync/fixture.mjs';
import { ProviderBudget } from '../../dist/providers/budget.js';
import { RpcClient } from '../../dist/providers/rpc.js';
import { PriceReader, priceTargets } from '../../dist/services/live/price.js';
import { MetricsService } from '../../dist/worker/metrics/service.js';

const c = {
  startDay: 2400,
  label: 'mixed',
  epoch: (1575331200 + 2454 * 86400) * 1000,
  started: Date.now(),
};
const m = model(c),
  clock = new FakeClock();
clock.time = c.epoch;
const state = m.f.states.get(537);
for (const [key, field] of [
  ['supply', 'totalSupply'],
  ['locked', 'lockedHearts'],
  ['active', 'stakeShares'],
  ['queued', 'nextStakeShares'],
])
  assert.equal(String(state[key]), payoutInputs[field]);
const budget = new ProviderBudget('worker', memoryCooldown(), clock),
  rows = {},
  inputs = {};
const transport = async (body, signal) => ({
  status: 200,
  retryAfter: null,
  body: (async function* () {
    yield await m.raw(body, signal, 537);
  })(),
});
const clients = ['one', 'two'].map(
  (id) => new RpcClient(id, id, 369, CONTRACT, transport, budget, priceTargets(m.price)),
);
const service = new MetricsService(clients, CODE_HASH, new PriceReader(m.price, CONTRACT), {
  read: async () => rows,
  put: async (chain, key, value, input) => {
    rows[key] = value;
    inputs[key] = input;
  },
});
clock.time += 60000;
const live = await service.tick(new AbortController().signal);
checkHome({ live }, c.startDay, clock.now());
console.log(
  JSON.stringify(
    {
      status: 'PASS',
      time: 'virtual',
      inputs,
      live,
      budget: budget.counters,
      rpc: clients.map((c) => c.counters),
    },
    (_, v) => (typeof v === 'bigint' ? String(v) : v),
    2,
  ),
);
