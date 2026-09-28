import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, readFileSync, writeFileSync, readdirSync, unlinkSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { randomUUID, createHash } from 'node:crypto';
import { coordinate, status, readSmall } from '../../scripts/operator/reconstruction-job.mjs';
import { identity } from '../../scripts/operator/reconstruction-seal.mjs';
import { digest } from '../../dist/services/projections/input.js';
import { boundaryFixture } from './boundary-fixture.mjs';

const root = resolve(process.env.HDD_V2_BOUNDARY_EVIDENCE);
mkdirSync(root, { recursive: true });
const fresh = (name) => boundaryFixture(join(root, name + '-' + randomUUID()));
const hash = (p) => createHash('sha256').update(readFileSync(p)).digest('hex');
const preserved = (f) =>
  Object.fromEntries(
    [
      f.old.resultFile,
      'segment-00018-summary.json',
      ...readdirSync(join(f.root, 'segment-00018')).map((n) => 'segment-00018/' + n),
    ].map((n) => [n, hash(join(f.root, n))]),
  );

test('explicit readmission retains failure/seal and runs actual supervisor/collector as same segment 19', async () => {
  const f = await fresh('readmit');
  const before = preserved(f),
    accounting = { ...f.old.lastSettled.totals },
    originalStart = f.state.start,
    deadline = f.state.deadline;
  await assert.rejects(
    coordinate({ ...f.options, readmitClockStop: undefined }, f.adapter, f.clock),
    /clean paused/,
  );
  const result = await coordinate(f.options, f.adapter, f.clock);
  assert.equal(result.outcome, 'PAUSED_AT_BOUNDARY');
  assert.equal(result.lastSettled.segment, 19);
  assert.equal(result.originalStart, originalStart);
  assert.equal(result.originalDeadline, deadline);
  assert.deepEqual(result.lastSettled.totals, accounting);
  assert.equal(result.clockReadmission.stoppedOwner, f.oldOwner);
  assert.equal(result.clockReadmission.requiredRawFloor, f.time(1001500));
  assert.equal(result.clockReadmission.classification, 'READMITTED_SEALED_CLOCK_BOUNDARY');
  assert.notEqual(result.owner, f.oldOwner);
  assert.deepEqual(preserved(f), before);
  assert.equal(readSmall(join(f.root, f.old.resultFile)).outcome, 'STOPPED_UNCERTAIN');
  assert.equal(f.events.filter((e) => e === 'launch-19').length, 1);
  const receipt = readSmall(join(f.root, result.clockReadmission.receipt));
  assert.deepEqual(receipt.originalStatus, f.old);
  await assert.rejects(coordinate(f.options, f.adapter, f.clock), /Stopped owner changed/);
  writeFileSync(
    join(root, 'READMISSION_RECEIPT.json'),
    JSON.stringify(
      {
        result,
        events: f.events,
        preserved: before,
        providerCalls: 0,
        sqlCalls: 0,
        dockerCalls: 0,
        runtimeSqlAdmission: 'UNCHANGED; NOT EXECUTED IN THIS FILE FIXTURE',
      },
      null,
      2,
    ),
  );
});

async function reseal(f) {
  f.saveState();
  const dir = join(f.root, 'segment-00018');
  writeFileSync(
    join(dir, 'reconstruction.json'),
    readFileSync(join(f.environment, 'reconstruction.json')),
  );
  const manifest = readSmall(join(dir, 'manifest.json'));
  for (const name of Object.keys(manifest.files))
    manifest.files[name] = await identity(join(dir, name));
  f.put(join(dir, 'manifest.json'), manifest);
}

