import type pg from 'pg';
import { cooldownFiles } from '../providers/cooldown.ts';
import { createHash } from 'node:crypto';
import { readFile, mkdir, rm, rename, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { finished } from 'node:stream/promises';
import { once } from 'node:events';
import { from as copyFrom } from 'pg-copy-streams';
import { z } from 'zod';
import { connect, databaseConfig } from '../db/connect.ts';
import { reconcile } from '../services/projections/initialize.ts';
import { validateSourceCheckpoints } from '../services/projections/provenance.ts';
import { validateDailyState } from '../worker/daily/validate.ts';
import { validateHistory } from '../worker/history/store.ts';
import { tableNames } from '../worker/bootstrap/manifest.ts';
import { emptyTarget, fileHash } from '../worker/bootstrap/seed.ts';
import { packArchive, readArchive } from '../worker/bootstrap/archive.ts';
import { safePath, reserve, syncPath, atomicJson, maxBackupBytes } from './files.ts';
import { toolFile } from './process.ts';
import { maintenanceLease } from './lease.ts';

const tables = [...tableNames, 'live_metrics', 'export_bundles'];
const hash = z.string().regex(/^[0-9a-f]{64}$/);
const manifestSchema = z.strictObject({
  format: z.literal('hdd-pgdump-age-1'),
  schema: z.literal(5),
  calculation: z.literal('hex-native-1'),
  release: z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,100}$/),
  sourceInstance: z.uuid(),
  capturedAt: z.iso.datetime(),
  cooldownUntil: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER),
  dumpBytes: z.number().int().min(0).max(maxBackupBytes),
  dumpSha256: hash,
  cutoffs: z
    .array(
      z.strictObject({
        chain_id: z.union([z.literal(1), z.literal(369)]),
        block_number: z.string().regex(/^\d+$/),
        block_hash: hash,
        revision: z.string().regex(/^\d+$/),
        block_time: z.string().regex(/^\d+$/),
      }),
    )
    .max(2),
});
export type BackupManifest = z.infer<typeof manifestSchema>;
export const receiptSchema = z.strictObject({
  sha256: hash,
  bytes: z.number().int().positive().max(maxBackupBytes),
  capturedAt: z.iso.datetime(),
  verifiedAt: z.iso.datetime(),
  sourceInstance: z.uuid(),
});
export function backupAge(receipt: unknown, now = Date.now()) {
  const parsed = receiptSchema.safeParse(receipt);
  if (!parsed.success) return { state: receipt == null ? 'missing' : 'invalid', ageMs: null };
  const captured = Date.parse(parsed.data.capturedAt),
    verified = Date.parse(parsed.data.verifiedAt);
  if (captured > verified || verified > now || captured > now)
    return { state: 'invalid', ageMs: null };
  return { state: now - captured <= 86400000 ? 'healthy' : 'stale', ageMs: now - captured };
}
export function backupConfig(env = process.env) {
  const stage = env.HDD_V2_MAINTENANCE_PATH,
    destination = env.HDD_V2_BACKUP_PATH,
    identity = env.HDD_V2_BACKUP_IDENTITY_FILE;
  if (!stage || !destination || !identity || !env.HDD_V2_RELEASE)
    throw new Error(
      'Backup is NOT_CONFIGURED: owned stage, destination, identity file and release required.',
    );
  if (
    stage === destination ||
    stage.startsWith(destination + '/') ||
    destination.startsWith(stage + '/')
  )
    throw new Error('Backup staging and destination must be separate mounts.');
  return { stage, destination, identity, release: env.HDD_V2_RELEASE };
}
async function schema(c: pg.Client) {
  const versions = (
    await c.query('SELECT version FROM hdd.schema_migrations ORDER BY version')
  ).rows
    .map((r) => r.version)
    .join(',');
  if (versions !== '1,2,3,4,5') throw new Error('Backup/restore requires supported schema 5.');
}
async function cutoff(c: pg.Client) {
  return (
    await c.query(
      "SELECT chain_id,block_number,encode(block_hash,'hex') AS block_hash,revision,block_time FROM hdd.sync_state ORDER BY chain_id",
    )
  ).rows;
}
async function receipt(root: string) {
  try {
    if ((await safePath(join(root, 'verified.json'), false)).size > 4096)
      throw new Error('Backup receipt exceeds bound.');
    return JSON.parse(await readFile(join(root, 'verified.json'), 'utf8'));
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw e;
  }
}
export async function backupStatus(env = process.env, now = Date.now()) {
  if (!env.HDD_V2_BACKUP_PATH) return { state: 'not_configured', ageMs: null };
  try {
    const raw = await receipt(env.HDD_V2_BACKUP_PATH);
    const r = receiptSchema.safeParse(raw);
    if (!r.success) return backupAge(raw, now);
    const info = await safePath(join(env.HDD_V2_BACKUP_PATH, 'current.age'), false);
    if (info.size !== r.data.bytes || info.mtimeMs > Date.parse(r.data.verifiedAt))
      return { state: 'unverified', ageMs: null };
    return {
      ...backupAge(r.data, now),
      ...r.data,
      verification:
        'destination hash + authenticated decryption + dump checksum; restore drill separate',
    };
  } catch {
    return { state: 'unavailable', ageMs: null };
  }
}
/** SQL coordinates maintenance with DB work; file locks protect fixed paths even
 * after a DB connection dies, and remain held until filesystem cleanup finishes. */
