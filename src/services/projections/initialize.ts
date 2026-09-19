import { query as measuredQuery } from '../../db/measure.ts';
import type pg from 'pg';
import { z } from 'zod';
import { contractDayAt } from '../../domain/day.ts';
import { bytes, hex, headerSchema, address, hash, uint, total, type Header } from './input.ts';
import { totalColumns, readCurrent } from './reduce.ts';

const identity = z.strictObject({
  checkpoint: headerSchema,
  contract: address,
  codeHash: hash,
  finality: z.enum(['confirmed', 'finalized']),
  shareRate: uint.refine((v) => BigInt(v) > 0n),
});
const constructorSchema = identity.extend({
  balances: z
    .array(z.strictObject({ address, hearts: uint.refine((v) => BigInt(v) > 0n) }))
    .max(10000),
  circulating: uint,
});
export type ConstructorInput = z.infer<typeof constructorSchema>;
export async function initializeConstructor(client: pg.Client, input: unknown) {
  const value = constructorSchema.parse(input);
  const balances = new Map(value.balances.map((b) => [b.address, b.hearts]));
  if (
    balances.size !== value.balances.length ||
    balances.has('0x' + '0'.repeat(40)) ||
    value.balances.reduce((sum, b) => sum + BigInt(b.hearts), 0n) !== BigInt(value.circulating)
  )
    throw new Error('Invalid constructor mint/supply.');
  await measuredQuery(
    client,
    `INSERT INTO hdd.chains(chain_id,contract_address,code_hash,initialization,origin_chain_id) VALUES(1,$1,$2,'constructor',1)`,
    [bytes(value.contract), bytes(value.codeHash)],
  );
  await insertSync(client, 1, value.checkpoint, value.finality, {
    initialization: 'constructor',
    balanceCount: balances.size,
  });
  for (const balance of value.balances)
    await measuredQuery(client, 'INSERT INTO hdd.accounts VALUES(1,$1,$2,0,0,$3,$3)', [
      bytes(balance.address),
      balance.hearts,
      value.checkpoint.number,
    ]);
  await measuredQuery(
    client,
    `INSERT INTO hdd.current_state VALUES(1,$1,$2,0,0,0,0,0,$3,0,$4,0,0,0,0)`,
    [
      contractDayAt(BigInt(value.checkpoint.timestamp)),
      value.circulating,
      balances.size,
      value.shareRate,
    ],
  );
}
async function insertSync(
  client: pg.Client,
  chain: number,
  h: Header,
  finality: string,
  acceptance: unknown,
) {
  await measuredQuery(client, 'INSERT INTO hdd.sync_state VALUES($1,$2,$3,$4,0,$5,$2,$6,NULL)', [
    chain,
    h.number,
    bytes(h.hash),
    h.timestamp,
    finality,
    JSON.stringify(acceptance),
  ]);
  await measuredQuery(client, 'INSERT INTO hdd.blocks_recent VALUES($1,$2,$3,$4,$5)', [
    chain,
    h.number,
    bytes(h.hash),
    bytes(h.parentHash),
    h.timestamp,
  ]);
}
const forkSchema = identity.extend({
  parent: headerSchema,
  expected: z.strictObject(
    Object.fromEntries(totalColumns.map((k) => [k, total])) as Record<
      (typeof totalColumns)[number],
      typeof total
    >,
  ),
});
/** Copies one necessary serving projection, never the common origin event history.
 * Provider/code/boundary acquisition and full external reconciliation remain the acquirer's job.
 */
