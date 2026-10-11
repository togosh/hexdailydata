// One finite authority for the maintained cooperative owner. No default activation.
import { readFileSync } from 'node:fs';
import { readFile, lstat } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { canonical, sha } from '../../dist/services/source-update/generation.js';
export const operatingPolicy = JSON.parse(
  readFileSync(new URL('../../config/repeatable-operating-public-1.json', import.meta.url)),
);
export const liveOperatingFormat = operatingPolicy.format;
export const boundaryOperatingFormat = 'unified-operating-denied-boundary-1';
const check = (v, why) => {
  if (!v) throw Error(why);
};
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
