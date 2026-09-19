import { dayStartSeconds } from '../../src/domain/day.ts';
export const A = '0x' + '11'.repeat(20),
  B = '0x' + '22'.repeat(20),
  C = '0x' + '33'.repeat(20),
  ZERO = '0x' + '00'.repeat(20);
export const CONTRACT = '0x' + 'ab'.repeat(20),
  CODE = '0x' + 'cd'.repeat(32);
export const hash = (n) => '0x' + BigInt(n).toString(16).padStart(64, '0');
export const header = (number, day, parent = BigInt(number) - 1n, seconds = 10) => ({
  number: String(number),
  hash: hash(number),
  parentHash: hash(parent),
  timestamp: String(dayStartSeconds(day) + BigInt(seconds)),
});
export function sources(value) {
  return [
    { id: 'fixture-one', operator: 'fixture-one', value },
    { id: 'fixture-two', operator: 'fixture-two', value: structuredClone(value) },
  ];
}
export const initial = {
  checkpoint: header(100, 10),
  contract: CONTRACT,
  codeHash: CODE,
  finality: 'confirmed',
  shareRate: '100000',
  circulating: '3000',
  balances: [
    { address: A, hearts: '2000' },
    { address: B, hearts: '1000' },
  ],
};
export const transfer = (sender, recipient, hearts) => ({
  kind: 'transfer',
  sender,
  recipient,
  hearts: String(hearts),
});
export const start = (stakeId, address, principal, shares, days) => ({
  kind: 'stake_start',
  stakeId: String(stakeId),
  address,
  principal: String(principal),
  shares: String(shares),
  days,
  auto: false,
});
export const end = (stakeId, address, payout, penalty, servedDays, prevUnlocked = false) => ({
  kind: 'stake_end',
  stakeId: String(stakeId),
  address,
  payout: String(payout),
  penalty: String(penalty),
  servedDays,
  prevUnlocked,
});
export async function batch(client, values = [], day, chainId = 1) {
  const {
    rows: [s],
  } = await client.query('SELECT * FROM hdd.sync_state WHERE chain_id=$1', [chainId]);
  const {
    rows: [state],
  } = await client.query('SELECT * FROM hdd.current_state WHERE chain_id=$1', [chainId]);
  const number = BigInt(s.block_number) + 1n;
  const h = header(number, day ?? state.contract_day, BigInt(s.block_number));
  h.parentHash = '0x' + s.block_hash.toString('hex');
  if (BigInt(h.timestamp) <= BigInt(s.block_time)) h.timestamp = String(BigInt(s.block_time) + 1n);
  const events = values.map((value, i) => ({
    originChainId: chainId,
    contract: CONTRACT,
    blockNumber: h.number,
    blockHash: h.hash,
    blockTime: h.timestamp,
    transactionHash: hash(number * 100n),
    transactionIndex: 0,
    logIndex: i,
    topics: [hash(999)],
    data: '0x',
    value,
  }));
  const closes = [];
  const balances = [];
  for (const address of state.sampled_addresses) {
    const {
      rows: [a],
    } = await client.query(
      'SELECT liquid_hearts FROM hdd.accounts WHERE chain_id=$1 AND address=$2',
      [chainId, address],
    );
    balances.push({ address: '0x' + address.toString('hex'), hearts: a?.liquid_hearts ?? '0' });
  }
  for (let d = state.contract_day; d < (day ?? state.contract_day); d++)
    closes.push({
      day: d,
      blockNumber: s.block_number,
      blockHash: '0x' + s.block_hash.toString('hex'),
      circulating: state.circulating_hearts,
      locked: state.locked_hearts,
      balances: d === state.contract_day ? balances : [],
    });
  const content = { headers: [h], events, closes, payouts: [] };
  return {
    chainId,
    contract: CONTRACT,
    expected: {
      blockNumber: s.block_number,
      blockHash: '0x' + s.block_hash.toString('hex'),
      revision: s.revision,
    },
    sources: [
      { id: 'fixture-one', operator: 'fixture-one', ...content },
      { id: 'fixture-two', operator: 'fixture-two', ...structuredClone(content) },
    ],
  };
}
