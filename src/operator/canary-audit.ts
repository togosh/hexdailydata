import { createHash } from 'node:crypto';
import { readFile, writeFile, appendFile } from 'node:fs/promises';
import type pg from 'pg';
import { pinnedAuditAdmissionSchema, type CanaryPlan } from './canary-plan.ts';
import { tables } from '../worker/bootstrap/manifest.ts';
import { profileBinding } from '../worker/sync/profile.ts';
import { sourceHistorySchema } from '../providers/binding.ts';
import { validateSourceHistory } from '../services/projections/provenance.ts';
import { reconcile } from '../services/projections/initialize.ts';
import { digest, hex, type Header } from '../services/projections/input.ts';
import { decodeHeader, plainHeader, q, selectors } from '../providers/abi.ts';
import { validateCall, type RpcCall } from '../providers/rpc.ts';
import type { SourceProfile } from '../worker/sync/profile.ts';
import type { AuditAccount } from '../worker/sync/audit.ts';
import { auditState, compareAccounts, type AuditBatch } from '../worker/sync/audit.ts';
import type { Source } from '../providers/source.ts';
import type { CanarySession } from './canary-session.ts';
import type { z } from 'zod';

export type AuditPhase = Extract<CanaryPlan['phases'][number], { kind: 'pinned-audit' }>;
export const auditPhase = (plan: CanaryPlan) =>
  plan.phases.find((p): p is AuditPhase => p.kind === 'pinned-audit');
export type RetainedPhase = Extract<
  CanaryPlan['phases'][number],
  { kind: 'pinned-audit' | 'common-continue' }
>;
export const retainedPhase = (plan: CanaryPlan) =>
  plan.phases.find(
    (p): p is RetainedPhase => p.kind === 'pinned-audit' || p.kind === 'common-continue',
  );
export type AuditAdmission = z.infer<typeof pinnedAuditAdmissionSchema>;
const sha = (text: string) => createHash('sha256').update(text).digest('hex');
const canonicalTables = {
  ...tables,
  live_metrics: ['chain_id', 'metric'],
  export_bundles: ['id'],
  schema_migrations: ['version'],
};

/** This transaction's idle allowance ends with its parent's deadline. Global SQL
 * and RPC statement/attempt defaults remain unchanged. */
export async function beginAuditSnapshot(reader: pg.Client, remaining: number) {
  if (!Number.isSafeInteger(remaining) || remaining <= 0 || remaining > 3600000)
    throw Error('Invalid pinned-audit snapshot deadline.');
  await reader.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
  await reader.query("SELECT set_config('idle_in_transaction_session_timeout',$1,true)", [
    String(remaining),
  ]);
}

/** Exclusion locks live on worker-role connections; this API-role snapshot has
 * SELECT only. Sequence state is read through the read-only lock owner. */
