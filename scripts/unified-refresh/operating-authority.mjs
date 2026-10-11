// One finite authority for the maintained cooperative owner. No default activation.
import { readFileSync } from 'node:fs';
import { readFile, lstat } from 'node:fs/promises';
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
// closure and current process identities before opening a genuine R2 runtime.
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
