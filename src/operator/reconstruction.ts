import { connect, databaseConfig } from '../db/connect.ts';
import { realClock, ProviderBudget, type Clock } from '../providers/budget.ts';
import { cooldownFiles } from '../providers/cooldown.ts';
import { httpTransport, type Transport } from '../providers/rpc.ts';
import { profileSources } from '../worker/sync/profile.ts';
import { SyncEngine } from '../worker/sync/engine.ts';
import { CanonicalWriter, type FaultHooks } from '../services/projections/writer.ts';
import { digest, hex, type Header } from '../services/projections/input.ts';
import { totalColumns } from '../services/projections/reduce.ts';
import { plainHeader } from '../providers/abi.ts';
import { maintenanceLease } from './lease.ts';
import { reserve, atomicJson } from './files.ts';
import { readCanaryJson, pinnedAuditAdmissionSchema, type CanaryPlan } from './canary-plan.ts';
import { beginAuditSnapshot, inspectAuditTarget, canonicalEvidence } from './canary-audit.ts';
import { PrefixScope } from './canary-prefix.ts';
import { reconstructionAuthority, reconstructionPlanSchema } from './reconstruction-plan.ts';
import { ReconstructionSession, ReconstructionPause, cadence } from './reconstruction-state.ts';
import {
  bindAudit,
  resumeAudit,
  ReconstructionAuditScope,
  type AuditHooks,
} from './reconstruction-audit.ts';
import { operatorError } from './errors.ts';
import { rpcDiagnostic } from '../providers/rpc-diagnostic.ts';
import type { SessionHooks } from './canary-session.ts';

export const reconstructionHelp =
  'reconstruct check|prepare|run|resume|status <plan.json> [approval.json]. One fixed common-history operation; clean pauses share original limits. No live authority by default.';