async function workspace(c: pg.Client, env: NodeJS.ProcessEnv, signal: AbortSignal) {
  const cfg = backupConfig(env);
  await safePath(cfg.stage);
  await safePath(cfg.destination);
  await safePath(cfg.identity, false);
  if (!(await c.query('SELECT pg_try_advisory_lock(4250,0) AS held')).rows[0].held)
    throw new Error('Maintenance already active.');
  const closeLease = await maintenanceLease([cfg.stage, cfg.destination], signal);
  const dir = join(cfg.stage, 'backup');
  try {
    try {
      await safePath(dir);
      await rm(dir, { recursive: true });
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e;
    }
    signal.throwIfAborted();
    await mkdir(dir, { mode: 0o700 });
    return { ...cfg, dir, closeLease };
  } catch (error) {
    await closeLease().catch(() => {});
    throw error;
  }
}
async function inspectArchive(
  path: string,
  signal: AbortSignal,
  consume?: (chunks: AsyncIterable<Buffer>) => Promise<void>,
) {
  let manifest: BackupManifest | undefined;
  await readArchive(
    path,
    ['backup.json', 'database.sql'],
    async (name, size, chunks) => {
      if (name === 'backup.json') {
        const parts = [];
        for await (const b of chunks) parts.push(b);
        manifest = manifestSchema.parse(JSON.parse(Buffer.concat(parts).toString('utf8')));
        if (Date.parse(manifest.capturedAt) > Date.now())
          throw new Error('Future backup snapshot refused.');
      } else {
        if (!manifest || size !== manifest.dumpBytes) throw new Error('Backup dump size mismatch.');
        const digest = createHash('sha256');
        async function* checked() {
          for await (const b of chunks) {
            digest.update(b);
            yield b;
          }
        }
        if (consume) await consume(checked());
        else
          for await (const _ of checked()) {
            /* read every byte */
          }
        if (digest.digest('hex') !== manifest.dumpSha256)
          throw new Error('Backup dump checksum mismatch.');
      }
    },
    signal,
    'backup.json',
  );
  return manifest!;
}
export async function backup(
  signal: AbortSignal,
  env = process.env,
  hooks: {
    afterSnapshot?: () => Promise<void>;
    afterTransfer?: () => Promise<void>;
    beforePromote?: () => Promise<void>;
  } = {},
) {
  const connectionLost = new AbortController();
  signal = AbortSignal.any([signal, connectionLost.signal, AbortSignal.timeout(2 * 3600000)]);
  const c = await connect(databaseConfig('worker', env));
  c.on('error', () => connectionLost.abort(new Error('Maintenance database connection lost.')));
  let work: Awaited<ReturnType<typeof workspace>> | undefined,
    phase = 'prepare';
  const started = Date.now();
  const milestones: unknown[] = [];
  async function sample(label: string) {
    if (!work) return;
    let stagingBytes = 0;
    for (const name of ['database.sql', 'archive.tar.gz'])
      try {
        stagingBytes += (await stat(join(work.dir, name))).size;
      } catch {
        /* not created yet */
      }
    milestones.push({
      label,
      elapsedMs: Date.now() - started,
      stagingBytes,
      disk: await reserve(work.stage),
      rss: process.memoryUsage().rss,
      cgroupCurrent: (await readFile('/sys/fs/cgroup/memory.current', 'utf8')).trim(),
      cgroupPeak: (await readFile('/sys/fs/cgroup/memory.peak', 'utf8')).trim(),
    });
  }
  const timer = setInterval(
    () => console.log(JSON.stringify({ job: 'backup', phase, elapsedMs: Date.now() - started })),
    30000,
  );
  try {
    await schema(c);
    work = await workspace(c, env, signal);
    const prior = await receipt(work.destination);
    if (
      prior &&
      receiptSchema.parse(prior).sourceInstance !== databaseConfig('worker', env).instance
    )
      throw new Error('Backup destination belongs to another source instance.');
    const size = Number(
      (await c.query('SELECT pg_database_size(current_database())::text AS bytes')).rows[0].bytes,
    );
    await reserve(work.stage, Math.min(maxBackupBytes * 2, size * 2 + 1048576));
    await reserve(work.destination, Math.min(maxBackupBytes, size + 1048576));
    const candidate = join(work.destination, 'candidate.age'),
      packed = join(work.dir, 'archive.tar.gz'),
      dump = join(work.dir, 'database.sql');
    try {
      await safePath(candidate, false);
      await rm(candidate);
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e;
    }
    await c.query('SELECT pg_advisory_lock_shared(4243,0)');
    await c.query(
      "SET idle_in_transaction_session_timeout='2h'; BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY",
    );
    const snap = (
      await c.query('SELECT pg_export_snapshot() AS id, transaction_timestamp() AS captured')
    ).rows[0];
    const cutoffs = await cutoff(c);
    await hooks.afterSnapshot?.();
    phase = 'dump';
    const cfg = databaseConfig('worker', env);
    const bytes = await toolFile(
      'pg_dump',
      [
        '--format=plain',
        '--data-only',
        '--schema=hdd',
        '--exclude-table=hdd.schema_migrations',
        '--no-owner',
        '--no-acl',
        '--no-comments',
        '--no-security-labels',
        '--no-large-objects',
        `--snapshot=${snap.id}`,
      ],
      dump,
      signal,
      {
        PATH: process.env.PATH,
        PGHOST: cfg.host,
        PGDATABASE: cfg.database,
        PGUSER: cfg.user,
        PGPASSWORD: cfg.password,
        PGCONNECT_TIMEOUT: '5',
        PGOPTIONS: '-c statement_timeout=3600000',
      },
    );
    const manifest = manifestSchema.parse({
      format: 'hdd-pgdump-age-1',
      schema: 5,
      calculation: 'hex-native-1',
      release: work.release,
      sourceInstance: cfg.instance,
      capturedAt: snap.captured.toISOString(),
      cooldownUntil: env.HDD_V2_PROVIDER_STATE
        ? await (await cooldownFiles(env.HDD_V2_PROVIDER_STATE, 'worker')).read()
        : 0,
      cutoffs,
      dumpBytes: bytes,
      dumpSha256: await fileHash(dump, signal),
    });
    await c.query('COMMIT');
    await c.query('SELECT pg_advisory_unlock_shared(4243,0)');
    phase = 'encrypt-transfer';
    const metadata = Buffer.from(JSON.stringify(manifest));
    // Logical COPY text can be much larger than compressed/toasted SQL storage.
    // Recheck against the actual dump before holding both dump and packed bytes.
    await reserve(work.stage, bytes + 64 * 1024 ** 2);
    await packArchive(
      packed,
      [
        { name: 'backup.json', data: metadata, size: metadata.length },
        { name: 'database.sql', path: dump, size: bytes },
      ],
      signal,
    );
    await sample('dump-and-packed');
    await reserve(work.destination, (await stat(packed)).size + 1024 ** 2);
    await toolFile('age', ['-e', '-i', work.identity, packed], candidate, signal);
    await syncPath(candidate);
    await syncPath(work.destination);
    await hooks.afterTransfer?.();
    await rm(dump);
    await rm(packed);
    phase = 'verify-destination';
    const sha256 = await fileHash(candidate, signal);
    const ciphertextBytes = (await stat(candidate)).size;
    await toolFile('age', ['-d', '-i', work.identity, candidate], packed, signal);
    const verified = await inspectArchive(packed, signal);
    await sample('destination-verified');
    if (JSON.stringify(verified) !== JSON.stringify(manifest))
      throw new Error('Destination manifest mismatch.');
    await hooks.beforePromote?.();
    signal.throwIfAborted();
    // One atomic file replacement. A crash before receipt replacement degrades health;
    // it never promotes an unverified candidate or deletes the last good prematurely.
    await rename(candidate, join(work.destination, 'current.age'));
    await syncPath(work.destination);
    const accepted = {
      sha256,
      bytes: ciphertextBytes,
      sourceInstance: cfg.instance,
      capturedAt: manifest.capturedAt,
      verifiedAt: new Date().toISOString(),
    };
    await atomicJson(work.destination, 'verified.json', accepted);
    return {
      ...accepted,
      cutoffs,
      dumpBytes: bytes,
      elapsedMs: Date.now() - started,
      health: backupAge(accepted),
      offHostQualification: 'NOT_RUN',
      milestones,
    };
  } finally {
    clearInterval(timer);
    await c.query('ROLLBACK').catch(() => {});
    if (work)
      await rm(work.dir, { recursive: true, force: true }).catch(() =>
        console.error('Backup staging cleanup failed.'),
      );
    await c.end().catch(() => {});
    await work?.closeLease().catch(() => console.error('Backup filesystem lock release failed.'));
  }
}

