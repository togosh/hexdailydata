import { fixture, CONTRACT, CODE_HASH, hash } from './fixture.mjs';

export function sharedProfile(commonHistory = 'pulsechain') {
  const f = fixture({ last: 220 });
  const provider = (phase, n) => ({
    id: `fixture-${phase}-${n}`,
    operator: `operator-${n}`,
    accountGroup: `physical-${n}`,
    endpointEnv: `HDD_V2_PROVIDER_${phase === 1 && commonHistory === 'ethereum' ? 'COMMON' : 'PULSE'}_${n}`,
  });
  return {
    commonHistory,
    contract: CONTRACT,
    codeHash: CODE_HASH,
    policy: { mode: 'confirmed', confirmations: 1, rollbackBlocks: 128 },
    ethereum: [provider(1, 1), provider(1, 2)],
    pulsechain: [provider(369, 1), provider(369, 2)],
    constructor: { checkpoint: f.plain(100), transactionHash: hash(10000), balances: [] },
    fork: { parent: f.plain(180), entry: f.plain(181) },
    target: f.plain(188),
  };
}
