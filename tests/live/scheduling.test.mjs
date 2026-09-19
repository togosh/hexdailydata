import test from 'node:test';
import assert from 'node:assert/strict';
import { MetricsJob, runWorkerLifecycle } from '../../src/worker/lifecycle.ts';
import { MetricsService } from '../../src/worker/metrics/service.ts';
import { PriceReader } from '../../src/services/live/price.ts';
import { AddressService } from '../../src/services/live/address.ts';
import { ProviderBudget } from '../../src/providers/budget.ts';
import { RpcClient } from '../../src/providers/rpc.ts';
import {
  fixture,
  ManualClock,
  SequentialClock,
  MemoryMetrics,
  emptyBaseline,
  signal,
  HEX,
  CODE_HASH,
  A,
  addr,
  cooldown,
} from './fixture.mjs';

export function assertWork(attempts, roleFor) {
  const sorted = [...attempts].sort((a, b) => a.at - b.at);
  for (let i = 1; i < sorted.length; i++) assert.ok(sorted[i].at - sorted[i - 1].at >= 2000);
  for (const end of sorted) {
    const window = sorted.filter((x) => x.at > end.at - 60000 && x.at <= end.at);
    assert.ok(window.length <= 30);
    assert.ok(window.reduce((n, x) => n + x.calls, 0) <= 900);
    for (const [lane, http, logical] of [
      ['address', 12, 360],
      ['metrics', 6, 180],
      ['sync', 12, 360],
    ]) {
      const rows = window.filter((x) => roleFor(x) === lane);
      assert.ok(rows.length <= http);
      assert.ok(rows.reduce((n, x) => n + x.calls, 0) <= logical);
    }
  }
}
test('actual metrics lifecycle progresses while sync lane stays busy; one shared timeline, bounded ticks and actual counts', async () => {
  const clock = new ManualClock(),
    f = fixture({ clock }),
    store = new MemoryMetrics();
  const primary = f.rpc('metrics-a'),
    secondary = f.rpc('metrics-b'),
    sync = f.rpc('sync'),
    api = f.rpc('api', f.api);
  const metrics = new MetricsService(
    [primary, secondary],
    CODE_HASH,
    new PriceReader(f.price, HEX),
    store,
  );
  const job = new MetricsJob(clock, (s) => metrics.tick(s)),
    stop = new AbortController();
  const live = new AddressService(api, CODE_HASH, emptyBaseline);
  let syncSteps = 0;
  const lifecycle = runWorkerLifecycle(
    async (s) => {
      while (!s.aborted) {
        await sync.calls([{ method: 'eth_chainId', params: [] }], s, clock.now() + 600000);
        syncSteps++;
      }
    },
    job,
    stop.signal,
  );
  const completion = lifecycle.catch((e) => {
    assert.ok(stop.signal.aborted);
  });
  await clock.advance(125000);
  const updates = metrics.counters.updates;
  assert.ok(updates >= 4);
  assert.ok(store.rows.price.value);
  assert.ok(syncSteps > 4);
  const request = live.get(A, signal, 3);
  const result = await clock.drive(request, 10000);
  assert.ok(result.live || result.outcome === 'quota');
  await clock.advance(120000);
  stop.abort(new Error('shutdown'));
  await completion;
  assert.ok(metrics.counters.updates > updates);
  assert.equal(f.peak, 1);
  assert.equal(
    primary.counters.requests + secondary.counters.requests + sync.counters.requests,
    f.worker.counters.attempts,
  );
  assert.equal(f.attempts.length, f.worker.counters.attempts + f.api.counters.attempts);
  assert.equal(
    f.attempts.reduce((n, x) => n + x.calls, 0),
    f.worker.counters.logical + f.api.counters.logical,
  );
  assertWork(f.attempts, (x) =>
    x.id === 'api' ? 'address' : x.id === 'sync' ? 'sync' : 'metrics',
  );
  assert.ok(job.counters.coalesced <= 1);
  console.log(
    'SCHEDULED_WORKLOAD ' +
      JSON.stringify({
        syncSteps,
        metrics: metrics.counters,
        job: job.counters,
        worker: f.worker.counters,
        api: f.api.counters,
        virtualMs: clock.now() - 1575331200000 - 400 * 86400000,
      }),
  );
});
test('slow scheduled ticks coalesce once, reject duplicate start and stop pending work', async () => {
  const clock = new ManualClock(),
    stop = new AbortController();
  let starts = 0;
  const job = new MetricsJob(clock, async (s) => {
    starts++;
    await clock.sleep(150000, s);
  });
  const run = job.run(stop.signal);
  await assert.rejects(() => job.run(stop.signal), /already started/);
  await clock.advance(149000);
  assert.equal(starts, 1);
  assert.equal(job.counters.coalesced, 2);
  await clock.advance(2000);
  assert.equal(starts, 2);
  stop.abort();
  await run;
  assert.equal(starts, 2);
  assert.equal(clock.waits.length, 0);
});

