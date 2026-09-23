// Synthetic-only adapters. No Docker, provider, SQL or private paths are reachable.
import { spawn } from 'node:child_process';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { digest } from '../../dist/services/projections/input.js';
import { pause } from '../../scripts/operator/reconstruction-job.mjs';
export function jobFixture(root, mode = 'complete') {
  const lockRoot = join(root, 'environment'),
    output = join(root, 'output');
  mkdirSync(lockRoot, { recursive: true });
  mkdirSync(output, { recursive: true });
  const plan = {
    run: randomUUID(),
    caps: { milliseconds: 100000, http: 100, logical: 1000, bytes: 1000000 },
    segment: { milliseconds: 10000 },
    milestones: ['20', '30'],
    target: '30',
    expiresAt: null,
  };
  const initial = {
    digest: digest(plan),
    start: null,
    deadline: null,
    status: 'prepared',
    terminal: false,
    pending: false,
    pendingSql: null,
    segment: null,
    accepted: { header: { number: '10' }, revision: '1' },
    audited: null,
    milestone: 0,
    phase: 'replay',
    http: 0,
    logical: 0,
    chargedBytes: 0,
    observedBytes: 0,
  };
  let state = initial,
    host,
    hostResult,
    child,
    activeNumber,
    native,
    originalStart;
  const events = [],
    children = [];
  const options = {
    root: output,
    lockRoot,
    operation: plan.run,
    plan,
    action: 'run',
    binding: digest({ fixture: plan.run }),
  };
  const adapter = {
    async admit() {
      events.push('admit');
      return { state };
    },
    async start() {
      events.push('start');
    },
    async boundary() {
      events.push('boundary');
      if (mode === 'boundary-failure') throw Error('synthetic seal missing');
    },
    async launch(action, number, onChild) {
      activeNumber = number;
      originalStart ??= Date.now();
      events.push('launch-' + number + '-' + action);
      const desired = mode === 'terminal' ? 2 : number >= 4 ? 0 : 3;
      child = spawn(process.execPath, ['-e', `setTimeout(() => process.exit(${desired}), 25)`], {
        stdio: 'ignore',
        windowsHide: true,
      });
      const handle = child;
      const completion = new Promise((resolve) => {
        child.once('error', (e) => resolve({ exit: null, error: e.message }));
        child.once('close', (exit, signal) => resolve({ exit, signal }));
      });
      onChild({ pid: child.pid, kind: 'harmless-fixture', segment: number });
      children.push({ pid: child.pid, number });
      if (mode === 'pause' && number === 1) pause(output, plan.run);
      if (mode === 'cancel') process.emit('SIGINT');
      native = await completion;
      child = null;
      events.push('exit-' + number + '-' + native.exit);
      if (handle.exitCode !== null) children.at(-1).exit = handle.exitCode;
      children.at(-1).signal = handle.signalCode;
      return native;
    },
    async snapshot(number) {
      events.push('snapshot-' + number);
      const full = number >= 3,
        complete = number >= 4;
      state = {
        ...state,
        start: originalStart,
        deadline: originalStart + plan.caps.milliseconds,
        status: complete
          ? 'complete'
          : mode === 'terminal' || mode === 'cancel'
            ? 'blocked'
            : 'paused',
        terminal: complete || mode === 'terminal' || mode === 'cancel',
        pending: mode === 'pending',
        segment: { number, ended: Date.now() },
        phase: complete
          ? 'complete'
          : full
            ? 'milestone-audited'
            : number === 2
              ? 'audit'
              : 'replay',
        accepted: {
          header: { number: complete ? '30' : full ? '20' : '15' },
          revision: String(number + 1),
        },
        audited: full
          ? { header: { number: complete ? '30' : '20' }, revision: String(number + 1) }
          : null,
        milestone: complete ? 2 : full ? 1 : 0,
        http: number,
        logical: number,
        observedBytes: number * 10,
        chargedBytes: number * 10,
      };
      if (mode === 'expired') state.deadline = originalStart - 1;
      if (mode === 'mismatch') state.digest = 'wrong';
      host = {
        digest: digest(plan),
        start: originalStart,
        deadline: state.deadline,
        segments: number,
        terminal: state.terminal,
        pending: false,
      };
      hostResult = { result: { status: mode === 'uncertain' ? null : native.exit } };
      return { state, host, hostResult, snapshot: 'synthetic-only' };
    },
    async collect() {
      events.push('collect-' + activeNumber);
      if (mode === 'seal-failure') throw Error('synthetic missing seal');
      return {
        status: mode === 'unsealed' ? 'UNSEALED' : 'SEALED',
        binding: { run: plan.run, planDigest: digest(plan), segment: activeNumber },
        resumeEligible: !state.terminal && !state.pending,
      };
    },
    async cancel() {
      events.push('cancel-owned-handle');
      if (child) child.kill();
    },
    async close() {
      if (child) throw Error('child still owned');
      events.push('closed');
    },
  };
  return { options, adapter, events, children, state: () => state };
}
