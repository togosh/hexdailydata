// Future between-invocation collection only. Inputs are explicit quiescent file copies.
// No supervisor, provider, SQL, or accounting mutation is available here.
import assert from 'node:assert/strict';
import { createReadStream } from 'node:fs';
import { readFile, mkdir, lstat } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { digest } from '../../dist/services/projections/input.js';
import {
  reconstructionStateSchema,
  assertAuditOnlyState,
} from '../../dist/operator/reconstruction-state.js';
import { seal, verify, identity } from './reconstruction-seal.mjs';
const json = async (p) => JSON.parse(await readFile(p, 'utf8'));

// Same page commitment as the runtime. Streaming keeps collection bounded even
// when a milestone's full comparison inventory is large.
async function verifyComparisons(path, audit, sources, partial = false) {
  const before = await identity(path);
  assert.equal(before.bytes, audit.coverage.bytes, 'Comparison byte count changed');
  assert(Number.isSafeInteger(audit.count) && audit.count > 0);
  assert.equal(sources.length, 2);
  const progress = sources.map((source) => ({ source, count: 0, after: null, pages: 0 }));
  let active = 0,
    commitment = digest([]),
    tail = '';
  const page = (line) => {
    assert(Buffer.byteLength(line) <= 4096, 'Comparison page exceeds bound');
    const p = JSON.parse(line);
    if (partial) assert.equal(p.binding, audit.binding, 'Partial audit binding changed');
    if (progress[active]?.count === audit.count) active++;
    const current = progress[active];
    assert(
      current && p.source === current.source && p.offset === current.count,
      'Comparison source/position changed',
    );
    assert(Array.isArray(p.rows) && p.rows.length >= 1 && p.rows.length <= 10);
    for (const row of p.rows) {
      assert(/^0x[0-9a-f]{40}$/.test(row.address));
      assert(
        current.after === null || row.address > current.after,
        'Comparison order/duplicate changed',
      );
      assert(
        /^(0|[1-9][0-9]*)$/.test(row.expected) && row.expected === row.observed,
        'Comparison value mismatch',
      );
      current.after = row.address;
      current.count++;
    }
    assert(current.count <= audit.count, 'Comparison count exceeded');
    current.pages++;
    commitment = digest({ prior: commitment, page: p });
  };
  for await (const chunk of createReadStream(path, { encoding: 'utf8', highWaterMark: 16384 })) {
    tail += chunk;
    let newline;
    while ((newline = tail.indexOf('\n')) !== -1) {
      page(tail.slice(0, newline));
      tail = tail.slice(newline + 1);
    }
    assert(Buffer.byteLength(tail) <= 4096, 'Comparison page exceeds bound');
  }
  assert.equal(tail, '', 'Incomplete comparison page');
  assert(
    partial || progress.every((p) => p.count === audit.count),
    'Incomplete paired comparison coverage',
  );
  assert.deepEqual(progress, audit.coverage.sources, 'Comparison coverage changed');
  assert.equal(commitment, audit.coverage.commitment, 'Comparison commitment changed');
  assert.deepEqual(await identity(path), before, 'Comparison changed during verification');
  return before;
}