export async function canonicalEvidence(reader: pg.Client, owner: pg.Client) {
  const expected = [
    ...Object.keys(canonicalTables).map((n) => 'hdd.' + n),
    'hdd_identity.instance',
  ].sort();
  const relations = (
    await reader.query(`SELECT n.nspname||'.'||c.relname AS name FROM pg_class c
    JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname IN ('hdd','hdd_identity')
    AND c.relkind IN ('r','p') ORDER BY 1`)
  ).rows.map((r) => r.name);
  if (digest(relations) !== digest(expected)) throw Error('Unexpected canonical table set.');
  const evidence: Record<string, { rows: number; sha256: string }> = {};
  for (const [name, keys] of [
    ...Object.entries(canonicalTables).map(([n, k]) => ['hdd.' + n, k] as const),
    ['hdd_identity.instance', ['singleton']] as const,
  ]) {
    const hash = createHash('sha256');
    let count = 0;
    await reader.query(
      `DECLARE audit_rows NO SCROLL CURSOR FOR SELECT row_to_json(t)::text AS row FROM ${name} t ORDER BY ${keys.join(',')}`,
    );
    try {
      for (;;) {
        const { rows } = await reader.query('FETCH FORWARD 256 FROM audit_rows');
        if (!rows.length) break;
        for (const row of rows) {
          hash.update(row.row + '\n');
          count++;
        }
      }
    } finally {
      await reader.query('CLOSE audit_rows');
    }
    evidence[name] = { rows: count, sha256: hash.digest('hex') };
  }
  // Canonical definitions/privileges and sequences are part of the equality proof,
  // unlike physical WAL, pg_stat counters, or PostgreSQL startup file writes.
  const schema = (
    await reader.query(`
    SELECT 'relation' AS kind,n.nspname||'.'||c.relname AS name,
      jsonb_build_array(c.relkind,c.relacl,pg_get_userbyid(c.relowner))::text AS definition
      FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname IN ('hdd','hdd_identity')
    UNION ALL SELECT 'column',n.nspname||'.'||c.relname||'.'||a.attname,
      jsonb_build_array(a.attnum,format_type(a.atttypid,a.atttypmod),a.attnotnull,a.attidentity,a.attgenerated,pg_get_expr(d.adbin,d.adrelid))::text
      FROM pg_attribute a JOIN pg_class c ON c.oid=a.attrelid JOIN pg_namespace n ON n.oid=c.relnamespace
      LEFT JOIN pg_attrdef d ON d.adrelid=c.oid AND d.adnum=a.attnum
      WHERE n.nspname IN ('hdd','hdd_identity') AND a.attnum>0 AND NOT a.attisdropped
    UNION ALL SELECT 'constraint',n.nspname||'.'||c.conname,pg_get_constraintdef(c.oid)
      FROM pg_constraint c JOIN pg_namespace n ON n.oid=c.connamespace WHERE n.nspname IN ('hdd','hdd_identity')
    UNION ALL SELECT 'index',schemaname||'.'||indexname,indexdef FROM pg_indexes WHERE schemaname IN ('hdd','hdd_identity')
    UNION ALL SELECT 'trigger',n.nspname||'.'||c.relname||'.'||t.tgname,pg_get_triggerdef(t.oid)
      FROM pg_trigger t JOIN pg_class c ON c.oid=t.tgrelid JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname IN ('hdd','hdd_identity')
    UNION ALL SELECT 'function',n.nspname||'.'||p.proname,pg_get_functiondef(p.oid)
      FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname IN ('hdd','hdd_identity')
    UNION ALL SELECT 'schema',n.nspname,jsonb_build_array(n.nspacl,pg_get_userbyid(n.nspowner))::text
      FROM pg_namespace n WHERE n.nspname IN ('hdd','hdd_identity')
    UNION ALL SELECT 'type',n.nspname||'.'||t.typname,
      jsonb_build_array(t.typtype,t.typcategory,format_type(t.typbasetype,t.typtypmod),t.typnotnull,t.typdefault,t.typacl)::text
      FROM pg_type t JOIN pg_namespace n ON n.oid=t.typnamespace WHERE n.nspname IN ('hdd','hdd_identity')
    UNION ALL SELECT 'sequence',n.nspname||'.'||c.relname,
      jsonb_build_array(s.seqstart,s.seqincrement,s.seqmax,s.seqmin,s.seqcache,s.seqcycle)::text
      FROM pg_sequence s JOIN pg_class c ON c.oid=s.seqrelid JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='hdd'
    ORDER BY 1,2,3`)
  ).rows;
  const sequence = (
    await owner.query('SELECT last_value::text,is_called FROM hdd.undo_recent_sequence_seq')
  ).rows;
  const value = { tables: evidence, schemaSha256: digest(schema), sequences: sequence };
  return { ...value, digest: digest(value) };
}

/** Read-only inspection used before plan binding and again before any provider
 * construction. This cannot initialize, migrate, repair or prepare a session. */
