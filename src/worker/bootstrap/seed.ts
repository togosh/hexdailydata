import type pg from 'pg';
import { createHash, randomUUID } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { mkdtemp, open, rename, rm, mkdir } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import { performance } from 'node:perf_hooks';
import { manifestSchema, tables, tableNames, type Table, type Manifest } from './manifest.ts';
import { packArchive, readArchive, lines, archiveLimits } from './archive.ts';
import { hex } from '../../services/projections/input.ts';
import { reconcile } from '../../services/projections/initialize.ts';
import { restoreCheckpoint, restoreCursor } from '../../services/projections/recovery.ts';
import { decodeLog } from '../../providers/abi.ts';
import { policySchema } from '../../providers/source.ts';
import { diskReserve } from '../sync/engine.ts';

export async function fileHash(path: string, signal: AbortSignal) {
  const digest = createHash('sha256');
  for await (const chunk of createReadStream(path)) {
    signal.throwIfAborted();
    digest.update(chunk);
  }
  return digest.digest('hex');
}
async function schema(client: pg.Client) {
  const { rows } = await client.query('SELECT version FROM hdd.schema_migrations ORDER BY version');
  if (JSON.stringify(rows.map((r) => r.version)) !== '[1,2]')
    throw new Error('Seed requires schema version 2.');
}
async function role(client: pg.Client) {
  const {
    rows: [r],
  } = await client.query('SELECT current_user AS role');
  if (r.role !== 'hdd_v2_worker') throw new Error('Seed requires explicit worker authority.');
}
async function emptyTarget(client: pg.Client) {
  // Catalogs reveal even objects the worker cannot read. Refuse extra user schemas
  // and relations rather than assuming the known application tables are the target.
  const { rows: schemas } = await client.query(`SELECT nspname FROM pg_namespace
    WHERE nspname !~ '^pg_' AND nspname NOT IN ('information_schema','public','hdd','hdd_identity')`);
  const { rows: relations } = await client.query(`SELECT n.nspname,c.relname,c.relkind
    FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
    WHERE n.nspname !~ '^pg_' AND n.nspname<>'information_schema' AND c.relkind NOT IN ('i','I')`);
  const expected = new Map([
    ...tableNames.map((t) => [`hdd.${t}`, 'r'] as const),
    ['hdd.schema_migrations', 'r'],
    ['hdd.undo_recent_sequence_seq', 'S'],
    ['hdd_identity.instance', 'r'],
  ]);
  if (
    schemas.length ||
    relations.length !== expected.size ||
    relations.some((r) => expected.get(`${r.nspname}.${r.relname}`) !== r.relkind)
  )
    throw new Error('Seed import refuses unrelated destination schema or relation.');
  for (const table of tableNames)
    if ((await client.query(`SELECT 1 FROM hdd.${table} LIMIT 1`)).rowCount)
      throw new Error('Seed import requires empty v2 target.');
}
async function descriptor(client: pg.Client): Promise<Omit<Manifest, 'files' | 'createdAt'>> {
  const { rows } = await client.query(
    'SELECT c.*,s.block_number,s.block_hash,s.block_time,s.revision,s.finality,s.rewind_floor FROM hdd.chains c JOIN hdd.sync_state s USING(chain_id) ORDER BY chain_id',
  );
  const last = rows.at(-1);
  if (!last) throw new Error('Cannot export uninitialized state.');
  const { rows: history } = await client.query(
    'SELECT * FROM hdd.source_history ORDER BY chain_id',
  );
  if (history.length !== rows.length) throw new Error('Missing acquired coverage metadata.');
  const coverage: Manifest['coverage'] = history.map((h, i) => ({
    dataset: h.chain_id === 1 ? 'ethereum-native' : 'pulsechain-native',
    status: 'complete',
    from: h.start_block,
    to: rows[i]!.block_number,
    reason: null,
  }));
  coverage.push({
    dataset: 'market',
    status: 'missing',
    from: null,
    to: null,
    reason: 'Market acquisition belongs to later tasks.',
  });
  return {
    formatVersion: 1,
    schemaVersion: 2,
    calculationVersion: 'hex-native-1',
    chainId: last.chain_id,
    contractAddress: hex(last.contract_address),
    codeSha256: last.code_hash.toString('hex'),
    checkpoint: {
      blockNumber: last.block_number,
      blockHash: hex(last.block_hash),
      blockTime: last.block_time,
      revision: last.revision,
      rewindFloor: last.rewind_floor,
      finality: last.finality,
    },
    ...(last.chain_id === 369
      ? {
          lineage: {
            parentChainId: 1 as const,
            parentBlockNumber: last.parent_block,
            parentBlockHash: hex(last.parent_hash),
            firstNativeBlockNumber: last.entry_block,
            firstNativeBlockHash: hex(last.entry_hash),
          },
        }
      : {}),
    coverage,
  };
}
async function columns(client: pg.Client, table: Table) {
  return (
    await client.query(
      "SELECT column_name FROM information_schema.columns WHERE table_schema='hdd' AND table_name=$1 ORDER BY ordinal_position",
      [table],
    )
  ).rows.map((r) => r.column_name as string);
}
/** Exact row JSON stays text between PostgreSQL instances. JS never parses a NUMERIC
 * or nested before-image into Number. Only the small, string-valued manifest is parsed.
 */
