import { open, type FileHandle } from 'node:fs/promises';
import { constants } from 'node:fs';
import { z } from 'zod';
import type pg from 'pg';
import { digest, address, uint, type Header } from '../services/projections/input.ts';
import {
  auditPage,
  auditInventoryDigest,
  canonicalEvidence,
  beginAuditSnapshot,
} from './canary-audit.ts';
import { auditState, compareAccounts, type AuditAccount } from '../worker/sync/audit.ts';
import { plainHeader, decodeHeader, q, selectors } from '../providers/abi.ts';
import { validateCall, type RpcCall } from '../providers/rpc.ts';
import type { Source } from '../providers/source.ts';
import type { RequestScope } from './attempt-gate.ts';
import { ReconstructionSession } from './reconstruction-state.ts';
import { exact, sha } from './reconstruction-plan.ts';
import { syncPath, atomicJson } from './files.ts';

export class ReconstructionAuditScope implements RequestScope {
  private verified = false;
  page: AuditAccount[] = [];
  constructor(
    private contract: string,
    private pin: Header,
  ) {}
  request(chain: number, calls: RpcCall[]) {
    if (chain !== 1 || calls.length < 1 || calls.length > 10)
      throw Error('Audit origin/batch rejected.');
    for (const c of calls) {
      validateCall(c, this.contract);
      if (!['eth_chainId', 'eth_getCode', 'eth_getBlockByNumber', 'eth_call'].includes(c.method))
        throw Error('Audit method rejected.');
      if (
        c.method === 'eth_getBlockByNumber' &&
        (c.params[0] !== q(this.pin.number) || c.params[1] !== false)
      )
        throw Error('Audit header pin rejected.');
      if (c.method === 'eth_getCode' && c.params[1] !== q(this.pin.number))
        throw Error('Audit code pin rejected.');
      if (c.method === 'eth_call') {
        const data = (c.params[0] as { data: string }).data,
          pin = c.params[1] as { blockHash: string; requireCanonical: boolean };
        if (
          !this.verified ||
          pin.blockHash !== this.pin.hash ||
          pin.requireCanonical !== true ||
          (data !== selectors.globalInfo &&
            data !== selectors.totalSupply &&
            !(
              data.startsWith(selectors.balanceOf) &&
              this.page.some((a) => a.address === '0x' + data.slice(-40))
            ))
        )
          throw Error('Audit state/page pin rejected.');
      }
    }
  }
  response(calls: (RpcCall & { id?: number })[], text: string) {
    const rows: unknown = JSON.parse(text);
    if (!Array.isArray(rows) || rows.length !== calls.length)
      throw Error('Audit response count rejected.');
    const byId = new Map(rows.map((r) => [r.id, r]));
    if (byId.size !== calls.length) throw Error('Audit duplicate response ID.');
    for (const c of calls) {
      const row = byId.get(c.id);
      if (!row) throw Error('Audit missing response ID.');
      if (!row.error && c.method === 'eth_getBlockByNumber') {
        if (digest(plainHeader(decodeHeader(row.result))) !== digest(this.pin))
          throw Error('Audit header mismatch.');
        this.verified = true;
      }
    }
  }
}
const pageSchema = z.strictObject({
  binding: sha,
  source: z.string(),
  offset: exact,
  rows: z
    .array(z.strictObject({ address, expected: uint, observed: uint }))
    .min(1)
    .max(10),
});
export interface AuditHooks {
  afterAppend?: () => Promise<void>;
  afterPage?: () => Promise<void>;
}

/** One bounded prefix scan on resume/finalization. A durable offset commits the
 * prefix; every uncommitted tail (even valid JSON) is discarded and may be fetched again. */
export async function validateComparisonPrefix(
  reader: pg.Client,
  file: FileHandle,
  session: ReconstructionSession,
) {
  const a = session.state.audit!;
  const progress = a.sources.map((s) => ({
    source: s.source,
    count: 0,
    after: null as string | null,
    pages: 0,
  }));
  let offset = 0,
    hash = digest([]),
    activeSource = 0,
    buffered = Buffer.alloc(0);
  if ((await file.stat()).size < a.bytes) throw Error('Committed comparison evidence truncated.');
  while (offset < a.bytes) {
    const chunk = Buffer.alloc(Math.min(16384, a.bytes - offset));
    const { bytesRead } = await file.read(chunk, 0, chunk.length, offset);
    if (!bytesRead) throw Error('Committed comparison evidence missing.');
    offset += bytesRead;
    buffered = Buffer.concat([buffered, chunk.subarray(0, bytesRead)]);
    let at: number;
    while ((at = buffered.indexOf(10)) !== -1) {
      if (at > 4096) throw Error('Comparison page too large.');
      const line = buffered.subarray(0, at).toString('utf8');
      buffered = buffered.subarray(at + 1);
      const page = pageSchema.parse(JSON.parse(line));
      if (progress[activeSource]!.count === a.count) activeSource++;
      const p = progress[activeSource];
      if (!p || page.source !== p.source || page.binding !== a.binding || page.offset !== p.count)
        throw Error('Comparison source/pin/position mismatch.');
      const expected = await auditPage(reader, p.after);
      if (
        digest(page.rows) !==
        digest(
          expected.map((r) => ({ address: r.address, expected: r.hearts, observed: r.hearts })),
        )
      )
        throw Error('Comparison gap/duplicate/value mismatch.');
      p.count += page.rows.length;
      p.pages++;
      p.after = page.rows.at(-1)!.address;
      hash = digest({ prior: hash, page });
    }
    if (buffered.length > 4096) throw Error('Comparison line exceeds bound.');
  }
  if (buffered.length || hash !== a.commitment || digest(progress) !== digest(a.sources))
    throw Error('Committed comparison prefix/cursor mismatch.');
  await file.truncate(a.bytes);
  await file.sync();
  return { bytes: a.bytes, commitment: hash, sources: progress };
}

