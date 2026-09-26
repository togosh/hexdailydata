// Maintained version of the saved supervisor -> snapshot -> collect -> continue loop.
// It owns one explicit operation in an owner terminal; it is not a job service.
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import {
  readFileSync,
  writeFileSync,
  openSync,
  closeSync,
  renameSync,
  unlinkSync,
  existsSync,
  mkdirSync,
  lstatSync,
  fsyncSync,
} from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { ReconstructionClock } from '../../dist/operator/reconstruction-clock.js';
import { digest } from '../../dist/services/projections/input.js';

export const jobHelp =
  'reconstruction-job run|resume <owned-environment> <scope.json> <output-directory> [--stop-at=<declared-milestone>]\nreconstruction-job status <output-directory>\nreconstruction-job pause <output-directory> <operation-UUID>\nForeground owner PowerShell only. Requires an existing separately authorized plan/approval/runtime. No prepare, grant renewal, crash restart or detached mode.';
const counters = ['http', 'logical', 'observedBytes', 'chargedBytes'];
export function readSmall(path) {
  const stat = lstatSync(path);
  assert(
    stat.isFile() && !stat.isSymbolicLink() && stat.size <= 65536,
    'Expected small regular control file',
  );
  return JSON.parse(readFileSync(path, 'utf8'));
}
export function publish(root, name, value, once = false) {
  const target = join(root, name),
    temporary = target + '.' + randomUUID() + '.tmp';
  if (once)
    writeFileSync(target, JSON.stringify(value, null, 2) + '\n', {
      flag: 'wx',
      flush: true,
      mode: 0o600,
    });
  else {
    writeFileSync(temporary, JSON.stringify(value, null, 2) + '\n', {
      flag: 'wx',
      flush: true,
      mode: 0o600,
    });
    renameSync(temporary, target);
  }
  if (process.platform === 'linux') {
    const fd = openSync(root, 'r');
    try {
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
  }
}
export function status(root) {
  try {
    const record = readSmall(join(root, 'status.json'));
    assert(/^[0-9a-f-]{36}$/.test(record.owner));
    if (record.resultFile) assert.equal(record.resultFile, 'result-' + record.owner + '.json');
    const result = record.resultFile ? readSmall(join(root, record.resultFile)) : null;
    if (result) assert.equal(result.owner, record.owner);
    return {
      ...record,
      observation: result ? 'SETTLED_RECORD' : 'OWNERSHIP_UNKNOWN',
      result: result ?? 'NOT_YET_OBSERVED',
      limitation:
        'One saved observation only. A running label, PID or timestamp does not establish a live or healthy worker; no process, SQL or provider was queried.',
    };
  } catch (error) {
    return {
      observation: 'UNKNOWN',
      result: 'NOT_YET_OBSERVED',
      reason:
        error.code === 'ENOENT'
          ? 'No complete status/result observed.'
          : 'Invalid or incomplete status evidence.',
    };
  }
}
export function pause(root, operation) {
  const record = readSmall(join(root, 'status.json'));
  assert(/^[0-9a-f-]{36}$/.test(record.owner));
  assert.equal(record.operation, operation, 'Pause operation mismatch');
  assert(!record.resultFile, 'Coordinator already settled; no pause request written');
  publish(
    root,
    'pause-' + record.owner + '.json',
    { operation, owner: record.owner, requestedWallUtc: Date.now() },
    true,
  );
  return {
    requested: true,
    operation,
    behavior: 'After current segment is collected and sealed; terminal outcomes take precedence.',
  };
}
function clean(state) {
  return (
    state &&
    !state.pending &&
    !state.pendingSql &&
    !state.terminal &&
    state.status === 'paused' &&
    state.segment?.ended != null
  );
}
function totals(state) {
  return Object.fromEntries(counters.map((k) => [k, state[k]]));
}

/** Adapters expose the existing supervisor/collector, or explicit offline fixtures.
 * No adapter is selected from a scope file, CLI string, or environment variable. */
export async function coordinate(
  { root, lockRoot, operation, plan, action, stopAt, binding },
  adapter,
  clock = new ReconstructionClock(),
) {
  assert(['run', 'resume'].includes(action));
  assert(!stopAt || plan.milestones.includes(stopAt), 'Stop must name a declared milestone');
  mkdirSync(root, { recursive: true });
  const owner = randomUUID(),
    locks = [];
  let admitted = false,
    outcome,
    previous,
    originalStart,
    originalDeadline,
    recoveryResult,
    currentChild = null,
    emergency = false;
  let current = {
    version: 1,
    owner,
    operation,
    binding,
    coordinatorPid: process.pid,
    child: null,
    segment: null,
    phase: 'admitting',
    lastSettled: null,
    currentSegment: null,
    originalDeadline: null,
    nativeOutcome: null,
    resultFile: null,
  };
  const update = (patch) => {
    current = {
      ...current,
      ...patch,
      observedWallUtc: clock.wallNow?.() ?? clock.now(),
      effectiveTime: clock.now(),
      clock: clock.snapshot?.(),
    };
    publish(root, 'status.json', current);
  };
  const checkDeadline = () => {
    const now = clock.now();
    if (plan.expiresAt != null)
      assert(
        Number.isSafeInteger(plan.expiresAt) && now < plan.expiresAt,
        'Absolute coordinator expiry reached',
      );
    if (originalDeadline != null)
      assert(now < originalDeadline, 'Original coordinator deadline expired');
    return now;
  };
  let cancellation;
  const cancel = () => {
    if (emergency) return;
    emergency = true;
    // The adapter retains the actual child handle / verifies exact container bindings.
    // Cancellation is never a clean-boundary pause and is awaited before release.
    cancellation = adapter.cancel?.().catch((error) => {
      current.cancelError = error.message;
    });
  };
  const pauseRequested = () => {
    const path = join(root, 'pause-' + owner + '.json');
    if (!existsSync(path)) return false;
    assert.deepEqual(Object.keys(readSmall(path)).sort(), [
      'operation',
      'owner',
      'requestedWallUtc',
    ]);
    const request = readSmall(path);
    assert.equal(request.operation, operation);
    assert.equal(request.owner, owner);
    return true;
  };
  try {
    for (const directory of new Set([lockRoot, root])) {
      const path = join(directory, '.reconstruction-job.lock'),
        fd = openSync(path, 'wx', 0o600);
      locks.push({ path, fd });
      writeFileSync(fd, JSON.stringify({ owner, operation, root, pid: process.pid }), {
        flush: true,
      });
    }
    const markerPath = join(lockRoot, 'reconstruction-job-binding.json');
    checkDeadline(); // No admission/startup adapter is reached by expired authority.
    if (action === 'run') {
      assert(!existsSync(join(root, 'status.json')), 'Existing output refuses a new run');
      publish(lockRoot, 'reconstruction-job-binding.json', { operation, root, binding }, true);
    } else {
      assert.deepEqual(
        readSmall(markerPath),
        { operation, root, binding },
        'Coordinator binding changed',
      );
      const old = status(root);
      assert(
        old.observation === 'SETTLED_RECORD' &&
          ['PAUSED_AT_BOUNDARY', 'PAUSED_AFTER_MILESTONE', 'RECOVERED_AFTER_POWER_LOSS'].includes(
            old.result.outcome,
          ),
        'Only an explicitly clean paused coordinator may resume',
      );
      originalStart = old.result.originalStart;
      originalDeadline = old.result.originalDeadline;
      if (old.result.outcome === 'RECOVERED_AFTER_POWER_LOSS') recoveryResult = old.result;
    }
    checkDeadline();
    ({ state: previous } = await adapter.admit(action));
    if (recoveryResult) {
      assert(adapter.recovery, 'Recovery verifier required');
      assert.equal(
        await adapter.recovery(previous, recoveryResult),
        true,
        'Recovery proof refused',
      );
    }
    assert.equal(previous.digest, digest(plan));
    assert(
      !previous.terminal && !previous.pending && !previous.pendingSql,
      'Terminal/pending operation refused',
    );
    assert(
      action === 'run'
        ? previous.status === 'prepared' && previous.start === null
        : recoveryResult
          ? previous.status === 'paused' &&
            previous.segment?.ended === null &&
            previous.lastEnded === null &&
            previous.reason === 'RECOVERED_AFTER_POWER_LOSS'
          : clean(previous),
      'Invalid start state',
    );
    admitted = true;
    update({
      lastSettled: {
        accepted: previous.accepted,
        audited: previous.audited,
        totals: totals(previous),
        phase: previous.phase,
      },
      originalDeadline: originalDeadline ?? null,
    });
    process.on('SIGINT', cancel);
    process.on('SIGTERM', cancel);
    checkDeadline(); // Admission and status publication spend the same allowance.
    await adapter.start?.();
    let next = action;
    for (;;) {
      await adapter.boundary(previous, next);
      const now = checkDeadline();
      if (previous.highWater !== undefined) {
        clock.assertContinuity?.(previous.highWater);
        assert(
          Number.isSafeInteger(previous.highWater) &&
            (clock.wallNow?.() ?? now) >= previous.highWater,
          'Raw UTC below settled operator high-water',
        );
      }
      assert(
        counters.every((k) => Number.isSafeInteger(previous[k]) && previous[k] >= 0),
        'Invalid counters',
      );
      assert(
        previous.http < plan.caps.http &&
          previous.logical < plan.caps.logical &&
          previous.chargedBytes < plan.caps.bytes,
        'Spent allowance',
      );
      if (emergency) {
        outcome = 'CANCELED_UNCERTAIN';
        break;
      }
      if (pauseRequested()) {
        if (recoveryResult && previous.segment?.ended === null) {
          // No new child has settled. Keep the verified recovery boundary usable
          // by the next coordinator without claiming the interrupted child paused.
          outcome = 'RECOVERED_AFTER_POWER_LOSS';
          update({
            segment: previous.segment.number,
            currentSegment: {
              segment: previous.segment.number,
              evidence: 'RECOVERY_BOUNDARY',
              reported: {
                accepted: previous.accepted,
                audited: previous.audited,
                totals: totals(previous),
                reason: outcome,
                ended: null,
                nativeExit: null,
              },
            },
            nativeOutcome: { exit: null, signal: null, classification: 'UNKNOWN_INTERRUPTED' },
            recovery: recoveryResult.recovery,
          });
        } else {
          outcome = previous.start === null ? 'STOPPED_NOT_STARTED' : 'PAUSED_AT_BOUNDARY';
        }
        break;
      }
      const number = (previous.segment?.number ?? 0) + 1;
      update({
        phase: 'segment-running',
        segment: number,
        child: null,
        currentSegment: { segment: number, evidence: 'UNVERIFIED', reported: null },
      });
      checkDeadline(); // Also fence a delayed wake / clock step during publication.
      const native = await adapter.launch(next, number, (child) => {
        currentChild = child;
        update({ child });
      });
      currentChild = null;
      update({ phase: 'collecting', child: null, nativeOutcome: native });
      const { state, host, hostResult, snapshot } = await adapter.snapshot(number);
      // A snapshot is only a reported claim until the real collector verifies it.
      // Keep it separate from the preceding sealed progress if collection fails.
      const reported = {
        segment: number,
        accepted: state.pendingSql ? null : state.accepted,
        lastAcknowledged: state.accepted,
        acceptedSqlUncertain: Boolean(state.pendingSql),
        pendingSql: state.pendingSql ?? null,
        pendingAttempt: state.pending,
        audited: state.audited,
        totals: totals(state),
        phase: state.phase,
        milestone: state.milestone,
        status: state.status,
        terminal: state.terminal,
        ended: state.segment?.ended ?? null,
        reason: typeof state.reason === 'string' ? state.reason.slice(0, 240) : null,
        nativeExit: native.exit,
        hostError: hostResult.result?.error ?? null,
      };
      current.currentSegment.reported = reported;
      originalStart ??= host.start;
      originalDeadline ??= host.deadline;
      assert.equal(host.start, originalStart);
      assert.equal(host.deadline, originalDeadline);
      assert.equal(
        host.deadline,
        Math.min(host.start + plan.caps.milliseconds, plan.expiresAt ?? Number.MAX_SAFE_INTEGER),
      );
      assert.equal(state.start, host.start);
      assert.equal(state.deadline, host.deadline);
      assert.equal(state.digest, digest(plan));
      assert.equal(host.digest, state.digest);
      assert.equal(state.segment.number, number);
      assert.equal(host.segments, number);
      assert(
        counters.every((k) => Number.isSafeInteger(state[k]) && state[k] >= previous[k]),
        'Accounting decreased/invalid',
      );
      assert.equal(native.exit, hostResult.result.status, 'Native/supervisor status mismatch');
      const collection = await adapter.collect(snapshot);
      assert.equal(collection.status, 'SEALED', 'Collection unsealed');
      assert.equal(collection.binding.run, operation);
      assert.equal(collection.binding.planDigest, digest(plan));
      assert.equal(collection.binding.segment, number);
      const settled = {
        ...reported,
        collection,
      };
      publish(root, 'segment-' + String(number).padStart(5, '0') + '-summary.json', settled, true);
      update({
        phase: 'boundary',
        lastSettled: settled,
        originalDeadline,
        currentSegment: { segment: number, evidence: 'SEALED', reported: settled },
      });
      previous = state;
      const complete =
        native.exit === 0 &&
        state.status === 'complete' &&
        state.phase === 'complete' &&
        state.milestone === plan.milestones.length &&
        state.accepted.header.number === plan.target &&
        digest(state.audited) === digest(state.accepted) &&
        !state.pending &&
        !state.pendingSql &&
        !host.pending;
      if (emergency) {
        outcome = 'CANCELED_UNCERTAIN';
        break;
      }
      if (state.pending || state.pendingSql || hostResult.result.error) {
        outcome = 'STOPPED_UNCERTAIN';
        break;
      }
      if (complete && clock.now() < originalDeadline) {
        outcome = 'SCOPED_INTERVAL_COMPLETE';
        break;
      }
      const eligible =
        native.exit === 3 &&
        clean(state) &&
        !host.pending &&
        !host.terminal &&
        collection.resumeEligible &&
        clock.now() < originalDeadline;
      if (!eligible) {
        outcome = state.terminal ? 'STOPPED_INCOMPLETE' : 'STOPPED_UNCERTAIN_OR_EXHAUSTED';
        break;
      }
      if (
        stopAt &&
        state.audited?.header.number === stopAt &&
        state.phase === 'milestone-audited' &&
        digest(state.audited) === digest(state.accepted)
      ) {
        outcome = 'PAUSED_AFTER_MILESTONE';
        break;
      }
      if (pauseRequested()) {
        outcome = 'PAUSED_AT_BOUNDARY';
        break;
      }
      next = 'resume';
    }
  } catch (error) {
    // Duplicate/ambiguous owners do not overwrite another coordinator's evidence.
    if (!admitted) throw error;
    outcome = 'STOPPED_UNCERTAIN';
    current.error = error.message;
  } finally {
    process.removeListener('SIGINT', cancel);
    process.removeListener('SIGTERM', cancel);
    if (admitted) {
      await cancellation;
      try {
        await adapter.close?.();
      } catch (error) {
        outcome = 'STOPPED_UNCERTAIN';
        current.cleanupError = error.message;
      }
      const result = {
        owner,
        operation,
        outcome,
        originalStart: originalStart ?? null,
        originalDeadline: originalDeadline ?? null,
        lastSettled: current.lastSettled,
        currentSegment: current.currentSegment,
        primaryReason:
          current.currentSegment?.reported?.reason ?? current.nativeOutcome?.error ?? null,
        primaryReasonEvidence: current.currentSegment?.evidence ?? 'UNVERIFIED',
        nativeOutcome: current.nativeOutcome,
        ...(outcome === 'RECOVERED_AFTER_POWER_LOSS'
          ? {
              recovery: recoveryResult.recovery,
              accepted: previous.accepted,
              audited: previous.audited,
              originalEnded: null,
            }
          : {}),
        error: current.error ?? null,
        cleanupError: current.cleanupError ?? null,
        cancellationError: current.cancelError ?? null,
        child: currentChild,
        fullTask10: 'PENDING',
        productionReady: false,
      };
      const resultFile = 'result-' + owner + '.json';
      publish(root, resultFile, result, true);
      // Clock failure must not prevent a truthful terminal result/status publication.
      current = {
        ...current,
        phase: 'settled',
        resultFile,
        clock: clock.snapshot?.(),
        child: currentChild,
      };
      publish(root, 'status.json', current);
    }
    for (const { fd, path } of locks.reverse()) {
      closeSync(fd);
      unlinkSync(path);
    }
  }
  return status(root).result;
}
export async function main(args) {
  const [action, directory, scope, output, stop] = args;
  if (!action || action === 'help' || action === '--help') return { help: jobHelp };
  if (action === 'status' && directory && args.length === 2) return status(resolve(directory));
  if (action === 'pause' && directory && scope && args.length === 3)
    return pause(resolve(directory), scope);
  assert(
    ['run', 'resume'].includes(action) &&
      directory &&
      scope &&
      output &&
      args.length <= 5 &&
      (!stop || /^--stop-at=\d+$/.test(stop)),
    jobHelp,
  );
  const { hostJob } = await import('./reconstruction-job-host.mjs');
  return hostJob({
    environment: resolve(directory),
    scopePath: resolve(scope),
    root: resolve(output),
    action,
    stopAt: stop?.slice(10),
  });
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  // Finish module evaluation before the host adapter imports this module back.
  main(process.argv.slice(2))
    .then((result) => {
      console.log(JSON.stringify(result, null, 2));
      if (result.outcome)
        process.exitCode =
          result.outcome === 'SCOPED_INTERVAL_COMPLETE'
            ? 0
            : result.outcome.startsWith('PAUSED_') ||
                result.outcome === 'RECOVERED_AFTER_POWER_LOSS'
              ? 3
              : 2;
    })
    .catch((error) => {
      console.error(error.message);
      process.exitCode = 2;
    });
}