export async function exportSeed(
  client: pg.Client,
  destination: string,
  signal: AbortSignal,
  hooks: { afterSnapshot?: () => Promise<void>; beforeRename?: () => Promise<void> } = {},
) {
  await role(client);
  await schema(client);
  await diskReserve(dirname(resolve(destination)));
  const parent = dirname(resolve(destination));
  await mkdir(parent, { recursive: true });
  const temporary = await mkdtemp(join(parent, '.seed-'));
  const packed = join(temporary, 'seed.tar.gz');
  const files: Manifest['files'] = [];
  let locked = false,
    transaction = false;
  const started = performance.now();
  try {
    await client.query('SELECT pg_advisory_lock_shared(4243,0)');
    locked = true;
    await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
    transaction = true;
    const identity = await descriptor(client);
    await validateState(client, signal);
    await hooks.afterSnapshot?.();
    for (const table of tableNames) {
      signal.throwIfAborted();
      const file = await open(join(temporary, table + '.ndjson'), 'wx', 0o600);
      const digest = createHash('sha256');
      let count = 0n,
        size = 0n;
      try {
        await client.query(
          `DECLARE seed_rows NO SCROLL CURSOR FOR SELECT to_jsonb(t)::text AS row FROM hdd.${table} t ORDER BY ${tables[table].join(',')}`,
        );
        for (;;) {
          const { rows } = await client.query('FETCH FORWARD 128 FROM seed_rows');
          if (!rows.length) break;
          for (const row of rows) {
            signal.throwIfAborted();
            const line = Buffer.from(row.row + '\n');
            if (line.length > archiveLimits.rowBytes) throw new Error('Seed row exceeds bound.');
            digest.update(line);
            await file.write(line);
            count++;
            size += BigInt(line.length);
            if (size > BigInt(archiveLimits.memberBytes))
              throw new Error('Seed member exceeds bound.');
          }
        }
        await client.query('CLOSE seed_rows');
        await file.sync();
      } finally {
        await file.close();
      }
      files.push({
        table,
        path: `tables/${table}.ndjson`,
        rows: count.toString(),
        bytes: size.toString(),
        sha256: digest.digest('hex'),
      });
    }
    await client.query('COMMIT');
    transaction = false;
    // The materialized consistent files own the snapshot now; pruning no longer needs it.
    await client.query('SELECT pg_advisory_unlock_shared(4243,0)');
    locked = false;
    const manifest = manifestSchema.parse({
      ...identity,
      createdAt: new Date().toISOString(),
      files,
    });
    const bytes = Buffer.from(JSON.stringify(manifest));
    await packArchive(
      packed,
      [
        { name: 'seed.json', data: bytes, size: bytes.length },
        ...files.map((f) => ({
          name: f.path,
          path: join(temporary, f.table + '.ndjson'),
          size: Number(f.bytes),
        })),
      ],
      signal,
    );
    const sha256 = await fileHash(packed, signal);
    await hooks.beforeRename?.();
    signal.throwIfAborted();
    await rename(packed, destination);
    return {
      manifest,
      ms: performance.now() - started,
      sha256,
    };
  } finally {
    if (transaction) await client.query('ROLLBACK').catch(() => {});
    if (locked) await client.query('SELECT pg_advisory_unlock_shared(4243,0)').catch(() => {});
    // Only this function's random private directory is removed; destination is never deleted.
    await rm(temporary, { recursive: true, force: true });
  }
}
export interface SeedExpectation {
  instance: string;
  sha256: string;
  contract: string;
  codeHash: string;
  checkpointHash: string;
}
export async function importSeed(
  client: pg.Client,
  path: string,
  expected: SeedExpectation,
  signal: AbortSignal,
  hooks: { beforeCommit?: () => Promise<void> } = {},
) {
  await role(client);
  await schema(client);
  if (!/^[0-9a-f]{64}$/.test(expected.sha256) || (await fileHash(path, signal)) !== expected.sha256)
    throw new Error('Seed transfer hash mismatch.');
  const {
    rows: [identity],
  } = await client.query('SELECT instance::text FROM hdd_identity.instance WHERE singleton');
  if (identity.instance !== expected.instance)
    throw new Error('Explicit seed destination identity mismatch.');
  const started = performance.now();
  await client.query('BEGIN');
  try {
    for (const chain of [1, 369]) {
      const {
        rows: [lock],
      } = await client.query('SELECT pg_try_advisory_xact_lock(4242,$1) AS held', [chain]);
      if (!lock.held) throw new Error('Seed target writer active.');
    }
    const {
      rows: [lock],
    } = await client.query('SELECT pg_try_advisory_xact_lock(4243,0) AS held');
    if (!lock.held) throw new Error('Seed snapshot/import active.');
    // Table locks also fence non-engine clients while checking the empty target.
    await client.query(
      `LOCK TABLE ${tableNames.map((t) => 'hdd.' + t).join(',')} IN EXCLUSIVE MODE`,
    );
    await emptyTarget(client);
    let manifest: Manifest | undefined;
    let tableIndex = 0;
    const transfer = await readArchive(
      path,
      ['seed.json', ...tableNames.map((t) => `tables/${t}.ndjson`)],
      async (name, size, chunks) => {
        if (name === 'seed.json') {
          const parts: Buffer[] = [];
          for await (const part of chunks) parts.push(part);
          manifest = manifestSchema.parse(
            JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(parts))),
          );
          if (
            manifest.contractAddress !== expected.contract ||
            '0x' + manifest.codeSha256 !== expected.codeHash ||
            manifest.checkpoint.blockHash !== expected.checkpointHash ||
            manifest.files.some(
              (f, i) => f.table !== tableNames[i] || f.path !== `tables/${f.table}.ndjson`,
            ) ||
            new Set(manifest.files.map((f) => f.table)).size !== tableNames.length
          )
            throw new Error('Seed manifest identity/member mapping mismatch.');
          return;
        }
        const table = tableNames[tableIndex++]!,
          entry = manifest?.files.find((f) => f.table === table);
        if (!entry || name !== entry.path || BigInt(entry.bytes) !== BigInt(size))
          throw new Error('Seed table order/size mismatch.');
        const allowedColumns = await columns(client, table),
          digest = createHash('sha256');
        let count = 0n;
        async function* hashed() {
          for await (const part of chunks) {
            digest.update(part);
            yield part;
          }
        }
        const buffer: string[] = [];
        async function flush() {
          if (!buffer.length) return;
          const {
            rows: [valid],
          } = await client.query(
            `SELECT bool_and(json_typeof(j)='object' AND
          (SELECT count(*)=count(DISTINCT key) AND count(*)=cardinality($2::text[]) AND bool_and(key=ANY($2::text[])) FROM json_each(j))) AS valid
          FROM unnest($1::json[]) AS j`,
            [buffer, [...allowedColumns].sort()],
          );
          if (!valid.valid)
            throw new Error(`Seed ${table} row has unknown, missing or duplicate columns.`);
          await client.query(
            `INSERT INTO hdd.${table} (${allowedColumns.join(',')}) ${table === 'undo_recent' ? 'OVERRIDING SYSTEM VALUE' : ''}
          SELECT r.* FROM unnest($1::jsonb[]) AS j CROSS JOIN LATERAL jsonb_populate_record(NULL::hdd.${table},j) AS r`,
            [buffer],
          );
          buffer.length = 0;
        }
        for await (const line of lines(hashed())) {
          signal.throwIfAborted();
          buffer.push(line);
          count++;
          if (buffer.length === 128) await flush();
        }
        await flush();
        if (count.toString() !== entry.rows || digest.digest('hex') !== entry.sha256)
          throw new Error('Seed table count/hash mismatch.');
      },
      signal,
    );
    if (transfer.sha256 !== expected.sha256)
      throw new Error('Seed changed during import; transfer hash mismatch.');
    if (!manifest) throw new Error('Missing seed manifest.');
    const actual = await descriptor(client);
    const { files: ignoredFiles, createdAt: ignoredCreated, ...declared } = manifest;
    if (JSON.stringify(actual) !== JSON.stringify(declared))
      throw new Error('Seed semantic coverage/checkpoint/lineage mismatch.');
    await validateState(client, signal);
    const recoveryCheckpoints = await validateRecovery(client, signal);
    // Heap/TOAST representation may differ after logical import. Recount physical
    // tuple accounting rather than trusting the publisher's retained-byte counters.
    await client.query(`UPDATE hdd.checkpoints_recent c SET
      undo_bytes=(SELECT coalesce(sum(pg_column_size(u)),0) FROM hdd.undo_recent u WHERE u.chain_id=c.chain_id AND u.revision=c.revision),
      tail_bytes=(SELECT coalesce(sum(pg_column_size(t)),0) FROM hdd.transfers_recent t WHERE t.origin_chain_id=c.chain_id AND t.block_number>(c.previous_sync->>'block_number')::bigint AND t.block_number<=c.block_number)
      +(SELECT coalesce(sum(pg_column_size(b)),0) FROM hdd.blocks_recent b WHERE b.chain_id=c.chain_id AND b.number>(c.previous_sync->>'block_number')::bigint AND b.number<=c.block_number)`);
    await client.query(
      "SELECT setval('hdd.undo_recent_sequence_seq',greatest(coalesce((SELECT max(sequence) FROM hdd.undo_recent),0)+1,1),false)",
    );
    await hooks.beforeCommit?.();
    signal.throwIfAborted();
    await client.query('COMMIT');
    return {
      ms: performance.now() - started,
      checkpoint: manifest.checkpoint,
      recoveryCheckpoints,
    };
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {});
    throw error;
  }
}
async function validateState(
  client: pg.Client,
  signal: AbortSignal,
  recoveryChain: number | null = null,
) {
  const { rows: chains } = await client.query(
    'SELECT * FROM hdd.chains WHERE $1::int IS NULL OR chain_id=$1 ORDER BY chain_id',
    [recoveryChain],
  );
  if (
    recoveryChain === null &&
    (chains.length < 1 || chains[0].chain_id !== 1 || chains.length > 2)
  )
    throw new Error('Invalid common/native lineage.');
  for (const chain of chains) {
    signal.throwIfAborted();
    await reconcile(client, chain.chain_id);
    const {
      rows: [check],
    } = await client.query(
      `SELECT s.*,c.contract_day,h.start_block,h.start_hash,h.sources,h.finality_policy,
      EXISTS(SELECT 1 FROM hdd.blocks_recent b WHERE b.chain_id=s.chain_id AND b.number=s.block_number AND b.hash=s.block_hash AND b.timestamp=s.block_time) AS header,
      EXISTS(SELECT 1 FROM hdd.blocks_recent b WHERE b.chain_id=s.chain_id AND b.number=s.rewind_floor) AS floor
      FROM hdd.sync_state s JOIN hdd.current_state c USING(chain_id) JOIN hdd.source_history h USING(chain_id) WHERE s.chain_id=$1`,
      [chain.chain_id],
    );
    // Native acquisition starts at the entry block, but its first undo checkpoint
    // restores the verified inherited parent. This exception is audit-only and exact.
    const inheritedBoundary =
      recoveryChain === 369 &&
      check &&
      chain.initialization === 'fork' &&
      check.block_number === chain.parent_block &&
      check.block_hash.equals(chain.parent_hash) &&
      check.start_block === chain.entry_block &&
      check.start_hash.equals(chain.entry_hash);
    if (
      !check ||
      !check.header ||
      !check.floor ||
      Number((BigInt(check.block_time) - 1575331200n) / 86400n) !== check.contract_day ||
      (BigInt(check.start_block) > BigInt(check.block_number) && !inheritedBoundary)
    )
      throw new Error('Seed cursor/header/day/coverage inconsistency.');
    const policy = policySchema.shape.finality.parse(check.finality_policy);
    if (
      policy.mode !== check.finality ||
      !Array.isArray(check.sources) ||
      check.sources.length !== 2 ||
      check.sources[0].id === check.sources[1].id ||
      (check.sources[0].operator !== null &&
        check.sources[0].operator === check.sources[1].operator)
    )
      throw new Error('Seed source/finality inconsistency.');
    const syncColumns = await columns(client, 'sync_state');
    const {
      rows: [tail],
    } = await client.query(
      `WITH ordered AS (SELECT *,lag(block_number,1,$2::bigint) OVER(ORDER BY block_number) AS prior FROM hdd.checkpoints_recent WHERE chain_id=$1)
      SELECT count(*) FILTER(WHERE (previous_sync->>'block_number')::bigint<>prior OR revision<= (previous_sync->>'revision')::bigint OR (previous_sync->>'chain_id')::int<>$1 OR block_number>$3 OR revision>$4
        OR NOT previous_sync ?& $5::text[] OR (SELECT count(*) FROM jsonb_object_keys(previous_sync))<>cardinality($5::text[]))::int AS errors,
      max(block_number)::text AS last, count(*)::int AS checkpoints FROM ordered`,
      [chain.chain_id, check.rewind_floor, check.block_number, check.revision, syncColumns],
    );
    if (
      tail.errors ||
      tail.checkpoints > 4096 ||
      (tail.last === null
        ? check.block_number !== check.rewind_floor
        : tail.last !== check.block_number)
    )
      throw new Error('Seed receipt tail is not contiguous.');
    const {
      rows: [bad],
    } = await client.query(
      `SELECT EXISTS(SELECT 1 FROM hdd.blocks_recent b WHERE b.chain_id=$1 AND (number<$2 OR number>$3)) OR
      ($5::boolean AND EXISTS(SELECT 1 FROM hdd.recovery_pins p WHERE p.chain_id=$1 AND (block_number<$2 OR block_number>$3))) OR
      EXISTS(SELECT 1 FROM hdd.daily_stats d WHERE d.chain_id=$1 AND (contract_day>=$4 OR close_block>$3 OR payout_block>$3)) OR
      EXISTS(SELECT 1 FROM hdd.accounts a WHERE a.chain_id=$1 AND last_block>$3) OR
      EXISTS(SELECT 1 FROM hdd.stakes t WHERE t.chain_id=$1 AND last_block>$3) OR
      EXISTS(SELECT 1 FROM hdd.blocks_recent b LEFT JOIN hdd.blocks_recent p ON p.chain_id=b.chain_id AND p.number=b.number-1
        WHERE b.chain_id=$1 AND b.number>$2 AND (p.number IS NULL OR b.parent_hash<>p.hash OR b.timestamp<=p.timestamp)) AS bad`,
      [
        chain.chain_id,
        check.rewind_floor,
        check.block_number,
        check.contract_day,
        recoveryChain === null,
      ],
    );
    if (bad.bad) throw new Error('Seed progress/tail/day bounds inconsistent.');
    if (chain.chain_id === 369 && recoveryChain === null) {
      const {
        rows: [parent],
      } = await client.query(
        'SELECT s.*,c.contract_address,c.code_hash FROM hdd.sync_state s JOIN hdd.chains c USING(chain_id) WHERE chain_id=1',
      );
      if (
        parent.block_number !== chain.parent_block ||
        !parent.block_hash.equals(chain.parent_hash) ||
        !parent.contract_address.equals(chain.contract_address) ||
        !parent.code_hash.equals(chain.code_hash) ||
        BigInt(chain.entry_block) !== BigInt(chain.parent_block) + 1n
      )
        throw new Error('Seed fork lineage mismatch.');
    }
  }
  for (const table of ['events', 'transfers_recent'] as const) {
    await client.query(
      `DECLARE verify_events NO SCROLL CURSOR FOR SELECT t.*,c.contract_address,s.block_number AS cursor,
        b.hash AS retained_hash,b.timestamp AS retained_time FROM hdd.${table} t
        JOIN hdd.chains c ON c.chain_id=t.origin_chain_id JOIN hdd.sync_state s ON s.chain_id=c.chain_id
        LEFT JOIN hdd.blocks_recent b ON b.chain_id=t.origin_chain_id AND b.number=t.block_number
        WHERE $1::int IS NULL OR t.origin_chain_id=$1`,
      [recoveryChain],
    );
    for (;;) {
      const { rows } = await client.query('FETCH FORWARD 128 FROM verify_events');
      if (!rows.length) break;
      for (const r of rows) {
        signal.throwIfAborted();
        if (BigInt(r.block_number) > BigInt(r.cursor)) throw new Error('Seed future event.');
        if (
          r.retained_hash &&
          (!r.retained_hash.equals(r.block_hash) || r.retained_time !== r.block_time)
        )
          throw new Error('Seed event/header inconsistency.');
        const e = decodeLog(
          {
            address: hex(r.contract_address),
            blockNumber: '0x' + BigInt(r.block_number).toString(16),
            blockHash: hex(r.block_hash),
            transactionHash: hex(r.transaction_hash),
            transactionIndex: '0x' + BigInt(r.transaction_index).toString(16),
            logIndex: '0x' + BigInt(r.log_index).toString(16),
            removed: false,
            topics: r.topics.map(hex),
            data: hex(r.data),
          },
          r.origin_chain_id,
          hex(r.contract_address),
          {
            number: r.block_number,
            hash: hex(r.block_hash),
            parentHash: '0x' + '0'.repeat(64),
            timestamp: r.block_time,
          },
        );
        // payload contains only bounded indices and string amounts, never raw SQL NUMERIC JSON.
        if (!isDeepStrictEqual(e, r.payload)) throw new Error('Seed raw/decoded event mismatch.');
      }
    }
    await client.query('CLOSE verify_events');
  }
  if (recoveryChain !== null) return;
  const {
    rows: [undo],
  } = await client.query(`SELECT EXISTS(SELECT 1 FROM hdd.undo_recent u WHERE
    coalesce((u.row_key->>'chain_id')::int,(u.row_key->>'origin_chain_id')::int) IS DISTINCT FROM u.chain_id OR
    (u.previous_value IS NOT NULL AND NOT u.previous_value @> u.row_key)) AS bad`);
  if (undo.bad) throw new Error('Seed undo identity mismatch.');
  for (const table of [
    'accounts',
    'stakes',
    'current_state',
    'share_schedule',
    'daily_stats',
    'events',
    'transfers_recent',
    'blocks_recent',
  ] as const) {
    const keys = tables[table],
      names = await columns(client, table);
    const {
      rows: [shape],
    } = await client.query(
      `SELECT EXISTS(SELECT 1 FROM hdd.undo_recent u WHERE relation_name=$1 AND
      (NOT row_key ?& $2::text[] OR (SELECT count(*) FROM jsonb_object_keys(row_key))<>cardinality($2::text[]) OR
       (previous_value IS NOT NULL AND (NOT previous_value ?& $3::text[] OR (SELECT count(*) FROM jsonb_object_keys(previous_value))<>cardinality($3::text[]))))) AS bad`,
      [table, keys, names],
    );
    if (shape.bad) throw new Error('Seed undo identity/column shape mismatch.');
  }
}

