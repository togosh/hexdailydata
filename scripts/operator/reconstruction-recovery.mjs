// Host recovery journal. SQL/provider authority is deliberately absent from this module.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import {
  readFileSync,
  writeFileSync,
  existsSync,
  lstatSync,
  mkdirSync,
  renameSync,
  unlinkSync,
  openSync,
  closeSync,
  fsyncSync,
} from 'node:fs';
import { join } from 'node:path';
import { digest } from '../../dist/services/projections/input.js';
import { reconstructionStateSchema } from '../../dist/operator/reconstruction-state.js';
import { verify } from './reconstruction-seal.mjs';

export const recoveryClass = 'RECOVERED_AFTER_POWER_LOSS';
export const sha = (bytes) => createHash('sha256').update(bytes).digest('hex');
export const jsonBytes = (value) => Buffer.from(JSON.stringify(value, null, 2) + '\n');
export const readJson = (path) => JSON.parse(readFileSync(path, 'utf8'));
const counters = ['http', 'logical', 'chargedBytes', 'observedBytes', 'uncertainAttempts'];
const authority = (plan) =>
  Object.fromEntries(
    ['run', 'project', 'instance', 'release', 'reviewedCommit', 'storagePath', 'quotaPath'].map(
      (k) => [k, plan[k]],
    ),
  );