export async function inspectAuditTarget(
  reader: pg.Client,
  owner: pg.Client,
  profile: SourceProfile,
  input: AuditAdmission,
  streamedInventory = false,
) {
  const expected = pinnedAuditAdmissionSchema.parse(input);
  const migrations = (
    await reader.query('SELECT version,sha256 FROM hdd.schema_migrations ORDER BY version')
  ).rows;
  const files = [
    '0001_initial.sql',
    '0002_recovery.sql',
    '0003_live.sql',
    '0004_daily.sql',
    '0005_history.sql',
  ];
  const hashes = await Promise.all(
    files.map(async (f) =>
      sha(await readFile(new URL('../../migrations/' + f, import.meta.url), 'utf8')),
    ),
  );
  if (
    migrations.length !== 5 ||
    migrations.some((r, i) => r.version !== i + 1 || r.sha256 !== hashes[i])
  )
    throw Error('Pinned audit migration version/checksum mismatch.');
  const chains = (await reader.query('SELECT * FROM hdd.chains ORDER BY chain_id')).rows;
  if (
    chains.length !== 1 ||
    chains[0].chain_id !== 1 ||
    chains[0].initialization !== 'constructor' ||
    chains[0].origin_chain_id !== 1
  )
    throw Error('Pinned audit requires only constructor-origin1 state.');
  const binding = profileBinding(profile, 1),
    metadata = await validateSourceHistory(reader, 1, binding);
  const identities = sourceHistorySchema.parse({
    binding,
    providers: profile.ethereum.map((s) => ({
      id: s.id,
      operator: s.operator,
      accountGroup: s.accountGroup,
      endpointAlias: s.endpointEnv,
    })),
  });
  if (digest(binding) !== expected.sourceBindingDigest || digest(metadata) !== digest(identities))
    throw Error('Pinned audit source identity mismatch.');
  const cursors = (await reader.query('SELECT * FROM hdd.sync_state ORDER BY chain_id')).rows;
  const cursor = cursors[0];
  const {
    rows: [header],
  } = await reader.query('SELECT * FROM hdd.blocks_recent WHERE chain_id=1 AND number=$1', [
    expected.checkpoint.number,
  ]);
  const observed: Header | null = header
    ? {
        number: header.number,
        hash: hex(header.hash),
        parentHash: hex(header.parent_hash),
        timestamp: header.timestamp,
      }
    : null;
  const {
    rows: [history],
  } = await reader.query('SELECT finality_policy FROM hdd.source_history WHERE chain_id=1');
  if (
    cursors.length !== 1 ||
    cursor.chain_id !== 1 ||
    cursor.block_number !== expected.checkpoint.number ||
    hex(cursor.block_hash) !== expected.checkpoint.hash ||
    cursor.block_time !== expected.checkpoint.timestamp ||
    cursor.revision !== expected.revision ||
    cursor.finality !== 'finalized' ||
    digest(observed) !== digest(expected.checkpoint) ||
    digest(history.finality_policy) !== digest(profile.policy)
  )
    throw Error('Pinned audit checkpoint/profile mismatch.');
  const states = (await reader.query('SELECT * FROM hdd.current_state ORDER BY chain_id')).rows;
  if (
    states.length !== 1 ||
    states[0].chain_id !== 1 ||
    Object.entries(expected.current).some(([k, v]) => String(states[0][k]) !== String(v))
  )
    throw Error('Pinned audit exact current totals mismatch.');
  await reconcile(reader, 1);
  const canonical = await canonicalEvidence(reader, owner);
  for (const [table, count] of Object.entries(expected.counts))
    if (String(canonical.tables['hdd.' + table]!.rows) !== count)
      throw Error('Pinned audit table count mismatch: ' + table);
  const inventory = streamedInventory ? [] : await auditInventory(reader);
  const inventoryEvidence = streamedInventory
    ? await auditInventoryDigest(reader)
    : { count: inventory.length, digest: digest(inventory) };
  if (String(inventoryEvidence.count) !== expected.counts.accounts)
    throw Error('Pinned audit inventory count mismatch.');
  return {
    canonical,
    inventory,
    inventoryDigest: inventoryEvidence.digest,
    inventoryCount: inventoryEvidence.count,
    current: states[0],
    cursor,
    migrations,
    source: metadata,
  };
}
export async function auditPage(
  reader: pg.Client,
  after: string | null,
  limit = 10,
): Promise<AuditAccount[]> {
  if (!Number.isInteger(limit) || limit < 1 || limit > 256)
    throw Error('Invalid audit page bound.');
  const { rows } = await reader.query(
    'SELECT address,liquid_hearts FROM hdd.accounts WHERE chain_id=1 AND address>$1 ORDER BY address LIMIT $2',
    [after ? Buffer.from(after.slice(2), 'hex') : Buffer.alloc(0), limit],
  );
  return rows.map((r) => ({ address: hex(r.address), hearts: r.liquid_hearts }));
}
/** Exactly the old JSON-array digest, streamed without retaining the inventory. */
export async function auditInventoryDigest(reader: pg.Client) {
  const hash = createHash('sha256').update('[');
  let count = 0,
    after: string | null = null;
  for (;;) {
    const page = await auditPage(reader, after, 256);
    if (!page.length) break;
    for (const row of page) {
      hash.update((count ? ',' : '') + JSON.stringify(row));
      count++;
    }
    if (!Number.isSafeInteger(count)) throw Error('Inventory count overflow.');
    after = page.at(-1)!.address;
  }
  return { count, digest: hash.update(']').digest('hex') };
}
export async function auditInventory(reader: pg.Client): Promise<AuditAccount[]> {
  const inventory: AuditAccount[] = [];
  let after = Buffer.alloc(0);
  for (;;) {
    const { rows } = await reader.query(
      'SELECT address,liquid_hearts FROM hdd.accounts WHERE chain_id=1 AND address>$1 ORDER BY address LIMIT 256',
      [after],
    );
    if (!rows.length) return inventory;
    inventory.push(...rows.map((r) => ({ address: hex(r.address), hearts: r.liquid_hearts })));
    after = rows.at(-1)!.address;
  }
}

