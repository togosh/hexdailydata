import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync, readFileSync, openSync, closeSync, readdirSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { join, resolve } from 'node:path';
import { coordinate, status, pause } from '../../scripts/operator/reconstruction-job.mjs';
import { collect } from '../../scripts/operator/reconstruction-collect.mjs';
import { verify } from '../../scripts/operator/reconstruction-seal.mjs';
import { digest } from '../../dist/services/projections/input.js';
import { jobFixture } from './job-fixture.mjs';
const root = resolve(process.env.HDD_V2_JOB_EVIDENCE ?? 'artifacts/task-10/clock-and-runner/jobs');
mkdirSync(root, { recursive: true });
const fresh = (name) => {
  const path = join(root, name + '-' + randomUUID());
  mkdirSync(path);
  return path;
};
test('one coordinator advances clean segments, partial audit and full milestones under the same original budget', async () => {
  const f = jobFixture(fresh('sequence'));
  const result = await coordinate(f.options, f.adapter);
  assert.equal(result.outcome, 'SCOPED_INTERVAL_COMPLETE');
  assert.equal(result.lastSettled.milestone, 2);
  assert.deepEqual(
    f.events.filter((e) => /launch|snapshot|collect/.test(e)),
    [
      'launch-1-run',
      'snapshot-1',
      'collect-1',
      'launch-2-resume',
      'snapshot-2',
      'collect-2',
      'launch-3-resume',
      'snapshot-3',
      'collect-3',
      'launch-4-resume',
      'snapshot-4',
      'collect-4',
    ],
  );
  assert.equal(result.originalDeadline - result.originalStart, f.options.plan.caps.milliseconds);
  assert.equal(status(f.options.root).observation, 'SETTLED_RECORD');
});
test('terminal, uncertain, mismatched, pending, expired and missing seal outcomes never launch another child', async () => {
  for (const mode of [
    'terminal',
    'uncertain',
    'mismatch',
    'pending',
    'expired',
    'seal-failure',
    'unsealed',
    'boundary-failure',
  ]) {
    const f = jobFixture(fresh(mode), mode),
      result = await coordinate(f.options, f.adapter);
    assert(result.outcome.startsWith('STOPPED_'));
    assert(f.children.length <= 1);
    await assert.rejects(coordinate({ ...f.options, action: 'resume' }, f.adapter), /clean paused/);
  }
});
test('duplicate operation/output owner and stale lock refuse without overwriting evidence', async () => {
  const f = jobFixture(fresh('duplicate'));
  const path = join(f.options.lockRoot, '.reconstruction-job.lock'),
    fd = openSync(path, 'wx');
  writeFileSync(fd, 'unknown prior owner');
  closeSync(fd);
  await assert.rejects(coordinate(f.options, f.adapter), /EEXIST/);
  assert.equal(readFileSync(path, 'utf8'), 'unknown prior owner');
  assert.equal(f.children.length, 0);
});
test('absolute expiry before admission, during admission/startup or final publication launches no child', async () => {
  for (const stage of ['initial', 'admit', 'start', 'publication']) {
    const f = jobFixture(fresh('expiry-' + stage));
    f.options.plan.expiresAt = 2000;
    f.state().digest = digest(f.options.plan);
    let now = stage === 'initial' ? 2000 : 1000;
    const clock = {
      now: () => now,
      wallNow: () => {
        // The second status publication is the final prelaunch publication.
        if (stage === 'publication' && f.events.includes('boundary')) now = 2000;
        return now;
      },
    };
    for (const name of ['admit', 'start']) {
      const original = f.adapter[name];
      f.adapter[name] = async (...args) => {
        const value = await original(...args);
        if (stage === name) now = 2000;
        return value;
      };
    }
    if (stage === 'initial') {
      await assert.rejects(coordinate(f.options, f.adapter, clock), /Absolute coordinator expiry/);
      assert.deepEqual(f.events, []);
    } else {
      const result = await coordinate(f.options, f.adapter, clock);
      assert.equal(result.outcome, 'STOPPED_UNCERTAIN');
      assert.match(result.error, /Absolute coordinator expiry/);
      assert.equal(f.events.at(-1), 'closed');
      if (stage === 'admit') assert(!f.events.includes('start'));
    }
    assert.equal(f.children.length, 0);
  }
});
test('operation-bound pause and full-milestone stop collect first, preserve partial status, and permit explicit clean resume', async () => {
  const f = jobFixture(fresh('pause'), 'pause');
  const first = await coordinate(f.options, f.adapter);
  assert.equal(first.outcome, 'PAUSED_AT_BOUNDARY');
  assert.equal(first.lastSettled.audited, null);
  assert.equal(f.children.length, 1);
  assert(f.events.indexOf('collect-1') > f.events.indexOf('exit-1-3'));
  const resumed = await coordinate({ ...f.options, action: 'resume', stopAt: '20' }, f.adapter);
  assert.equal(resumed.outcome, 'PAUSED_AFTER_MILESTONE');
  assert.equal(resumed.lastSettled.milestone, 1);
  assert.equal(resumed.originalStart, first.originalStart);
  assert.equal(resumed.originalDeadline, first.originalDeadline);
  assert.equal(f.children.length, 3);
  await assert.rejects(
    coordinate({ ...f.options, action: 'resume', stopAt: '99' }, f.adapter),
    /declared milestone/,
  );
  const completed = await coordinate({ ...f.options, action: 'resume' }, f.adapter);
  assert.equal(completed.outcome, 'SCOPED_INTERVAL_COMPLETE');
});
test('status reads are bounded, read-only and honest about stale running records; wrong-operation pause refuses', () => {
  const directory = fresh('status');
  assert.equal(status(directory).observation, 'UNKNOWN');
  const record = {
    owner: randomUUID(),
    operation: randomUUID(),
    phase: 'segment-running',
    coordinatorPid: process.pid,
    observedWallUtc: 1,
    resultFile: null,
  };
  writeFileSync(join(directory, 'status.json'), JSON.stringify(record));
  const before = readFileSync(join(directory, 'status.json')),
    files = readdirSync(directory);
  assert.equal(status(directory).observation, 'OWNERSHIP_UNKNOWN');
  assert.deepEqual(readFileSync(join(directory, 'status.json')), before);
  assert.deepEqual(readdirSync(directory), files);
  assert.throws(() => pause(directory, randomUUID()), /mismatch/);
  writeFileSync(join(directory, 'status.json'), ' '.repeat(65537));
  assert.equal(status(directory).observation, 'UNKNOWN');
});
test('emergency cancellation targets the actual short child handle and is never a clean pause', async () => {
  const f = jobFixture(fresh('cancel'), 'cancel'),
    result = await coordinate(f.options, f.adapter);
  assert.equal(result.outcome, 'CANCELED_UNCERTAIN');
  assert.equal(f.children.length, 1);
  assert(f.events.includes('cancel-owned-handle'));
  assert.equal(f.events.at(-1), 'closed');
});
test('ordinary Windows PowerShell parent runs short coordinator to native completion without model driving segments', () => {
  assert.equal(process.platform, 'win32', 'This host proof requires Windows');
  const directory = fresh('powershell-process');
  const script = `& '${process.execPath.replaceAll("'", "''")}' tests/reconstruction/job-child.mjs '${directory.replaceAll("'", "''")}'; exit $LASTEXITCODE`;
  const start = performance.now(),
    r = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], {
      encoding: 'utf8',
      timeout: 15000,
      windowsHide: true,
    });
  writeFileSync(
    join(directory, 'parent-receipt.json'),
    JSON.stringify(
      {
        command: ['powershell.exe', '-NoProfile', '-NonInteractive', '-Command', script],
        exit: r.status,
        signal: r.signal,
        error: r.error?.message,
        elapsedMonotonicMs: performance.now() - start,
        stdout: r.stdout,
        stderr: r.stderr,
        endOfAiTurnSurvival: 'NOT_EXERCISED',
        productionLiveOperation: 'NOT_RUN',
      },
      null,
      2,
    ),
  );
  assert.equal(r.status, 0, r.stderr);
  const proof = JSON.parse(readFileSync(join(directory, 'process-proof.json')));
  assert.equal(proof.children.length, 4);
  assert.deepEqual(
    proof.children.map((c) => c.exit),
    [3, 3, 3, 0],
  );
});
test('promoted collector/seal verifies full paired pages and rejects corruption, missing pages and partial seals', async () => {
  for (const mode of ['valid', 'corrupt', 'partial', 'missing']) {
    const dir = fresh('collector-' + mode),
      environment = join(dir, 'env'),
      snapshot = join(dir, 'snapshot'),
      archive = join(dir, 'archive');
    mkdirSync(join(environment, 'input'), { recursive: true });
    mkdirSync(snapshot);
    const plan = {
      run: randomUUID(),
      milestones: ['20'],
      profile: { ethereum: [{ id: 'a' }, { id: 'b' }] },
    };
    const pin = { header: { number: '20' }, revision: '2' },
      start = Date.now(),
      deadline = start + 100000;
    const state = {
      digest: digest(plan),
      start,
      deadline,
      segment: { number: 1, ended: start },
      status: 'complete',
      phase: 'complete',
      milestone: 1,
      accepted: pin,
      audited: pin,
      canonicalAtPause: 'same',
      terminal: true,
    };
    const host = {
      digest: state.digest,
      start,
      deadline,
      segments: 1,
      pending: false,
      terminal: true,
    };
    const put = (p, v) => writeFileSync(p, JSON.stringify(v));
    put(join(environment, 'input/plan.json'), plan);
    put(join(environment, 'reconstruction-host.json'), host);
    put(join(environment, 'reconstruction-host-result.json'), { ...host, result: { status: 0 } });
    writeFileSync(join(environment, 'reconstruction-output.log'), 'synthetic complete');
    put(join(snapshot, 'reconstruction.json'), { ...state, checksum: digest(state) });
    const address = '0x' + '1'.repeat(40),
      pages = ['a', 'b'].map((source) => ({
        source,
        offset: 0,
        rows: [{ address, expected: '0', observed: '0' }],
      }));
    let commitment = digest([]);
    for (const page of pages) commitment = digest({ prior: commitment, page });
    const text = pages.map((p) => JSON.stringify(p) + '\n').join('');
    put(join(snapshot, 'audit-result.json'), {
      unchanged: true,
      before: 'same',
      after: 'same',
      count: 1,
      coverage: {
        bytes: Buffer.byteLength(text),
        commitment,
        sources: ['a', 'b'].map((source) => ({ source, count: 1, after: address, pages: 1 })),
      },
    });
    if (mode !== 'missing')
      writeFileSync(
        join(snapshot, 'comparisons.jsonl'),
        mode === 'corrupt' ? text.replace('"observed":"0"', '"observed":"1"') : text,
      );
    if (mode === 'partial') mkdirSync(join(archive, 'segment-00001'), { recursive: true });
    if (mode === 'valid') {
      assert.equal((await collect(environment, snapshot, archive)).status, 'SEALED');
      await verify(join(archive, 'milestone-20'));
      const manifestPath = join(archive, 'milestone-20', 'manifest.json');
      const manifest = JSON.parse(readFileSync(manifestPath));
      manifest.files = {};
      writeFileSync(manifestPath, JSON.stringify(manifest));
      await assert.rejects(verify(join(archive, 'milestone-20')), /inventory/);
    } else await assert.rejects(collect(environment, snapshot, archive));
  }
});
