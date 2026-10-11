// One finite authority for the maintained cooperative owner. No default activation.
import { readFileSync } from 'node:fs';
import { readFile, lstat, readdir } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { canonical, sha } from '../../dist/services/source-update/generation.js';
export const operatingPolicy = JSON.parse(
  readFileSync(new URL('../../config/repeatable-operating-public-1.json', import.meta.url)),
);
export const liveOperatingFormat = operatingPolicy.format;
export const boundaryOperatingFormat = 'unified-operating-denied-boundary-1';
const check = (v, why) => {
  if (!v) throw Error(why);
};
export function validatePriorProcessObservations(expectedPids, observed, lastClose) {
  check(
    Array.isArray(observed) && observed.length === expectedPids.length,
    'OPERATING_PRIOR_PROCESS_OBSERVATIONS',
  );
  const remaining = new Set(expectedPids);
  for (const p of observed) {
    check(remaining.delete(p.pid), 'OPERATING_PRIOR_PROCESS_IDENTITY');
    check(
      p.status === 'ABSENT' ||
        (p.status === 'PRESENT' && Date.parse(p.startedAtUtc) / 1000 > lastClose),
      'OPERATING_PRIOR_PROCESS_UNCERTAIN',
    );
  }
  check(remaining.size === 0, 'OPERATING_PRIOR_PROCESS_MISSING');
}
// New authority never settles an older UNKNOWN owner. Inspect its exact native
// closure and current process identities before opening the new genuine runtime.
export async function verifyPriorOperatingSafety() {
  const old = operatingPolicy.oldStateProtection;
  check(old && old.root !== operatingPolicy.root, 'OPERATING_PRIOR_OWNER_BOUNDARY');
  const proof = JSON.parse(
    await readFile(join(operatingPolicy.root, 'reference/OLD_STATE_BINDINGS.json')),
  );
  check(proof.root === old.root && proof.physical.length === 43, 'OPERATING_PRIOR_PROOF');
  for (const item of proof.files) {
    const path = resolve(old.root, item.path);
    check(path.startsWith(old.root + '\\'), 'OPERATING_PRIOR_PATH');
    check(sha(await readFile(path)) === item.sha256, 'OPERATING_PRIOR_STATE_CHANGED');
  }
  const state = JSON.parse(await readFile(join(old.root, 'session/OPERATING_STATE.json')));
  check(
    state.status === 'UNKNOWN' &&
      state.pending.id === 43 &&
      state.pending.bytes === 16384 &&
      state.pending.objects === 16,
    'OPERATING_PRIOR_PROTECTION',
  );
  const pids = new Set([proof.oldOwner.pid]);
  let lastClose = 0;
  for (const item of proof.physical) {
    const permit = JSON.parse(
      await readFile(join(old.root, 'session', `PERMIT_${String(item.id).padStart(8, '0')}.json`)),
    );
    const captureRoot = resolve(permit.requestPath, '..');
    check(captureRoot.startsWith(old.root + '\\session\\'), 'OPERATING_PRIOR_CAPTURE_PATH');
    const close = JSON.parse(await readFile(join(captureRoot, 'PHYSICAL_CLOSED.json')));
    check(
      close.permit === permit.id &&
        close.nonce === permit.nonce &&
        close.childReaped === true &&
        close.connectionClosed === true &&
        close.native?.childReaped === true &&
        Number.isInteger(close.native.exitCode) &&
        close.workerPid !== close.proofOwnerPid,
      'OPERATING_PRIOR_PHYSICAL_CLOSURE',
    );
    pids.add(close.workerPid);
    pids.add(close.proofOwnerPid);
    lastClose = Math.max(lastClose, close.closedAt);
  }
  check(
    [...pids].every((p) => Number.isInteger(p) && p > 0),
    'OPERATING_PRIOR_PID',
  );
  const command = `$ErrorActionPreference='Stop'; $ids=@(${[...pids].join(',')}); $rows=@(foreach($idValue in $ids){try {$p=Get-Process -Id $idValue -ErrorAction Stop; $stamp=$p.StartTime.ToUniversalTime().ToString('o'); [pscustomobject]@{pid=$idValue;status='PRESENT';startedAtUtc=$stamp}} catch {if($_.FullyQualifiedErrorId -eq 'NoProcessFoundForGivenId,Microsoft.PowerShell.Commands.GetProcessCommand'){[pscustomobject]@{pid=$idValue;status='ABSENT'}}else{throw}}}); ConvertTo-Json -InputObject $rows -Compress`;
  const observed = JSON.parse(
    execFileSync('powershell', ['-NoProfile', '-NonInteractive', '-Command', command], {
      encoding: 'utf8',
      timeout: 10000,
      windowsHide: true,
    }),
  );
  validatePriorProcessObservations([...pids], observed, lastClose);
  const additional = operatingPolicy.additionalOldStateProtection
    ? await verifyAdditionalPriorSafety()
    : null;
  const third = operatingPolicy.thirdOldStateProtection ? await verifyReapedPriorSafety() : null;
  return {
    status: 'PASS',
    atUtc: new Date().toISOString(),
    checkedFiles: proof.files.length,
    physicalReaps: 43,
    inspectedPids: [...pids],
    observations: observed,
    reusedPids: observed.filter((p) => p.status === 'PRESENT'),
    oldParent: 'UNKNOWN_UNCHANGED',
    pendingPermit: 43,
    oldLockPreserved: true,
    actions: 'READ_ONLY_NO_SETTLEMENT',
    additional,
    third,
  };
}