export async function collect(environment, snapshot, archive) {
  const plan = await json(join(environment, 'input/plan.json'));
  const statePath = join(snapshot, 'reconstruction.json');
  const { checksum, ...state } = await json(statePath);
  const host = await json(join(environment, 'reconstruction-host.json'));
  const result = await json(join(environment, 'reconstruction-host-result.json'));
  assert.equal(checksum, digest(state));
  assert.equal(state.digest, digest(plan));
  assertAuditOnlyState(plan, state);
  assert.equal(host.digest, state.digest);
  assert.equal(result.digest, state.digest);
  assert.equal(host.pending, false);
  assert.equal(state.segment.number, host.segments);
  assert.equal(result.segments, host.segments);
  assert.equal(result.start, host.start);
  assert.equal(result.deadline, host.deadline);
  assert.equal(state.start, host.start);
  assert.equal(state.deadline, host.deadline);
  const unknownEnd = state.segment.ended === null;
  if (unknownEnd) {
    // Clock-failed timestamps cannot prove settlement. The bound host/native
    // records must do so; this exception only preserves terminal evidence.
    reconstructionStateSchema.parse(state);
    const clock = state.clockDiagnostic;
    const clockFailed =
      (clock?.domain === 'reconstruction-ceiling-epoch-ms' &&
        clock.failed === true &&
        Number.isSafeInteger(clock.anomalies?.count) &&
        clock.anomalies.count > 0 &&
        clock.anomalies.last?.classification === 'terminal') ||
      (clock?.domain === 'injected-effective-ms' && clock.classification === 'terminal');
    const native = result.result;
    const exit = Object.hasOwn(native ?? {}, 'nativeStatus') ? native.nativeStatus : native?.status;
    assert(
      state.status === 'blocked' &&
        state.terminal === true &&
        state.lastEnded === null &&
        clockFailed &&
        state.reason.length > 0 &&
        host.terminal === true &&
        result.terminal === true &&
        result.pending === false &&
        native?.status === 2 &&
        Number.isSafeInteger(exit) &&
        exit >= 0 &&
        native.signal == null,
      'Null ending requires a settled terminal clock failure',
    );
  } else assert(Number.isSafeInteger(state.segment.ended) && state.status !== 'running');
  for (const name of ['.reconstruction-host.lock'])
    await assert.rejects(lstat(join(environment, name)), { code: 'ENOENT' });
  await mkdir(archive, { recursive: true });
  const binding = {
    planDigest: state.digest,
    run: plan.run,
    segment: host.segments,
    milestone: state.milestone,
    audited: state.audited,
  };
  const destination = join(archive, 'segment-' + String(host.segments).padStart(5, '0'));
  const partial = {};
  if ((state.terminal || plan.auditOnly) && state.audit) {
    const label = await json(join(snapshot, 'PARTIAL.json'));
    assert.equal(label.classification, 'PARTIAL_NOT_A_COMPLETED_AUDIT');
    assert.deepEqual(label.audit, state.audit);
    if (plan.auditOnly && !state.terminal) {
      await verifyComparisons(
        join(snapshot, 'comparisons-PARTIAL.jsonl'),
        {
          ...state.audit,
          coverage: {
            bytes: state.audit.bytes,
            commitment: state.audit.commitment,
            sources: state.audit.sources,
          },
        },
        plan.profile.ethereum.map((s) => s.id),
        true,
      );
    }
    partial['comparisons-partial.jsonl'] = join(snapshot, 'comparisons-PARTIAL.jsonl');
    partial['partial.json'] = join(snapshot, 'PARTIAL.json');
  }
  await seal(
    destination,
    {
      'reconstruction-output.log': join(environment, 'reconstruction-output.log'),
      'reconstruction-host-result.json': join(environment, 'reconstruction-host-result.json'),
      'reconstruction-host.json': join(environment, 'reconstruction-host.json'),
      'reconstruction.json': statePath,
      ...partial,
    },
    binding,
  );
  // A missing/partial milestone seal blocks this procedure, therefore the next invocation.
  for (let i = 1; i <= state.milestone; i++) {
    const milestone = join(archive, 'milestone-' + plan.milestones[i - 1]);
    let exists = true;
    try {
      await lstat(milestone);
    } catch (e) {
      if (e.code !== 'ENOENT') throw e;
      exists = false;
    }
    if (!exists) {
      assert.equal(i, state.milestone, 'Earlier milestone evidence is missing');
      assert(
        ['milestone-audited', 'complete'].includes(state.phase),
        'Current full milestone evidence is no longer guaranteed',
      );
      assert.equal(state.audited.header.number, plan.milestones[i - 1]);
      assert.deepEqual(state.audited, state.accepted);
      const audit = await json(join(snapshot, 'audit-result.json'));
      assert.equal(audit.unchanged, true);
      assert.equal(audit.before, audit.after);
      assert.equal(audit.after, state.canonicalAtPause);
      assert(audit.coverage.sources.every((s) => s.count === audit.count));
      const verified = await verifyComparisons(
        join(snapshot, 'comparisons.jsonl'),
        audit,
        plan.profile.ethereum.map((s) => s.id),
      );
      const copied = await seal(
        milestone,
        {
          'comparisons.jsonl': join(snapshot, 'comparisons.jsonl'),
          'audit-result.json': join(snapshot, 'audit-result.json'),
          'reconstruction.json': statePath,
        },
        { ...binding, milestone: i },
      );
      assert.deepEqual(
        copied.files['comparisons.jsonl'],
        verified,
        'Verified comparison changed before seal',
      );
    }
    const sealed = await verify(milestone);
    assert.equal(sealed.binding.planDigest, state.digest);
    assert.equal(sealed.binding.milestone, i);
    assert.equal(sealed.binding.audited.header.number, plan.milestones[i - 1]);
    await verifyComparisons(
      join(milestone, 'comparisons.jsonl'),
      await json(join(milestone, 'audit-result.json')),
      plan.profile.ethereum.map((s) => s.id),
    );
  }
  await verify(destination);
  const resumeEligible =
    state.status === 'paused' &&
    !state.terminal &&
    !state.pending &&
    !state.pendingSql &&
    !host.terminal &&
    result.result.status === 3 &&
    Date.now() < host.deadline;
  return {
    status: 'SEALED',
    destination,
    binding,
    resumeEligible,
    authorization: 'NOT_AUTHORIZED_BY_COLLECTION',
    classification: state.terminal ? 'TERMINAL_EVIDENCE' : 'SETTLED_EVIDENCE',
    endingTime: unknownEnd ? 'UNKNOWN' : 'RECORDED',
  };
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url))
  console.log(JSON.stringify(await collect(...process.argv.slice(2)), null, 2));
