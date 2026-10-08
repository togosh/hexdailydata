// Synthetic decoded input, not RPC evidence. Adapted from archived tests/sql/fixtures.mjs.
import { CanonicalWriter } from '../../dist/services/projections/writer.js';
import { connect, databaseConfig } from '../../dist/db/connect.js';
import { totalColumns } from '../../dist/services/projections/reduce.js';
export const A = '0x' + 'ab'.repeat(20),
  B = '0x' + '22'.repeat(20),
  C = '0x' + '33'.repeat(20),
  ZERO = '0x' + '00'.repeat(20);
export const CONTRACT = '0x' + 'cd'.repeat(20),
  CODE = '0x' + 'ef'.repeat(32),
  LARGE = '900719925474099312345678';
export const hash = (n) => '0x' + BigInt(n).toString(16).padStart(64, '0');
const hex = (b) => '0x' + b.toString('hex');
export const header = (n, day = 10, seconds = 10) => ({
  number: String(n),
  hash: hash(n),
  parentHash: hash(BigInt(n) - 1n),
  timestamp: String(1575331200n + BigInt(day) * 86400n + BigInt(seconds)),
});
export const sources = (value) => [
  { id: 'synthetic-one', operator: 'lab-one', value },
  { id: 'synthetic-two', operator: 'lab-two', value: structuredClone(value) },
];
export const start = (stakeId, address = A, principal = '1000', shares = '500', days = 1) => ({
  kind: 'stake_start',
  stakeId: String(stakeId),
  address,
  principal,
  shares,
  days,
  auto: false,
});
export const end = (
  stakeId,
  address = A,
  payout = '0',
  penalty = '0',
  servedDays = 0,
  prevUnlocked = false,
) => ({
  kind: 'stake_end',
  stakeId: String(stakeId),
  address,
  payout,
  penalty,
  servedDays,
  prevUnlocked,
});
export const transfer = (sender, recipient, hearts) => ({
  kind: 'transfer',
  sender,
  recipient,
  hearts,
});
export const ga = (stakeId, payout = '5') => ({
  kind: 'good_accounting',
  stakeId: String(stakeId),
  address: A,
  payout,
  penalty: '0',
});
export async function batch(client, values = [], day, chainId = 369, branch = 0) {
  const {
    rows: [s],
  } = await client.query('SELECT * FROM hdd.sync_state WHERE chain_id=$1', [chainId]);
  const {
    rows: [state],
  } = await client.query('SELECT * FROM hdd.current_state WHERE chain_id=$1', [chainId]);
  const n = BigInt(s.block_number) + 1n,
    h = header(n, day ?? state.contract_day);
  h.hash = hash(n + BigInt(branch) * 1000000n);
  h.parentHash = hex(s.block_hash);
  if (BigInt(h.timestamp) <= BigInt(s.block_time)) h.timestamp = String(BigInt(s.block_time) + 1n);
  const events = values.map((value, i) => ({
    originChainId: chainId,
    contract: CONTRACT,
    blockNumber: h.number,
    blockHash: h.hash,
    transactionHash: hash(n * 10000n + BigInt(branch) * 100000000n + BigInt(Math.floor(i / 2))),
    transactionIndex: Math.floor(i / 2),
    logIndex: i,
    blockTime: h.timestamp,
    topics: [hash(999)],
    data: '0x',
    value,
  }));
  const balances = [];
  for (const address of state.sampled_addresses) {
    const {
      rows: [a],
    } = await client.query(
      'SELECT liquid_hearts FROM hdd.accounts WHERE chain_id=$1 AND address=$2',
      [chainId, address],
    );
    balances.push({ address: hex(address), hearts: a?.liquid_hearts ?? '0' });
  }
  const closes = [];
  for (let d = state.contract_day; d < (day ?? state.contract_day); d++)
    closes.push({
      day: d,
      blockNumber: s.block_number,
      blockHash: hex(s.block_hash),
      circulating: state.circulating_hearts,
      locked: state.locked_hearts,
      balances: d === state.contract_day ? balances : [],
    });
  const {
    rows: [previous],
  } = await client.query('SELECT * FROM hdd.blocks_recent WHERE chain_id=$1 AND number=$2', [
    chainId,
    s.block_number,
  ]);
  const content = {
    next: null,
    previous: {
      number: previous.number,
      hash: hex(previous.hash),
      parentHash: hex(previous.parent_hash),
      timestamp: previous.timestamp,
    },
    headers: [h],
    events,
    closes,
    payouts: [],
  };
  return {
    chainId,
    contract: CONTRACT,
    expected: { blockNumber: s.block_number, blockHash: hex(s.block_hash), revision: s.revision },
    range: { fromBlock: h.number, toBlock: h.number },
    sources: [
      { id: 'synthetic-one', operator: 'lab-one', ...content },
      { id: 'synthetic-two', operator: 'lab-two', ...structuredClone(content) },
    ],
  };
}
export async function acquire(chain) {
  const client = await connect(databaseConfig('worker'));
  return { client, writer: await CanonicalWriter.acquire(client, chain) };
}
export async function commit(pair, values = [], day, branch = 0) {
  const input = await batch(pair.client, values, day, pair.writer.chainId, branch);
  const result = await pair.writer.commit(input);
  return { input, result };
}
export async function expectedCursor(client, chain = 369) {
  const {
    rows: [s],
  } = await client.query('SELECT * FROM hdd.sync_state WHERE chain_id=$1', [chain]);
  return { blockNumber: s.block_number, blockHash: hex(s.block_hash), revision: s.revision };
}
export async function bootstrap({ inherited = true, beforeNative = async () => {} } = {}) {
  const first = header(100),
    parent = inherited ? header(101, 10, 11) : first;
  const entry = header(BigInt(parent.number) + 1n, 10, inherited ? 12 : 11);
  const common = {
    transportChainId: 369,
    constructor: first,
    transactionHash: hash(10000),
    parent,
    entry,
  };
  const providers = [
    { id: 'synthetic-one', operator: 'lab-one', accountGroup: null, endpointAlias: null },
    { id: 'synthetic-two', operator: 'lab-two', accountGroup: null, endpointAlias: null },
  ];
  const binding = (originChainId) => ({
    version: 1,
    networkChainId: 369,
    originChainId,
    contract: CONTRACT,
    codeHash: CODE,
    common,
  });
  const history = (chain) => ({
    startBlock: chain === 1 ? first.number : entry.number,
    startHash: chain === 1 ? first.hash : entry.hash,
    startTime: chain === 1 ? first.timestamp : entry.timestamp,
    finalityPolicy: { kind: 'synthetic-confirmed' },
    binding: binding(chain),
    providers,
  });
  const commonPair = await acquire(1);
  await commonPair.writer.initialize(
    'constructor',
    sources({
      checkpoint: first,
      contract: CONTRACT,
      codeHash: CODE,
      finality: 'confirmed',
      shareRate: '100000',
      circulating: (BigInt(LARGE) * 2n).toString(),
      balances: [
        { address: A, hearts: LARGE },
        { address: B, hearts: LARGE },
      ],
    }),
    history(1),
  );
  const inheritedEvents = [];
  if (inherited) {
    const r = await commit(
      commonPair,
      [transfer(A, ZERO, LARGE), start(1, A, LARGE, LARGE, 1)],
      10,
    );
    inheritedEvents.push(...r.input.sources[0].events.filter((e) => e.value.kind !== 'transfer'));
  }
  await commonPair.writer.close();
  await beforeNative();
  const native = await acquire(369);
  const {
    rows: [s],
  } = await native.client.query('SELECT * FROM hdd.current_state WHERE chain_id=1');
  await native.writer.initialize(
    'fork',
    sources({
      checkpoint: entry,
      parent,
      contract: CONTRACT,
      codeHash: CODE,
      finality: 'confirmed',
      shareRate: '100000',
      expected: Object.fromEntries(totalColumns.map((k) => [k, s[k]])),
    }),
    history(369),
  );
  return { native, inheritedEvents, common };
}
