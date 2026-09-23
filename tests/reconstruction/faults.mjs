import assert from 'node:assert/strict';
import { readFile, writeFile, appendFile, truncate, rename, mkdir } from 'node:fs/promises';
import fs from 'node:fs/promises';
import { syncBuiltinESMExports } from 'node:module';
import { randomUUID } from 'node:crypto';
import {
  ReconstructionSession,
  ReconstructionPause,
  cadence,
} from '../../dist/operator/reconstruction-state.js';
import { RpcClient } from '../../dist/providers/rpc.js';
import { ProviderBudget } from '../../dist/providers/budget.js';
import { cooldownFiles } from '../../dist/providers/cooldown.js';
import { maintenanceLease } from '../../dist/operator/lease.js';
import { digest } from '../../dist/services/projections/input.js';
import {
  admin,
  seeded,
  newPlan,
  clockAt,
  executeBulk,
  fixture,
  json,
  save,
  inputs,
} from './fixture.mjs';

export async function faultTests({ root, test, reset, child }) {
  await test('terminal writer acknowledgement reconciles committed or rolled-back SQL and labels unavailable SQL uncertain', async () => {
    const outcomes = [];
    for (const kind of ['committed', 'rolled-back', 'reader-loss']) {
      await reset();
      const clock = clockAt(),
        prior = await seeded(root, clock),
        p = await newPlan(root, prior, { target: '611', milestones: ['611'] }),
        f = fixture(p, clock);
      await executeBulk(p, 'prepare', clock);
      let attemptsAtFailure;
      const reason = 'Synthetic writer acknowledgement failure: ' + kind;
      const fault = async () => {
        attemptsAtFailure = f.attempts.length;
        if (kind === 'reader-loss')
          await admin((c) =>
            c.query(
              "SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname=current_database() AND usename='hdd_v2_api'",
            ),
          );
        throw Error(reason);
      };
      const state = await executeBulk(p, 'run', clock, {
        fixture: f,
        hooks: kind === 'rolled-back' ? { beforeCommit: fault } : { afterCommit: fault },
      });
      const sql = await admin(
        async (c) =>
          (
            await c.query(
              "SELECT block_number,revision,encode(block_hash,'hex') block_hash FROM hdd.sync_state WHERE chain_id=1",
            )
          ).rows[0],
      );
      assert.equal(state.status, 'blocked');
      assert.equal(state.reason, reason);
      assert.equal(state.audited, null);
      assert.equal(state.milestone, 0);
      assert.equal(f.attempts.length, attemptsAtFailure, 'No dispatch after writer failure');
      assert.equal(sql.block_number, kind === 'rolled-back' ? '355' : '483');
      if (kind === 'reader-loss') {
        assert.equal(state.acceptedSqlUncertain, true);
        assert.equal(state.accepted.header.number, '355');
        assert.equal(state.pendingSql.next.header.number, sql.block_number);
        assert(
          state.secondary.some((message) => /Accepted SQL checkpoint uncertain/.test(message)),
        );
      } else {
        assert.equal(state.acceptedSqlUncertain, false);
        assert.equal(state.pendingSql, null);
        assert.equal(state.accepted.header.number, sql.block_number);
        assert.equal(state.accepted.header.hash, '0x' + sql.block_hash);
        assert.equal(state.accepted.revision, sql.revision);
      }
      const saved = await json(p.storagePath + '/reconstruction.json');
      assert.deepEqual(saved.accepted, state.accepted);
      assert.deepEqual(saved.pendingSql, state.pendingSql);
      assert.equal(saved.reason, reason);
      const status = await executeBulk(p, 'status', clock);
      assert.equal(status.acceptedSqlUncertain, state.acceptedSqlUncertain);
      assert.deepEqual(status.accepted, state.accepted);
      const refused = fixture(p, clock);
      const beforeRefusal = await readFile(p.storagePath + '/reconstruction.json');
      for (const action of ['run', 'resume'])
        await assert.rejects(
          executeBulk(p, action, clock, { fixture: refused }),
          /Operation cannot run\/resume/,
        );
      const afterRefusal = await readFile(p.storagePath + '/reconstruction.json');
      assert.deepEqual(
        afterRefusal,
        beforeRefusal,
        'Refusal must preserve the entire saved record',
      );
      assert.equal(refused.attempts.length, 0);
      outcomes.push({
        kind,
        state,
        saved,
        status,
        sql,
        attempts: f.attempts,
        refusal: { before: beforeRefusal.toString(), after: afterRefusal.toString() },
      });
    }
    await save('writer-acknowledgement', outcomes);
  });
  await test('cumulative limits, retries, cooldown, rollback, deadline and unsettled reservation remain fail closed', async () => {
    await reset();
    const clock = clockAt(),
      prior = await seeded(root, clock),
      receipts = [];
    for (const kind of [
      'http',
      'logical',
      'bytes',
      'retry',
      'cooldown',
      'deadline',
      'rollback',
      'pending',
      'settlement',
      'late-wake',
    ]) {
      const p = await newPlan(root, prior, {
        caps: {
          milliseconds: 86400000,
          http: kind === 'http' || kind === 'retry' ? 2 : 100,
          logical: kind === 'logical' ? 2 : 1000,
          bytes: kind === 'bytes' ? 8388612 : 268435456,
          responseBytes: 4194304,
        },
        segment: { milliseconds: 3600000, http: 1, logical: 12000, bytes: 268435456 },
      });
      const s = await ReconstructionSession.prepare(p, clock);
      await s.start(false, clock.now());
      const attempts = [];
      const scope = { request() {}, response() {} };
      const transport = async (body) => {
        const calls = JSON.parse(body);
        attempts.push({ at: clock.now(), logical: calls.length });
        const b = Buffer.from(
          JSON.stringify(calls.map((c) => ({ id: c.id, jsonrpc: '2.0', result: '0x171' }))),
        );
        if (kind === 'pending')
          process.emitWarning('Synthetic pending record examined without dispatch recovery');
        return {
          status: kind === 'retry' ? 503 : kind === 'cooldown' ? 429 : 200,
          retryAfter: kind === 'cooldown' ? '120' : null,
          body: (async function* () {
            yield b;
          })(),
        };
      };
      const invoke = async (session) => {
        const budget = new ProviderBudget('worker', await cooldownFiles(p.quotaPath, 'worker'), {
          now: () => session.time(),
          sleep: (ms, signal) => clock.sleep(ms, signal),
        });
        const rpc = new RpcClient(
          'fixture',
          'operator',
          369,
          p.profile.contract,
          session.gate.transport(
            1,
            transport,
            'fixture',
            scope,
            cadence,
            session.state.segment.started + 60000,
          ),
          budget,
        );
        return rpc.call('eth_chainId', [], session.controller.signal);
      };
      let first;
      if (kind === 'deadline') clock.time = s.state.deadline;
      if (kind === 'rollback') clock.time = s.state.highWater - 1;
      if (kind === 'settlement')
        s.hooks.beforeSettlement = async () => {
          s.save = async () => {
            s.stop('Injected settlement save failure');
            throw Error('Injected persistence failure');
          };
        };
      if (kind === 'late-wake')
        s.hooks.beforeDispatch = async () => {
          clock.time += 16000;
        };
      try {
        first = await invoke(s);
      } catch (e) {
        first = e.message;
      }
      await s.close();
      if (kind === 'rollback') clock.time = s.state.highWater;
      if (kind === 'pending') {
        const disk = await json(p.storagePath + '/reconstruction.json');
        delete disk.checksum;
        disk.pending = true;
        disk.chargedBytes += 8388608;
        await writeFile(
          p.storagePath + '/reconstruction.json',
          JSON.stringify({ ...disk, checksum: digest(disk) }),
        );
        const restored = await ReconstructionSession.load(p, clock);
        await assert.rejects(restored.start(true, clock.now()), /outstanding/);
        assert.equal(attempts.length, 1);
      } else if (['http', 'logical', 'bytes', 'retry', 'cooldown'].includes(kind)) {
        s.state.status = 'paused';
        s.state.lastEnded = clock.now();
        await s.save();
        const original = {
          start: s.state.start,
          deadline: s.state.deadline,
          http: s.state.http,
          logical: s.state.logical,
          chargedBytes: s.state.chargedBytes,
        };
        clock.time += kind === 'cooldown' ? 10 : 3700000;
        const restored = await ReconstructionSession.load(p, clock);
        await restored.start(true, clock.now());
        let second;
        try {
          second = await invoke(restored);
        } catch (e) {
          second = e.message;
        }
        assert.equal(restored.state.start, original.start);
        assert.equal(restored.state.deadline, original.deadline);
        if (kind === 'http' || kind === 'logical') assert.equal(attempts.length, 2);
        if (kind === 'bytes') assert.equal(attempts.length, 1);
        if (kind === 'cooldown')
          assert(
            attempts[1].at - attempts[0].at >= 120000,
            'Retained Retry-After exceeds restart quarantine',
          );
        await restored.close();
        receipts.push({ kind, first, second, original, restored: restored.state, attempts });
      } else {
        if (['deadline', 'rollback', 'late-wake'].includes(kind)) assert.equal(attempts.length, 0);
        if (kind === 'settlement')
          assert((await json(p.storagePath + '/reconstruction.json')).pending);
        receipts.push({ kind, first, state: s.state, attempts });
      }
    }
    const expiredPlan = await newPlan(root, prior),
      expired = await ReconstructionSession.prepare(expiredPlan, clock);
    await expired.start(false, clock.now());
    await expired.close();
    expired.state.status = 'paused';
    await expired.save();
    clock.time = expired.state.deadline;
    const expiredResume = await ReconstructionSession.load(expiredPlan, clock);
    await assert.rejects(expiredResume.start(true, clock.now()), /expired/);
    await expiredResume.close();
    receipts.push({ kind: 'resume-at-original-expiry', state: expiredResume.state });
    await save('budget-faults', receipts);
  });
  await test('retained audit prefix rejects changed SQL and corrupt committed evidence before any external dispatch', async () => {
    const cases = [
      'balance',
      'added',
      'deleted',
      'revision',
      'hash',
      'source',
      'truncated',
      'duplicate',
      'position',
      'pin',
      'valid-tail',
      'mismatch',
    ];
    const outcomes = [];
    for (const kind of cases) {
      await reset();
      const clock = clockAt(),
        prior = await seeded(root, clock),
        p = await newPlan(root, prior, { target: '483', milestones: ['483'] });
      await executeBulk(p, 'prepare', clock);
      let r = await child(p, 'run', kind === 'mismatch' ? 'mismatch' : 'page-pause');
      if (kind === 'mismatch') {
        assert.equal(r.state.status, 'blocked');
        assert.equal(r.state.audit.sources[0].count, 0);
        outcomes.push({ kind, state: r.state });
        continue;
      }
      assert.equal(r.code, 3, JSON.stringify(r));
      const comparison = p.storagePath + '/comparisons.jsonl',
        before = await readFile(comparison, 'utf8');
      if (kind === 'balance')
        await admin((c) =>
          c.query(
            'UPDATE hdd.accounts SET liquid_hearts=liquid_hearts+1 WHERE address=(SELECT address FROM hdd.accounts ORDER BY address LIMIT 1)',
          ),
        );
      if (kind === 'added')
        await admin((c) =>
          c.query("INSERT INTO hdd.accounts VALUES(1,decode(repeat('ff',20),'hex'),0,0,0,0,0)"),
        );
      if (kind === 'deleted')
        await admin((c) => c.query('DELETE FROM hdd.accounts WHERE liquid_hearts=0'));
      if (kind === 'revision')
        await admin((c) => c.query('UPDATE hdd.sync_state SET revision=revision+1'));
      if (kind === 'hash')
        await admin((c) =>
          c.query("UPDATE hdd.sync_state SET block_hash=decode(repeat('ff',32),'hex')"),
        );
      if (kind === 'source')
        await admin((c) =>
          c.query(
            "UPDATE hdd.source_history SET sources=jsonb_set(sources,'{providers,0,operator}','\"changed\"'::jsonb)",
          ),
        );
      if (kind === 'truncated') await truncate(comparison, 8);
      if (['duplicate', 'position', 'pin'].includes(kind)) {
        const lines = before.trim().split('\n').map(JSON.parse);
        if (kind === 'duplicate') lines[1] = structuredClone(lines[0]);
        if (kind === 'position') lines[0].offset = 1;
        if (kind === 'pin') lines[0].binding = 'f'.repeat(64);
        await writeFile(comparison, lines.map(JSON.stringify).join('\n') + '\n');
      }
      if (kind === 'valid-tail') await appendFile(comparison, before.split('\n')[0] + '\n');
      r = await child(p, 'resume');
      if (kind === 'valid-tail') {
        assert.equal(r.state.status, 'complete', r.state.reason);
        assert.equal((await readFile(comparison, 'utf8')).trim().split('\n').length, 4);
      } else {
        assert.equal(r.state.status, 'blocked', kind);
        assert.equal(r.attempts.length, 0, kind);
      }
      outcomes.push({ kind, state: r.state, attempts: r.attempts });
    }
    await save('audit-corruption', outcomes);
  });
  await test('fresh post-audit snapshot detects concurrent canonical drift and final-save expiry cannot PASS', async () => {
    const outcomes = [];
    for (const kind of ['fresh-snapshot', 'final-deadline']) {
      await reset();
      const clock = clockAt(),
        prior = await seeded(root, clock),
        p = await newPlan(root, prior, { target: '483', milestones: ['483'] });
      await executeBulk(p, 'prepare', clock);
      let changed = false;
      const state = await executeBulk(
        p,
        'run',
        clock,
        kind === 'fresh-snapshot'
          ? {
              auditHooks: {
                afterPage: async () => {
                  if (changed) return;
                  changed = true;
                  await admin((c) =>
                    c.query(
                      "INSERT INTO hdd.accounts VALUES(1,decode(repeat('fe',20),'hex'),0,0,0,0,0)",
                    ),
                  );
                },
              },
            }
          : {
              sessionHooks: {
                beforeFinalSave: async () => {
                  clock.time += 3600000;
                },
              },
            },
      );
      assert.equal(state.status, 'blocked', JSON.stringify(state));
      assert.notEqual(state.phase, 'complete');
      outcomes.push({ kind, state });
    }
    await save('audit-finalization', outcomes);
  });
  await test('disk reserves, exclusive files and SQL ownership terminal faults retain accepted checkpoint', async () => {
    await reset();
    const clock = clockAt(),
      prior = await seeded(root, clock),
      outcomes = [];
    for (const kind of ['absolute-space', 'percentage-space', 'filesystem', 'sql', 'hard-size']) {
      const p = await newPlan(root, prior),
        f = fixture(p, clock, kind);
      await executeBulk(p, 'prepare', clock);
      const original = fs.statfs;
      let fired = false;
      const options = {
        fixture: f,
        boundary: async () => {
          if (fired) return;
          fired = true;
          if (kind.endsWith('-space')) {
            fs.statfs = async () => ({
              bsize: 4096n,
              bavail: kind === 'absolute-space' ? 1n : 3000000n,
              blocks: kind === 'absolute-space' ? 2n : 20000000n,
            });
            syncBuiltinESMExports();
          }
          if (kind === 'filesystem') {
            await rename(p.storagePath + '/.maintenance.lock', p.storagePath + '/.old-lock');
            await writeFile(p.storagePath + '/.maintenance.lock', '');
          }
          if (kind === 'sql')
            await admin((c) =>
              c.query(
                "SELECT pg_terminate_backend(pid) FROM pg_locks WHERE locktype='advisory' AND classid=4242 AND objid=1 AND granted",
              ),
            );
        },
      };
      let state;
      try {
        state = await executeBulk(p, 'run', clock, options);
      } finally {
        fs.statfs = original;
        syncBuiltinESMExports();
      }
      assert.equal(state.status, 'blocked', JSON.stringify(state));
      assert.equal(state.accepted.header.number, '355');
      if (kind === 'hard-size') assert.equal(f.attempts.length, 1);
      else assert.equal(f.attempts.length, 0);
      outcomes.push({ kind, state, attempts: f.attempts });
    }
    const p = await newPlan(root, prior);
    await executeBulk(p, 'prepare', clock);
    const release = await maintenanceLease(
      [p.storagePath, p.quotaPath],
      new AbortController().signal,
    );
    try {
      await assert.rejects(executeBulk(p, 'run', clock), /already active/);
    } finally {
      await release();
    }
    await save('ownership-disk', outcomes);
  });
  await test('failed durable page-cursor save leaves no credit and blocks resume with its failure receipt', async () => {
    await reset();
    const clock = clockAt(),
      prior = await seeded(root, clock),
      p = await newPlan(root, prior, { target: '483', milestones: ['483'] });
    await executeBulk(p, 'prepare', clock);
    const original = fs.rename;
    let state;
    try {
      state = await executeBulk(p, 'run', clock, {
        auditHooks: {
          afterAppend: async () => {
            fs.rename = async (from, to) => {
              if (String(to).endsWith('/reconstruction.json'))
                throw Error('Injected state replacement failure');
              return original(from, to);
            };
            syncBuiltinESMExports();
          },
        },
      });
    } finally {
      fs.rename = original;
      syncBuiltinESMExports();
    }
    assert.equal(state.status, 'blocked');
    const persisted = await json(p.storagePath + '/reconstruction.json');
    assert.equal(persisted.audit.sources[0].count, 0);
    await assert.rejects(executeBulk(p, 'resume', clock), /failure marker/);
    await save('page-save-failure', {
      state,
      persisted,
      marker: await json(p.storagePath + '/blocked.json'),
    });
  });
}