export async function initializeFork(client: pg.Client, input: unknown) {
  const value = forkSchema.parse(input);
  const {
    rows: [lock],
  } = await measuredQuery(client, 'SELECT pg_try_advisory_xact_lock(4242,1) AS acquired');
  if (!lock.acquired) throw new Error('Parent writer busy.');
  const {
    rows: [parent],
  } = await measuredQuery(client, 'SELECT * FROM hdd.sync_state WHERE chain_id=1 FOR UPDATE');
  if (
    !parent ||
    parent.block_number !== value.parent.number ||
    hex(parent.block_hash) !== value.parent.hash ||
    parent.block_time !== value.parent.timestamp ||
    BigInt(value.checkpoint.number) !== BigInt(parent.block_number) + 1n ||
    value.checkpoint.parentHash !== value.parent.hash ||
    BigInt(value.checkpoint.timestamp) <= BigInt(parent.block_time)
  )
    throw new Error('Fork boundary/state mismatch; replay to the boundary first.');
  const {
    rows: [chain],
  } = await measuredQuery(client, 'SELECT * FROM hdd.chains WHERE chain_id=1');
  if (hex(chain.contract_address) !== value.contract || hex(chain.code_hash) !== value.codeHash)
    throw new Error('Fork contract/code mismatch.');
  const {
    rows: [current],
  } = await measuredQuery(client, 'SELECT * FROM hdd.current_state WHERE chain_id=1');
  for (const key of totalColumns)
    if (current[key] !== value.expected[key]) throw new Error(`Fork aggregate mismatch: ${key}`);
  if (current.raw_share_rate !== value.shareRate) throw new Error('Fork share rate mismatch.');
  await reconcile(client, 1);
  await measuredQuery(client, `INSERT INTO hdd.chains VALUES(369,$1,$2,'fork',369,$3,$4,$5,$6)`, [
    bytes(value.contract),
    bytes(value.codeHash),
    value.parent.number,
    bytes(value.parent.hash),
    value.checkpoint.number,
    bytes(value.checkpoint.hash),
  ]);
  // The inherited cursor is BEFORE the first native block. That block's events must
  // pass the ordinary commit path; initialization must never silently skip them.
  await insertSync(client, 369, value.parent, value.finality, {
    initialization: 'fork',
    parentBlock: value.parent.number,
    parentHash: value.parent.hash,
  });
  // Column lists are read from the fixed migration tables. One initialization copy is O(state), not O(days).
  for (const table of ['accounts', 'stakes', 'share_schedule', 'current_state', 'daily_stats']) {
    const { rows } = await measuredQuery(
      client,
      `SELECT column_name FROM information_schema.columns WHERE table_schema='hdd' AND table_name=$1 ORDER BY ordinal_position`,
      [table],
    );
    const columns = rows.map((r) => r.column_name as string);
    await measuredQuery(
      client,
      `INSERT INTO hdd.${table}(${columns.join(',')}) SELECT ${columns.map((c) => (c === 'chain_id' ? '369' : c)).join(',')} FROM hdd.${table} WHERE chain_id=1`,
    );
  }
  await reconcile(client, 369);
}
/** Initialization/checkpoint audit only; ordinary commits and reads do not scan all state. */
export async function reconcile(client: pg.Client, chain: number) {
  const {
    rows: [raw],
  } = await measuredQuery(client, 'SELECT * FROM hdd.current_state WHERE chain_id=$1', [chain]);
  if (!raw) throw new Error('Missing current state.');
  const current = readCurrent(raw);
  const {
    rows: [accounts],
  } = await measuredQuery(
    client,
    `SELECT coalesce(sum(liquid_hearts),0)::text AS supply,
 count(*) FILTER(WHERE liquid_hearts>0)::text AS holders,count(*) FILTER(WHERE stake_count>0)::text AS stakers,
 coalesce(sum(accounted_hearts),0)::text AS principal,coalesce(sum(stake_count),0)::text AS stakes FROM hdd.accounts WHERE chain_id=$1`,
    [chain],
  );
  const {
    rows: [stakes],
  } = await measuredQuery(
    client,
    `SELECT
 coalesce(sum(principal_hearts) FILTER(WHERE lifecycle IN ('unsettled','good_accounted')),0)::text AS locked,
 coalesce(sum(principal_hearts) FILTER(WHERE lifecycle='unsettled'),0)::text AS principal,
 coalesce(sum(principal_hearts*staked_days) FILTER(WHERE lifecycle='unsettled'),0)::text AS weighted,
 coalesce(sum(stake_shares) FILTER(WHERE lifecycle='unsettled' AND locked_day<=$2),0)::text AS active,
 coalesce(sum(stake_shares) FILTER(WHERE lifecycle='unsettled' AND locked_day>$2),0)::text AS queued,
 count(*) FILTER(WHERE lifecycle='unsettled')::text AS stakes FROM hdd.stakes WHERE chain_id=$1`,
    [chain, current.contract_day],
  );
  const pairs: [bigint, string][] = [
    [current.circulating_hearts, accounts.supply],
    [current.holder_count, accounts.holders],
    [current.staker_count, accounts.stakers],
    [current.accounted_hearts, accounts.principal],
    [current.accounted_hearts, stakes.principal],
    [current.locked_hearts, stakes.locked],
    [current.weighted_days, stakes.weighted],
    [current.active_shares, stakes.active],
    [current.queued_shares, stakes.queued],
    [BigInt(accounts.stakes), stakes.stakes],
  ];
  if (pairs.some(([a, b]) => a !== BigInt(b)))
    throw new Error('SQL balance/stake aggregate reconciliation failed.');
  const {
    rows: [owners],
  } = await measuredQuery(
    client,
    `WITH s AS (SELECT address,sum(principal_hearts) AS principal,count(*) AS count FROM hdd.stakes WHERE chain_id=$1 AND lifecycle='unsettled' GROUP BY address)
 SELECT count(*)::text AS errors FROM (SELECT address,accounted_hearts,stake_count FROM hdd.accounts WHERE chain_id=$1) a FULL JOIN s USING(address)
 WHERE coalesce(a.accounted_hearts,0)<>coalesce(s.principal,0) OR coalesce(a.stake_count,0)<>coalesce(s.count,0)`,
    [chain],
  );
  if (owners.errors !== '0') throw new Error('SQL owner reconciliation failed.');
  const {
    rows: [schedule],
  } = await measuredQuery(
    client,
    `WITH s AS (SELECT locked_day,sum(stake_shares) AS shares FROM hdd.stakes WHERE chain_id=$1 AND lifecycle='unsettled' AND locked_day>$2 GROUP BY locked_day)
 SELECT count(*)::text AS errors FROM (SELECT activation_day,shares FROM hdd.share_schedule WHERE chain_id=$1) q FULL JOIN s ON q.activation_day=s.locked_day
 WHERE q.activation_day IS NULL OR s.locked_day IS NULL OR q.shares<>s.shares`,
    [chain, current.contract_day],
  );
  if (schedule.errors !== '0') throw new Error('SQL activation schedule reconciliation failed.');
}