/** Only COPY data enters trusted current-schema tables. No dump SQL, SET, role,
 * sequence command, function, trigger or psql backslash command is ever executed. */
async function importCopy(
  c: pg.Client,
  chunks: AsyncIterable<Buffer>,
  signal: AbortSignal,
  stage: string,
) {
  const allowed = new Map<string, string>();
  for (const table of tables) {
    const columns = (
      await c.query(
        "SELECT quote_ident(column_name) AS column_name FROM information_schema.columns WHERE table_schema='hdd' AND table_name=$1 ORDER BY ordinal_position",
        [table],
      )
    ).rows.map((r) => r.column_name);
    allowed.set(`COPY hdd.${table} (${columns.join(', ')}) FROM stdin;`, table);
  }
  let pending = Buffer.alloc(0),
    sinceReserve = 0,
    current: ReturnType<typeof copyFrom> | undefined,
    completion: Promise<void> | undefined;
  const seen = new Set<string>();
  async function line(b: Buffer) {
    signal.throwIfAborted();
    const text = b.toString('utf8');
    if (current) {
      if (text === '\\.') {
        current.end();
        await completion;
        current = undefined;
      } else {
        if (!current.write(Buffer.concat([b, Buffer.from('\n')]))) await once(current, 'drain');
      }
    } else if (text.startsWith('COPY ')) {
      const table = allowed.get(text);
      if (!table || seen.has(table))
        throw new Error('Unsupported or duplicate backup COPY target.');
      seen.add(table);
      current = c.query(copyFrom(text));
      completion = finished(current);
      void completion.catch(() => {});
    } else if (text.startsWith('\\')) {
      if (!/^\\(?:un)?restrict [A-Za-z0-9]+$/.test(text))
        throw new Error('Unsupported backup command.');
    } else if (
      text &&
      !text.startsWith('--') &&
      !/^SET [a-z_]+ = (?:[A-Za-z0-9]+|'[^']*');$/.test(text) &&
      !/^SELECT pg_catalog\.set_config\('search_path', '', false\);$/.test(text) &&
      !/^SELECT pg_catalog\.setval\('hdd\.undo_recent_sequence_seq', \d+, (?:true|false)\);$/.test(
        text,
      )
    )
      throw new Error('Unsupported backup SQL (never executed).');
  }
  try {
    for await (const chunk of chunks) {
      sinceReserve += chunk.length;
      if (sinceReserve >= 16 * 1024 ** 2) {
        // Supported named volumes share the Docker data filesystem. Keep a margin
        // before more COPY/index/WAL growth; failure aborts the import transaction.
        await reserve(stage, 64 * 1024 ** 2);
        sinceReserve = 0;
      }
      pending = Buffer.concat([pending, chunk]);
      let end;
      while ((end = pending.indexOf(10)) !== -1) {
        if (end > 1024 * 1024) throw new Error('Backup row bound.');
        await line(pending.subarray(0, end));
        pending = pending.subarray(end + 1);
      }
      if (pending.length > 1024 * 1024) throw new Error('Backup row bound.');
    }
    if (pending.length || current || seen.size !== tables.length)
      throw new Error('Incomplete backup data.');
  } catch (e) {
    current?.destroy(e as Error);
    await completion?.catch(() => {});
    throw e;
  }
}
const restoreExpectation = z.strictObject({
  sha256: hash,
  sourceInstance: z.uuid(),
  destinationInstance: z.uuid(),
  destinationProject: z.string().regex(/^hexdailydata-v2-[a-z0-9-]+$/),
});
export async function restore(
  path: string,
  expectation: unknown,
  signal: AbortSignal,
  env = process.env,
  hooks: { beforeCommit?: () => Promise<void> } = {},
) {
  const connectionLost = new AbortController();
  signal = AbortSignal.any([signal, connectionLost.signal, AbortSignal.timeout(2 * 3600000)]);
  const expected = restoreExpectation.parse(expectation),
    cfg = databaseConfig('worker', env);
  if (
    expected.destinationInstance !== cfg.instance ||
    expected.destinationProject !== env.HDD_V2_PROJECT ||
    expected.sourceInstance === cfg.instance
  )
    throw new Error('Explicit NEW restore destination identity/project required.');
  await safePath(path, false);
  if ((await fileHash(path, signal)) !== expected.sha256)
    throw new Error('Backup source integrity mismatch.');
  const c = await connect(cfg);
  c.on('error', () => connectionLost.abort(new Error('Maintenance database connection lost.')));
  let work: Awaited<ReturnType<typeof workspace>> | undefined,
    phase = 'verify';
  const started = Date.now();
  const timer = setInterval(
    () => console.log(JSON.stringify({ job: 'restore', phase, elapsedMs: Date.now() - started })),
    30000,
  );
  try {
    await schema(c);
    work = await workspace(c, env, signal);
    await reserve(work.stage, 2 * (await stat(path)).size);
    const packed = join(work.dir, 'archive.tar.gz');
    await toolFile('age', ['-d', '-i', work.identity, path], packed, signal);
    const manifest = await inspectArchive(packed, signal);
    if (manifest.sourceInstance !== expected.sourceInstance)
      throw new Error('Restore source instance mismatch.');
    // The measured large restore includes indexes, WAL and temporary SQL work.
    await reserve(work.stage, manifest.dumpBytes * 4 + 64 * 1024 ** 2);
    await c.query(
      "SET statement_timeout='1h'; SET idle_in_transaction_session_timeout='1h'; BEGIN",
    );
    for (const [a, b] of [
      [4244, 1],
      [4242, 1],
      [4242, 369],
      [4243, 0],
      [4246, 0],
      [4248, 0],
    ])
      if (!(await c.query('SELECT pg_try_advisory_xact_lock($1,$2) AS held', [a, b])).rows[0].held)
        throw new Error('Restore target is active.');
    await c.query(`LOCK TABLE ${tables.map((t) => 'hdd.' + t).join(',')} IN EXCLUSIVE MODE`);
    await emptyTarget(c);
    phase = 'import';
    await inspectArchive(packed, signal, (chunks) => importCopy(c, chunks, signal, work!.stage));
    if (JSON.stringify(await cutoff(c)) !== JSON.stringify(manifest.cutoffs))
      throw new Error('Restored cutoff differs from snapshot.');
    phase = 'audit';
    await validateSourceCheckpoints(c);
    for (const r of (await c.query('SELECT chain_id FROM hdd.chains ORDER BY chain_id')).rows)
      await reconcile(c, r.chain_id);
    await validateDailyState(c, signal);
    await validateHistory(c, signal);
    const recoveryCheckpoints = (
      await c.query('SELECT count(*)::text AS n FROM hdd.checkpoints_recent')
    ).rows[0].n;
    await c.query(`UPDATE hdd.checkpoints_recent c SET undo_bytes=(SELECT coalesce(sum(pg_column_size(u)),0) FROM hdd.undo_recent u WHERE u.chain_id=c.chain_id AND u.revision=c.revision),
      tail_bytes=(SELECT coalesce(sum(pg_column_size(t)),0) FROM hdd.transfers_recent t WHERE t.origin_chain_id=c.chain_id AND t.block_number>(c.previous_sync->>'block_number')::bigint AND t.block_number<=c.block_number)
      +(SELECT coalesce(sum(pg_column_size(b)),0) FROM hdd.blocks_recent b WHERE b.chain_id=c.chain_id AND b.number>(c.previous_sync->>'block_number')::bigint AND b.number<=c.block_number)`);
    await c.query(
      "SELECT setval('hdd.undo_recent_sequence_seq',greatest(coalesce((SELECT max(sequence) FROM hdd.undo_recent),0)+1,1),false)",
    );
    await hooks.beforeCommit?.();
    signal.throwIfAborted();
    const provenance = {
      acceptance: 'prepared',
      sourceInstance: manifest.sourceInstance,
      destinationInstance: cfg.instance,
      capturedAt: manifest.capturedAt,
      restoredAt: new Date().toISOString(),
      marketGap: {
        from: manifest.capturedAt,
        to: new Date().toISOString(),
        coverage: 'unknown',
        reason: 'Local observations after the snapshot are unrecoverable by native replay.',
      },
      providerPermissions: 'NOT_RESTORED',
    };
    // Write provenance before acceptance. Failure leaves DB empty, never partly accepted.
    if (!env.HDD_V2_PROVIDER_STATE)
      throw new Error('Restore needs an owned persistent provider-state path.');
    await safePath(env.HDD_V2_PROVIDER_STATE);
    const cooldown = await cooldownFiles(env.HDD_V2_PROVIDER_STATE, 'worker');
    await cooldown.extend(Math.max(manifest.cooldownUntil, Date.now() + 60000));
    await syncPath(env.HDD_V2_PROVIDER_STATE);
    await atomicJson(work.stage, 'restore.json', provenance);
    await c.query('COMMIT');
    provenance.acceptance = 'accepted';
    await atomicJson(work.stage, 'restore.json', provenance);
    return {
      ...provenance,
      cutoffs: manifest.cutoffs,
      recoveryCheckpoints,
      elapsedMs: Date.now() - started,
      resources: {
        rss: process.memoryUsage().rss,
        cgroupCurrent: (await readFile('/sys/fs/cgroup/memory.current', 'utf8')).trim(),
        cgroupPeak: (await readFile('/sys/fs/cgroup/memory.peak', 'utf8')).trim(),
        stagingBytes: (await stat(packed)).size,
        disk: await reserve(work.stage),
      },
    };
  } finally {
    clearInterval(timer);
    await c.query('ROLLBACK').catch(() => {});
    if (work)
      await rm(work.dir, { recursive: true, force: true }).catch(() =>
        console.error('Restore staging cleanup failed.'),
      );
    await c.end().catch(() => {});
    await work?.closeLease().catch(() => console.error('Restore filesystem lock release failed.'));
  }
}

/** A bounded daily job inside the ordinary worker. Failure retries no sooner than 1h. */
export class BackupSchedule {
  private next = 0;
  readonly env: NodeJS.ProcessEnv;
  readonly now: () => number;
  constructor(env = process.env, now = Date.now) {
    this.env = env;
    this.now = now;
  }
  async tick(signal: AbortSignal) {
    if (!this.env.HDD_V2_BACKUP_PATH || this.now() < this.next) return;
    this.next = this.now() + 3600000;
    const status = await backupStatus(this.env, this.now());
    if (status.ageMs !== null && status.state === 'healthy' && status.ageMs < 23 * 3600000) return;
    await backup(signal, this.env);
  }
}