test('watch preserves native failure without retries while real metrics keep progressing', async () => {
  const clock = new ManualClock(),
    f = fixture({ clock }),
    store = new MemoryMetrics();
  const metrics = new MetricsService(
    [f.rpc('a'), f.rpc('b')],
    CODE_HASH,
    new PriceReader(f.price, HEX),
    store,
  );
  const stop = new AbortController();
  let nativeAttempts = 0;
  const job = runWorkerLifecycle(
    async () => {
      nativeAttempts++;
      throw new Error('native conflict witness');
    },
    new MetricsJob(clock, (s) => metrics.tick(s)),
    stop.signal,
    true,
  );
  const rejected = assert.rejects(job, /native conflict witness/);
  await clock.advance(185000);
  assert.ok(metrics.counters.updates >= 8);
  assert.equal(nativeAttempts, 1);
  assert.ok(store.rows.price.value);
  stop.abort();
  await rejected;
});
test('address request reservations charge retries/aliases, hard physical and logical cap, no deadline renewal', async () => {
  const clock = new SequentialClock(),
    store = cooldown(),
    budget = new ProviderBudget('api', store, clock);
  clock.time = Math.ceil((clock.time + 60000) / 10500) * 10500;
  const request = await budget.addressRequest(clock.now() + 10000, 1, signal);
  let attempts = 0;
  const transport = async (body) => {
    attempts++;
    return {
      status: 200,
      retryAfter: null,
      body: (async function* () {
        yield Buffer.from(
          JSON.stringify(
            JSON.parse(body).map((r) => ({ jsonrpc: '2.0', id: r.id, result: '0x171' })),
          ),
        );
      })(),
    };
  };
  const rpc = new RpcClient('alias-a', null, 369, HEX, transport, budget),
    other = new RpcClient('alias-b', null, 369, HEX, transport, budget);
  await rpc.calls([{ method: 'eth_chainId', params: [] }], signal, request.deadline, 'address', {
    request,
  });
  await other.calls([{ method: 'eth_chainId', params: [] }], signal, request.deadline, 'address', {
    request,
  });
  await assert.rejects(
    () =>
      rpc.calls([{ method: 'eth_chainId', params: [] }], signal, request.deadline + 1, 'address', {
        request,
      }),
    /renewed/,
  );
  request.close();
  assert.equal(attempts, 2);
  clock.time = Math.ceil((clock.time + 60000) / 10500) * 10500;
  const capped = await budget.addressRequest(clock.now() + 10000, 1, signal);
  for (let i = 0; i < 4; i++) capped.charge(1);
  assert.throws(() => capped.charge(1), /cap/);
  capped.close();
  const logical = await budget.addressRequest(clock.now() + 10000, 1, signal);
  logical.charge(100);
  assert.throws(() => logical.charge(29), /cap/);
  logical.close();
});
test('429 retries preserve bytes and charges, fail within original request deadline; same account cooldown blocks alias', async () => {
  const f = fixture();
  f.clock.time = Math.ceil((f.clock.time + 60000) / 10500) * 10500;
  const rpc = f.rpc('api', f.api),
    service = new AddressService(rpc, CODE_HASH, emptyBaseline);
  f.state.fail = () => 429;
  const r = await service.get(A, signal);
  assert.equal(r.outcome, 'quota');
  assert.equal(rpc.counters.requests, 1);
  assert.ok(rpc.counters.bytes > 0);
  const alias = new AddressService(f.rpc('alias', f.api), CODE_HASH, emptyBaseline);
  assert.equal((await alias.get(addr(200), signal)).outcome, 'quota');
  assert.equal(f.attempts.length, 1);
});

test('public deadline includes delayed ID lookup; baseline timeout and dispatched cancellation use real wall time', async () => {
  const f = fixture();
  f.clock.time = Math.ceil((f.clock.time + 60000) / 10500) * 10500;
  const rpc = f.rpc('api', f.api);
  const baseline = {
    async address() {
      return null;
    },
    async stake() {
      f.clock.time += 10001;
      return { address: A, lifecycle: 'unsettled', asOfBlock: '1' };
    },
  };
  const service = new AddressService(rpc, CODE_HASH, baseline);
  assert.equal((await service.stake('1', signal)).outcome, 'quota');
  assert.equal(rpc.counters.requests, 0);
  const hanging = new AddressService(rpc, CODE_HASH, {
    ...baseline,
    address: () => new Promise(() => {}),
  });
  const start = performance.now();
  const r = await hanging.get(A, signal, 3, undefined, f.clock.now() + 25);
  assert.equal(r.outcome, 'quota');
  assert.ok(performance.now() - start < 1000);
  f.clock.time = Math.ceil(f.clock.now() / 10500) * 10500;
  const stop = new AbortController();
  f.state.delay = (s) =>
    new Promise((resolve, reject) =>
      s.addEventListener('abort', () => reject(s.reason), { once: true }),
    );
  const request = service.get(A, stop.signal, 3);
  const rejected = assert.rejects(request, /wall-clock/);
  setTimeout(() => stop.abort(new Error('wall-clock disconnect')), 25);
  await rejected;
  assert.equal(rpc.counters.requests, 1);
  assert.equal(f.api.counters.attempts, 1);
});