// Historical R3 is not R2's never-started case. Its last worker started and
// was reaped; the original parent nevertheless retains its unknown liability.
export function validatePriorReapedPermit(state, capture, close, old) {
  check(
    state.status === 'UNKNOWN' &&
      state.pending?.id === old.pendingPermit &&
      state.pending.bytes === old.reservedBytes &&
      state.pending.objects === old.reservedObjects &&
      capture.failureKind === 'transport_timeout' &&
      capture.status === null &&
      capture.complete === false &&
      capture.usable === false &&
      capture.entityRows === null &&
      capture.bodyDurable === true &&
      capture.responseBytes === 0 &&
      capture.chargedBytes === old.reservedBytes &&
      capture.chargedEntities === old.reservedObjects &&
      capture.childStarted === true &&
      capture.childReaped === true &&
      capture.connectionClosed === true &&
      close.permit === state.pending.id &&
      close.nonce === state.pending.nonce &&
      close.physicalStarted === false &&
      close.noChildStarted === false &&
      close.childReaped === true &&
      close.connectionClosed === true &&
      close.native?.childStarted === true &&
      close.native.childReaped === true &&
      close.native.workerPid === close.workerPid &&
      close.native.ownerPid === close.proofOwnerPid &&
      close.workerPid !== close.proofOwnerPid &&
      Number.isInteger(close.native.exitCode),
    'OPERATING_PRIOR_REAPED_UNCERTAIN',
  );
}

