import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { pathToFileURL } from 'node:url';
import { ReconstructionClock } from '../../dist/operator/reconstruction-clock.js';
import { jobFixture } from './job-fixture.mjs';

const root = resolve(process.env.HDD_V2_BOUNDARY_EVIDENCE);
mkdirSync(root, { recursive: true });
const baseline = process.env.HDD_V2_BOUNDARY_BASELINE === '1';
const { coordinate } =
  baseline && process.env.HDD_V2_BOUNDARY_ORIGINAL
    ? await import(pathToFileURL(resolve(process.env.HDD_V2_BOUNDARY_ORIGINAL)))
    : await import('../../scripts/operator/reconstruction-job.mjs');
export function fakeClock(wall = 1790520899789) {
  const raw = { wall, mono: 0n, sleeps: [], step: null };
  const clock = new ReconstructionClock({
    wall: () => raw.wall,
    monotonic: () => raw.mono,
    sleep: async (ms, signal) => {
      signal.throwIfAborted();
      raw.sleeps.push(ms);
      if (raw.step) raw.step(ms);
      else {
        raw.wall += ms;
        raw.mono += BigInt(ms) * 1000000n;
      }
    },
  });
  return { raw, clock };
}

test('actual coordinate reproduces the post-seal handoff, including the exact 186 ms gap', async () => {
  const receipts = [];
  for (const gap of [0, 1, 186, 2400]) {
    const f = jobFixture(join(root, 'handoff-' + gap + '-' + randomUUID()));
    const { raw, clock } = fakeClock();
    clock.now();
    raw.mono += 1999000000n; // Raw is unchanged: divergence does not require a backward sample.
    const floor = raw.wall + gap;
    const snapshot = f.adapter.snapshot;
    f.adapter.snapshot = async (...args) => {
      const result = await snapshot(...args);
      result.state.highWater = floor;
      return result;
    };
    f.adapter.boundary = async () => ({ normalSeal: true, highWater: floor });
    const launch = f.adapter.launch;
    f.adapter.launch = async (...args) => {
      if (args[1] === 2) {
        assert(raw.wall >= floor, 'No dispatch before actual raw reaches the floor');
        f.events.push('second-dispatch');
        throw Error('synthetic abrupt next-child failure');
      }
      return launch(...args);
    };
    const result = await coordinate(f.options, f.adapter, clock);
    if (baseline && gap > 0) {
      assert.equal(
        result.error,
        'Reconstruction clock invalid/unprovable: raw-continuity-below-durable-high-water',
      );
      assert(!f.events.includes('second-dispatch'));
      raw.wall += 10000;
      await assert.rejects(
        coordinate({ ...f.options, action: 'resume' }, f.adapter, fakeClock(raw.wall).clock),
        /clean paused/,
      );
    } else {
      assert.equal(result.error, 'synthetic abrupt next-child failure');
      assert(f.events.includes('second-dispatch'));
    }
    assert.equal(result.outcome, 'STOPPED_UNCERTAIN');
    receipts.push({ gap, result, clock: clock.snapshot(), sleeps: raw.sleeps, events: f.events });
  }
  writeFileSync(
    join(root, baseline ? 'ORIGINAL_FAILURE.json' : 'FIXED_HANDOFF.json'),
    JSON.stringify(receipts, null, 2),
  );
});

if (!baseline) {
  const { waitForRawBoundary } = await import('../../scripts/operator/reconstruction-boundary.mjs');
  test('raw boundary has no tolerance, bounded elapsed wait, sticky expiry and cancellable samples', async () => {
    for (const gap of [0, 1, 186, 4999, 5000]) {
      const { raw, clock } = fakeClock(10000);
      const result = await waitForRawBoundary(
        clock,
        10000 + gap,
        20000,
        new AbortController().signal,
      );
      assert(raw.wall >= 10000 + gap);
      assert(result.elapsedMs <= 5000);
      assert.equal(raw.sleeps.length, Math.ceil(gap / 50));
    }
    for (const mode of [
      'frozen-raw',
      'frozen-monotonic',
      'regressing-monotonic',
      'invalid-monotonic',
      'invalid-wall',
      'unsafe-wall',
      'expiry',
      'forward-expiry-rewind',
      'cancel',
      'oversleep',
    ]) {
      const { raw, clock } = fakeClock(10000);
      const abort = new AbortController();
      raw.step = (ms) => {
        raw.mono += BigInt(ms) * 1000000n;
        if (mode === 'frozen-monotonic') raw.mono = 0n;
        if (mode === 'regressing-monotonic') raw.mono = -1n;
        if (mode === 'invalid-monotonic') raw.mono = NaN;
        if (mode === 'invalid-wall') raw.wall = Infinity;
        if (mode === 'unsafe-wall') raw.wall = Number.MAX_SAFE_INTEGER + 1;
        if (mode === 'expiry') raw.wall = 11000;
        if (mode === 'forward-expiry-rewind') {
          raw.wall = 11000;
          clock.now();
          raw.wall = 10000;
        }
        if (mode === 'cancel') abort.abort(Error('fixture canceled'));
        if (mode === 'oversleep') {
          raw.mono += 5000000000n;
          raw.wall = 10200;
        }
      };
      await assert.rejects(
        waitForRawBoundary(clock, 10186, mode === 'frozen-raw' ? 30000 : 11000, abort.signal),
      );
      assert(raw.sleeps.length <= 100, mode);
    }
    const { raw, clock } = fakeClock(10000);
    assert.throws(() => clock.assertContinuity(10100));
    raw.wall = 20000;
    await assert.rejects(
      waitForRawBoundary(clock, 10100, 30000, new AbortController().signal),
      /raw-continuity/,
    );
  });
}