/** Import-only audit: exercise every retained checkpoint without publishing any
 * historical state. Full reconciliation costs SQL work per checkpoint, not JS heap
 * proportional to account/undo count. Ordinary sync/API reads never do this audit.
 */
async function validateRecovery(client: pg.Client, signal: AbortSignal) {
  const { rows: chains } = await client.query(
    'SELECT chain_id,rewind_floor FROM hdd.sync_state ORDER BY chain_id',
  );
  let count = 0;
  for (const chain of chains) {
    await client.query('SAVEPOINT seed_recovery');
    await client.query("SELECT set_config('hdd.rewinding','yes',true)");
    for (;;) {
      signal.throwIfAborted();
      const {
        rows: [checkpoint],
      } = await client.query(
        `SELECT revision,previous_sync::text
        FROM hdd.checkpoints_recent WHERE chain_id=$1 ORDER BY block_number DESC LIMIT 1`,
        [chain.chain_id],
      );
      if (!checkpoint) break;
      await restoreCheckpoint(client, chain.chain_id, checkpoint.revision, signal);
      await restoreCursor(client, chain.chain_id, checkpoint.previous_sync, chain.rewind_floor);
      await validateState(client, signal, chain.chain_id);
      count++;
    }
    await client.query('ROLLBACK TO SAVEPOINT seed_recovery');
    await client.query('RELEASE SAVEPOINT seed_recovery');
  }
  return count;
}