async function verifyReapedPriorSafety() {
  const old = operatingPolicy.thirdOldStateProtection;
  check(
    old.root !== operatingPolicy.root &&
      old.root !== operatingPolicy.oldStateProtection.root &&
      old.root !== operatingPolicy.additionalOldStateProtection.root,
    'OPERATING_PRIOR_THIRD_ROOT',
  );
  const read = async (p) => JSON.parse(await readFile(p));
  const proof = await read(join(operatingPolicy.root, 'reference/PRIOR_R3_STATE_BINDINGS.json'));
  check(
    proof.root === old.root &&
      proof.physical.length === old.physicalReaps &&
      proof.native.length === 9,
    'OPERATING_PRIOR_THIRD_PROOF',
  );
  for (const item of proof.files) {
    const p = resolve(old.root, item.path);
    check(p.startsWith(old.root + '\\'), 'OPERATING_PRIOR_PATH');
    const raw = await readFile(p);
    check(raw.length === item.bytes && sha(raw) === item.sha256, 'OPERATING_PRIOR_STATE_CHANGED');
  }
  const state = await read(join(old.root, 'session/OPERATING_STATE.json'));
  const folder = resolve(state.pending.requestPath, '..');
  check(folder.startsWith(old.root + '\\session\\'), 'OPERATING_PRIOR_CAPTURE_PATH');
  validatePriorReapedPermit(
    state,
    await read(join(folder, 'capture.json')),
    await read(join(folder, 'PHYSICAL_CLOSED.json')),
    old,
  );
  check(
    canonical((await readdir(folder)).sort()) ===
      canonical(
        [
          'PHYSICAL_CLOSED.json',
          'capture.json',
          'request.body',
          'request.json',
          'response.body',
        ].sort(),
      ),
    'OPERATING_PRIOR_THIRD_CAPTURE',
  );
  check(
    (await readFile(join(folder, 'response.body'))).length === 0,
    'OPERATING_PRIOR_THIRD_EMPTY',
  );
  const owner = await read(join(old.root, 'evidence/OWNER_CLOSURE.json'));
  const final = await read(join(old.root, 'finalization-r1/evidence/RESULT.json'));
  const base = await read(join(old.root, 'finalization-r1/evidence/BASE_ADMISSION.json'));
  check(
    owner.status === 'CLOSED' &&
      owner.closed.known &&
      owner.baseClosed.known &&
      final.status === 'SAVED_ONLY_FINALIZATION_PASS' &&
      final.cleanup.ok &&
      base.status === 'CLOSED' &&
      base.pid === final.pid,
    'OPERATING_PRIOR_THIRD_OWNER_CLOSURE',
  );
  const reviewRaw = await readFile(join(old.root, 'SEALED_ARCHIVE_REVIEW.json'));
  const review = JSON.parse(reviewRaw);
  check(
    sha(reviewRaw) === proof.sealedReviewSha256 &&
      review.verdict === 'PASS' &&
      review.sha256 === proof.archiveSha256,
    'OPERATING_PRIOR_THIRD_REVIEW',
  );
  const pids = new Set([owner.pid, final.pid, proof.oldOwner.pid]);
  const seen = new Set();
  let lastClose = Date.parse(base.closedAtUtc) / 1000;
  check(Number.isFinite(lastClose), 'OPERATING_PRIOR_CLOSE_TIME');
  for (const item of proof.physical) {
    check(
      !seen.has(item.id) && item.id >= 1 && item.id <= old.pendingPermit,
      'OPERATING_PRIOR_PERMIT_DUPLICATE',
    );
    seen.add(item.id);
    const permit = await read(
      join(old.root, 'session', `PERMIT_${String(item.id).padStart(8, '0')}.json`),
    );
    const captureRoot = resolve(permit.requestPath, '..');
    check(captureRoot.startsWith(old.root + '\\session\\'), 'OPERATING_PRIOR_CAPTURE_PATH');
    const c = await read(join(captureRoot, 'PHYSICAL_CLOSED.json'));
    check(
      c.permit === permit.id &&
        c.nonce === permit.nonce &&
        c.childReaped === true &&
        c.connectionClosed === true &&
        c.native?.childReaped === true &&
        Number.isInteger(c.native.exitCode) &&
        c.workerPid !== c.proofOwnerPid,
      'OPERATING_PRIOR_PHYSICAL_CLOSURE',
    );
    pids.add(c.workerPid);
    pids.add(c.proofOwnerPid);
    lastClose = Math.max(lastClose, c.closedAt);
  }
  check(seen.size === old.pendingPermit, 'OPERATING_PRIOR_PERMIT_GAP');
  for (const item of proof.native) {
    const n = await read(join(old.root, item.path));
    check(
      n.knownClosure === true &&
        n.childCloseObserved === true &&
        n.childExitObserved === true &&
        Number.isInteger(n.childExitCode),
      'OPERATING_PRIOR_NATIVE_CLOSURE',
    );
    pids.add(n.ownerPid);
    pids.add(n.childPid);
    lastClose = Math.max(lastClose, Date.parse(n.recordedAtUtc) / 1000);
  }
  check(
    [...pids].every((p) => Number.isInteger(p) && p > 0),
    'OPERATING_PRIOR_PID',
  );
  const command = `$ErrorActionPreference='Stop'; $ids=@(${[...pids].join(',')}); $rows=@(foreach($idValue in $ids){try {$p=Get-Process -Id $idValue -ErrorAction Stop; [pscustomobject]@{pid=$idValue;status='PRESENT';startedAtUtc=$p.StartTime.ToUniversalTime().ToString('o')}} catch {if($_.FullyQualifiedErrorId -eq 'NoProcessFoundForGivenId,Microsoft.PowerShell.Commands.GetProcessCommand'){[pscustomobject]@{pid=$idValue;status='ABSENT'}}else{throw}}}); ConvertTo-Json -InputObject $rows -Compress`;
  const observations = JSON.parse(
    execFileSync('powershell', ['-NoProfile', '-NonInteractive', '-Command', command], {
      encoding: 'utf8',
      timeout: 10000,
      windowsHide: true,
    }),
  );
  validatePriorProcessObservations([...pids], observations, lastClose);
  return {
    status: 'PASS',
    root: old.root,
    physicalReaps: seen.size,
    observations,
    oldParent: 'UNKNOWN_UNCHANGED',
    pendingPermit: old.pendingPermit,
    oldLockPreserved: true,
    pendingChargeBytes: old.reservedBytes,
    pendingObjects: old.reservedObjects,
    actions: 'READ_ONLY_NO_SETTLEMENT',
  };
}