export async function bindAudit(
  reader: pg.Client,
  owner: pg.Client,
  session: ReconstructionSession,
) {
  const canonical = await canonicalEvidence(reader, owner),
    inventory = await auditInventoryDigest(reader);
  const pin = session.state.accepted;
  const binding = digest({
    pin,
    canonical: canonical.digest,
    schema: canonical.schemaSha256,
    inventory,
    instance: session.plan.instance,
    profile: session.plan.profile,
    endpoints: session.plan.endpoints,
  });
  if (session.state.audit) {
    if (session.state.audit.binding !== binding)
      throw Error('Audit pin/inventory/canonical/source binding changed.');
  } else {
    // Previous milestone is already durably marked audited before reusing this file.
    const file = await open(
      session.plan.storagePath + '/comparisons.jsonl',
      constants.O_CREAT | constants.O_WRONLY | constants.O_TRUNC | constants.O_NOFOLLOW,
      0o600,
    );
    await file.sync();
    await file.close();
    await syncPath(session.plan.storagePath);
    session.state.audit = {
      pin,
      canonical: canonical.digest,
      schema: canonical.schemaSha256,
      inventory: inventory.digest,
      count: inventory.count,
      binding,
      bytes: 0,
      commitment: digest([]),
      sources: [session.plan.profile.ethereum[0], session.plan.profile.ethereum[1]].map((s) => ({
        source: s.id,
        count: 0,
        after: null,
        pages: 0,
      })) as NonNullable<typeof session.state.audit>['sources'],
      finalizing: false,
    };
    session.state.phase = 'audit';
    await session.save();
  }
  return { canonical, inventory };
}

export async function resumeAudit(
  reader: pg.Client,
  owner: pg.Client,
  session: ReconstructionSession,
  sources: [Source, Source],
  scopes: ReconstructionAuditScope[],
  signal: AbortSignal,
  boundary: () => Promise<void>,
  hooks: AuditHooks = {},
) {
  const a = session.state.audit!,
    pin = a.pin.header;
  const file = await open(
    session.plan.storagePath + '/comparisons.jsonl',
    constants.O_RDWR | constants.O_NOFOLLOW,
  );
  try {
    await validateComparisonPrefix(reader, file, session);
    for (const source of sources) await source.verify(pin, signal);
    await auditState(reader, 1, sources, signal, {
      header: pin,
      balances: async (source) => {
        const i = sources.indexOf(source),
          p = a.sources[i]!,
          scope = scopes[i]!;
        for (;;) {
          await boundary();
          const expected = await auditPage(reader, p.after);
          if (!expected.length) {
            if (p.count !== a.count) throw Error('Audit incomplete inventory.');
            break;
          }
          scope.page = expected;
          // The observed callback precedes compareAccounts' mismatch check. It is
          // diagnostic only; matched coverage is credited after this function returns.
          let observed: AuditAccount[] | undefined;
          try {
            await compareAccounts(source, expected, pin, signal, {
              batch: async (event) => {
                observed = event.observed;
              },
            });
          } catch (error) {
            if (observed)
              await atomicJson(session.plan.storagePath, 'audit-mismatch.json', {
                binding: a.binding,
                source: p.source,
                offset: p.count,
                expected,
                observed,
              }).catch((secondary: unknown) => session.secondary(String(secondary)));
            throw error;
          }
          scope.page = [];
          const page = {
            binding: a.binding,
            source: p.source,
            offset: p.count,
            rows: expected.map((r) => ({
              address: r.address,
              expected: r.hearts,
              observed: r.hearts,
            })),
          };
          const line = Buffer.from(JSON.stringify(page) + '\n');
          const written = await file.write(line, 0, line.length, a.bytes);
          if (written.bytesWritten !== line.length) throw Error('Comparison append incomplete.');
          await file.sync();
          await hooks.afterAppend?.();
          const previous = { bytes: a.bytes, commitment: a.commitment, coverage: { ...p } };
          a.bytes += line.length;
          a.commitment = digest({ prior: a.commitment, page });
          p.count += expected.length;
          p.pages++;
          p.after = expected.at(-1)!.address;
          try {
            await session.save();
          } catch (error) {
            a.bytes = previous.bytes;
            a.commitment = previous.commitment;
            Object.assign(p, previous.coverage);
            throw error;
          }
          await hooks.afterPage?.();
        }
      },
    });
    a.finalizing = true;
    await session.save();
    for (const source of sources)
      if (digest(plainHeader(await source.header(pin.number, signal, true))) !== digest(pin))
        throw Error('Audit ending header changed.');
    if (a.sources.some((s) => s.count !== a.count)) throw Error('Full paired coverage incomplete.');
    const coverage = await validateComparisonPrefix(reader, file, session);
    await reader.query('ROLLBACK');
    await beginAuditSnapshot(reader, session.deadline() - session.time());
    const after = await canonicalEvidence(reader, owner);
    if (after.digest !== a.canonical) throw Error('Fresh post-audit canonical equality failed.');
    return {
      before: a.canonical,
      after: after.digest,
      unchanged: true,
      inventory: a.inventory,
      count: a.count,
      coverage,
    };
  } finally {
    await file.close();
  }
}
