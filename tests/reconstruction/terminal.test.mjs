import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync, mkdirSync, unlinkSync, existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { collect } from '../../scripts/operator/reconstruction-collect.mjs';
import { verify } from '../../scripts/operator/reconstruction-seal.mjs';
import { coordinate } from '../../scripts/operator/reconstruction-job.mjs';
import { terminalFixture, saved, put } from './terminal-fixture.mjs';
const root = resolve(
  process.env.HDD_V2_TERMINAL_EVIDENCE ??
    'artifacts/task-10/clock-and-runner/correction-2/terminal',
);
mkdirSync(root, { recursive: true });
const fresh = (mode) => terminalFixture(join(root, mode + '-' + randomUUID()), mode);

test('real collector seals all six saved SQL clock-fault shapes without altering their records or granting resume', async () => {
  for (const { mode } of saved.cases.filter((c) => c.mode !== 'control')) {
    const f = fresh(mode);
    const before = readFileSync(join(f.snapshot, 'reconstruction.json'));
    const result = await collect(f.environment, f.snapshot, f.output);
    assert.equal(result.status, 'SEALED');
    assert.equal(result.resumeEligible, false);
    assert.equal(result.endingTime, 'UNKNOWN');
    assert.equal(result.classification, 'TERMINAL_EVIDENCE');
    await verify(result.destination);
    for (const name of [
      'reconstruction.json',
      'reconstruction-host.json',
      'reconstruction-host-result.json',
      'reconstruction-output.log',
    ]) {
      assert.deepEqual(
        readFileSync(join(result.destination, name)),
        readFileSync(join(name === 'reconstruction.json' ? f.snapshot : f.environment, name)),
      );
    }
    assert.deepEqual(readFileSync(join(result.destination, 'reconstruction.json')), before);
    assert.equal(f.state.segment.ended, null);
    assert.equal(f.state.lastEnded, null);
    assert.equal(existsSync(join(f.output, 'milestone-357')), mode === 'final-invalid');
    put(join(f.root, 'collection-result.json'), result);
    await assert.rejects(collect(f.environment, f.snapshot, f.output), /EEXIST/);
  }
});

test('coordinator snapshot -> real collector -> terminal return reports the stopped segment, advanced pin and original clock cause', async () => {
  for (const mode of ['stream-invalid', 'ack-invalid', 'final-invalid']) {
    const f = fresh(mode),
      result = await coordinate(f.options, f.adapter, f.clock);
    assert.equal(result.outcome, 'STOPPED_INCOMPLETE');
    assert.equal(f.launches(), 1);
    assert.equal(result.nativeOutcome.exit, 2);
    assert.equal(result.error, null);
    assert.equal(result.currentSegment.evidence, 'SEALED');
    assert.equal(result.lastSettled.segment, 1);
    assert.deepEqual(result.lastSettled.accepted, f.state.accepted);
    assert.equal(
      result.lastSettled.accepted.header.number,
      mode === 'stream-invalid' ? '355' : '357',
    );
    assert.equal(result.lastSettled.acceptedSqlUncertain, false);
    assert.equal(result.lastSettled.ended, null);
    assert.equal(result.primaryReason, f.state.reason);
    for (const key of ['http', 'logical', 'observedBytes', 'chargedBytes'])
      assert.equal(result.lastSettled.totals[key], f.state[key]);
    await assert.rejects(
      coordinate({ ...f.options, action: 'resume' }, f.adapter, f.clock),
      /clean paused/,
    );
    assert.equal(f.launches(), 1);
  }
});

test('pending SQL/attempts and additional host uncertainty remain uncertain even when terminal evidence seals', async () => {
  for (const mode of ['sql', 'attempt', 'host']) {
    const f = fresh('ack-invalid');
    if (mode === 'sql') {
      f.state.pendingSql = {
        previous: saved.cases[1].state.accepted,
        next: f.state.accepted,
        batchDigest: '0'.repeat(64),
      };
      f.state.accepted = structuredClone(f.state.pendingSql.previous);
    }
    if (mode === 'attempt') f.state.pending = true;
    if (mode === 'host')
      f.hostResult.result = {
        status: 2,
        nativeStatus: 2,
        error: 'Synthetic secondary host clock failure',
      };
    f.save();
    const result = await coordinate(f.options, f.adapter, f.clock);
    assert.equal(result.outcome, 'STOPPED_UNCERTAIN');
    assert.equal(f.launches(), 1);
    assert.equal(result.currentSegment.evidence, 'SEALED');
    assert.equal(result.primaryReason, f.state.reason);
    assert.equal(result.lastSettled.collection.resumeEligible, false);
    if (mode === 'sql') {
      assert.equal(result.lastSettled.accepted, null);
      assert.equal(result.lastSettled.acceptedSqlUncertain, true);
      assert.deepEqual(result.lastSettled.pendingSql, f.state.pendingSql);
    }
  }
});

