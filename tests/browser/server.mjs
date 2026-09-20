// Explicit test host only. The shipped API entry point has no fixture switch or fallback.
import assert from 'node:assert/strict';
import { createApp } from '../../dist/api/app.js';
import { openDependencies, sqlBaseline } from '../../dist/api/dependencies.js';
import { AddressService } from '../../dist/services/live/address.js';
import { fixture, CODE_HASH } from '../live/fixture.mjs';
assert.equal(process.env.HDD_V2_ALLOW_LIVE_RPC, 'false');
const scenario = process.env.HDD_V2_WEB_SCENARIO;
assert.ok(['empty', 'native', 'scale'].includes(scenario));
const at = Date.parse('2026-09-19T12:00:00.000Z');
const deps = await openDependencies();
if (scenario !== 'empty') {
  const raw = fixture();
  raw.clock.time = at - 30000;
  raw.state.count = 41;
  deps.addresses = new AddressService(raw.rpc('api', raw.api), CODE_HASH, sqlBaseline(deps.db));
}
const app = createApp({
  webRoot: '/app/dist/web',
  mode: 'production',
  dependencies: deps,
  now: () => at,
});
await app.listen({ host: '0.0.0.0', port: 4320 });
console.log(
  JSON.stringify({
    scenario,
    compiled: true,
    sourceClock: new Date(at).toISOString(),
    realProviderRequests: 0,
  }),
);
process.once('SIGTERM', () => {
  void app.close();
});
