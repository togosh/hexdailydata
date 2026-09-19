import type pg from 'pg';
import { contractDayAt } from '../../domain/day.ts';
import { validateBatch, bytes, hex, digest, type Batch } from './input.ts';
import { readCurrent, saveCurrent, closeDay, applyEvent, applyPayout } from './reduce.ts';
import { initializeConstructor, initializeFork } from './initialize.ts';

const rewindTables: Record<string, string[]> = {
  accounts: ['chain_id', 'address'],
  stakes: ['chain_id', 'stake_id'],
  current_state: ['chain_id'],
  share_schedule: ['chain_id', 'activation_day'],
  daily_stats: ['chain_id', 'contract_day'],
  events: ['origin_chain_id', 'block_number', 'log_index'],
  transfers_recent: ['origin_chain_id', 'block_number', 'log_index'],
  blocks_recent: ['chain_id', 'number'],
};
const ownedConnections = new WeakSet<pg.Client>();
export interface FaultHooks {
  /** Test harness fault injection only; not a validation bypass or provider callback. */
  beforeCommit?: () => Promise<void>;
  afterCommit?: () => Promise<void>;
}
export class CanonicalWriter {
  private dead = false;
  private busy = false;
  private client: pg.Client;
  readonly chainId: 1 | 369;
  private constructor(client: pg.Client, chainId: 1 | 369) {
    this.client = client;
    this.chainId = chainId;
    client.on('error', () => {
      this.dead = true;
    });
    client.on('end', () => {
      this.dead = true;
    });
  }
  static async acquire(client: pg.Client, chainId: 1 | 369) {
    if (ownedConnections.has(client)) throw new Error('Connection already belongs to a writer.');
    const {
      rows: [role],
    } = await client.query('SELECT current_user AS name');
    if (role.name !== 'hdd_v2_worker') throw new Error('Dedicated worker role required.');
    const {
      rows: [lock],
    } = await client.query('SELECT pg_try_advisory_lock(4242,$1) AS acquired', [chainId]);
    if (!lock.acquired) throw new Error('Canonical writer already active.');
    ownedConnections.add(client);
    return new CanonicalWriter(client, chainId);
  }
  async close() {
    this.dead = true;
    await this.client.end();
  }
  private async transaction<T>(work: () => Promise<T>, hooks: FaultHooks = {}): Promise<T> {
    if (this.dead || this.busy)
      throw new Error('Writer connection lost or busy; acquire a new writer explicitly.');
    this.busy = true;
    try {
      await this.client.query('BEGIN');
      const {
        rows: [lock],
      } = await this.client.query(
        `SELECT EXISTS(SELECT 1 FROM pg_locks WHERE pid=pg_backend_pid() AND locktype='advisory'
       AND classid=4242 AND objid=$1 AND objsubid=2 AND granted) AS held`,
        [this.chainId],
      );
      if (!lock.held) {
        this.dead = true;
        throw new Error('Canonical writer lock lost.');
      }
      const result = await work();
      await hooks.beforeCommit?.();
      await this.client.query('COMMIT');
      await hooks.afterCommit?.();
      return result;
    } catch (error) {
      await this.client.query('ROLLBACK').catch(() => {
        this.dead = true;
      });
      throw error;
    } finally {
      this.busy = false;
    }
  }
  /** Both inputs are decoded source states; no boolean "accepted" shortcut. */
  async initialize(
    kind: 'constructor' | 'fork',
    sources: [
      { id: string; operator: string | null; value: unknown },
      { id: string; operator: string | null; value: unknown },
    ],
  ) {
    const [a, b] = sources;
    if (
      !a.id ||
      !b.id ||
      a.id === b.id ||
      (a.operator !== null && a.operator === b.operator) ||
      digest(a.value) !== digest(b.value)
    )
      throw new Error('Initialization source disagreement/identity.');
    if ((kind === 'constructor' && this.chainId !== 1) || (kind === 'fork' && this.chainId !== 369))
      throw new Error('Wrong initialization chain.');
    return this.transaction(async () => {
      const { rows } = await this.client.query(
        'SELECT chain_id FROM hdd.chains WHERE chain_id=$1',
        [this.chainId],
      );
      if (rows.length) throw new Error('Initialization requires empty chain target.');
      if (kind === 'constructor') await initializeConstructor(this.client, a.value);
      else await initializeFork(this.client, a.value);
      await this.client.query(
        `UPDATE hdd.sync_state SET acceptance=acceptance || $2::jsonb WHERE chain_id=$1`,
        [
          this.chainId,
          JSON.stringify({
            sources: sources.map((s) => ({ id: s.id, operator: s.operator })),
            stateDigest: digest(a.value),
          }),
        ],
      );
    });
  }
  async commit(input: unknown, hooks: FaultHooks = {}) {
    const accepted = validateBatch(input),
      { batch, headers, events, closes, payouts, last, batchDigest, acceptance } = accepted;
    if (batch.chainId !== this.chainId) throw new Error('Wrong writer chain.');
    return this.transaction(async () => {
      const {
        rows: [sync],
      } = await this.client.query('SELECT * FROM hdd.sync_state WHERE chain_id=$1 FOR UPDATE', [
        this.chainId,
      ]);
      if (!sync) throw new Error('Chain not initialized.');
      const {
        rows: [receipt],
      } = await this.client.query(
        'SELECT batch_digest FROM hdd.checkpoints_recent WHERE chain_id=$1 AND block_number=$2',
        [this.chainId, last.number],
      );
      if (receipt) {
        if (receipt.batch_digest !== batchDigest)
          throw new Error('Conflicting duplicate batch payload.');
        return { replayed: true, block: last.number };
      }
      if (
        this.chainId === 1 &&
        (await this.client.query("SELECT 1 FROM hdd.chains WHERE initialization='fork'")).rowCount
      )
        throw new Error('Common parent history is frozen after fork initialization.');
      if (
        sync.block_number !== batch.expected.blockNumber ||
        hex(sync.block_hash) !== batch.expected.blockHash ||
        sync.revision !== batch.expected.revision
      )
        throw new Error('Stale cursor CAS.');
      const {
        rows: [chain],
      } = await this.client.query('SELECT * FROM hdd.chains WHERE chain_id=$1', [this.chainId]);
      if (
        hex(chain.contract_address) !== batch.contract ||
        BigInt(headers[0]!.timestamp) <= BigInt(sync.block_time)
      )
        throw new Error('Contract/time mismatch.');
      if (
        chain.initialization === 'fork' &&
        sync.block_number === chain.parent_block &&
        (headers[0]!.number !== chain.entry_block || headers[0]!.hash !== hex(chain.entry_hash))
      )
        throw new Error('First native block differs from the fork entry identity.');
      const {
        rows: [raw],
      } = await this.client.query('SELECT * FROM hdd.current_state WHERE chain_id=$1', [
        this.chainId,
      ]);
      const state = readCurrent(raw),
        finalDay = contractDayAt(BigInt(last.timestamp));
      if (finalDay - state.contract_day > 32) throw new Error('Split range at 32 day boundaries.');
      const revision = (BigInt(sync.revision) + 1n).toString();
      await this.client.query(
        `INSERT INTO hdd.checkpoints_recent(chain_id,revision,block_number,block_time,batch_digest,previous_sync)
       SELECT chain_id,$2,$3,$4,$5,to_jsonb(s) FROM hdd.sync_state s WHERE chain_id=$1`,
        [this.chainId, revision, last.number, last.timestamp, batchDigest],
      );
      await this.client.query(
        "SELECT set_config('hdd.chain',$1,true),set_config('hdd.revision',$2,true)",
        [String(this.chainId), revision],
      );
      let priorBlock = sync.block_number,
        priorHash: Buffer = sync.block_hash,
        eventIndex = 0,
        closeIndex = 0;
      for (const header of headers) {
        const day = contractDayAt(BigInt(header.timestamp));
        while (state.contract_day < day) {
          const close = closes[closeIndex++];
          if (
            !close ||
            close.day !== state.contract_day ||
            close.blockNumber !== priorBlock ||
            close.blockHash !== hex(priorHash) ||
            BigInt(close.circulating) !== state.circulating_hearts ||
            BigInt(close.locked) !== state.locked_hearts
          )
            throw new Error('Missing or mismatched corroborated day-close supply check.');
          if (
            JSON.stringify(close.balances.map((b) => b.address)) !==
            JSON.stringify(state.sampled_addresses)
          )
            throw new Error('Missing deterministic day-close balance sample.');
          for (const balance of close.balances) {
            const {
              rows: [account],
            } = await this.client.query(
              'SELECT liquid_hearts FROM hdd.accounts WHERE chain_id=$1 AND address=$2',
              [this.chainId, bytes(balance.address)],
            );
            if ((account?.liquid_hearts ?? '0') !== balance.hearts)
              throw new Error('Day-close balance sample mismatch.');
          }
          await closeDay(
            this.client,
            this.chainId,
            chain.initialization === 'fork' && BigInt(priorBlock) <= BigInt(chain.parent_block)
              ? 1
              : chain.origin_chain_id,
            state,
            priorBlock,
            priorHash,
          );
        }
        await this.client.query('INSERT INTO hdd.blocks_recent VALUES($1,$2,$3,$4,$5)', [
          this.chainId,
          header.number,
          bytes(header.hash),
          bytes(header.parentHash),
          header.timestamp,
        ]);
        while (events[eventIndex]?.blockNumber === header.number)
          await applyEvent(this.client, this.chainId, state, events[eventIndex++]!);
        for (const payout of payouts.filter((p) => p.blockNumber === header.number))
          await applyPayout(this.client, this.chainId, state.contract_day, payout);
        priorBlock = header.number;
        priorHash = bytes(header.hash);
      }
      if (closeIndex !== closes.length || eventIndex !== events.length)
        throw new Error('Extraneous close/event input.');
      await saveCurrent(this.client, this.chainId, state);
      const { rowCount } = await this.client.query(
        `UPDATE hdd.sync_state SET block_number=$2,block_hash=$3,block_time=$4,revision=$5,acceptance=$6
       WHERE chain_id=$1 AND block_number=$7 AND block_hash=$8 AND revision=$9`,
        [
          this.chainId,
          last.number,
          bytes(last.hash),
          last.timestamp,
          revision,
          JSON.stringify(acceptance),
          batch.expected.blockNumber,
          bytes(batch.expected.blockHash),
          batch.expected.revision,
        ],
      );
      if (rowCount !== 1) throw new Error('Stale cursor CAS.');
      await this.client.query(
        `UPDATE hdd.checkpoints_recent SET undo_bytes=(SELECT coalesce(sum(pg_column_size(u)),0) FROM hdd.undo_recent u WHERE chain_id=$1 AND revision=$2),
        tail_bytes=(SELECT coalesce(sum(pg_column_size(t)),0) FROM hdd.transfers_recent t WHERE origin_chain_id=$1 AND block_number>$3 AND block_number<=$4)
        +(SELECT coalesce(sum(pg_column_size(b)),0) FROM hdd.blocks_recent b WHERE chain_id=$1 AND number>$3 AND number<=$4)
        WHERE chain_id=$1 AND revision=$2`,
        [this.chainId, revision, batch.expected.blockNumber, last.number],
      );
      const {
        rows: [size],
      } = await this.client.query(
        `SELECT count(*)::text AS checkpoints,coalesce(sum(undo_bytes),0)::text AS bytes,coalesce(sum(tail_bytes),0)::text AS tail_bytes FROM hdd.checkpoints_recent WHERE chain_id=$1`,
        [this.chainId],
      );
      // Pressure stops publication; it never discards protected inputs. Task03 owns explicit pruning.
      if (
        BigInt(size.bytes) > 134217728n ||
        BigInt(size.tail_bytes) > 268435456n ||
        BigInt(size.checkpoints) > 4096n
      )
        throw new Error(
          'Recovery retention capacity reached; protected tail must not be discarded.',
        );
      return { replayed: false, block: last.number };
    }, hooks);
  }
  async rewind(targetBlock: string, expected: Batch['expected']) {
    if (!/^(0|[1-9][0-9]*)$/.test(targetBlock)) throw new Error('Invalid rewind target.');
    return this.transaction(async () => {
      const {
        rows: [sync],
      } = await this.client.query('SELECT * FROM hdd.sync_state WHERE chain_id=$1 FOR UPDATE', [
        this.chainId,
      ]);
      if (
        !sync ||
        sync.revision !== expected.revision ||
        sync.block_number !== expected.blockNumber ||
        hex(sync.block_hash) !== expected.blockHash
      )
        throw new Error('Stale rewind CAS.');
      if (sync.finality !== 'confirmed')
        throw new Error('Finalized disagreement requires explicit repair.');
      if (
        this.chainId === 1 &&
        (await this.client.query("SELECT 1 FROM hdd.chains WHERE initialization='fork'")).rowCount
      )
        throw new Error('Common parent history is frozen after fork initialization.');
      if (
        BigInt(targetBlock) < BigInt(sync.rewind_floor) ||
        BigInt(targetBlock) >= BigInt(sync.block_number)
      )
        throw new Error('Outside retained rewind window.');
      const { rows: checkpoints } = await this.client.query(
        `SELECT revision,previous_sync::text FROM hdd.checkpoints_recent
       WHERE chain_id=$1 AND block_number>$2 ORDER BY block_number DESC`,
        [this.chainId, targetBlock],
      );
      const previous = checkpoints.at(-1)?.previous_sync;
      const {
        rows: [boundary],
      } = await this.client.query(
        `SELECT ($1::jsonb->>'block_number')=$2 AS matches,
       $3::bigint-($1::jsonb->>'block_time')::bigint<=604800 AS recent`,
        [previous ?? '{}', targetBlock, sync.block_time],
      );
      if (!boundary.matches || !boundary.recent)
        throw new Error('Target is not a retained checkpoint within seven replay days.');
      await this.client.query("SELECT set_config('hdd.rewinding','yes',true)");
      for (const checkpoint of checkpoints) {
        const { rows } = await this.client.query(
          'SELECT relation_name,row_key::text,previous_value::text FROM hdd.undo_recent WHERE chain_id=$1 AND revision=$2 ORDER BY sequence DESC',
          [this.chainId, checkpoint.revision],
        );
        for (const row of rows) {
          const keys = rewindTables[row.relation_name];
          if (!keys) throw new Error('Unsupported undo relation.');
          const table = `hdd.${row.relation_name}`;
          await this.client.query(
            `DELETE FROM ${table} WHERE ${keys.map((k) => `${k}=(jsonb_populate_record(NULL::${table},$1::jsonb)).${k}`).join(' AND ')}`,
            [row.row_key],
          );
          if (row.previous_value !== null)
            await this.client.query(
              `INSERT INTO ${table} SELECT * FROM jsonb_populate_record(NULL::${table},$1::jsonb)`,
              [row.previous_value],
            );
        }
        await this.client.query(
          'DELETE FROM hdd.checkpoints_recent WHERE chain_id=$1 AND revision=$2',
          [this.chainId, checkpoint.revision],
        );
      }
      // Cursor revision is a fencing token: never reuse it after rewind (prevents ABA).
      await this.client.query(
        `UPDATE hdd.sync_state SET (block_number,block_hash,block_time,finality,rewind_floor,acceptance,ranking_day)=
       (SELECT block_number,block_hash,block_time,finality,rewind_floor,acceptance,ranking_day FROM jsonb_populate_record(NULL::hdd.sync_state,$2::jsonb)),revision=$3 WHERE chain_id=$1`,
        [this.chainId, previous, (BigInt(sync.revision) + 1n).toString()],
      );
      return { block: targetBlock, revision: (BigInt(sync.revision) + 1n).toString() };
    });
  }
}
