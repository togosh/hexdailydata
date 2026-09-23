import {
  decodeHeader,
  plainHeader,
  decodeLog,
  rawLogSchema,
  selectors,
  q,
  type RawLog,
} from '../providers/abi.ts';
import { validateCall, type RpcCall } from '../providers/rpc.ts';
import { assertDeclaredHeader } from '../providers/binding.ts';
import { profileBinding } from '../worker/sync/profile.ts';
import { digest, type Header } from '../services/projections/input.ts';
import type { AuditAccount } from '../worker/sync/audit.ts';
import type { CanaryPlan } from './canary-plan.ts';

export type PrefixPhase = Extract<
  CanaryPlan['phases'][number],
  { kind: 'common-prefix' | 'common-continue' }
>;
export const prefixPhase = (plan: CanaryPlan) =>
  plan.phases.find(
    (p): p is PrefixPhase => p.kind === 'common-prefix' || p.kind === 'common-continue',
  );

/** Ephemeral, bounded permission context for this one non-resumable prefix. Header-only
 * exceptions never enter the state-pin set. Source still performs its normal checks. */
export class PrefixScope {
  private headers = new Map<string, Header>();
  private addresses = new Set<string>();
  private logs: RawLog[] = [];
  private finalized: Header | undefined;
  private start: string;
  constructor(
    private plan: Pick<CanaryPlan, 'profile' | 'methods'>,
    private phase:
      | PrefixPhase
      | {
          kind: 'reconstruct';
          start: Header;
          through: string;
          finalityHeaders: { minimum: string; maximum: string };
        },
    private source = 'TEST',
    inventory?: AuditAccount[],
  ) {
    this.start =
      phase.kind === 'reconstruct'
        ? phase.start.number
        : phase.kind === 'common-continue'
          ? phase.admission.checkpoint.number
          : plan.profile.constructor.checkpoint.number;
    if (
      phase.kind === 'common-continue' &&
      (!inventory ||
        digest(inventory) !== phase.inventoryDigest ||
        inventory.length !== Number(phase.admission.counts.accounts) ||
        new Set(inventory.map((a) => a.address)).size !== inventory.length)
    )
      throw Error('Common continuation requires admitted inventory.');
    for (const b of inventory ?? plan.profile.constructor.balances) this.addresses.add(b.address);
  }
  /** Bulk replay carries only the current deterministic sample, never its full inventory. */
  sample(inventory: AuditAccount[]) {
    this.addresses = new Set(inventory.map((a) => a.address));
  }
  private contains(n: string) {
    return BigInt(n) >= BigInt(this.start) && BigInt(n) <= BigInt(this.phase.through);
  }
  request(chain: number, calls: RpcCall[]) {
    if (chain !== 1 || calls.length < 1 || calls.length > 30)
      throw Error('Common prefix origin/batch rejected.');
    for (const c of calls) {
      validateCall(c, this.plan.profile.contract);
      const p = c.params;
      if (!this.plan.methods.includes(c.method as CanaryPlan['methods'][number]))
        throw Error('Common prefix method rejected.');
      if (c.method === 'eth_getBlockByNumber') {
        if (p[0] === 'finalized') continue;
        if (p[0] === 'latest') throw Error('Common prefix latest rejected.');
        const n = BigInt(p[0] as string).toString();
        if (
          !this.contains(n) &&
          n !== this.plan.profile.fork.parent.number &&
          n !== this.finalized?.number
        )
          throw Error('Common prefix header outside scope.');
      } else if (c.method === 'eth_getCode') {
        if (!this.contains(BigInt(p[1] as string).toString()))
          throw Error('Common prefix code outside scope.');
      } else if (c.method === 'eth_getLogs') {
        const f = p[0] as { fromBlock: string; toBlock: string };
        if (
          !this.contains(BigInt(f.fromBlock).toString()) ||
          !this.contains(BigInt(f.toBlock).toString()) ||
          (this.phase.kind !== 'common-prefix' && BigInt(f.fromBlock) <= BigInt(this.start))
        )
          throw Error('Common prefix logs outside scope.');
      } else if (c.method === 'eth_getTransactionReceipt') {
        if (
          this.phase.kind !== 'common-prefix' ||
          p[0] !== this.plan.profile.constructor.transactionHash
        )
          throw Error('Common prefix receipt rejected.');
      } else if (c.method === 'eth_call') {
        const data = (p[0] as { data: string }).data;
        if (!Object.values(selectors).includes(data.slice(0, 10)))
          throw Error('Common prefix selector rejected.');
        if (
          ![...this.headers.values()].some(
            (h) => h.hash === (p[1] as { blockHash: string }).blockHash,
          )
        )
          throw Error('Common prefix state pin unverified/outside scope.');
        if (data.startsWith(selectors.balanceOf) && !this.addresses.has('0x' + data.slice(-40)))
          throw Error('Common prefix balance inventory rejected.');
      }
    }
  }
  response(calls: (RpcCall & { id?: number })[], text: string) {
    const rows: unknown = JSON.parse(text);
    if (!Array.isArray(rows) || rows.length !== calls.length)
      throw Error('Common prefix requires batch responses.');
    const byId = new Map(rows.map((r) => [r.id, r]));
    if (byId.size !== calls.length) throw Error('Common prefix duplicate response.');
    for (const c of calls) {
      const row = byId.get(c.id);
      if (!row) throw Error('Common prefix missing response.');
      if (row.error) continue; // RpcClient owns retry/capability classification.
      if (c.method === 'eth_getBlockByNumber') {
        const decoded = decodeHeader(row.result),
          h = plainHeader(decoded);
        if (c.params[0] === 'finalized') {
          if (
            BigInt(h.number) < BigInt(this.phase.finalityHeaders.minimum) ||
            BigInt(h.number) > BigInt(this.phase.finalityHeaders.maximum)
          )
            throw Error('Common prefix finalized header outside corridor.');
          this.finalized = h;
          console.log(
            JSON.stringify({ event: 'canary_finalized_header', source: this.source, header: h }),
          );
        } else {
          if (q(h.number) !== c.params[0]) throw Error('Common prefix numeric header mismatch.');
          if (
            h.number === this.finalized?.number &&
            JSON.stringify(h) !== JSON.stringify(this.finalized)
          )
            throw Error('Common prefix finalized identity contradiction.');
          if (this.contains(h.number) || h.number === this.plan.profile.fork.parent.number)
            assertDeclaredHeader(profileBinding(this.plan.profile, 1), h);
          if (this.contains(h.number)) {
            const prior = this.headers.get(h.number);
            if (prior && JSON.stringify(prior) !== JSON.stringify(h))
              throw Error('Common prefix header changed.');
            this.headers.set(h.number, h);
            if (this.phase.kind === 'reconstruct')
              while (this.headers.size > 4096)
                this.headers.delete(this.headers.keys().next().value!);
            const remaining: RawLog[] = [];
            for (const log of this.logs) {
              if (BigInt(log.blockNumber).toString() !== h.number) {
                remaining.push(log);
                continue;
              }
              if (
                decoded.transactions[Number(BigInt(log.transactionIndex))] !== log.transactionHash
              )
                throw Error('Common prefix event transaction mismatch.');
              const event = decodeLog(log, 1, this.plan.profile.contract, h);
              for (const key of ['address', 'sender', 'recipient'] as const) {
                const value = event.value as unknown as Record<string, string>;
                if (value[key] && value[key] !== '0x' + '0'.repeat(40))
                  this.addresses.add(value[key]);
              }
            }
            this.logs = remaining;
          }
        }
      } else if (c.method === 'eth_getLogs') {
        if (!Array.isArray(row.result) || row.result.length > 2000) continue; // Source splits oversized sets.
        const f = c.params[0] as { fromBlock: string; toBlock: string };
        this.logs = row.result.map((v: unknown) => rawLogSchema.parse(v));
        if (
          this.logs.some(
            (l) =>
              l.address !== this.plan.profile.contract ||
              BigInt(l.blockNumber) < BigInt(f.fromBlock) ||
              BigInt(l.blockNumber) > BigInt(f.toBlock),
          )
        )
          throw Error('Common prefix returned logs outside scope.');
      }
    }
  }
}
