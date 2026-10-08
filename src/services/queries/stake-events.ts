import { z } from 'zod';
import type { QueryResultRow } from 'pg';
import { ApiFailure, unavailable } from '../../api/errors.ts';
import type { StakeEventsSelection } from '../../contracts/stake-events.ts';
import { integer, hash, eventSchema, digest, hex } from '../projections/input.ts';
import { validateSourceHistory } from '../projections/provenance.ts';
import type { ReadDatabase } from './database.ts';

const SCAN_MAX = 200;
const Upper = z.strictObject({
  number: integer,
  hash,
  timestamp: integer,
  finality: z.enum(['confirmed', 'finalized']),
});
const Position = z.strictObject({
  block: integer,
  log: z.number().int().min(0).max(2147483647),
  hash,
});
const Token = z
  .strictObject({
    v: z.literal(1),
    mode: z.enum(['page', 'progress']),
    instance: z.uuid(),
    binding: z.string().length(64),
    selection: z.string().length(64),
    upper: Upper,
    position: Position.nullable(),
  })
  .refine((t) => (t.mode === 'progress') === (t.position === null));
const encode = (token: z.input<typeof Token>) =>
  Buffer.from(JSON.stringify(Token.parse(token))).toString('base64url');
const decode = (cursor: string) =>
  Token.parse(JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8')));
const invalid = () =>
  new ApiFailure(400, 'invalid_request', 'Malformed or inconsistent selection/position.');
const reset = () =>
  new ApiFailure(
    409,
    'reset_required',
    'Continuation proof is unavailable or changed; explicitly reset and replay.',
  );
const fingerprint = (q: StakeEventsSelection) =>
  digest({
    chain: q.chain,
    fromBlock: q.fromBlock,
    address: q.address ?? null,
    stakeId: q.stakeId ?? null,
    kind: q.kind ?? null,
    limit: q.limit,
  });

// Both disjoint origins use existing primary-key range scans. Address/kind selection
// is evaluated AFTER a bounded raw scan, so an empty page can carry honest progress.
export const activitySql = `WITH candidates AS MATERIALIZED (
 (SELECT * FROM hdd.events WHERE origin_chain_id=1 AND block_number<=$1
  AND block_number>=$2 AND (block_number,log_index)>($3::bigint,$4::int)
  AND block_number<=$5 ORDER BY block_number,log_index LIMIT 201)
 UNION ALL
 (SELECT * FROM hdd.events WHERE origin_chain_id=369 AND block_number>$1
  AND block_number>=$2 AND (block_number,log_index)>($3::bigint,$4::int)
  AND block_number<=$5 ORDER BY block_number,log_index LIMIT 201)
), scanned AS MATERIALIZED (SELECT * FROM candidates ORDER BY block_number,log_index LIMIT 201)
SELECT origin_chain_id,block_number,log_index,block_hash,transaction_hash,transaction_index,block_time,kind,stake_id,payload,
 (kind IN ('stake_start','good_accounting','stake_end')
  AND ($6::text IS NULL OR payload->'value'->>'address'=$6)
  AND ($7::bigint IS NULL OR stake_id=$7)
  AND ($8::text IS NULL OR kind=$8)) AS matches
FROM scanned ORDER BY block_number,log_index`;

function serialize(row: QueryResultRow, contract: string) {
  const e = eventSchema.parse(row.payload),
    value = e.value;
  if (
    e.contract !== contract ||
    e.originChainId !== row.origin_chain_id ||
    e.blockNumber !== row.block_number ||
    e.blockHash !== hex(row.block_hash) ||
    e.logIndex !== row.log_index ||
    e.blockTime !== row.block_time ||
    e.transactionHash !== hex(row.transaction_hash) ||
    e.transactionIndex !== row.transaction_index ||
    value.kind !== row.kind ||
    !('stakeId' in value) ||
    value.stakeId !== row.stake_id
  )
    throw unavailable();
  const amounts =
    value.kind === 'stake_start'
      ? {
          principalHearts: value.principal,
          stakeShares: value.shares,
          stakedDays: value.days,
          isAutoStake: value.auto,
        }
      : {
          payoutHearts: value.payout,
          penaltyHearts: value.penalty,
          principalHearts: value.principal ?? null,
          stakeShares: value.shares ?? null,
          ...(value.kind === 'stake_end'
            ? { servedDays: value.servedDays, previouslyUnlocked: value.prevUnlocked }
            : {}),
        };
  return {
    eventId: `${e.originChainId}:${e.blockHash}:${e.logIndex}`,
    originChainId: e.originChainId,
    blockNumber: e.blockNumber,
    blockHash: e.blockHash,
    transactionHash: e.transactionHash,
    transactionIndex: e.transactionIndex,
    logIndex: e.logIndex,
    timestamp: new Date(Number(BigInt(e.blockTime) * 1000n)).toISOString(),
    stakeId: value.stakeId,
    address: value.address,
    kind: value.kind,
    amounts,
  };
}

export async function stakeEvents(db: ReadDatabase, q: StakeEventsSelection, signal: AbortSignal) {
  let token;
  try {
    token = q.cursor ? decode(q.cursor) : null;
  } catch {
    throw invalid();
  }
  const selection = fingerprint(q);
  if (token && token.selection !== selection) throw reset();
  return db.read(
    signal,
    async (client) => {
      // A database failure during provenance validation is unavailable, not evidence
      // that a client's checkpoint must be reset. Keep the validator's SQL unchanged.
      let queryFailed = false;
      const sql = new Proxy(client, {
        get(target, key) {
          if (key === 'query')
            return async (text: string, values?: unknown[]) => {
              try {
                return await target.query(text, values);
              } catch (error) {
                queryFailed = true;
                throw error;
              }
            };
          return Reflect.get(target, key);
        },
      });
      const {
        rows: [state],
      } = await sql.query(`SELECT s.*,c.parent_block,c.parent_hash,c.entry_block,
      (SELECT instance::text FROM hdd_identity.instance WHERE singleton) AS instance
      FROM hdd.sync_state s JOIN hdd.chains c USING(chain_id) WHERE s.chain_id=369 AND c.initialization='fork'`);
      if (!state) throw unavailable();
      let native, parent;
      try {
        parent = await validateSourceHistory(sql, 1);
        native = await validateSourceHistory(sql, 369);
      } catch {
        if (queryFailed || signal.aborted) throw unavailable();
        throw token ? reset() : unavailable();
      }
      if (!native.binding.common || !parent.binding.common) throw unavailable();
      const binding = digest({ parent: parent.binding, native: native.binding });
      if (token && (token.instance !== state.instance || token.binding !== binding)) throw reset();
      async function prove(upper: z.infer<typeof Upper>) {
        if (upper.finality === 'finalized' && state.finality !== 'finalized') throw reset();
        if (BigInt(upper.number) > BigInt(state.block_number)) throw reset();
        const {
          rows: [h],
        } = await sql.query(
          'SELECT hash,timestamp FROM hdd.blocks_recent WHERE chain_id=369 AND number=$1',
          [upper.number],
        );
        if (!h) throw reset();
        if (hex(h.hash) !== upper.hash || h.timestamp !== upper.timestamp) throw reset();
      }
      if (token) await prove(token.upper);
      const upper =
        token?.mode === 'page'
          ? token.upper
          : {
              number: state.block_number,
              hash: hex(state.block_hash),
              timestamp: state.block_time,
              finality: state.finality,
            };
      await prove(upper);
      if (BigInt(q.fromBlock) > BigInt(upper.number)) throw invalid();
      const lower =
        BigInt(q.fromBlock) > BigInt(parent.binding.common.constructor.number)
          ? q.fromBlock
          : parent.binding.common.constructor.number;
      let position = token?.mode === 'page' ? token.position : null;
      if (position) {
        if (BigInt(position.block) < BigInt(lower) || BigInt(position.block) > BigInt(upper.number))
          throw invalid();
        const origin = BigInt(position.block) <= BigInt(state.parent_block) ? 1 : 369;
        const {
          rows: [proof],
        } = await sql.query(
          'SELECT block_hash FROM hdd.events WHERE origin_chain_id=$1 AND block_number=$2 AND log_index=$3',
          [origin, position.block, position.log],
        );
        if (!proof || hex(proof.block_hash) !== position.hash) throw reset();
      }
      const after =
        position ??
        (token?.mode === 'progress'
          ? { block: token.upper.number, log: 2147483647 }
          : { block: lower, log: -1 });
      const values = [
        state.parent_block,
        lower,
        after.block,
        after.log,
        upper.number,
        q.address ?? null,
        q.stakeId ?? null,
        q.kind ?? null,
      ];
      const { rows } = await sql.query(activitySql, values);
      const items = [];
      let examined = 0;
      for (const row of rows) {
        if (examined === SCAN_MAX || items.length === q.limit) break;
        examined++;
        position = { block: row.block_number, log: row.log_index, hash: hex(row.block_hash) };
        if (row.matches) items.push(serialize(row, native.binding.contract));
      }
      const caughtUp = examined === rows.length;
      const next = {
        v: 1 as const,
        mode: caughtUp ? ('progress' as const) : ('page' as const),
        instance: state.instance,
        binding,
        selection,
        upper,
        position: caughtUp ? null : position,
      };
      return {
        chain: 'pulsechain',
        coverageStartBlock: parent.binding.common.constructor.number,
        cutoff: {
          blockNumber: upper.number,
          blockHash: upper.hash,
          blockTimestamp: new Date(Number(BigInt(upper.timestamp) * 1000n)).toISOString(),
          finality: upper.finality,
        },
        items,
        caughtUp,
        scannedEvents: examined,
        nextCursor: encode(next),
      };
    },
    true,
  );
}