export function durable(path, bytes, once = false) {
  if (once && existsSync(path)) {
    assert.deepEqual(readFileSync(path), bytes, 'Conflicting recovery evidence: ' + path);
    return;
  }
  const temp = path + '.recovery-tmp';
  writeFileSync(temp, bytes, { mode: 0o600, flush: true });
  renameSync(temp, path);
  if (process.platform === 'linux') {
    const fd = openSync(join(path, '..'), 'r');
    try {
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
  }
}
export function capture(path) {
  const s = lstatSync(path);
  assert(s.isFile() && !s.isSymbolicLink() && s.size <= 65536, 'Small regular evidence required');
  const bytes = readFileSync(path);
  return {
    bytes: bytes.toString('base64'),
    sha256: sha(bytes),
    stat: { mtimeMs: s.mtimeMs, birthtimeMs: s.birthtimeMs, size: s.size },
  };
}
const decode = (file) => {
  const bytes = Buffer.from(file.bytes, 'base64');
  assert.equal(sha(bytes), file.sha256, 'Captured evidence checksum mismatch');
  return bytes;
};
const parsed = (file) => JSON.parse(decode(file));
export function checkedState(bytes) {
  const { checksum, ...state } = JSON.parse(bytes);
  assert.equal(checksum, digest(state), 'State checksum mismatch');
  return reconstructionStateSchema.parse(state);
}
export function recoveredState(before, canonical) {
  assert(/^[a-f0-9]{64}$/.test(canonical));
  const state = {
    ...before,
    status: 'paused',
    reason: recoveryClass,
    canonicalAtPause: canonical,
    lastEnded: null,
  };
  reconstructionStateSchema.parse(state);
  return Buffer.from(JSON.stringify({ ...state, checksum: digest(state) }) + '\n');
}
function eligible(plan, state, previous, host, status, now) {
  assert.equal(state.digest, digest(plan));
  assert.equal(previous.digest, state.digest);
  assert.equal(state.status, 'running');
  assert.equal(state.terminal, false);
  assert.equal(state.pending, false);
  assert.equal(state.pendingSql, null);
  assert.equal(state.audit, null);
  assert.equal(state.segment.ended, null);
  assert.equal(state.canonicalAtPause, null);
  // Runtime retains milestone-audited during later replay. It is replay only
  // while strictly below the next target, with no audit or pending milestone.
  assert(['replay', 'milestone-audited'].includes(state.phase), 'Unsupported interrupted phase');
  assert(
    BigInt(state.accepted.header.number) < BigInt(plan.milestones[state.milestone]),
    'Not interrupted replay',
  );
  assert.equal(previous.status, 'paused');
  assert(
    previous.segment.ended !== null &&
      !previous.terminal &&
      !previous.pending &&
      !previous.pendingSql,
  );
  assert.equal(state.segment.number, previous.segment.number + 1);
  assert.deepEqual(
    state.segment.before,
    Object.fromEntries(counters.slice(0, 4).map((k) => [k, previous[k]])),
  );
  assert.equal(state.milestone, previous.milestone);
  assert.deepEqual(state.audited, previous.audited, 'Unsealed audit credit');
  assert(BigInt(state.accepted.header.number) >= BigInt(previous.accepted.header.number));
  assert(BigInt(state.accepted.revision) >= BigInt(previous.accepted.revision));
  for (const k of counters) assert(state[k] >= previous[k], 'Accounting decreased: ' + k);
  assert(
    state.http < plan.caps.http &&
      state.logical < plan.caps.logical &&
      state.chargedBytes < plan.caps.bytes,
    'Spent allowance',
  );
  assert(state.observedBytes <= state.chargedBytes);
  for (const k of ['start', 'deadline']) assert.equal(state[k], previous[k]);
  assert.equal(
    state.deadline,
    Math.min(state.start + plan.caps.milliseconds, plan.expiresAt ?? Number.MAX_SAFE_INTEGER),
  );
  assert(now >= state.highWater && now < state.deadline, 'Expired authority or clock continuity');
  assert(
    state.highWater >= previous.highWater && now >= host.highWater,
    'Clock high-water mismatch',
  );
  assert.equal(host.digest, state.digest);
  assert.equal(host.start, state.start);
  assert.equal(host.deadline, state.deadline);
  assert.equal(host.segments, state.segment.number);
  assert.equal(host.pending, true);
  assert.equal(host.terminal, false);
  assert.equal(status.segment, state.segment.number);
  assert.equal(status.phase, 'segment-running');
  assert.equal(status.resultFile, null);
  assert.equal(status.operation, plan.run);
  assert.equal(status.lastSettled.segment, previous.segment.number);
  assert.deepEqual(status.lastSettled.accepted, previous.accepted);
}
export async function priorSeals(root, plan, state) {
  const names = [
    'segment-' + String(state.segment.number - 1).padStart(5, '0'),
    ...plan.milestones.slice(0, state.milestone).map((n) => 'milestone-' + n),
  ];
  const seals = {};
  for (const name of names) {
    const m = await verify(
      join(root, name),
      name.startsWith('segment-')
        ? [
            'reconstruction-output.log',
            'reconstruction-host-result.json',
            'reconstruction-host.json',
            'reconstruction.json',
          ]
        : ['comparisons.jsonl', 'audit-result.json', 'reconstruction.json'],
    );
    assert.equal(m.binding.run, plan.run);
    assert.equal(m.binding.planDigest, digest(plan));
    if (name.startsWith('milestone-')) {
      const index = plan.milestones.indexOf(name.slice(10)) + 1;
      assert.equal(m.binding.milestone, index);
      assert.equal(m.binding.audited.header.number, plan.milestones[index - 1]);
      if (index === state.milestone) assert.deepEqual(m.binding.audited, state.audited);
    } else assert.equal(m.binding.segment, state.segment.number - 1);
    seals[name] = sha(readFileSync(join(root, name, 'manifest.json')));
  }
  return seals;
}
function proveDead(seed, observed) {
  assert(Number.isSafeInteger(observed.boot) && observed.boot > 0 && observed.now >= observed.boot);
  assert.equal(observed.operatorAbsent, true, 'Operator still present');
  assert.equal(observed.volumesIdle, true, 'Volume ownership not excluded');
  const status = parsed(seed.status);
  assert(
    status.observedWallUtc < observed.boot && status.effectiveTime < observed.boot,
    'Same-boot ownership',
  );
  for (const name of ['jobEnvironment', 'jobOutput', 'hostLock']) {
    const item = seed[name];
    assert(
      item.stat.mtimeMs < observed.boot && item.stat.birthtimeMs < observed.boot,
      'Lock does not predate reboot',
    );
  }
  for (const pid of [status.coordinatorPid, status.child?.pid]) {
    assert(Number.isSafeInteger(pid) && pid > 0, 'Missing process identity');
    const p = observed.processes.find((p) => p.pid === pid);
    assert(
      p && (p.absent === true || (Number.isSafeInteger(p.started) && p.started >= observed.boot)),
      'Old process not disproved',
    );
  }
}

// Adapter owns a kernel exclusion, exact Docker exclusions and a bounded SQL
// snapshot across proof and control commit. Fault hooks exist only in callers.
export async function recover(options, adapter, stage = async () => {}) {
  const { environment, root, plan, binding, identities } = options;
  const paths = {
    status: join(root, 'status.json'),
    host: join(environment, 'reconstruction-host.json'),
    hostResult: join(environment, 'reconstruction-host-result.json'),
    jobEnvironment: join(environment, '.reconstruction-job.lock'),
    jobOutput: join(root, '.reconstruction-job.lock'),
    hostLock: join(environment, '.reconstruction-host.lock'),
  };
  const live = readJson(paths.status);
  const number = live.segment;
  assert(Number.isSafeInteger(number) && number > 1);
  const name = 'recovery-' + String(number).padStart(5, '0'),
    directory = join(root, name);
  const journal = join(directory, 'seed.json');
  const observed = await adapter.observe(
    existsSync(journal) ? parsed(readJson(journal).status) : live,
  );
  let seed;
  if (existsSync(journal)) {
    seed = readJson(journal);
    assert.deepEqual(seed.identities, identities, 'Recovery authority changed');
    assert.equal(seed.binding, binding);
    assert.equal(seed.environment, environment);
    assert.equal(seed.root, root);
  } else {
    assert.equal(live.resultFile, null, 'Not an interrupted coordinator');
    assert(
      !existsSync(join(root, 'result-' + live.owner + '.json')),
      'Existing native/coordinator settlement',
    );
    for (const suffix of ['-result.json'])
      assert(
        !existsSync(join(root, 'invocation-' + String(number).padStart(5, '0') + suffix)),
        'Native result exists',
      );
    assert(
      !existsSync(join(root, 'segment-' + String(number).padStart(5, '0'))),
      'Segment already sealed',
    );
    seed = {
      version: 1,
      classification: recoveryClass,
      environment,
      root,
      binding,
      identities,
      authority: authority(plan),
      ...Object.fromEntries(Object.entries(paths).map(([k, p]) => [k, capture(p)])),
      state: await adapter.capture(),
      observed,
    };
    const state = checkedState(decode(seed.state));
    const prior = 'segment-' + String(number - 1).padStart(5, '0');
    seed.previous = capture(join(root, prior, 'reconstruction.json'));
    seed.seals = await priorSeals(root, plan, state);
    eligible(
      plan,
      state,
      checkedState(decode(seed.previous)),
      parsed(seed.host),
      live,
      observed.now,
    );
    assert.equal(live.binding, binding);
    const expectedLock = { owner: live.owner, operation: plan.run, root, pid: live.coordinatorPid };
    assert.deepEqual(parsed(seed.jobEnvironment), expectedLock);
    assert.deepEqual(parsed(seed.jobOutput), expectedLock);
    assert.equal(decode(seed.hostLock).length, 0);
    assert.deepEqual(readJson(join(environment, 'reconstruction-job-binding.json')), {
      operation: plan.run,
      root,
      binding,
    });
    assert.deepEqual(
      decode(seed.hostResult),
      readFileSync(join(root, prior, 'reconstruction-host-result.json')),
    );
    proveDead(seed, observed);
    mkdirSync(directory, { recursive: true });
    durable(journal, jsonBytes(seed), true);
    await stage('capture');
  }
  proveDead(seed, observed);
  assert.deepEqual(seed.authority, authority(plan));
  const before = checkedState(decode(seed.state)),
    oldStatus = parsed(seed.status);
  eligible(
    plan,
    before,
    checkedState(decode(seed.previous)),
    parsed(seed.host),
    oldStatus,
    observed.now,
  );
  assert.deepEqual(await priorSeals(root, plan, before), seed.seals);
  const intentPath = join(directory, 'intent.json');
  let intent = existsSync(intentPath) ? readJson(intentPath) : null;
  const currentState = await adapter.capture();
  assert(
    [seed.state.sha256, intent?.postState?.sha256].includes(currentState.sha256),
    'Control drift',
  );
  // Re-prove SQL on every partial retry; no historical proof authorizes a changed DB.
  const proof = await adapter.prove(
    before,
    checkedState(decode(seed.previous)),
    decode(seed.state),
  );
  assert.deepEqual(proof.accepted, before.accepted);
  assert.equal(proof.instance, plan.instance);
  assert.equal(proof.consistent, true);
  assert.equal(proof.noFutureRows, true);
  assert(
    (await adapter.observe(parsed(seed.status), true)).now < before.deadline,
    'Authority expired during proof',
  );
  await stage('proof');
  const postState = recoveredState(before, proof.canonical);
  const postHost = jsonBytes({ ...parsed(seed.host), pending: false });
  if (intent) {
    assert.equal(intent.seed, sha(readFileSync(journal)));
    assert.equal(intent.proof.canonical, proof.canonical, 'Canonical drift during recovery');
    assert.deepEqual(decode(intent.postState), postState);
    assert.deepEqual(decode(intent.postHost), postHost);
  } else {
    const pack = (b) => ({ bytes: b.toString('base64'), sha256: sha(b) });
    intent = {
      classification: recoveryClass,
      seed: sha(readFileSync(journal)),
      proof,
      postState: pack(postState),
      postHost: pack(postHost),
      observed: seed.observed,
      originalNativeExit: null,
      originalEnded: null,
    };
    durable(intentPath, jsonBytes(intent), true);
    await stage('intent');
  }
  const intended = {
    classification: recoveryClass,
    binding,
    operation: plan.run,
    segment: number,
    files: {
      'seed.json': sha(readFileSync(journal)),
      'intent.json': sha(readFileSync(intentPath)),
    },
  };
  const resultFile = 'result-' + oldStatus.owner + '.json';
  const result = {
    owner: oldStatus.owner,
    operation: plan.run,
    outcome: recoveryClass,
    originalStart: before.start,
    originalDeadline: before.deadline,
    recovery: { directory: name, manifest: sha(jsonBytes(intended)) },
    accepted: before.accepted,
    audited: before.audited,
    nativeOutcome: { exit: null, signal: null, classification: 'UNKNOWN_INTERRUPTED' },
    originalEnded: null,
    fullTask10: 'PENDING',
    productionReady: false,
  };
  const nextStatus = {
    ...oldStatus,
    phase: 'settled',
    child: null,
    nativeOutcome: result.nativeOutcome,
    resultFile,
    currentSegment: {
      segment: number,
      evidence: 'RECOVERY_BOUNDARY',
      reported: {
        accepted: before.accepted,
        audited: before.audited,
        totals: Object.fromEntries(counters.map((k) => [k, before[k]])),
        ended: null,
        nativeExit: null,
      },
    },
    recovery: result.recovery,
  };
  for (const [path, pre, post] of [
    [paths.host, decode(seed.host), postHost],
    [paths.status, decode(seed.status), jsonBytes(nextStatus)],
  ]) {
    const bytes = readFileSync(path);
    assert(bytes.equals(pre) || bytes.equals(post), 'Conflicting recovery metadata');
  }
  assert.deepEqual(readFileSync(paths.hostResult), decode(seed.hostResult));
  if (
    currentState.sha256 === intent.postState.sha256 &&
    !['hostLock', 'jobOutput', 'jobEnvironment'].some((k) => existsSync(paths[k])) &&
    readFileSync(paths.status).equals(jsonBytes(nextStatus))
  ) {
    assert.deepEqual(readFileSync(join(directory, 'manifest.json')), jsonBytes(intended));
    assert.deepEqual(readFileSync(join(root, resultFile)), jsonBytes(result));
    return result;
  }
  await adapter.commit(decode(seed.state), postState);
  await stage('state');
  durable(paths.host, postHost);
  await stage('host');
  durable(join(directory, 'manifest.json'), jsonBytes(intended), true);
  await stage('seal');
  durable(join(root, resultFile), jsonBytes(result), true);
  await stage('result');
  durable(paths.status, jsonBytes(nextStatus));
  await stage('status');
  for (const k of ['hostLock', 'jobOutput', 'jobEnvironment']) {
    if (existsSync(paths[k])) {
      assert.deepEqual(readFileSync(paths[k]), decode(seed[k]), 'Stale lock changed');
      unlinkSync(paths[k]);
    }
    await stage(k);
  }
  return result;
}

export async function verifyRecovery({
  environment,
  root,
  plan,
  binding,
  state,
  stateBytes,
  result,
}) {
  assert.equal(result.outcome, recoveryClass);
  const name = 'recovery-' + String(state.segment.number).padStart(5, '0');
  assert.equal(result.recovery.directory, name);
  const dir = join(root, name),
    manifestBytes = readFileSync(join(dir, 'manifest.json'));
  assert.equal(sha(manifestBytes), result.recovery.manifest);
  const manifest = JSON.parse(manifestBytes);
  assert.equal(manifest.classification, recoveryClass);
  assert.equal(manifest.binding, binding);
  assert.equal(manifest.operation, plan.run);
  for (const file of ['seed.json', 'intent.json'])
    assert.equal(sha(readFileSync(join(dir, file))), manifest.files[file]);
  const seed = readJson(join(dir, 'seed.json')),
    intent = readJson(join(dir, 'intent.json'));
  assert.equal(intent.seed, manifest.files['seed.json']);
  assert.equal(seed.environment, environment);
  assert.equal(seed.root, root);
  assert.equal(seed.binding, binding);
  assert.deepEqual(seed.authority, authority(plan));
  const pre = checkedState(decode(seed.state));
  assert.equal(pre.digest, digest(plan));
  assert.deepEqual(await priorSeals(root, plan, pre), seed.seals);
  assert.deepEqual(state, checkedState(decode(intent.postState)));
  assert.equal(sha(stateBytes), intent.postState.sha256, 'Recovered control bytes changed');
  assert.deepEqual(decode(intent.postState), recoveredState(pre, intent.proof.canonical));
  assert.deepEqual(
    readFileSync(join(environment, 'reconstruction-host.json')),
    decode(intent.postHost),
  );
  assert.deepEqual(
    readFileSync(join(environment, 'reconstruction-host-result.json')),
    decode(seed.hostResult),
  );
  assert.equal(state.segment.ended, null);
  assert.equal(state.lastEnded, null);
  assert.equal(result.originalStart, state.start);
  assert.equal(result.originalDeadline, state.deadline);
  return true;
}
