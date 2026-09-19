import { writeFile } from 'node:fs/promises';
import { fixture, FakeClock, CONTRACT, CODE_HASH, hash } from '../sync/fixture.mjs';
import { runWorker } from '../../dist/worker/main.js';
const [command = 'rebuild', end = '296'] = process.argv.slice(2);
console.log(
  'SYNTHETIC OFFLINE WORKER FIXTURE: actual compiled worker entrypoint, injected private transport/clock; no live qualification.',
);
const f = fixture({ last: 364 }),
  clock = new FakeClock();
clock.time = Date.now();
f.setHead(Number(end) + 1);
const provider = (chain, n) => ({
  id: `synthetic-${chain}-${n}`,
  operator: `synthetic-${n}`,
  accountGroup: 'synthetic-private',
  endpointEnv: `HDD_V2_PROVIDER_${chain}_${n}`,
});
const profile = {
  contract: CONTRACT,
  codeHash: CODE_HASH,
  policy: { mode: 'confirmed', confirmations: 1, rollbackBlocks: 128 },
  ethereum: [provider(1, 1), provider(1, 2)],
  pulsechain: [provider(369, 1), provider(369, 2)],
  constructor: { checkpoint: f.plain(100), transactionHash: hash(10000), balances: [] },
  fork: { parent: f.plain(180), entry: f.plain(181) },
  target: f.plain(Number(end)),
};
const transports = new Map();
for (const p of [...profile.ethereum, ...profile.pulsechain]) {
  const chain = p.id.includes('-369-') ? 369 : 1;
  process.env[p.endpointEnv] = 'https://' + p.id + '.invalid';
  transports.set(process.env[p.endpointEnv], f.source(chain, p.id, clock).rpc.transport);
}
process.env.HDD_V2_SOURCE_PROFILE = '/state/synthetic-profile.json';
await writeFile(process.env.HDD_V2_SOURCE_PROFILE, JSON.stringify(profile));
await runWorker(command === 'repair-range' ? [command, end] : [command], {
  clock,
  transport: (endpoint) => {
    if (!transports.has(endpoint)) throw Error('Only private synthetic fixture transport allowed.');
    return transports.get(endpoint);
  },
});
