// Synthetic file/process evidence only. No incident paths, Docker, SQL or providers.
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { digest } from '../../dist/services/projections/input.js';
import { ReconstructionClock } from '../../dist/operator/reconstruction-clock.js';
import { supervise } from '../../scripts/operator/reconstruction-segment.mjs';
import { publish, readSmall } from '../../scripts/operator/reconstruction-job.mjs';
import { collect } from '../../scripts/operator/reconstruction-collect.mjs';
import { verify } from '../../scripts/operator/reconstruction-seal.mjs';

export async function boundaryFixture(directory) {
  const environment = join(directory, 'environment'),
    root = join(directory, 'output');
  mkdirSync(join(environment, 'input'), { recursive: true });
  mkdirSync(root);
  const offset = Date.now() - 1000000;
  const time = (n) => offset + n;
  const plan = JSON.parse(readFileSync('config/reconstruction.synthetic.example.json'));
  plan.run = randomUUID();
  plan.milestones = [plan.target];
  plan.expiresAt = time(20000000);
  plan.caps.milliseconds = 19000000;
  const state = {
    version: 1,
    kind: 'reconstruction-state',
    digest: digest(plan),
    storage: 'synthetic:state',
    quota: 'synthetic:quota',
    start: time(1000000),
    deadline: time(20000000),
    highWater: time(1001200),
    http: 8100,
    logical: 72331,
    chargedBytes: 1641858695,
    observedBytes: 1210836121,
    uncertainAttempts: 67,
    pending: false,
    status: 'paused',
    phase: 'replay',
    reason: 'Segment allowance reached at accepted checkpoint/page.',
    terminal: false,
    accepted: { header: plan.admission.checkpoint, revision: '908' },
    audited: null,
    milestone: 0,
    stopHeader: { ...plan.admission.checkpoint, number: plan.target },
    pendingSql: null,
    canonicalAtPause: plan.canonicalDigest,
    audit: null,
    segment: {
      number: 18,
      started: time(1000100),
      deadline: time(4600100),
      before: { http: 7650, logical: 67095, chargedBytes: 1528541590, observedBytes: 1128894376 },
      ended: time(1001200),
    },
    receipts: [],
    pausedMs: 57077,
    lastEnded: time(1001200),
    secondary: [],
    fullTask10: 'PENDING',
    productionReady: false,
  };
  const healthy = (effective) => ({
    domain: 'reconstruction-ceiling-epoch-ms',
    waitDomain: 'process-monotonic-epoch-ms',
    rawWall: effective - 1000,
    effective,
    continuous: effective,
    failed: false,
    anomalies: { count: 0, first: null, last: null },
  });
  state.clockDiagnostic = healthy(state.highWater);
  let host = {
    digest: state.digest,
    start: state.start,
    deadline: state.deadline,
    highWater: time(1001300),
    segments: 18,
    pending: false,
    terminal: false,
    clock: healthy(time(1001300)),
  };
  const put = (p, value) => writeFileSync(p, JSON.stringify(value, null, 2) + '\n');
  const saveState = () =>
    put(join(environment, 'reconstruction.json'), { ...state, checksum: digest(state) });
  put(join(environment, 'input/plan.json'), plan);
  const scopePath = join(environment, 'runner-scope.AUTHORIZED.json');
  put(scopePath, { override: 'offline.yaml' });
  put(join(environment, 'reconstruction-host.json'), host);
  put(join(environment, 'reconstruction-host-result.json'), {
    ...host,
    invoked: state.segment.started,
    segmentDeadline: state.segment.deadline,
    result: { status: 3 },
  });
  writeFileSync(join(environment, 'reconstruction-output.log'), 'SYNTHETIC settled replay\n');
  saveState();
  const collection = await collect(environment, environment, root);
  const summary = {
    segment: 18,
    accepted: state.accepted,
    lastAcknowledged: state.accepted,
    acceptedSqlUncertain: false,
    pendingSql: null,
    pendingAttempt: false,
    audited: null,
    totals: {
      http: state.http,
      logical: state.logical,
      observedBytes: state.observedBytes,
      chargedBytes: state.chargedBytes,
    },
    phase: state.phase,
    milestone: 0,
    status: 'paused',
    terminal: false,
    ended: state.lastEnded,
    reason: state.reason,
    nativeExit: 3,
    hostError: null,
    collection,
  };
  publish(root, 'segment-00018-summary.json', summary, true);
  publish(
    root,
    'invocation-00018-launch.json',
    {
      pid: 12345,
      command: [
        process.execPath,
        'scripts/operator/reconstruction-segment.mjs',
        environment,
        join(environment, 'offline.yaml'),
        'resume',
        'plan.json',
        'approval.json',
      ],
      observedWallUtc: time(1000100),
    },
    true,
  );
  publish(
    root,
    'invocation-00018-result.json',
    { exit: 3, signal: null, elapsedMonotonicMs: 1000 },
    true,
  );
  const oldOwner = randomUUID(),
    binding = digest({ synthetic: plan.run });
  const result = {
    owner: oldOwner,
    operation: plan.run,
    outcome: 'STOPPED_UNCERTAIN',
    originalStart: state.start,
    originalDeadline: state.deadline,
    lastSettled: summary,
    currentSegment: { segment: 18, evidence: 'SEALED', reported: summary },
    primaryReason: state.reason,
    primaryReasonEvidence: 'SEALED',
    nativeOutcome: { exit: 3, signal: null },
    error: 'Reconstruction clock invalid/unprovable: raw-continuity-below-durable-high-water',
    cleanupError: null,
    cancellationError: null,
    child: null,
    fullTask10: 'PENDING',
    productionReady: false,
  };
  // Match the proved stop class using the actual clock's sticky witness.
  let wall = time(1001014),
    mono = 0n;
  const priorClock = new ReconstructionClock({ wall: () => wall, monotonic: () => mono });
  priorClock.now();
  mono = 486000000n;
  try {
    priorClock.assertContinuity(state.highWater);
  } catch {}
  const old = {
    version: 1,
    owner: oldOwner,
    operation: plan.run,
    binding,
    coordinatorPid: 12344,
    child: null,
    segment: 18,
    phase: 'settled',
    lastSettled: summary,
    currentSegment: result.currentSegment,
    originalDeadline: state.deadline,
    nativeOutcome: result.nativeOutcome,
    resultFile: 'result-' + oldOwner + '.json',
    observedWallUtc: wall,
    effectiveTime: time(1001500),
    clock: priorClock.snapshot(),
    error: result.error,
  };
  publish(root, old.resultFile, result, true);
  publish(root, 'status.json', old);
  publish(
    environment,
    'reconstruction-job-binding.json',
    { operation: plan.run, root, binding },
    true,
  );
  const options = {
    root,
    lockRoot: environment,
    operation: plan.run,
    plan,
    action: 'resume',
    binding,
    scopePath,
    readmitClockStop: oldOwner,
  };
  const events = [];
  let raw = time(1002000);
  let elapsed = 0n;
  const currentClock = new ReconstructionClock({
    wall: () => raw,
    monotonic: () => elapsed,
    sleep: async (ms, signal) => {
      signal.throwIfAborted();
      raw += ms;
      elapsed += BigInt(ms) * 1000000n;
      events.push('clock-wait-' + ms);
    },
  });
  const adapter = {
    async admit() {
      events.push('admit');
      return { state: structuredClone(state) };
    },
    async boundary(previous) {
      events.push('boundary');
      const seal = join(root, 'segment-' + String(previous.segment.number).padStart(5, '0'));
      await verify(seal);
      const saved = readSmall(join(seal, 'reconstruction.json'));
      if (saved.checksum !== digest(previous)) throw Error('Fixture retained state changed');
      host = readSmall(join(environment, 'reconstruction-host.json'));
      return { normalSeal: true, highWater: host.highWater };
    },
    async start() {
      events.push('start');
    },
    async launch(action, number, onChild) {
      events.push('launch-' + number);
      if (number !== 19) throw Error('Unexpected synthetic child');
      const native = supervise(
        environment,
        plan,
        action,
        ({ originalStart, invoked, deadline }) => {
          events.push('supervise');
          onChild({ pid: process.pid, kind: 'synchronous-fixture', segment: number });
          if (originalStart !== state.start) throw Error('Start changed');
          state.segment = {
            number,
            started: invoked,
            deadline,
            before: { ...summary.totals },
            ended: raw,
          };
          state.lastEnded = raw;
          state.highWater = raw;
          state.clockDiagnostic = currentClock.snapshot();
          saveState();
          return { status: 3 };
        },
        currentClock,
      );
      return { exit: native.status, signal: null };
    },
    async snapshot() {
      return {
        state: structuredClone(state),
        host: readSmall(join(environment, 'reconstruction-host.json')),
        hostResult: readSmall(join(environment, 'reconstruction-host-result.json')),
        snapshot: environment,
      };
    },
    async collect(path) {
      const result = await collect(environment, path, root);
      const { pause } = await import('../../scripts/operator/reconstruction-job.mjs');
      pause(root, plan.run);
      return result;
    },
    async close() {
      events.push('close');
    },
    async cancel() {
      events.push('cancel');
    },
  };
  return {
    time,
    options,
    adapter,
    clock: currentClock,
    state,
    host,
    result,
    old,
    oldOwner,
    events,
    environment,
    root,
    put,
    saveState,
    setRaw: (value) => {
      raw = value;
    },
  };
}
