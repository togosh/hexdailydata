import assert from 'node:assert/strict';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import {
  ReconstructionClock,
  reconstructionCooldown,
} from '../../dist/operator/reconstruction-clock.js';
import { ReconstructionSession } from '../../dist/operator/reconstruction-state.js';
import { seeded, newPlan, clockAt, executeBulk, fixture, json, save, admin } from './fixture.mjs';

function clockPair(epoch) {
  const raw = { wall: epoch, mono: 50000000000n };
  const clock = new ReconstructionClock({
    wall: () => raw.wall,
    monotonic: () => raw.mono,
    sleep: async (ms, signal) => {
      signal.throwIfAborted();
      raw.wall += ms;
      raw.mono += BigInt(ms) * 1000000n;
    },
  });
  return { raw, clock };
}
export async function clockSqlTests({ root, test, reset, semantic }) {
  await test('production SQL streamed wall adjustment preserves exact semantic state; invalid clock settles charges without partial commit', async () => {
    let expected;
    const receipts = [];
    for (const mode of [
      'control',
      'rollback',
      'stream-invalid',
      'cleanup-invalid',
      'reservation-invalid',
      'settlement-invalid',
      'ack-invalid',
      'final-invalid',
    ]) {
      await reset();
      const seedClock = clockAt(),
        prior = await seeded(root, seedClock),
        p = await newPlan(root, prior, { target: '357', milestones: ['357'] });
      const { raw, clock } = clockPair(seedClock.now() + 1000),
        f = fixture(p, clock);
      await executeBulk(p, 'prepare', clock);
      let changed = false;
      const fault = () => {
        if (!changed) {
          changed = true;
          raw.wall = mode === 'rollback' ? raw.wall - 1 : NaN;
          raw.mono += 1000000n;
        }
      };
      const transport = (endpoint) => {
        const underlying = f.transport(endpoint);
        return async (...args) => {
          const response = await underlying(...args),
            header = JSON.parse(args[0]).some((c) => c.method === 'eth_getBlockByNumber');
          return {
            ...response,
            body: (async function* () {
              for await (const chunk of response.body) {
                if (header && ['rollback', 'stream-invalid'].includes(mode)) fault();
                yield chunk;
              }
            })(),
            close: async () => {
              await response.close?.();
              if (header && mode === 'cleanup-invalid') fault();
            },
          };
        };
      };
      const hooks = mode === 'ack-invalid' ? { afterCommit: async () => fault() } : {};
      const sessionHooks = {
        ...(mode === 'reservation-invalid' ? { beforeDispatch: async () => fault() } : {}),
        ...(mode === 'settlement-invalid' ? { beforeSettlement: async () => fault() } : {}),
        ...(mode === 'final-invalid' ? { beforeFinalSave: async () => fault() } : {}),
      };
      const state = await executeBulk(p, 'run', clock, {
        fixture: f,
        transport,
        hooks,
        sessionHooks,
      });
      const sql = await admin(
        async (c) =>
          (await c.query('SELECT block_number,revision FROM hdd.sync_state WHERE chain_id=1'))
            .rows[0],
      );
      assert.equal(state.pending, false);
      assert.equal(state.accepted.header.number, sql.block_number);
      assert.equal(state.accepted.revision, sql.revision);
      assert.equal(state.pendingSql, null);
      const disk = await json(p.storagePath + '/reconstruction.json');
      assert.equal(disk.chargedBytes, state.chargedBytes);
      assert.equal(disk.terminal, true);
      if (['control', 'rollback'].includes(mode)) {
        assert.equal(state.status, 'complete', JSON.stringify(state));
        const actual = await semantic();
        if (!expected) expected = actual;
        else assert.deepEqual(actual, expected);
        assert.equal(
          state.observedBytes,
          f.attempts.reduce((n, a) => n + a.bytes, 0),
        );
        assert.equal(state.chargedBytes, state.observedBytes);
        if (mode === 'rollback') assert.equal(state.clockDiagnostic.anomalies.count, 1);
      } else {
        assert.equal(state.status, 'blocked', JSON.stringify(state));
        assert.match(state.reason, /clock/);
        assert.equal(state.clockDiagnostic.anomalies.last.rawWall.value, 'NaN');
        assert.equal(disk.clockDiagnostic.anomalies.last.rawWall.value, 'NaN');
        assert.equal(state.lastEnded, null);
        if (!['ack-invalid', 'final-invalid'].includes(mode)) {
          assert.equal(sql.block_number, p.admission.checkpoint.number);
          assert.equal(state.audited, null);
          assert.equal(
            state.chargedBytes,
            mode === 'reservation-invalid'
              ? 8388608
              : mode === 'cleanup-invalid'
                ? state.observedBytes
                : 8388608,
          );
        }
        const immutable = await readFile(p.storagePath + '/reconstruction.json');
        const refusal = clockPair(state.highWater + 1000).clock,
          unused = fixture(p, refusal);
        await assert.rejects(
          executeBulk(p, 'resume', refusal, { fixture: unused }),
          /cannot run\/resume/,
        );
        assert.equal(unused.attempts.length, 0);
        assert.deepEqual(await readFile(p.storagePath + '/reconstruction.json'), immutable);
      }
      receipts.push({ mode, state, sql, attempts: f.attempts });
    }
    await save('clock-sql-faults', receipts);
  });
  await test('fresh process continuity preserves original deadline/counters; cooldown duration survives new origins', async () => {
    await reset();
    const seed = clockAt(),
      prior = await seeded(root, seed),
      p = await newPlan(root, prior, { target: '357', milestones: ['356', '357'] });
    const first = clockPair(seed.now() + 1000);
    await executeBulk(p, 'prepare', first.clock);
    const paused = await executeBulk(p, 'run', first.clock);
    assert.equal(paused.status, 'paused');
    const before = await readFile(p.storagePath + '/reconstruction.json');
    const invalid = clockPair(paused.highWater - 1);
    invalid.raw.mono = 99999999999999999n;
    const unused = fixture(p, invalid.clock);
    await assert.rejects(
      executeBulk(p, 'resume', invalid.clock, { fixture: unused }),
      /continuity/,
    );
    assert.equal(unused.attempts.length, 0);
    assert.deepEqual(await readFile(p.storagePath + '/reconstruction.json'), before);
    const valid = clockPair(paused.highWater + 1000);
    valid.raw.mono = 1n;
    const complete = await executeBulk(p, 'resume', valid.clock);
    assert.equal(complete.status, 'complete');
    assert.equal(complete.start, paused.start);
    assert.equal(complete.deadline, paused.deadline);
    assert(complete.http > paused.http);
    const quota = root + '/cooldown-' + randomUUID();
    await mkdir(quota);
    const c1 = clockPair(1800000000000),
      store = await reconstructionCooldown(quota, c1.clock);
    await store.extend(c1.clock.waitNow() + 120000);
    c1.raw.wall += 60000;
    c1.clock.now();
    c1.raw.wall -= 10000;
    assert((await store.read()) - c1.clock.waitNow() === 120000);
    const c2 = clockPair(1800000200000);
    c2.raw.mono = 1n;
    const restart = await reconstructionCooldown(quota, c2.clock);
    assert.equal((await restart.read()) - c2.clock.waitNow(), 120000);
    await c2.clock.sleep(120000, new AbortController().signal);
    await restart.read();
    assert.equal((await json(quota + '/reconstruction-cooldown.json')).milliseconds, 0);
    await writeFile(quota + '/reconstruction-cooldown.json', '{"version":1,"milliseconds":-1}');
    await assert.rejects(reconstructionCooldown(quota, c2.clock), /Invalid/);
    await save('clock-restart', {
      paused,
      complete,
      refusedAttempts: unused.attempts.length,
      cooldownReimposedMs: 120000,
    });
  });
}