test('all other stopped, pending, drifted, expired, ambiguous and incomplete classes refuse without dispatch', async () => {
  const cases = {
    'non-clock': (f) => {
      f.old.error = f.result.error = 'unrelated collector fault';
    },
    'terminal-provider': (f) => {
      f.result.outcome = 'STOPPED_INCOMPLETE';
      f.result.primaryReason = 'Provider timeout';
    },
    'cleanup-uncertain': (f) => {
      f.result.cleanupError = 'unconfirmed cleanup';
    },
    'cancel-uncertain': (f) => {
      f.result.cancellationError = 'unconfirmed cancel';
    },
    'active-owner': (f) => {
      f.old.child = f.result.child = { pid: 1 };
    },
    'wrong-owner': (f) => {
      f.options.readmitClockStop = randomUUID();
    },
    'state-pending': async (f) => {
      f.state.pending = true;
      await reseal(f);
    },
    'pending-sql': async (f) => {
      f.state.pendingSql = {
        previous: f.state.accepted,
        next: f.state.accepted,
        batchDigest: 'a'.repeat(64),
      };
      await reseal(f);
    },
    'audit-phase': async (f) => {
      f.state.phase = 'audit';
      await reseal(f);
    },
    'state-terminal': async (f) => {
      f.state.terminal = true;
      await reseal(f);
    },
    cutoff: async (f) => {
      f.state.stopHeader.number = '9999';
      await reseal(f);
    },
    counters: async (f) => {
      f.state.http++;
      await reseal(f);
    },
    'host-pending': (f) => {
      f.host.pending = true;
      f.put(join(f.environment, 'reconstruction-host.json'), f.host);
    },
    'host-terminal': (f) => {
      f.host.terminal = true;
      f.put(join(f.environment, 'reconstruction-host.json'), f.host);
    },
    'operator-clock-fault': async (f) => {
      f.state.clockDiagnostic.failed = true;
      await reseal(f);
    },
    'extra-coordinator-fault': (f) => {
      f.old.clock.anomalies.count++;
    },
    'missing-seal': (f) => unlinkSync(join(f.root, 'segment-00018/manifest.json')),
    'tampered-seal': (f) =>
      writeFileSync(join(f.root, 'segment-00018/reconstruction-output.log'), 'tampered'),
    authority: (f) => {
      f.options.binding = 'f'.repeat(64);
    },
    'changed-control-admission': (f) => {
      f.adapter.admit = async () => ({ state: { ...f.state, pausedMs: 0 } });
    },
    'stale-coordinator-lock': (f) =>
      writeFileSync(join(f.environment, '.reconstruction-job.lock'), 'dead but never taken over'),
    'stale-host-lock': (f) =>
      writeFileSync(join(f.environment, '.reconstruction-host.lock'), 'unknown'),
    'later-launch': (f) => writeFileSync(join(f.root, 'invocation-00019-launch.json'), '{}'),
    'later-admission': (f) => mkdirSync(join(f.root, 'admission-00018-' + randomUUID())),
    'another-result': (f) => writeFileSync(join(f.root, 'result-' + randomUUID() + '.json'), '{}'),
    'already-attempted': (f) =>
      writeFileSync(join(f.root, 'clock-readmission-' + randomUUID() + '.json'), '{}'),
    'raw-one-short-of-coordinator': (f) => f.setRaw(f.time(1001499)),
    expired: (f) => f.setRaw(f.state.deadline),
  };
  const receipts = [];
  for (const [name, mutate] of Object.entries(cases)) {
    const f = await fresh(name);
    await mutate(f);
    f.put(join(f.root, f.old.resultFile), f.result);
    f.put(join(f.root, 'status.json'), f.old);
    const originalResult = hash(join(f.root, f.old.resultFile));
    const originalStatus = hash(join(f.root, 'status.json'));
    await assert.rejects(coordinate(f.options, f.adapter, f.clock), undefined, name);
    assert(!f.events.includes('start') && !f.events.some((e) => e.startsWith('launch-')), name);
    assert.equal(hash(join(f.root, f.old.resultFile)), originalResult, name);
    assert.equal(hash(join(f.root, 'status.json')), originalStatus, name);
    receipts.push({ name, refused: true, events: f.events, originalResult, originalStatus });
  }
  writeFileSync(join(root, 'REFUSALS.json'), JSON.stringify(receipts, null, 2));
});

test('concurrent/duplicate readmission cannot acquire a second owner; interruption stays uncertain', async () => {
  const f = await fresh('concurrent'),
    before = preserved(f);
  let release, entered;
  const pending = new Promise((resolve) => {
    entered = resolve;
  });
  const admit = f.adapter.admit;
  f.adapter.admit = async () => {
    entered();
    await new Promise((resolve) => {
      release = resolve;
    });
    return admit();
  };
  const first = coordinate(f.options, f.adapter, f.clock);
  await pending;
  await assert.rejects(coordinate(f.options, f.adapter, f.clock), /EEXIST/);
  f.adapter.start = async () => {
    throw Error('synthetic interruption before dispatch');
  };
  release();
  const result = await first;
  assert.equal(result.outcome, 'STOPPED_UNCERTAIN');
  assert.equal(result.error, 'synthetic interruption before dispatch');
  assert.equal(result.child, null);
  assert.equal(result.nativeOutcome, null);
  assert.equal(result.clockReadmission.stoppedOwner, f.oldOwner);
  assert.deepEqual(preserved(f), before);
  assert(!f.events.includes('launch-19'));
  await assert.rejects(coordinate(f.options, f.adapter, f.clock), /Stopped owner changed/);
  assert.equal(status(f.root).result.owner, result.owner);
});

test('raw rewind during startup cannot dispatch below the prior coordinator floor', async () => {
  const f = await fresh('late-raw-rewind');
  const before = preserved(f);
  f.adapter.start = async () => f.setRaw(f.time(1001499));
  const result = await coordinate(f.options, f.adapter, f.clock);
  assert.equal(result.outcome, 'STOPPED_UNCERTAIN');
  assert.match(result.error, /raw-continuity/);
  assert(!f.events.includes('launch-19'));
  assert.deepEqual(preserved(f), before);
});
