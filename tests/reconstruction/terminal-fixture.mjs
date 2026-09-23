// File-only terminal fixtures. No Docker, provider, SQL or real authority exists.
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import { digest } from '../../dist/services/projections/input.js';
import { collect } from '../../scripts/operator/reconstruction-collect.mjs';
export const saved = JSON.parse(readFileSync(new URL('./terminal-states.json', import.meta.url)));
export const put = (path, value) => writeFileSync(path, JSON.stringify(value, null, 2) + '\n');
export function terminalFixture(root, mode = 'stream-invalid') {
  const environment = join(root, 'environment'),
    snapshot = join(root, 'snapshot'),
    output = join(root, 'output');
  mkdirSync(join(environment, 'input'), { recursive: true });
  mkdirSync(snapshot);
  mkdirSync(output);
  const state = structuredClone(saved.cases.find((c) => c.mode === mode).state);
  if (mode === 'control') {
    // Only the healthy synthetic pause/completion control needs a current lease.
    // The six saved terminal cases retain every original clock/deadline field.
    const offset = Date.now() - state.highWater;
    for (const key of ['start', 'deadline', 'highWater', 'lastEnded']) state[key] += offset;
    for (const key of ['started', 'deadline', 'ended']) state.segment[key] += offset;
  }
  const plan = {
    run: randomUUID(),
    caps: {
      milliseconds: state.deadline - state.start,
      http: 20000,
      logical: 200000,
      bytes: 2147483648,
    },
    segment: { milliseconds: 3600000 },
    expiresAt: null,
    target: '357',
    milestones: ['357'],
    profile: { ethereum: [{ id: 'a' }, { id: 'b' }] },
  };
  state.digest = digest(plan);
  const host = {
    digest: state.digest,
    start: state.start,
    deadline: state.deadline,
    segments: state.segment.number,
    pending: false,
    terminal: true,
  };
  const hostResult = { ...host, result: { status: mode === 'control' ? 0 : 2, signal: null } };
  put(join(root, 'fixture.json'), {
    provenance: saved.provenance,
    synthetic: [
      'plan/digest binding',
      'settled host/native wrappers',
      'short child',
      'one-account paired file inventory when full-audit state',
      'healthy control times shifted together to keep its original duration usable',
    ],
    auditLimitation:
      'The small synthetic comparison files test collector integrity only; they do not reproduce or qualify the saved SQL audit.',
    mode,
  });
  put(join(environment, 'input/plan.json'), plan);
  writeFileSync(
    join(environment, 'reconstruction-output.log'),
    'SYNTHETIC host invocation\n' + state.reason,
  );
  const save = () => {
    put(join(snapshot, 'reconstruction.json'), { ...state, checksum: digest(state) });
    put(join(environment, 'reconstruction-host.json'), host);
    put(join(environment, 'reconstruction-host-result.json'), hostResult);
  };
  const full = () => {
    const address = '0x' + '1'.repeat(40);
    const pages = ['a', 'b'].map((source) => ({
      source,
      offset: 0,
      rows: [{ address, expected: '1', observed: '1' }],
    }));
    let commitment = digest([]);
    for (const page of pages) commitment = digest({ prior: commitment, page });
    const text = pages.map((page) => JSON.stringify(page) + '\n').join('');
    writeFileSync(join(snapshot, 'comparisons.jsonl'), text);
    put(join(snapshot, 'audit-result.json'), {
      unchanged: true,
      before: state.canonicalAtPause,
      after: state.canonicalAtPause,
      count: 1,
      coverage: {
        bytes: Buffer.byteLength(text),
        commitment,
        sources: ['a', 'b'].map((source) => ({ source, count: 1, after: address, pages: 1 })),
      },
    });
  };
  if (state.milestone) full();
  save();
  const prior = {
    ...structuredClone(state),
    digest: digest(plan),
    start: null,
    deadline: null,
    highWater: state.start,
    segment: null,
    status: 'prepared',
    terminal: false,
    pending: false,
    pendingSql: null,
    accepted: structuredClone(saved.cases.find((c) => c.mode === 'stream-invalid').state.accepted),
    audited: null,
    milestone: 0,
    reason: 'NOT_RUN',
    http: 0,
    logical: 0,
    observedBytes: 0,
    chargedBytes: 0,
  };
  const events = [];
  let launches = 0;
  const adapter = {
    admit: async () => ({ state: prior }),
    boundary: async () => {},
    launch: async (_action, number, onChild) => {
      launches++;
      const child = spawn(
        process.execPath,
        ['-e', `setTimeout(() => process.exit(${hostResult.result.status}), 10)`],
        { stdio: 'ignore', windowsHide: true },
      );
      const completion = new Promise((resolve) =>
        child.once('close', (exit, signal) => resolve({ exit, signal })),
      );
      onChild({ pid: child.pid, kind: 'harmless-terminal-fixture', segment: number });
      const native = await completion;
      events.push({ event: 'native-settled', ...native });
      return native;
    },
    snapshot: async () => {
      events.push({ event: 'snapshot' });
      const { checksum, ...disk } = JSON.parse(readFileSync(join(snapshot, 'reconstruction.json')));
      return { state: disk, host, hostResult, snapshot };
    },
    collect: async (path) => {
      events.push({ event: 'real-collect' });
      return collect(environment, path, output);
    },
    close: async () => {
      events.push({ event: 'closed' });
      put(join(root, 'process-receipt.json'), { launches, events });
    },
  };
  return {
    root,
    environment,
    snapshot,
    output,
    state,
    host,
    hostResult,
    plan,
    save,
    full,
    adapter,
    events,
    launches: () => launches,
    options: {
      root: output,
      lockRoot: environment,
      operation: plan.run,
      plan,
      action: 'run',
      binding: digest({ fixture: plan.run }),
    },
    clock: { now: () => state.start + 1 },
  };
}
