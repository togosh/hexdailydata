// File-only proof and bounded no-work clock handoff. No provider or SQL effects.
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, lstatSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { digest } from '../../dist/services/projections/input.js';
import { reconstructionStateSchema } from '../../dist/operator/reconstruction-state.js';
import { identity, verify } from './reconstruction-seal.mjs';

const failure = 'Reconstruction clock invalid/unprovable: raw-continuity-below-durable-high-water';
const integer = (n) => Number.isSafeInteger(n) && n >= 0;
const read = (path) => {
  const stat = lstatSync(path);
  assert(stat.isFile() && !stat.isSymbolicLink() && stat.size <= 65536);
  return JSON.parse(readFileSync(path, 'utf8'));
};
const counterNames = ['http', 'logical', 'observedBytes', 'chargedBytes'];

/** Wait for actual raw UTC; an elapsed budget never grants a backward tolerance.
 * Expiry uses the existing sticky upper envelope throughout, including after sleep. */
export async function waitForRawBoundary(clock, floor, deadline, signal) {
  assert(integer(floor) && integer(deadline), 'Invalid boundary clock floor/deadline');
  assert(clock.wallNow && clock.waitNow && clock.sleep, 'Full boundary clock required');
  const begin = clock.waitNow();
  assert(integer(begin), 'Invalid boundary elapsed clock');
  let previous = begin,
    slept = false,
    samples = 0;
  for (;;) {
    signal.throwIfAborted();
    const effective = clock.now(),
      elapsed = clock.waitNow(),
      raw = clock.wallNow();
    assert([effective, elapsed, raw].every(integer), 'Invalid boundary clock sample');
    assert(
      elapsed >= previous && (!slept || elapsed > previous),
      'Frozen/regressing boundary elapsed clock',
    );
    assert(effective < deadline, 'Original coordinator deadline expired during boundary wait');
    assert(elapsed - begin <= 5000, 'Boundary raw clock wait exhausted');
    if (raw >= floor) {
      clock.assertContinuity?.(floor); // Retain strict raw admission, including a new sample.
      assert(clock.wallNow() >= floor, 'Raw clock changed at boundary admission');
      assert(clock.now() < deadline, 'Original coordinator deadline expired during boundary wait');
      return { floor, raw, elapsedMs: elapsed - begin, samples };
    }
    assert(elapsed - begin < 5000 && samples < 100, 'Boundary raw clock wait exhausted');
    previous = elapsed;
    samples++;
    await clock.sleep(Math.min(50, 5000 - (elapsed - begin), deadline - effective), signal);
    slept = true;
  }
}

function healthyClock(clock) {
  assert(
    clock?.domain === 'reconstruction-ceiling-epoch-ms' && clock.failed === false,
    'Unsettled host/operator clock',
  );
  assert(integer(clock.effective) && integer(clock.rawWall));
  const a = clock.anomalies;
  assert(integer(a?.count));
  if (a.count === 0) assert(a.first === null && a.last === null);
  else
    for (const witness of [a.first, a.last])
      assert(
        witness?.classification === 'wall-adjustment' && witness.reason === 'backward-wall',
        'Host/operator clock fault',
      );
}

export function replayClockFloor(state, host) {
  healthyClock(state.clockDiagnostic);
  healthyClock(host.clock);
  assert.equal(state.clockDiagnostic.effective, state.highWater);
  assert.equal(host.clock.effective, host.highWater);
  assert(integer(state.highWater) && integer(host.highWater));
  return Math.max(state.highWater, host.highWater);
}

/** Only one settled coordinator's ordinary replay seal qualifies. The caller owns
 * normal coordinator/host exclusions; this proof cannot take over a stale lock. */