export class AuditScope {
  private observed = false;
  private addresses: Set<string>;
  constructor(
    private plan: CanaryPlan,
    private phase: AuditPhase,
    inventory: AuditAccount[],
    source: string,
  ) {
    if (
      !plan.profile.ethereum.some((s) => s.id === source) ||
      digest(inventory) !== phase.inventoryDigest ||
      inventory.length !== Number(phase.admission.counts.accounts)
    )
      throw Error('Pinned audit source/inventory not admitted.');
    this.addresses = new Set(inventory.map((r) => r.address));
    if (this.addresses.size !== inventory.length) throw Error('Pinned audit duplicate inventory.');
  }
  request(chain: number, calls: RpcCall[]) {
    if (chain !== 1 || !Array.isArray(calls) || !calls.length || calls.length > 10)
      throw Error('Pinned audit origin/batch rejected.');
    const pin = this.phase.admission.checkpoint;
    for (const c of calls) {
      validateCall(c, this.plan.profile.contract);
      if (!this.plan.methods.includes(c.method as CanaryPlan['methods'][number]))
        throw Error('Pinned audit method rejected.');
      if (
        c.method === 'eth_getBlockByNumber' &&
        (c.params[0] !== q(pin.number) || c.params[1] !== false)
      )
        throw Error('Pinned audit header rejected.');
      if (c.method === 'eth_getCode' && c.params[1] !== q(pin.number))
        throw Error('Pinned audit code pin rejected.');
      if (c.method === 'eth_call') {
        const data = (c.params[0] as { data: string }).data,
          state = c.params[1] as { blockHash: string; requireCanonical: boolean };
        if (!this.observed || state.blockHash !== pin.hash || state.requireCanonical !== true)
          throw Error('Pinned audit state pin unverified/rejected.');
        if (
          data !== selectors.globalInfo &&
          data !== selectors.totalSupply &&
          !(data.startsWith(selectors.balanceOf) && this.addresses.has('0x' + data.slice(-40)))
        )
          throw Error('Pinned audit selector/inventory rejected.');
      }
    }
  }
  response(calls: (RpcCall & { id?: number })[], text: string) {
    const rows: unknown = JSON.parse(text);
    if (!Array.isArray(rows) || rows.length !== calls.length)
      throw Error('Pinned audit requires batch responses.');
    const byId = new Map(rows.map((r) => [r.id, r]));
    if (byId.size !== calls.length) throw Error('Pinned audit duplicate response.');
    for (const c of calls) {
      const row = byId.get(c.id);
      if (!row) throw Error('Pinned audit missing response.');
      if (!row.error && c.method === 'eth_getBlockByNumber') {
        if (
          digest(plainHeader(decodeHeader(row.result))) !== digest(this.phase.admission.checkpoint)
        )
          throw Error('Pinned audit exact header mismatch.');
        this.observed = true;
      }
    }
  }
}

