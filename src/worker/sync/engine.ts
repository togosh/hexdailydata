import type pg from 'pg';
import { performance } from 'node:perf_hooks';
import { statfs } from 'node:fs/promises';
import { z } from 'zod';
import { Source } from '../../providers/source.ts';
import { RangeError, RpcError } from '../../providers/rpc.ts';
import { q, plainHeader } from '../../providers/abi.ts';
import { CanonicalWriter, type FaultHooks } from '../../services/projections/writer.ts';
import {
  hex,
  bytes,
  hash,
  headerSchema,
  validateBatch,
  type Header,
  type Batch,
} from '../../services/projections/input.ts';
import { reconcile } from '../../services/projections/initialize.ts';
import { totalColumns } from '../../services/projections/reduce.ts';
import { contractDayAt } from '../../domain/day.ts';
import limits from '../../../config/limits.json' with { type: 'json' };

export async function diskReserve(path: string) {
  const s = await statfs(path, { bigint: true });
  if (s.bavail * s.bsize < BigInt(limits.resources.minimumFreeBytes) || s.bavail * 5n < s.blocks)
    throw new Error('Disk reserve below 8GiB/20%; protected data retained.');
  return {
    freeBytes: (s.bavail * s.bsize).toString(),
    totalBytes: (s.blocks * s.bsize).toString(),
  };
}
export class SyncEngine {
  readonly progress = {
    phase: 'idle',
    commits: 0,
    events: 0,
    headers: 0,
    splits: 0,
    failures: 0,
    sqlMs: 0,
    reconciliationMs: 0,
    acquisitionMs: 0,
    pruneMs: 0,
    replayMs: 0,
    guardsMs: 0,
    exports: 'NOT_IMPLEMENTED',
    lastError: null as string | null,
    cursor: null as string | null,
    target: null as string | null,
  };
  private verified = false;
  readonly writer: CanonicalWriter;
  readonly reader: pg.Client;
  readonly sources: [Source, Source];
  readonly storagePath: string;
  readonly hooks: FaultHooks;
  constructor(
    writer: CanonicalWriter,
    reader: pg.Client,
    sources: [Source, Source],
    storagePath: string,
    hooks: FaultHooks = {},
  ) {
    this.writer = writer;
    this.reader = reader;
    this.sources = sources;
    this.storagePath = storagePath;
    this.hooks = hooks;
    const [a, b] = sources;
    if (
      a.rpc.chain !== writer.chainId ||
      b.rpc.chain !== writer.chainId ||
      a.rpc.contract !== b.rpc.contract ||
      a.rpc.id === b.rpc.id ||
      (a.rpc.operator !== null && a.rpc.operator === b.rpc.operator) ||
      JSON.stringify(a.policy) !== JSON.stringify(b.policy)
    )
      throw new Error('Incompatible source pair.');
  }
  async cursor() {
    const {
      rows: [s],
    } = await this.reader.query('SELECT * FROM hdd.sync_state WHERE chain_id=$1', [
      this.writer.chainId,
    ]);
    return s;
  }
  async initializeConstructor(
    checkpoint: Header,
    transactionHash: string,
    balances: { address: string; hearts: string }[],
    signal: AbortSignal,
  ) {
    hash.parse(transactionHash);
    const values = [];
    for (const source of this.sources) {
      await source.verify(checkpoint, signal);
      const receipt = z
        .object({
          transactionHash: hash,
          blockHash: hash,
          contractAddress: z.literal(source.rpc.contract),
          status: z.literal('0x1'),
        })
        .passthrough()
        .parse(await source.rpc.call('eth_getTransactionReceipt', [transactionHash], signal));
      if (receipt.transactionHash !== transactionHash || receipt.blockHash !== checkpoint.hash)
        throw new Error('Constructor receipt mismatch.');
      const events = await source.events([checkpoint], signal);
      const minted = new Map<string, bigint>();
      for (const e of events) {
        if (
          e.transactionHash !== transactionHash ||
          e.value.kind !== 'transfer' ||
          e.value.sender !== '0x' + '0'.repeat(40)
        )
          throw new Error('Constructor block requires explicit replay of non-mint effects.');
        minted.set(
          e.value.recipient,
          (minted.get(e.value.recipient) ?? 0n) + BigInt(e.value.hearts),
        );
      }
      const actual = [...minted]
        .filter(([, v]) => v > 0n)
        .map(([address, v]) => ({ address, hearts: v.toString() }))
        .sort((a, b) => a.address.localeCompare(b.address));
      if (
        JSON.stringify(actual) !==
        JSON.stringify([...balances].sort((a, b) => a.address.localeCompare(b.address)))
      )
        throw new Error('Explicit constructor balances do not match deployment logs.');
      const state = await source.state(checkpoint, signal),
        observed = await source.balances(
          actual.map((x) => x.address),
          checkpoint,
          signal,
        );
      if (
        state.locked !== '0' ||
        state.active !== '0' ||
        state.queued !== '0' ||
        JSON.stringify(actual) !== JSON.stringify(observed)
      )
        throw new Error('Constructor state mismatch.');
      values.push({
        id: source.rpc.id,
        operator: source.rpc.operator,
        value: {
          checkpoint,
          contract: source.rpc.contract,
          codeHash: source.policy.codeHash,
          finality: source.policy.finality.mode,
          shareRate: state.shareRate,
          circulating: state.circulating,
          balances: actual,
        },
      });
    }
    await this.writer.initialize(
      'constructor',
      values as [(typeof values)[number], (typeof values)[number]],
      {
        startBlock: checkpoint.number,
        startHash: checkpoint.hash,
        startTime: checkpoint.timestamp,
        finalityPolicy: this.sources[0].policy.finality,
      },
    );
  }
  async fork(parent: Header, entry: Header, signal: AbortSignal) {
    const {
      rows: [current],
    } = await this.reader.query('SELECT * FROM hdd.current_state WHERE chain_id=1');
    if (!current) throw new Error('Common history is missing.');
    const expected = Object.fromEntries(totalColumns.map((k) => [k, current[k]]));
    const values = [];
    for (const source of this.sources) {
      await source.verify(parent, signal);
      await source.verify(entry, signal);
      const state = await source.state(parent, signal);
      if (
        state.circulating !== current.circulating_hearts ||
        state.locked !== current.locked_hearts ||
        state.active !== current.active_shares ||
        state.queued !== current.queued_shares ||
        state.shareRate !== current.raw_share_rate
      )
        throw new Error('Inherited external aggregate mismatch.');
      await this.reconcileBalances(source, 1, parent, signal);
      values.push({
        id: source.rpc.id,
        operator: source.rpc.operator,
        value: {
          checkpoint: entry,
          parent,
          contract: source.rpc.contract,
          codeHash: source.policy.codeHash,
          finality: source.policy.finality.mode,
          shareRate: state.shareRate,
          expected,
        },
      });
    }
    await this.writer.initialize(
      'fork',
      values as [(typeof values)[number], (typeof values)[number]],
      {
        startBlock: entry.number,
        startHash: entry.hash,
        startTime: entry.timestamp,
        finalityPolicy: this.sources[0].policy.finality,
      },
    );
  }
  private async reconcileBalances(source: Source, chain: number, h: Header, signal: AbortSignal) {
    let after = Buffer.alloc(0);
    for (;;) {
      signal.throwIfAborted();
      const { rows } = await this.reader.query(
        'SELECT address,liquid_hearts FROM hdd.accounts WHERE chain_id=$1 AND address>$2 ORDER BY address LIMIT 30',
        [chain, after],
      );
      if (!rows.length) break;
      const observed = await source.balances(
        rows.map((r) => hex(r.address)),
        h,
        signal,
      );
      if (observed.some((v, i) => v.hearts !== rows[i]!.liquid_hearts))
        throw new Error('Full current address reconciliation mismatch.');
      after = rows.at(-1)!.address;
    }
  }
  async audit(signal: AbortSignal) {
    const start = performance.now(),
      s = await this.cursor();
    if (!s) throw new Error('Chain not initialized.');
    await reconcile(this.reader, this.writer.chainId);
    const {
      rows: [current],
    } = await this.reader.query('SELECT * FROM hdd.current_state WHERE chain_id=$1', [
      this.writer.chainId,
    ]);
    for (const source of this.sources) {
      const h = plainHeader(await source.header(s.block_number, signal, true));
      if (h.hash !== hex(s.block_hash)) throw new Error('Reconciliation checkpoint changed.');
      const state = await source.state(h, signal);
      if (
        state.circulating !== current.circulating_hearts ||
        state.locked !== current.locked_hearts ||
        state.active !== current.active_shares ||
        state.queued !== current.queued_shares ||
        state.shareRate !== current.raw_share_rate
      )
        throw new Error('Final external aggregate reconciliation mismatch.');
      await this.reconcileBalances(source, this.writer.chainId, h, signal);
    }
    this.progress.reconciliationMs += performance.now() - start;
  }
  private async recover(s: pg.QueryResultRow, signal: AbortSignal) {
    const current = await Promise.all(
      this.sources.map((source) => source.header(s.block_number, signal, true)),
    );
    if (current.every((h) => h.hash === hex(s.block_hash))) return;
    if (s.finality !== 'confirmed')
      throw new Error('Finalized checkpoint disagreement; explicit repair required.');
    const policy = this.sources[0].policy.finality;
    if (policy.mode !== 'confirmed') throw new Error('Finality mode mismatch.');
    const { rows } = await this.reader.query(
      `SELECT previous_sync->>'block_number' AS number,previous_sync->>'block_hash' AS hash
      FROM hdd.checkpoints_recent WHERE chain_id=$1 AND (previous_sync->>'block_number')::bigint>=greatest($2::bigint,$3::bigint-$4::bigint)
      ORDER BY block_number DESC LIMIT 4096`,
      [this.writer.chainId, s.rewind_floor, s.block_number, policy.rollbackBlocks],
    );
    rows.sort((a, b) => (BigInt(a.number) > BigInt(b.number) ? -1 : 1));
    for (const row of rows) {
      const matches = await Promise.all(
        this.sources.map((source) => source.header(row.number, signal, true)),
      );
      // JSONB BYTEA is PostgreSQL \x, while RPC is 0x.
      if (matches.every((h) => h.hash === row.hash.replace('\\x', '0x'))) {
        await this.writer.rewind(row.number, {
          blockNumber: s.block_number,
          blockHash: hex(s.block_hash),
          revision: s.revision,
        });
        return;
      }
    }
    throw new Error('Reorg beyond retained/configured window; explicit repair required.');
  }
  async once(signal: AbortSignal, stopAt?: Header) {
    try {
      this.progress.phase = 'acquiring';
      let s = await this.cursor();
      if (!s) throw new Error('Initialize explicitly or import a seed before sync.');
      await this.recover(s, signal);
      s = await this.cursor();
      if (!this.verified) {
        const {
          rows: [chain],
        } = await this.reader.query('SELECT * FROM hdd.chains WHERE chain_id=$1', [
          this.writer.chainId,
        ]);
        if (
          hex(chain.code_hash) !== this.sources[0].policy.codeHash ||
          hex(chain.contract_address) !== this.sources[0].rpc.contract ||
          s.finality !== this.sources[0].policy.finality.mode
        )
          throw new Error('Stored chain/profile mismatch.');
        for (const source of this.sources)
          await source.verify(
            plainHeader(await source.header(s.block_number, signal, true)),
            signal,
          );
        this.verified = true;
      }
      const targets = await Promise.all(this.sources.map((source) => source.target(signal)));
      const min = targets.reduce((a, b) => (BigInt(a.number) < BigInt(b.number) ? a : b));
      const target = stopAt ?? min;
      if (BigInt(target.number) > BigInt(min.number))
        throw new Error('Target is beyond configured finality.');
      for (const source of this.sources)
        if ((await source.header(target.number, signal, true)).hash !== target.hash)
          throw new Error('Target identity disagreement.');
      if (BigInt(target.number) < BigInt(s.block_number) && !stopAt)
        throw new Error('Finality target regressed.');
      this.progress.target = target.number;
      let range = 128;
      while (BigInt(s.block_number) < BigInt(target.number)) {
        signal.throwIfAborted();
        await diskReserve(this.storagePath);
        const previous = plainHeader(await this.sources[0].header(s.block_number, signal));
        const expected = {
          blockNumber: s.block_number,
          blockHash: hex(s.block_hash),
          revision: s.revision,
        };
        const {
          rows: [state],
        } = await this.reader.query(
          'SELECT sampled_addresses FROM hdd.current_state WHERE chain_id=$1',
          [this.writer.chainId],
        );
        const {
          rows: [pending],
        } = await this.reader.query(
          "SELECT min(contract_day) AS day FROM hdd.daily_stats WHERE chain_id=$1 AND payout_status='pending'",
          [this.writer.chainId],
        );
        const acquisitionStart = performance.now();
        let accepted: ReturnType<typeof validateBatch>;
        for (;;) {
          try {
            const all: [Header[], Header[]] = [[], []];
            let rangeDay: number | undefined;
            const count = Number(
              BigInt(target.number) - BigInt(s.block_number) > BigInt(range)
                ? BigInt(range)
                : BigInt(target.number) - BigInt(s.block_number),
            );
            const acquired = await Promise.all(
              this.sources.map((source) =>
                source.rangeHeaders(BigInt(s.block_number) + 1n, count, signal),
              ),
            );
            for (let i = 0; i < count; i++) {
              const pair = [acquired[0]![i]!, acquired[1]![i]!];
              const day = contractDayAt(BigInt(pair[0]!.timestamp));
              if (rangeDay !== undefined && day !== rangeDay) break;
              rangeDay = day;
              all[0].push(plainHeader(pair[0]!));
              all[1].push(plainHeader(pair[1]!));
            }
            const first = await this.sources[0].acquire(
              expected,
              all[0],
              state.sampled_addresses.map(hex),
              previous,
              pending.day,
              signal,
            );
            const second = await this.sources[1].acquire(
              expected,
              all[1],
              state.sampled_addresses.map(hex),
              previous,
              pending.day,
              signal,
            );
            const batch: Batch = {
              chainId: this.writer.chainId,
              contract: this.sources[0].rpc.contract,
              expected,
              sources: [first, second],
            };
            accepted = validateBatch(batch);
            break;
          } catch (error) {
            signal.throwIfAborted();
            if (
              !(
                error instanceof RangeError ||
                (error instanceof Error &&
                  /disagreement|Noncontiguous|day transitions/.test(error.message))
              ) ||
              range === 1
            )
              throw error;
            range = Math.max(1, Math.floor(range / 2));
            this.progress.splits++;
          }
        }
        this.progress.acquisitionMs += performance.now() - acquisitionStart;
        signal.throwIfAborted();
        this.progress.phase = 'committing';
        const beforeTimings = { ...this.writer.timings };
        await this.writer.commit(accepted.batch, this.hooks);
        this.progress.sqlMs += this.writer.timings.sqlMs - beforeTimings.sqlMs;
        this.progress.replayMs += this.writer.timings.replayMs - beforeTimings.replayMs;
        this.progress.guardsMs += this.writer.timings.guardsMs - beforeTimings.guardsMs;
        this.progress.commits++;
        this.progress.events += accepted.events.length;
        this.progress.headers += accepted.headers.length;
        s = await this.cursor();
        this.progress.cursor = s.block_number;
        const pruneStart = performance.now();
        await this.writer.prune();
        this.progress.pruneMs += performance.now() - pruneStart;
        range = Math.min(128, range * 2);
        this.progress.phase = 'acquiring';
      }
      this.progress.phase = 'idle';
      return this.progress;
    } catch (error) {
      this.progress.phase = 'paused';
      this.progress.failures++;
      this.progress.lastError = error instanceof Error ? error.message : 'Unknown sync failure';
      throw error;
    }
  }
  async watch(signal: AbortSignal, onProgress: (progress: typeof this.progress) => void) {
    while (!signal.aborted) {
      try {
        await this.once(signal);
        onProgress(this.progress);
      } catch (error) {
        onProgress(this.progress);
        if (
          signal.aborted ||
          !(
            error instanceof RpcError ||
            (error instanceof Error && /timeout|network|deadline|fetch failed/i.test(error.message))
          )
        )
          throw error;
      }
      await this.sources[0].rpc.budget.clock.sleep(30_000, signal);
    }
  }
}