export async function proveClockStop({
  root,
  environment,
  operation,
  plan,
  binding,
  scopePath,
  oldOwner,
  old,
}) {
  assert(/^[0-9a-f-]{36}$/.test(oldOwner), 'Explicit stopped owner UUID required');
  assert.equal(old.observation, 'SETTLED_RECORD');
  assert.equal(old.owner, oldOwner, 'Stopped owner changed');
  assert.equal(old.operation, operation);
  assert.equal(old.binding, binding, 'Stopped authority changed');
  assert.equal(old.phase, 'settled');
  assert.equal(old.child, null);
  assert.equal(old.error, failure);
  const resultName = 'result-' + oldOwner + '.json';
  assert.equal(old.resultFile, resultName);
  const result = read(join(root, resultName));
  assert.deepEqual(result, old.result);
  assert.equal(result.owner, oldOwner);
  assert.equal(result.operation, operation);
  assert.equal(result.outcome, 'STOPPED_UNCERTAIN');
  assert.equal(result.error, failure);
  for (const key of ['child', 'cleanupError', 'cancellationError']) assert.equal(result[key], null);
  for (const key of ['cleanupError', 'cancelError']) assert(old[key] == null);
  assert.deepEqual(result.nativeOutcome, { exit: 3, signal: null });
  assert.deepEqual(old.nativeOutcome, result.nativeOutcome);
  assert.equal(result.primaryReasonEvidence, 'SEALED');
  assert.deepEqual(old.currentSegment, result.currentSegment);
  assert.deepEqual(old.lastSettled, result.lastSettled);
  assert.equal(result.currentSegment?.evidence, 'SEALED');
  assert.deepEqual(result.currentSegment.reported, result.lastSettled);

  const n = old.segment;
  assert(integer(n) && n > 0 && result.currentSegment.segment === n);
  const prefix = 'segment-' + String(n).padStart(5, '0');
  const destination = join(root, prefix);
  const manifest = await verify(destination, [
    'reconstruction-output.log',
    'reconstruction-host-result.json',
    'reconstruction-host.json',
    'reconstruction.json',
  ]);
  const { checksum, ...payload } = read(join(destination, 'reconstruction.json'));
  reconstructionStateSchema.parse(payload);
  const state = payload; // Checksum covers persisted key order, as in runtime load.
  assert.equal(checksum, digest(state));
  assert.equal(state.digest, digest(plan));
  assert(
    state.status === 'paused' &&
      state.phase === 'replay' &&
      !state.terminal &&
      !state.pending &&
      state.pendingSql === null &&
      state.audit === null,
    'Only quiescent replay qualifies',
  );
  assert(state.canonicalAtPause !== null && state.segment?.number === n);
  assert(integer(state.segment.ended) && state.lastEnded === state.segment.ended);
  assert.equal(state.highWater, state.segment.ended);
  assert.equal(state.stopHeader?.number, plan.milestones[state.milestone], 'Replay cutoff changed');
  assert(BigInt(state.accepted.header.number) < BigInt(state.stopHeader.number));
  assert.equal(state.start, result.originalStart);
  assert.equal(state.deadline, result.originalDeadline);
  assert.equal(old.originalDeadline, state.deadline);
  assert.equal(
    state.deadline,
    Math.min(state.start + plan.caps.milliseconds, plan.expiresAt ?? Number.MAX_SAFE_INTEGER),
  );
  assert(integer(state.start) && integer(state.deadline) && state.highWater < state.deadline);
  healthyClock(state.clockDiagnostic);
  assert.equal(state.clockDiagnostic.effective, state.highWater);

  const host = read(join(environment, 'reconstruction-host.json'));
  const hostResult = read(join(environment, 'reconstruction-host-result.json'));
  assert.deepEqual(
    host,
    read(join(destination, 'reconstruction-host.json')),
    'Host boundary changed',
  );
  assert.deepEqual(
    hostResult,
    read(join(destination, 'reconstruction-host-result.json')),
    'Host result changed',
  );
  assert.deepEqual(hostResult, {
    ...host,
    invoked: state.segment.started,
    segmentDeadline: state.segment.deadline,
    result: { status: 3 },
  });
  assert(host.pending === false && host.terminal === false && host.segments === n);
  assert.equal(host.digest, state.digest);
  assert.equal(host.start, state.start);
  assert.equal(host.deadline, state.deadline);
  healthyClock(host.clock);
  assert.equal(host.clock.effective, host.highWater);
  assert(integer(host.highWater) && host.highWater < hostResult.segmentDeadline);
  assert(!existsSync(join(environment, '.reconstruction-host.lock')), 'Host ownership uncertain');

  const expectedBinding = {
    planDigest: state.digest,
    run: operation,
    segment: n,
    milestone: state.milestone,
    audited: state.audited,
  };
  assert.deepEqual(manifest.binding, expectedBinding);
  const summary = read(join(root, prefix + '-summary.json'));
  assert.deepEqual(summary, result.lastSettled);
  assert.deepEqual(summary, {
    segment: n,
    accepted: state.accepted,
    lastAcknowledged: state.accepted,
    acceptedSqlUncertain: false,
    pendingSql: null,
    pendingAttempt: false,
    audited: state.audited,
    totals: Object.fromEntries(counterNames.map((k) => [k, state[k]])),
    phase: state.phase,
    milestone: state.milestone,
    status: state.status,
    terminal: false,
    ended: state.segment.ended,
    reason: state.reason,
    nativeExit: 3,
    hostError: null,
    collection: {
      status: 'SEALED',
      destination,
      binding: expectedBinding,
      resumeEligible: true,
      authorization: 'NOT_AUTHORIZED_BY_COLLECTION',
      classification: 'SETTLED_EVIDENCE',
      endingTime: 'RECORDED',
    },
  });
  assert.equal(result.primaryReason, state.reason);
  const invocation = 'invocation-' + String(n).padStart(5, '0');
  const native = read(join(root, invocation + '-result.json'));
  assert.deepEqual(Object.keys(native).sort(), ['elapsedMonotonicMs', 'exit', 'signal']);
  assert(
    native.exit === 3 &&
      native.signal === null &&
      Number.isFinite(native.elapsedMonotonicMs) &&
      native.elapsedMonotonicMs >= 0,
  );
  const launch = read(join(root, invocation + '-launch.json'));
  assert(integer(launch.pid) && launch.pid > 0 && integer(launch.observedWallUtc));
  assert.equal(launch.command[0], process.execPath);
  assert.deepEqual(launch.command.slice(1), [
    'scripts/operator/reconstruction-segment.mjs',
    environment,
    join(environment, read(scopePath).override),
    'resume',
    'plan.json',
    'approval.json',
  ]);
  const clock = old.clock;
  assert(clock?.domain === 'reconstruction-ceiling-epoch-ms' && clock.failed === true);
  assert(integer(clock.effective) && integer(clock.rawWall) && integer(old.effectiveTime));
  assert.equal(clock.anomalies?.count, 1, 'Additional coordinator clock anomalies');
  const witness = clock.anomalies.last;
  assert.deepEqual(clock.anomalies.first, witness);
  assert(
    witness.classification === 'terminal' &&
      witness.reason === 'raw-continuity-below-durable-high-water' &&
      witness.monotonicValid === true,
  );
  assert.equal(witness.previousEffective, state.highWater);
  assert.equal(witness.previousRawWall, null);
  assert.equal(witness.selectedEffective, null);
  assert.deepEqual(witness.rawWall, { type: 'number', value: String(clock.rawWall) });
  assert(clock.rawWall < state.highWater && clock.effective >= state.highWater);
  const floor = Math.max(state.highWater, host.highWater, old.effectiveTime, clock.effective);
  assert(floor < state.deadline, 'Recorded effective deadline spent');

  // Own admission copies are the only new entries allowed during the bounded wait.
  const noLaterWork = (allowed = []) => {
    for (const name of readdirSync(root)) {
      if (allowed.includes(name)) continue;
      assert(!name.startsWith('clock-readmission-'), 'Readmission already attempted');
      if (name.startsWith('result-'))
        assert.equal(name, resultName, 'Another coordinator result exists');
      const segment = /^(?:invocation|segment|snapshot)-(\d+)/.exec(name);
      assert(!segment || Number(segment[1]) <= n, 'Later segment evidence exists');
      const admission = /^admission-(\d+)/.exec(name);
      assert(!admission || Number(admission[1]) < n, 'Later admission exists');
    }
  };
  noLaterWork();
  const files = [
    join(root, resultName),
    join(root, prefix + '-summary.json'),
    join(destination, 'manifest.json'),
    join(environment, 'reconstruction-host.json'),
    join(environment, 'reconstruction-host-result.json'),
    join(root, invocation + '-launch.json'),
    join(root, invocation + '-result.json'),
  ];
  const identities = await Promise.all(files.map(identity));
  return {
    state,
    floor,
    reference: {
      classification: 'READMITTED_SEALED_CLOCK_BOUNDARY',
      stoppedOwner: oldOwner,
      resultFile: resultName,
      resultIdentity: identities[0],
      seal: prefix,
      sealIdentity: identities[2],
      requiredRawFloor: floor,
    },
    async recheck(allowed) {
      noLaterWork(allowed);
      await verify(destination, Object.keys(manifest.files));
      assert.deepEqual(
        await Promise.all(files.map(identity)),
        identities,
        'Readmission evidence changed',
      );
      assert(
        !existsSync(join(environment, '.reconstruction-host.lock')),
        'Host ownership uncertain',
      );
    },
  };
}
