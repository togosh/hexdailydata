import {
  readFileSync,
  writeFileSync,
  openSync,
  closeSync,
  fsyncSync,
  renameSync,
  unlinkSync,
  lstatSync,
  realpathSync,
} from 'node:fs';
import { resolve, relative, isAbsolute, join, dirname } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { reconstructionPlanSchema } from '../../dist/operator/reconstruction-plan.js';
import { digest } from '../../dist/services/projections/input.js';
import { checkAuditBindings } from './audit-bindings.mjs';
import { ReconstructionClock } from '../../dist/operator/reconstruction-clock.js';

/** A timed child, not a scheduler. The same host record covers all invocations. */
export function supervise(
  root,
  plan,
  action,
  work,
  clock = new ReconstructionClock(),
  invocationStart,
) {
  const source = typeof clock === 'function' ? { now: clock } : clock;
  let highWater = null,
    invalidReading;
  const now = () => {
    const value = source.now();
    if (!Number.isSafeInteger(value) || value < 0 || (highWater !== null && value < highWater)) {
      invalidReading = {
        type: typeof value,
        value: String(value).slice(0, 80),
        previousEffective: highWater,
      };
      throw Error('Invalid/backward effective host clock.');
    }
    highWater = value;
    return value;
  };
  const lock = openSync(join(root, '.reconstruction-host.lock'), 'wx', 0o600);
  const save = (name, value) => {
    const temp = join(root, name + '.tmp');
    writeFileSync(temp, JSON.stringify(value) + '\n', { mode: 0o600, flush: true });
    renameSync(temp, join(root, name));
    // Directory fsync is supported on the Linux operator host; Windows host
    // still flushes the replacement itself and fails closed on uncertain state.
    if (process.platform === 'linux') {
      const fd = openSync(root, 'r');
      try {
        fsyncSync(fd);
      } finally {
        closeSync(fd);
      }
    }
  };
  let record, result, invoked, deadline;
  if (source instanceof ReconstructionClock)
    source.context = () => ({
      phase: 'host-supervision',
      segment: record?.segments ?? null,
      checkpoint: null,
    });
  try {
    invoked = invocationStart ?? now();
    const entered = now();
    if (!Number.isSafeInteger(invoked) || invoked <= 0 || invoked > entered)
      throw Error('Invalid original host invocation.');
    if (action === 'run') {
      try {
        lstatSync(join(root, 'reconstruction-host.json'));
        throw Error('Host operation already exists.');
      } catch (e) {
        if (e.code !== 'ENOENT') throw e;
      }
      record = {
        digest: digest(plan),
        start: invoked,
        deadline: Math.min(
          invoked + plan.caps.milliseconds,
          plan.expiresAt ?? Number.MAX_SAFE_INTEGER,
        ),
        highWater: invoked,
        segments: 0,
        pending: false,
        terminal: false,
      };
    } else if (action === 'resume') {
      record = JSON.parse(readFileSync(join(root, 'reconstruction-host.json'), 'utf8'));
      if (
        record.digest !== digest(plan) ||
        record.pending ||
        record.terminal ||
        invoked < record.highWater ||
        (source.wallNow && source.wallNow() < record.highWater) ||
        ![record.start, record.deadline, record.highWater, record.segments].every(
          Number.isSafeInteger,
        ) ||
        record.deadline !==
          Math.min(record.start + plan.caps.milliseconds, plan.expiresAt ?? Number.MAX_SAFE_INTEGER)
      )
        throw Error('Host continuation uncertain/incompatible.');
    } else throw Error('Expected run or resume.');
    if (!Number.isSafeInteger(record.deadline) || entered >= record.deadline)
      throw Error('Original host deadline expired.');
    deadline = Math.min(record.deadline, invoked + plan.segment.milliseconds);
    if (!Number.isSafeInteger(deadline) || now() >= deadline)
      throw Error('Host segment deadline expired.');
    record.pending = true;
    record.segments++;
    record.highWater = invoked;
    save('reconstruction-host.json', record);
    const remaining = deadline - now();
    if (remaining <= 0) throw Error('Deadline spent before host child launch.');
    result = work({
      invoked,
      deadline,
      originalStart: record.start,
      timeout: remaining,
      now,
    });
    record.highWater = now();
    record.pending = false;
    // Only the compiled operator's clean-pause exit may resume.
    record.terminal = result.status !== 3 || record.highWater >= deadline;
    record.clock = source.snapshot?.();
    if (record.highWater >= deadline)
      result = {
        ...result,
        nativeStatus: result.status,
        status: 2,
        error: 'Host deadline expired.',
      };
    save('reconstruction-host.json', record);
    save('reconstruction-host-result.json', {
      ...record,
      invoked,
      segmentDeadline: deadline,
      result,
    });
    return result;
  } catch (error) {
    // Only an invocation we marked pending may be terminalized here. Refused old
    // records (including terminal ones) remain byte-for-byte unchanged.
    if (record?.pending && deadline !== undefined) {
      record.terminal = true;
      record.highWater = highWater ?? record.highWater;
      record.clock = source.snapshot?.() ?? {
        domain: 'injected-effective-ms',
        lastValid: highWater,
        invalidReading,
      };
      if (result) record.pending = false;
      const failure = { status: 2, nativeStatus: result?.status ?? null, error: error.message };
      save('reconstruction-host.json', record);
      save('reconstruction-host-result.json', {
        ...record,
        invoked,
        segmentDeadline: deadline,
        result: failure,
      });
      return failure;
    }
    throw error;
  } finally {
    closeSync(lock);
    unlinkSync(join(root, '.reconstruction-host.lock'));
  }
}