// R2's final permit has no worker receipt. Its sealed, reviewed pre-worker
// refusal is checked as historical evidence, never converted into a settlement.
export function validatePriorUnstartedPermit(state, result, names, expected) {
  const pending = state.pending;
  check(
    state.status === 'UNKNOWN' &&
      pending?.id === expected.pendingPermit &&
      pending.bytes === expected.reservedBytes &&
      pending.objects === expected.reservedObjects &&
      result.failure === 'LimitReached: Combined mandatory controls/publication deadline reserve' &&
      result.accounting.status === 'CLOSURE_OR_ACCOUNTING_UNKNOWN' &&
      result.accounting.pending?.requestPath === pending.requestPath &&
      result.accounting.pending.reservedBytes === pending.bytes &&
      result.accounting.pending.reservedEntities === pending.objects &&
      canonical([...names].sort()) === canonical(['request.body', 'request.json']),
    'OPERATING_PRIOR_UNSTARTED_UNCERTAIN',
  );
}

async function verifyAdditionalPriorSafety() {
  const old = operatingPolicy.additionalOldStateProtection;
  check(
    old.root !== operatingPolicy.root && old.root !== operatingPolicy.oldStateProtection.root,
    'OPERATING_PRIOR_ADDITIONAL_ROOT',
  );
  const read = async (p) => JSON.parse(await readFile(p));
  const proof = await read(join(operatingPolicy.root, 'reference/PRIOR_R2_STATE_BINDINGS.json'));
  check(
    proof.root === old.root && proof.physical.length === old.physicalReaps,
    'OPERATING_PRIOR_ADDITIONAL_PROOF',
  );
  for (const item of proof.files) {
    const path = resolve(old.root, item.path);
    check(path.startsWith(old.root + '\\'), 'OPERATING_PRIOR_PATH');
    const raw = await readFile(path);
    check(raw.length === item.bytes && sha(raw) === item.sha256, 'OPERATING_PRIOR_STATE_CHANGED');
  }
  const owner = await read(join(old.root, 'evidence/OWNER_CLOSURE.json'));
  check(
    owner.status === 'CLOSED' && owner.closed.known && owner.baseClosed.known,
    'OPERATING_PRIOR_OWNER_CLOSURE',
  );
  const state = await read(join(old.root, 'session/OPERATING_STATE.json'));
  const capture = resolve(state.pending.requestPath, '..');
  check(
    capture === proof.unsettled.capture && capture.startsWith(old.root + '\\session\\'),
    'OPERATING_PRIOR_UNSTARTED_PATH',
  );
  const result = await read(join(old.root, 'session', state.pending.job, 'RESULT.json'));
  validatePriorUnstartedPermit(state, result, await readdir(capture), old);
  const review = await read(join(old.root, 'SEALED_ARCHIVE_REVIEW.json'));
  check(
    review.verdict === 'PASS' &&
      review.qualifiedOutcome.unsettledPermit === old.pendingPermit &&
      review.qualifiedOutcome.actualPhysicalStartsAndCloses === old.physicalReaps &&
      sha(await readFile(join(old.root, 'SEALED_ARCHIVE_REVIEW.json'))) ===
        proof.sealedReviewSha256,
    'OPERATING_PRIOR_REVIEW_BINDING',
  );
  const pids = new Set([owner.pid, proof.oldOwner.pid]);
  const permits = new Set();
  let lastClose =
    Date.parse(
      owner.baseClosed.closedAtUtc ??
        (await read(join(old.root, 'evidence/BASE_ADMISSIONS.json'))).entries[0].closedAtUtc,
    ) / 1000;
  check(Number.isFinite(lastClose), 'OPERATING_PRIOR_CLOSE_TIME');
  for (const item of proof.physical) {
    check(!permits.has(item.id) && item.id < old.pendingPermit, 'OPERATING_PRIOR_PERMIT_DUPLICATE');
    permits.add(item.id);
    const permit = await read(
      join(old.root, 'session', `PERMIT_${String(item.id).padStart(8, '0')}.json`),
    );
    const folder = resolve(permit.requestPath, '..');
    check(folder.startsWith(old.root + '\\session\\'), 'OPERATING_PRIOR_CAPTURE_PATH');
    const close = await read(join(folder, 'PHYSICAL_CLOSED.json'));
    check(
      close.permit === permit.id &&
        close.nonce === permit.nonce &&
        close.childReaped === true &&
        close.connectionClosed === true &&
        close.native?.childReaped === true &&
        Number.isInteger(close.native.exitCode) &&
        close.workerPid !== close.proofOwnerPid,
      'OPERATING_PRIOR_PHYSICAL_CLOSURE',
    );
    pids.add(close.workerPid);
    pids.add(close.proofOwnerPid);
    lastClose = Math.max(lastClose, close.closedAt);
  }
  check(permits.size === old.pendingPermit - 1, 'OPERATING_PRIOR_PERMIT_GAP');
  for (const item of proof.native) {
    const n = await read(join(old.root, item.path));
    check(
      n.knownClosure === true &&
        n.childCloseObserved === true &&
        n.childExitObserved === true &&
        Number.isInteger(n.childExitCode),
      'OPERATING_PRIOR_NATIVE_CLOSURE',
    );
    pids.add(n.ownerPid);
    pids.add(n.childPid);
    lastClose = Math.max(lastClose, Date.parse(n.recordedAtUtc) / 1000);
  }
  check(
    [...pids].every((p) => Number.isInteger(p) && p > 0),
    'OPERATING_PRIOR_PID',
  );
  const command = `$ErrorActionPreference='Stop'; $ids=@(${[...pids].join(',')}); $rows=@(foreach($idValue in $ids){try {$p=Get-Process -Id $idValue -ErrorAction Stop; [pscustomobject]@{pid=$idValue;status='PRESENT';startedAtUtc=$p.StartTime.ToUniversalTime().ToString('o')}} catch {if($_.FullyQualifiedErrorId -eq 'NoProcessFoundForGivenId,Microsoft.PowerShell.Commands.GetProcessCommand'){[pscustomobject]@{pid=$idValue;status='ABSENT'}}else{throw}}}); ConvertTo-Json -InputObject $rows -Compress`;
  const observed = JSON.parse(
    execFileSync('powershell', ['-NoProfile', '-NonInteractive', '-Command', command], {
      encoding: 'utf8',
      timeout: 10000,
      windowsHide: true,
    }),
  );
  validatePriorProcessObservations([...pids], observed, lastClose);
  return {
    status: 'PASS',
    root: old.root,
    checkedFiles: proof.files.length,
    physicalReaps: permits.size,
    observations: observed,
    oldParent: 'UNKNOWN_UNCHANGED',
    pendingPermit: old.pendingPermit,
    pendingChargeBytes: old.reservedBytes,
    pendingObjects: old.reservedObjects,
    oldLockPreserved: true,
    actions: 'READ_ONLY_NO_SETTLEMENT',
  };
}
export function liveOperating(a) {
  if (a?.operatingFormat !== liveOperatingFormat) return false;
  check(
    a.authorityTaskId === operatingPolicy.task &&
      a.parentMode === 'OWNER_AUTHORIZED_PUBLIC' &&
      a.synthetic === false,
    'OPERATING_EXACT_LIVE_MODE',
  );
  check(
    /^[a-f0-9]{64}$/.test(a.preflightSha256 ?? '') && /^[a-f0-9]{64}$/.test(a.parentNonce ?? ''),
    'OPERATING_LIVE_NONCE',
  );
  return true;
}
export function boundedOperatingConfig(start, boundary = false) {
  const p = operatingPolicy.public;
  return {
    format: boundary ? boundaryOperatingFormat : liveOperatingFormat,
    mode: boundary ? 'DENIED_NETWORK_TEST' : 'OWNER_AUTHORIZED_PUBLIC',
    startsAt: start,
    expiresAt: start + p.sessionSecondsIncludingClosure,
    admissionEndsAt: start + p.newJobAdmissionSeconds,
    dispatchEndsAt: start + p.sessionSecondsIncludingClosure - p.finalClosureReserveSeconds,
    families: Object.fromEntries(
      Object.entries(p.families).map(([f, v]) => [
        f,
        { enabled: true, period: v.periodSeconds, deadline: v.deadlineSeconds },
      ]),
    ),
    total: p.protocolReservationLimits,
    rolling: p.rolling,
    storage: { bytes: 4294967296, entries: 100000, jobs: p.maximumJobs },
    participants: { maximumWindowBlocks: 4096, maximumActivationBlocks: 4096 },
    maximumJobsByFamily: Object.fromEntries(
      Object.entries(p.families).map(([f, v]) => [f, v.maximumJobs]),
    ),
    aggregate: {
      attempts: p.globalMaximumPhysicalAttempts,
      bytes: p.maximumChargedBytes,
      objects: p.maximumChargedObjects,
    },
  };
}
export function validateBoundedOperating(c) {
  const boundary = c?.format === boundaryOperatingFormat;
  check(boundary || c?.format === liveOperatingFormat, 'OPERATING_EXACT_CONFIG_MODE');
  check(
    Number.isFinite(c.startsAt) &&
      c.startsAt > 0 &&
      canonical(c) === canonical(boundedOperatingConfig(c.startsAt, boundary)),
    'OPERATING_EXACT_CONFIG',
  );
  return c;
}
// Every process owns its own monotonic origin; only epoch deadlines cross IPC.
export class RealOperatingClock {
  constructor({ wall = () => Date.now() / 1000, mono = () => performance.now() / 1000 } = {}) {
    this.mode = 'REAL_EPOCH';
    this.wall = wall;
    this.mono = mono;
    this.origin = { unixSeconds: wall(), monotonicSeconds: mono(), pid: process.pid };
    this.last = this.origin.unixSeconds;
  }
  now() {
    const n = this.origin.unixSeconds + this.mono() - this.origin.monotonicSeconds;
    check(n >= this.last && Math.abs(this.wall() - n) <= 2, 'OPERATING_CLOCK_DISCONTINUITY');
    this.last = n;
    return n;
  }
  sleep(seconds) {
    return new Promise((r) => setTimeout(r, Math.max(0, seconds) * 1000));
  }
}
export async function validateOperatingReady({ root, registry, loadedRuntimeFiles, repo }) {
  check(resolve(root) === operatingPolicy.root, 'OPERATING_EXACT_PUBLIC_ROOT');
  for (const n of ['session', 'PUBLIC_ADMISSION.json'])
    check(
      !(await lstat(join(root, n)).catch((e) => {
        if (e.code === 'ENOENT') return null;
        throw e;
      })),
      'OPERATING_PUBLIC_SPENT_OR_UNKNOWN',
    );
  for (const [p, h] of Object.entries(operatingPolicy.packetHashes))
    check(sha(await readFile(join(root, p))) === h, 'OPERATING_PACKET_CHANGED');
  const raw = async (n) => readFile(join(root, n));
  const read = async (n) => JSON.parse(await raw(n));
  const plan = await read('FROZEN_PLAN.json'),
    pre = await read('PREFLIGHT.json'),
    review = await read('evidence/PREFLIGHT_REVIEW.json'),
    ready = await read('evidence/READY.json');
  check(
    pre.taskId === operatingPolicy.task &&
      pre.verdict === 'PASS' &&
      pre.synthetic === false &&
      review.verdict === 'PASS' &&
      review.candidateCommit === plan.commit &&
      review.planSha256 === sha(await raw('FROZEN_PLAN.json')),
    'OPERATING_PREFLIGHT_REVIEW',
  );
  check(
    pre.reviewSha256 === sha(await raw('evidence/PREFLIGHT_REVIEW.json')) &&
      pre.readySha256 === sha(await raw('evidence/READY.json')),
    'OPERATING_PREFLIGHT_DIGEST',
  );
  check(
    ready.status === 'PASS' &&
      ready.pid === process.pid &&
      ready.actualPairedRegistry === true &&
      ready.freshProcess === true &&
      Date.now() - Date.parse(ready.readyAtUtc) >= 0 &&
      Date.now() - Date.parse(ready.readyAtUtc) < 120000,
    'OPERATING_LOADED_READY',
  );
  check(
    canonical(plan.runtimeFiles) === canonical(loadedRuntimeFiles) &&
      ready.runtimeHash === sha(canonical(loadedRuntimeFiles)) &&
      canonical(pre.runtimeFiles) === canonical(loadedRuntimeFiles),
    'OPERATING_LOADED_SOURCE',
  );
  for (const [p, h] of Object.entries(plan.runtimeFiles))
    check(sha(await readFile(join(repo, p))) === h, 'OPERATING_SOURCE_CHANGED');
  for (const [p, h] of Object.entries(plan.inputFiles))
    check(sha(await raw(p)) === h, 'OPERATING_INPUT_CHANGED');
  const selected = registry.productDaily.capture(),
    state = registry.status(),
    s = operatingPolicy.selection;
  check(
    selected.version === s.productVersion &&
      state.generation === s.participantGeneration &&
      selected.metadata.marketStorage.sequence === s.sequence,
    'OPERATING_INITIAL_PAIR',
  );
  return {
    preflightSha256: sha(await raw('PREFLIGHT.json')),
    scopeSha256: operatingPolicy.packetHashes['packet/SCOPE.json'],
    runtimeFiles: plan.runtimeFiles,
  };
}