export interface ReconstructionOptions {
  env?: NodeJS.ProcessEnv;
  clock?: Clock;
  transport?: (endpoint: string) => Transport;
  hooks?: FaultHooks;
  sessionHooks?: SessionHooks;
  auditHooks?: AuditHooks;
  /** Explicit offline fault/boundary seams; unavailable from CLI/environment. */
  boundary?: (session: ReconstructionSession) => Promise<void>;
  afterMilestone?: (result: unknown) => Promise<void>;
}
function result(session: ReconstructionSession) {
  const s = session.state,
    caps = session.plan.caps,
    b = s.segment?.before;
  return {
    ...s,
    acceptedSqlUncertain: s.pendingSql !== null,
    remaining: {
      milliseconds:
        s.deadline === null ? caps.milliseconds : Math.max(0, s.deadline - session.clock.now()),
      http: Math.max(0, caps.http - s.http),
      logical: Math.max(0, caps.logical - s.logical),
      chargedBytes: Math.max(0, caps.bytes - s.chargedBytes),
    },
    segmentWork: b
      ? {
          http: s.http - b.http,
          logical: s.logical - b.logical,
          chargedBytes: s.chargedBytes - b.chargedBytes,
          observedBytes: s.observedBytes - b.observedBytes,
        }
      : null,
  };
}
export async function runReconstruction(
  args: string[],
  signal: AbortSignal,
  options: ReconstructionOptions = {},
) {
  const clock = options.clock ?? realClock,
    entered = clock.now();
  const [command, path, approval] = args;
  if (!command || command === 'help') return { help: reconstructionHelp };
  if (!path || !['check', 'prepare', 'run', 'resume', 'status'].includes(command))
    throw Error(reconstructionHelp);
  const plan = reconstructionPlanSchema.parse(await readCanaryJson(path));
  if (command === 'check')
    return {
      status: 'CONFIGURED_LOCALLY',
      authorization: 'NOT_AUTHORIZED',
      digest: digest(plan),
      fullTask10: 'PENDING',
      productionReady: false,
    };
  const env = options.env ?? process.env;
  if (process.platform !== 'linux') throw Error('Durable reconstruction requires Linux.');
  if (
    env.HDD_V2_PROJECT !== plan.project ||
    env.HDD_V2_DB_INSTANCE !== plan.instance ||
    env.HDD_V2_RECONSTRUCTION_RELEASE !== plan.release ||
    env.HDD_V2_REVIEWED_COMMIT !== plan.reviewedCommit ||
    env.HDD_V2_STORAGE_PATH !== plan.storagePath ||
    env.HDD_V2_PROVIDER_STATE !== plan.quotaPath
  )
    throw Error('Reconstruction destination/release/source mismatch.');
  const execute = command === 'run' || command === 'resume';
  let invoked = entered;
  if (execute) {
    reconstructionAuthority(plan, approval ? await readCanaryJson(approval) : null, env);
    for (const [i, source] of plan.profile.ethereum.entries())
      if (env[source.endpointEnv] !== plan.endpoints[i])
        throw Error('Reconstruction endpoint mismatch.');
    if (!options.transport) {
      invoked = Number(env.HDD_V2_RECONSTRUCTION_INVOKED_AT);
      if (!Number.isSafeInteger(invoked) || invoked <= 0 || invoked > entered)
        throw Error('Reconstruction requires host supervisor invocation clock.');
    }
  }
  const controller = new AbortController(),
    sqlSignal = AbortSignal.any([signal, controller.signal]);
  const clients: Awaited<ReturnType<typeof connect>>[] = [];
  const release = await maintenanceLease([plan.storagePath, plan.quotaPath], signal);
  let session: ReconstructionSession | undefined,
    owned = false,
    closing = false,
    snapshot = false;
  let reader: Awaited<ReturnType<typeof connect>> | undefined;
  let owner: Awaited<ReturnType<typeof connect>> | undefined;
  const writerClients: Awaited<ReturnType<typeof connect>>[] = [];
  let complete = false,
    primary: unknown;
  const cancelSql = () => {
    for (const c of clients) void c.end().catch(() => {});
  };
  sqlSignal.addEventListener('abort', cancelSql, { once: true });
  const db = async (role: 'api' | 'worker', writable = false) => {
    const c = await connect(databaseConfig(role, env), { signal: sqlSignal });
    clients.push(c);
    const lost = () => {
      if (!closing) controller.abort(Error('SQL ownership lost.'));
    };
    c.on('error', lost);
    c.on('end', lost);
    if (!writable) await c.query('SET default_transaction_read_only=on');
    return c;
  };
  const localGuard = async () => {
    sqlSignal.throwIfAborted();
    await ReconstructionSession.roots(plan);
    await release.check();
    await reserve(plan.storagePath);
    await reserve(plan.quotaPath);
    if (owner && reader) {
      for (const [client, locks] of [
        [
          owner,
          [
            [4244, 0],
            [4244, 1],
            [4250, 0],
          ],
        ],
        ...writerClients.map((c, i) => [c, [[4242, i ? 369 : 1]]]),
      ] as [typeof owner, number[][]][]) {
        const held = (
          await client.query(
            "SELECT classid::int a,objid::int b FROM pg_locks WHERE pid=pg_backend_pid() AND locktype='advisory' AND objsubid=2 AND granted",
          )
        ).rows;
        if (locks.some(([a, b]) => !held.some((r) => r.a === a && r.b === b)))
          throw Error('SQL exclusion lost.');
      }
      const [state] = (
        await reader.query(
          "SELECT current_setting('transaction_read_only') ro,current_setting('transaction_isolation') iso",
        )
      ).rows;
      if (state.ro !== 'on' || state.iso !== (snapshot ? 'repeatable read' : 'read committed'))
        throw Error('Read-only snapshot lost.');
    }
  };
  const begin = async () => {
    await beginAuditSnapshot(
      reader!,
      session
        ? session.deadline() - session.time()
        : Math.max(1, 3600000 - (clock.now() - entered)),
    );
    snapshot = true;
  };
  const end = async () => {
    if (snapshot) await reader!.query('ROLLBACK');
    snapshot = false;
  };
  const cursor = async () => {
    const [s] = (await reader!.query('SELECT * FROM hdd.sync_state WHERE chain_id=1')).rows;
    const [h] = (
      await reader!.query('SELECT * FROM hdd.blocks_recent WHERE chain_id=1 AND number=$1', [
        s?.block_number,
      ])
    ).rows;
    if (!s || !h) throw Error('Missing accepted SQL checkpoint.');
    return {
      header: {
        number: h.number,
        hash: hex(h.hash),
        parentHash: hex(h.parent_hash),
        timestamp: h.timestamp,
      } as Header,
      revision: s.revision as string,
    };
  };
  const reconcilePendingSql = async (
    actual: Awaited<ReturnType<typeof cursor>>,
    allowRolledBack = false,
  ) => {
    const s = session!,
      pending = s.state.pendingSql!;
    const [receipt] = (
      await reader!.query(
        "SELECT batch_digest,previous_sync->>'block_number' previous_number,previous_sync->>'block_hash' previous_hash,previous_sync->>'revision' previous_revision FROM hdd.checkpoints_recent WHERE chain_id=1 AND block_number=$1",
        [pending.next.header.number],
      )
    ).rows;
    const committed =
      digest(actual) === digest(pending.next) &&
      receipt?.batch_digest === pending.batchDigest &&
      receipt.previous_number === pending.previous.header.number &&
      receipt.previous_hash === pending.previous.header.hash.replace('0x', '\\x') &&
      receipt.previous_revision === pending.previous.revision;
    const rolledBack = allowRolledBack && !receipt && digest(actual) === digest(pending.previous);
    if (!committed && !rolledBack)
      throw Error('BLOCKED_UNCERTAIN: SQL transition cannot be uniquely recovered.');
    s.state.accepted = actual;
    s.state.pendingSql = null;
  };
  try {
    await localGuard();
    if (command !== 'prepare')
      session = await ReconstructionSession.load(plan, clock, options.sessionHooks);
    if (command === 'status') return result(session!);
    const oldDigest = session?.state.canonicalAtPause;
    const oldStatus = session?.state.status;
    if (execute) {
      session!.assertStartable(command === 'resume');
      owned = true;
      await session!.start(command === 'resume', invoked);
    }
    owner = await db('worker');
    for (const [a, b] of [
      [4244, 0],
      [4244, 1],
      [4250, 0],
    ])
      if (
        !(await owner.query('SELECT pg_try_advisory_lock($1::int,$2::int) held', [a, b])).rows[0]
          .held
      )
        throw Error('Exclusive stopped API/worker/maintenance required.');
    let writer: CanonicalWriter | undefined;
    for (const chain of [1, 369] as const) {
      const c = await db('worker', execute && chain === 1);
      writerClients.push(c);
      const w = await CanonicalWriter.acquire(c, chain);
      if (chain === 1) writer = w;
    }
    reader = await db('api');
    await begin();
    if (session) {
      const actual = await cursor(),
        pending = session.state.pendingSql;
      if (pending) await reconcilePendingSql(actual);
      else if (digest(actual) !== digest(session.state.accepted))
        throw Error('BLOCKED_UNCERTAIN: arbitrary SQL checkpoint drift.');
      else if (oldStatus === 'running' && !session.state.audit && !oldDigest)
        throw Error('BLOCKED_UNCERTAIN: no quiescent replay receipt.');
    }
    // Reuse the exact admission checks for migrations, chain/history/identities and totals.
    let expected = plan.admission;
    if (session && command === 'resume') {
      const [current] = (await reader.query('SELECT * FROM hdd.current_state WHERE chain_id=1'))
        .rows;
      const counts: Record<string, string> = {};
      for (const table of Object.keys(pinnedAuditAdmissionSchema.shape.counts.shape))
        counts[table] = (await reader.query('SELECT count(*)::text n FROM hdd.' + table)).rows[0].n;
      expected = pinnedAuditAdmissionSchema.parse({
        ...plan.admission,
        checkpoint: session.state.accepted.header,
        revision: session.state.accepted.revision,
        counts,
        current: Object.fromEntries(['contract_day', ...totalColumns].map((k) => [k, current[k]])),
      });
    }
    const admitted = await inspectAuditTarget(reader, owner, plan.profile, expected, true);
    if (
      command !== 'resume' &&
      (admitted.canonical.digest !== plan.canonicalDigest ||
        admitted.inventoryDigest !== plan.inventoryDigest)
    )
      throw Error('Start admission digest mismatch.');
    if (oldDigest && admitted.canonical.digest !== oldDigest)
      throw Error('Paused canonical state changed.');
    if (command === 'prepare') {
      session = await ReconstructionSession.prepare(plan, clock);
      return session.state;
    }
    const s = session!,
      active = AbortSignal.any([sqlSignal, s.controller.signal]);
    await s.save();
    await end();
    const cooldown = await cooldownFiles(plan.quotaPath, 'worker');
    const budget = new ProviderBudget('worker', cooldown, {
      now: () => s.time(),
      sleep: (ms, signal) => clock.sleep(ms, signal),
    });
    const boundary = async () => {
      await localGuard();
      s.check();
      await options.boundary?.(s);
    };
    const transport = (index: number, scope: PrefixScope | ReconstructionAuditScope) =>
      s.gate.transport(
        1,
        (options.transport ?? httpTransport)(plan.endpoints[index]!),
        plan.profile.ethereum[index]!.id,
        scope,
        cadence,
        s.state.segment!.started + 60000,
        { guard: localGuard },
      );
    while (s.state.milestone < plan.milestones.length) {
      await boundary();
      const target = plan.milestones[s.state.milestone]!;
      if (BigInt(s.state.accepted.header.number) < BigInt(target)) {
        const scopes = plan.profile.ethereum.map(
          (provider) =>
            new PrefixScope(
              plan as Pick<CanaryPlan, 'profile' | 'methods'>,
              {
                kind: 'reconstruct',
                start: plan.admission.checkpoint,
                through: target,
                finalityHeaders: plan.finalityHeaders,
              },
              provider.id,
              [],
            ),
        );
        const sources = profileSources(
          plan.profile,
          1,
          (source) =>
            transport(
              plan.profile.ethereum.indexOf(source),
              scopes[plan.profile.ethereum.indexOf(source)]!,
            ),
          budget,
          2097152,
        );
        const stops: Header[] = [];
        for (const source of sources)
          stops.push(plainHeader(await source.header(target, active, true)));
        if (
          digest(stops[0]) !== digest(stops[1]) ||
          (s.state.stopHeader && digest(stops[0]) !== digest(s.state.stopHeader))
        )
          throw Error('Milestone header disagreement/change.');
        s.state.stopHeader = stops[0]!;
        await s.save();
        const engine = new SyncEngine(writer!, reader, sources, plan.storagePath, options.hooks);
        await engine.once(active, stops[0], {
          beforeRange: async () => {
            await boundary();
            const [current] = (
              await reader!.query(
                'SELECT sampled_addresses FROM hdd.current_state WHERE chain_id=1',
              )
            ).rows;
            for (const scope of scopes)
              scope.sample(
                current.sampled_addresses.map((a: Buffer) => ({ address: hex(a), hearts: '0' })),
              );
          },
          beforeCommit: async (accepted) => {
            await localGuard();
            s.check();
            s.state.pendingSql = {
              previous: s.state.accepted,
              next: {
                header: accepted.last,
                revision: (BigInt(s.state.accepted.revision) + 1n).toString(),
              },
              batchDigest: accepted.batchDigest,
            };
            await s.save();
          },
          checkpoint: async () => {
            const actual = await cursor();
            if (digest(actual) !== digest(s.state.pendingSql?.next))
              throw Error('SQL receipt acknowledgement mismatch.');
            s.state.accepted = actual;
            s.state.pendingSql = null;
            if (actual.header.number === target) s.state.phase = 'milestone-pending';
            await s.save();
            await boundary();
          },
        });
      }
      if (
        s.state.accepted.header.number !== target ||
        digest(s.state.accepted.header) !== digest(s.state.stopHeader)
      )
        throw Error('Milestone barrier mismatch.');
      s.state.phase = 'milestone-pending';
      await s.save();
      await begin();
      await bindAudit(reader, owner, s);
      const scopes = plan.profile.ethereum.map(
        () => new ReconstructionAuditScope(plan.profile.contract, s.state.accepted.header),
      );
      const sources = profileSources(
        plan.profile,
        1,
        (source) =>
          transport(
            plan.profile.ethereum.indexOf(source),
            scopes[plan.profile.ethereum.indexOf(source)]!,
          ),
        budget,
        2097152,
      );
      const result = await resumeAudit(
        reader,
        owner,
        s,
        sources,
        scopes,
        active,
        boundary,
        options.auditHooks,
      );
      await atomicJson(plan.storagePath, 'audit-result.json', result);
      await options.afterMilestone?.(result);
      await end();
      s.state.audited = s.state.accepted;
      s.state.milestone++;
      s.state.phase = 'milestone-audited';
      s.state.audit = null;
      s.state.stopHeader = null;
      await s.save();
      // Leave this milestone's complete evidence available to the host collector
      // before bindAudit can reuse the comparison/result files on a later resume.
      if (s.state.milestone < plan.milestones.length)
        throw new ReconstructionPause(
          'Declared milestone audited; collect evidence before resume.',
        );
    }
    complete = true;
  } catch (e) {
    primary = e;
    if (!owned || !session) throw e;
  } finally {
    if (owned && session) {
      await session.close();
      const clean =
        primary instanceof ReconstructionPause &&
        !session.state.terminal &&
        !session.state.pending &&
        !session.state.pendingSql;
      if (!complete && !clean) session.state.terminal = true;
      const cleanup = async (work: () => Promise<unknown>) => {
        try {
          await work();
        } catch (e) {
          session!.secondary(operatorError(e));
          session!.state.terminal = true;
        }
      };
      await cleanup(end);
      if (reader && owner && session.state.pendingSql)
        await cleanup(async () => {
          try {
            // A rejected acknowledgement may follow COMMIT. Resolve only the
            // exact saved transition while exclusions still protect this SQL state.
            await localGuard();
            await reconcilePendingSql(await cursor(), true);
          } catch (e) {
            throw Error('Accepted SQL checkpoint uncertain: ' + operatorError(e));
          }
        });
      if (reader && owner && !session.state.terminal)
        await cleanup(async () => {
          await localGuard();
          await begin();
          session!.state.canonicalAtPause = (await canonicalEvidence(reader!, owner!)).digest;
          await end();
        });
      closing = true;
      for (const c of clients) await cleanup(() => c.end());
      const st = session.state;
      if (clock.now() >= session.deadline() || sqlSignal.aborted) {
        st.terminal = true;
        primary ??= Error('Deadline/cancellation during finalization.');
      }
      st.status = st.terminal ? 'blocked' : complete ? 'complete' : 'paused';
      if (complete && !st.terminal) {
        st.phase = 'complete';
        st.terminal = true;
      }
      st.reason = (
        primary
          ? operatorError(primary)
          : (st.secondary[0] ?? 'Declared common-history interval fully audited.')
      ).slice(0, 240);
      st.rpcDiagnostic = rpcDiagnostic(primary);
      st.lastEnded = clock.now();
      if (st.segment) st.segment.ended = st.lastEnded;
      try {
        await session.hooks.beforeFinalSave?.();
        await session.save();
        if (clock.now() >= session.deadline() && st.status !== 'blocked') {
          st.status = 'blocked';
          st.terminal = true;
          st.phase = complete ? 'milestone-audited' : st.phase;
          st.reason = 'Deadline during final save.';
          await session.save();
        }
      } catch (e) {
        st.status = 'blocked';
        st.terminal = true;
        if (complete) st.phase = 'milestone-audited';
        st.secondary.push(operatorError(e).slice(0, 240));
      }
    } else {
      closing = true;
      await end();
      for (const c of clients) await c.end();
    }
    sqlSignal.removeEventListener('abort', cancelSql);
    await release();
  }
  return result(session!);
}