export function main([
  directory,
  override,
  action,
  planName = 'plan.json',
  approvalName = 'approval.json',
]) {
  const clock = new ReconstructionClock(),
    invocationStart = clock.now();
  if (
    !directory ||
    !override ||
    !['run', 'resume'].includes(action) ||
    ![planName, approvalName].every((s) => /^[a-z-]+\.json$/.test(s))
  )
    throw Error(
      'reconstruction-segment <owned environment> <override> run|resume [plan.json] [approval.json]',
    );
  const root = resolve(directory),
    rel = relative(process.cwd(), root),
    overridePath = resolve(override),
    sub = relative(root, overridePath);
  if (
    !rel ||
    rel.startsWith('..') ||
    isAbsolute(rel) ||
    !['.local', 'artifacts'].includes(rel.split(/[\\/]/)[0]) ||
    !sub ||
    sub.startsWith('..') ||
    isAbsolute(sub)
  )
    throw Error('Owned environment/override required.');
  for (let p = root; p !== dirname(p); p = dirname(p))
    if (lstatSync(p).isSymbolicLink()) throw Error('Indirect environment refused.');
  if (realpathSync(root) !== root || lstatSync(overridePath).isSymbolicLink())
    throw Error('Indirect host binding.');
  const plan = reconstructionPlanSchema.parse(
    JSON.parse(readFileSync(join(root, 'input', planName), 'utf8')),
  );
  const config = JSON.parse(readFileSync(join(root, 'environment.json'), 'utf8'));
  if (
    config.project !== plan.project ||
    config.instance !== plan.instance ||
    (config.current ?? config.built) !== plan.release
  )
    throw Error('Host release/instance mismatch.');
  const compose = [
    'compose',
    '--env-file',
    join(root, 'compose.env'),
    '-p',
    plan.project,
    '-f',
    overridePath,
  ];
  const inspect = (args) => {
    const r = spawnSync('docker', args, {
      encoding: 'utf8',
      timeout: 30000,
      maxBuffer: 1024 * 1024,
    });
    if (r.status !== 0) throw Error('Host binding inspection failed.');
    return JSON.parse(r.stdout);
  };
  const result = supervise(
    root,
    plan,
    action,
    ({ invoked, deadline, timeout, now }) => {
      const graph = inspect([...compose, 'config', '--format', 'json']);
      const volume = inspect(['volume', 'inspect', plan.admission.volume])[0];
      const names = graph.services.operator.volumes
        .filter((m) => m.type === 'volume')
        .map((m) => graph.volumes[m.source].name);
      const active = spawnSync('docker', ['ps', '-q', '--filter', 'volume=' + volume.Name], {
        encoding: 'utf8',
        timeout: 30000,
      });
      if (active.status !== 0) throw Error('Cannot exclude competing database.');
      const ids = active.stdout.trim().split(/\s+/).filter(Boolean);
      checkAuditBindings(
        plan,
        graph,
        volume,
        inspect(['volume', 'inspect', ...names]),
        ids.length ? inspect(['inspect', ...ids]) : [],
      );
      if (now() >= deadline) throw Error('Deadline spent during host binding checks.');
      const name = plan.project + '-reconstruction';
      const argv = [
        ...compose,
        'run',
        '--rm',
        '--name',
        name,
        '-T',
        '-e',
        'HDD_V2_ALLOW_LIVE_RPC=true',
        '-e',
        'HDD_V2_RECONSTRUCTION_OPT_IN=' + plan.run,
        '-e',
        'HDD_V2_RECONSTRUCTION_INVOKED_AT=' + invoked,
        'operator',
        'reconstruct',
        action,
        '/input/' + planName,
        '/input/' + approvalName,
      ];
      const r = spawnSync('docker', argv, {
        encoding: 'utf8',
        timeout: Math.max(1, Math.min(timeout, deadline - now())),
        maxBuffer: 8 * 1024 * 1024,
      });
      writeFileSync(join(root, 'reconstruction-output.log'), (r.stdout ?? '') + (r.stderr ?? ''), {
        flush: true,
      });
      let expired;
      try {
        expired = now() >= deadline;
      } catch {
        expired = true;
      }
      if (r.error || expired) {
        const owned = inspect(['inspect', name])[0];
        if (
          owned.Config.Labels?.['com.docker.compose.project'] !== plan.project ||
          owned.Config.Labels?.['com.docker.compose.service'] !== 'operator' ||
          owned.Config.Image !== plan.release ||
          ![plan.storagePath, plan.quotaPath].every((target) =>
            owned.Mounts.some((m) => m.Destination === target && names.includes(m.Name)),
          )
        )
          throw Error('Uncertain child identity; scoped cancellation refused.');
        const killed = spawnSync('docker', ['kill', owned.Id], {
          encoding: 'utf8',
          timeout: 15000,
        });
        if (killed.status !== 0) throw Error('Scoped child cancellation uncertain.');
      }
      return { status: r.status, error: r.error?.message };
    },
    clock,
    invocationStart,
  );
  process.exitCode = result.status ?? 2;
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url))
  main(process.argv.slice(2));
