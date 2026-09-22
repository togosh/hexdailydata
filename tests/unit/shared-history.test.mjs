import test from 'node:test';
import assert from 'node:assert/strict';
import { Source } from '../../src/providers/source.ts';
import { bindingSchema } from '../../src/providers/binding.ts';
import { profileSchema, profileBinding, profileSources } from '../../src/worker/sync/profile.ts';
import { ProviderBudget } from '../../src/providers/budget.ts';
import { SyncEngine } from '../../src/worker/sync/engine.ts';
import { fixture, FakeClock, memoryCooldown, hash } from '../sync/fixture.mjs';
import { sharedProfile } from '../sync/shared-profile.mjs';

const signal = new AbortController().signal;
function setup(mode = 'pulsechain', mutate) {
  const f = fixture({ last: 220 }),
    profile = profileSchema.parse(sharedProfile(mode));
  const clock = new FakeClock(),
    budget = new ProviderBudget('worker', memoryCooldown(), clock);
  const pair = profileSources(
    profile,
    1,
    (s) => f.source(mode === 'pulsechain' ? 369 : 1, s.id, clock, mutate, budget).rpc.transport,
    budget,
  );
  return { f, profile, pair, budget };
}
test('strict profile and binding: exact integer boundaries, only declared 369 to 1', () => {
  const good = sharedProfile();
  for (const edit of [
    (p) => delete p.fork.parent,
    (p) => (p.fork.parent.number = 180),
    (p) => (p.fork.parent.number = '9007199254740993.0'),
    (p) => (p.fork.entry.parentHash = hash(999)),
    (p) => (p.fork.entry.number = '182'),
    (p) => (p.fork.parent.timestamp = p.constructor.checkpoint.timestamp),
    (p) => (p.fork.entry.timestamp = p.fork.parent.timestamp),
    (p) => (p.constructor.checkpoint.number = '181'),
    (p) => (p.codeHash = null),
    (p) => (p.contract = '0x1234'),
    (p) => (p.commonHistory = 'arbitrary'),
  ]) {
    const p = structuredClone(good);
    edit(p);
    assert.equal(profileSchema.safeParse(p).success, false);
  }
  const huge = structuredClone(good);
  for (const h of [huge.constructor.checkpoint, huge.fork.parent, huge.fork.entry, huge.target])
    h.number = (BigInt(h.number) + 9007199254740993n).toString();
  assert.equal(profileSchema.parse(huge).fork.parent.number, '9007199254741173');
  const binding = profileBinding(profileSchema.parse(good), 1);
  assert.equal(binding.networkChainId, 369);
  assert.equal(binding.originChainId, 1);
  for (const b of [
    { ...binding, common: null },
    { ...binding, networkChainId: 1 },
    { ...binding, networkChainId: 2 },
    { ...binding, networkChainId: 1, originChainId: 369 },
    { ...binding, originChainId: '1' },
    { ...binding, version: 2 },
  ])
    assert.equal(bindingSchema.safeParse(b).success, false);
});
test('honest chain369 verification and origin1 raw decode equal direct control', async () => {
  const shared = setup(),
    direct = setup('ethereum');
  for (const s of shared.pair) await s.verify(shared.f.plain(100), signal);
  const a = await shared.pair[0].events([shared.f.plain(101)], signal);
  const b = await direct.pair[0].events([direct.f.plain(101)], signal);
  assert.deepEqual(a, b);
  assert.equal(a[0].originChainId, 1);
  assert.equal(a[0].value.hearts, '900719925474099312345678');
  const wrong = setup('pulsechain', (rows, calls) =>
    rows.map((r, i) => (calls[i].method === 'eth_chainId' ? { ...r, result: '0x1' } : r)),
  );
  await assert.rejects(wrong.pair[0].verify(wrong.f.plain(100), signal), /Wrong provider chain/);
  assert.throws(
    () => new Source(direct.pair[0].rpc, direct.pair[0].policy, shared.pair[0].binding),
    /binding mismatch/,
  );
});
test('parent fence precedes provider work; newer head does not enlarge common events', async () => {
  const { pair, f } = setup(),
    s = pair[0];
  const before = s.rpc.counters.requests;
  for (const operation of [
    () => s.events([f.plain(180), f.plain(181)], signal),
    () =>
      s.acquire(
        { blockNumber: '179', blockHash: hash(179), revision: '1' },
        '181',
        [],
        null,
        signal,
      ),
    () =>
      s.acquire({ blockNumber: '99', blockHash: hash(99), revision: '0' }, '101', [], null, signal),
    () => s.header('181', signal),
  ])
    await assert.rejects(operation, /outside source binding/);
  assert.equal(s.rpc.counters.requests, before);
  assert.deepEqual(await s.target(signal), f.plain(180));
  assert.ok(s.rpc.counters.requests > before);
  const far = setup('pulsechain', (rows, calls) =>
    rows.map((r, i) =>
      calls[i].method === 'eth_getBlockByNumber' && calls[i].params[0] === 'latest'
        ? { ...r, result: { ...r.result, number: '0x2386f26fc10000' } }
        : r,
    ),
  );
  assert.deepEqual(await far.pair[0].target(signal), f.plain(180));
  f.setHead(180);
  assert.deepEqual(await s.target(signal), f.plain(179));
});
test('out-of-range returned log fails before decoding; known duplicate operators cannot corroborate', async () => {
  const foreign = fixture({ last: 220 }).logs.get(181)[0];
  const { pair, f } = setup('pulsechain', (rows, calls) =>
    rows.map((r, i) => (calls[i].method === 'eth_getLogs' ? { ...r, result: [foreign] } : r)),
  );
  await assert.rejects(pair[0].events([f.plain(180)], signal), /Out-of-range log/);
  assert.equal(pair[0].counters.eventsPeak, 0);
  const valid = setup();
  assert.throws(
    () => new SyncEngine({ chainId: 369 }, {}, valid.pair, '.'),
    /Incompatible source pair/,
  );
  const p = sharedProfile();
  p.ethereum[1].operator = 'OPERATOR-1';
  const sources = profileSources(
    profileSchema.parse(p),
    1,
    () => valid.pair[0].rpc.transport,
    valid.budget,
  );
  assert.throws(
    () => new SyncEngine({ chainId: 1 }, {}, sources, '.'),
    /Incompatible source identities/,
  );
  assert.equal(valid.pair[0].rpc.budget, valid.pair[1].rpc.budget);
});