test('untrusted current evidence is labelled separately from preceding progress and preserves the reported primary cause', async () => {
  for (const mode of ['checksum', 'host-pending', 'missing-log']) {
    const f = fresh('ack-invalid');
    if (mode === 'checksum') {
      const p = join(f.snapshot, 'reconstruction.json');
      const data = JSON.parse(readFileSync(p));
      data.checksum = '0'.repeat(64);
      put(p, data);
    }
    if (mode === 'host-pending') {
      f.host.pending = true;
      f.save();
    }
    if (mode === 'missing-log') unlinkSync(join(f.environment, 'reconstruction-output.log'));
    const result = await coordinate(f.options, f.adapter, f.clock);
    assert.equal(result.outcome, 'STOPPED_UNCERTAIN');
    assert.equal(f.launches(), 1);
    assert.equal(result.currentSegment.evidence, 'UNVERIFIED');
    assert.equal(result.currentSegment.reported.accepted.header.number, '357');
    assert.equal(result.lastSettled.accepted.header.number, '355');
    assert.equal(result.primaryReason, f.state.reason);
    assert.equal(result.primaryReasonEvidence, 'UNVERIFIED');
    assert(result.error);
  }
});

test('null-end exception refuses unexplained/running/malformed/unsettled/binding-invalid records', async () => {
  const cases = {
    paused: (f) => {
      f.state.status = 'paused';
      f.state.terminal = false;
    },
    running: (f) => {
      f.state.status = 'running';
    },
    unexplained: (f) => {
      delete f.state.clockDiagnostic;
    },
    malformed: (f) => {
      f.state.chargedBytes = -1;
    },
    'missing-ended': (f) => {
      delete f.state.segment.ended;
    },
    'missing-reason': (f) => {
      f.state.reason = '';
    },
    'host-pending': (f) => {
      f.host.pending = true;
    },
    'result-pending': (f) => {
      f.hostResult.pending = true;
    },
    'host-nonterminal': (f) => {
      f.host.terminal = false;
    },
    'native-unsettled': (f) => {
      f.hostResult.result.status = null;
    },
    'native-unknown': (f) => {
      f.hostResult.result.nativeStatus = null;
    },
    'native-signal': (f) => {
      f.hostResult.result.signal = 'SIGTERM';
    },
    'native-pause': (f) => {
      f.hostResult.result.status = 3;
    },
    binding: (f) => {
      f.hostResult.digest = '0'.repeat(64);
    },
    lock: (f) => {
      writeFileSync(join(f.environment, '.reconstruction-host.lock'), 'owned');
    },
  };
  for (const [name, corrupt] of Object.entries(cases)) {
    const f = fresh('stream-invalid');
    corrupt(f);
    f.save();
    await assert.rejects(collect(f.environment, f.snapshot, f.output), name);
    assert.equal(existsSync(join(f.output, 'segment-00001/manifest.json')), false);
    put(join(f.root, 'negative.json'), { name, refused: true });
  }
});

test('terminal partial prefixes are sealed only as partial; corrupt or missing complete comparisons still refuse', async () => {
  const f = fresh('stream-invalid');
  f.state.phase = 'audit';
  f.state.audit = {
    pin: f.state.accepted,
    canonical: '1'.repeat(64),
    schema: '2'.repeat(64),
    inventory: '3'.repeat(64),
    binding: '4'.repeat(64),
    count: 1,
    sources: ['a', 'b'].map((source) => ({ source, count: 0, after: null, pages: 0 })),
    bytes: 0,
    commitment: '5'.repeat(64),
    finalizing: false,
  };
  f.save();
  const partial = '{"incomplete":';
  writeFileSync(join(f.snapshot, 'comparisons-PARTIAL.jsonl'), partial);
  put(join(f.snapshot, 'PARTIAL.json'), {
    classification: 'PARTIAL_NOT_A_COMPLETED_AUDIT',
    audit: f.state.audit,
  });
  const collected = await collect(f.environment, f.snapshot, f.output);
  await verify(collected.destination);
  assert.equal(
    readFileSync(join(collected.destination, 'comparisons-partial.jsonl'), 'utf8'),
    partial,
  );
  assert.equal(existsSync(join(f.output, 'milestone-357')), false);
  assert.equal(collected.resumeEligible, false);
  for (const mode of ['corrupt', 'missing', 'unknown-canonical', 'partial-label']) {
    const g = fresh('final-invalid');
    if (mode === 'corrupt') writeFileSync(join(g.snapshot, 'comparisons.jsonl'), '{}\n');
    if (mode === 'missing') unlinkSync(join(g.snapshot, 'audit-result.json'));
    if (mode === 'unknown-canonical') {
      g.state.canonicalAtPause = null;
      g.save();
    }
    if (mode === 'partial-label') {
      g.state.audit = f.state.audit;
      g.save();
      put(join(g.snapshot, 'PARTIAL.json'), { classification: 'COMPLETE', audit: g.state.audit });
    }
    await assert.rejects(collect(g.environment, g.snapshot, g.output));
    assert.equal(existsSync(join(g.output, 'milestone-357/manifest.json')), false);
  }
});

test('real collector still reports normal completion and clean pause with their actual native outcomes', async () => {
  for (const mode of ['complete', 'pause']) {
    const f = fresh('control');
    if (mode === 'pause') {
      f.state.status = 'paused';
      f.state.terminal = false;
      f.state.phase = 'milestone-audited';
      f.host.terminal = false;
      f.hostResult.terminal = false;
      f.hostResult.result.status = 3;
      f.save();
      f.options.stopAt = '357';
    }
    const result = await coordinate(f.options, f.adapter, f.clock);
    assert.equal(
      result.outcome,
      mode === 'complete' ? 'SCOPED_INTERVAL_COMPLETE' : 'PAUSED_AFTER_MILESTONE',
    );
    assert.equal(result.nativeOutcome.exit, mode === 'complete' ? 0 : 3);
    assert.equal(f.launches(), 1);
    assert.equal(result.lastSettled.collection.resumeEligible, mode === 'pause');
  }
});