export async function runPinnedAudit(
  reader: pg.Client,
  sources: readonly Source[],
  session: CanarySession,
  phase: { admission: { checkpoint: Header }; inventoryDigest: string },
  inventory: AuditAccount[],
  signal: AbortSignal,
) {
  const root = session.plan.storagePath,
    file = root + '/audit-comparisons.jsonl';
  session.state.audit!.checkpoint = phase.admission.checkpoint;
  await writeFile(file, '', { flag: 'wx', mode: 0o600, flush: true });
  const progress = sources.map((s) => ({
    source: s.identity.id,
    identityVerified: false,
    probeAttempted: false,
    probeComplete: false,
    attemptedBatches: 0,
    completedBatches: 0,
    verifiedAccounts: 0,
    firstPosition: null as number | null,
    lastPosition: null as number | null,
    comparisonDigest: sha(''),
    complete: false,
    pending: null as { offset: number; count: number; probe: boolean } | null,
    mismatch: null as {
      position: number;
      address: string;
      expected: string;
      observed: string | null;
    } | null,
  }));
  const hashes = sources.map(() => createHash('sha256'));
  const save = async () => {
    session.state.audit!.progress = progress;
    await session.save();
    signal.throwIfAborted();
  };
  const batch = async (event: AuditBatch) => {
    const index = sources.findIndex((s) => s.identity.id === event.source),
      p = progress[index]!;
    if (!event.observed) {
      if (event.probe) p.probeAttempted = true;
      else p.attemptedBatches++;
      p.pending = { offset: event.offset, count: event.expected.length, probe: event.probe };
    } else {
      const rows = event.expected.map((e, i) => ({
        position: event.offset + i,
        address: e.address,
        expected: e.hearts,
        observed: event.observed![i]?.hearts ?? null,
      }));
      await appendFile(
        file,
        JSON.stringify({ source: event.source, probe: event.probe, rows }) + '\n',
        { flush: true },
      );
      const mismatch = rows.find(
        (r, i) => r.observed !== r.expected || event.observed![i]?.address !== r.address,
      );
      if (mismatch) p.mismatch = mismatch;
      else if (event.probe) {
        p.probeComplete = true;
        p.pending = null;
      } else {
        for (const r of rows) hashes[index]!.update(JSON.stringify(r) + '\n');
        p.completedBatches++;
        p.verifiedAccounts += rows.length;
        p.firstPosition ??= event.offset;
        p.lastPosition = event.offset + rows.length - 1;
        p.comparisonDigest = hashes[index]!.copy().digest('hex');
        p.pending = null;
        p.complete = p.verifiedAccounts === inventory.length;
      }
    }
    await save();
  };
  await save();
  const pin = phase.admission.checkpoint;
  for (let i = 0; i < sources.length; i++) {
    const source = sources[i]!;
    const h = plainHeader(await source.header(pin.number, signal, true));
    if (digest(h) !== digest(pin)) throw Error('Pinned audit verification header mismatch.');
    await source.verify(pin, signal);
    progress[i]!.identityVerified = true;
    await save();
  }
  for (const source of sources)
    await compareAccounts(source, [inventory[0]!], pin, signal, { batch }, 0, true);
  await auditState(reader, 1, sources, signal, { batchSize: 10, header: pin, batch });
  for (const source of sources)
    if (digest(plainHeader(await source.header(pin.number, signal, true))) !== digest(pin))
      throw Error('Pinned audit final header mismatch.');
  if (
    progress.some(
      (p) =>
        !p.complete || !p.probeComplete || p.verifiedAccounts !== inventory.length || p.pending,
    )
  )
    throw Error('Pinned audit coverage incomplete.');
  return {
    sources: progress,
    inventoryDigest: phase.inventoryDigest,
    inventoryCount: inventory.length,
    checkpoint: pin,
  };
}
