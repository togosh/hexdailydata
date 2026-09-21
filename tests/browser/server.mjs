// Explicit test host only. The shipped API entry point has no fixture switch or fallback.
import assert from 'node:assert/strict';
import { createApp } from '../../dist/api/app.js';
import { openDependencies, sqlBaseline } from '../../dist/api/dependencies.js';
import { AddressService } from '../../dist/services/live/address.js';
import { fixture, CODE_HASH } from '../live/fixture.mjs';
assert.equal(process.env.HDD_V2_ALLOW_LIVE_RPC, 'false');
const scenario = process.env.HDD_V2_WEB_SCENARIO;
assert.ok(['empty', 'native', 'scale', 'address'].includes(scenario));
const at = Date.parse('2026-09-19T12:00:00.000Z');
const deps = await openDependencies();
if (scenario !== 'empty') {
  const raw = fixture();
  raw.clock.time = at - 30000;
  raw.state.count = 41;
  if (scenario === 'address') {
    const rows = await deps.db.read(
      new AbortController().signal,
      async (c) =>
        (
          await c.query(
            "SELECT * FROM hdd.stakes WHERE chain_id=369 AND address=decode(lpad('1',40,'0'),'hex') AND lifecycle IN('unsettled','good_accounted') ORDER BY stake_id",
          )
        ).rows,
    );
    raw.state.count = rows.length;
    raw.state.balance = 12543087654321n;
    raw.state.stakeRows = rows.map((s) => [
      BigInt(s.stake_id),
      BigInt(s.principal_hearts),
      BigInt(s.stake_shares),
      s.locked_day,
      s.staked_days,
      s.ga_day ?? 0,
      0,
    ]);
  }
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
