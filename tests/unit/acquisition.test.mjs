import test from 'node:test';
import assert from 'node:assert/strict';
import { sparseFixture } from '../sync/sparse-fixture.mjs';
import { validateBatch } from '../../src/services/projections/input.ts';
import { CONTRACT, hash } from '../sync/fixture.mjs';

const signal = new AbortController().signal;
export async function witness(spacing, unrelated = 0) {
  const f = sparseFixture({ spacing, unrelated }),
    start = performance.now();
  const expected = { blockNumber: '100', blockHash: hash(100), revision: '0' };
  const pair = [f.source('one'), f.source('two')];
  const sources = [];
  for (const source of pair)
    sources.push(await source.acquire(expected, String(f.number(108)), [], null, signal));
  const accepted = validateBatch({
    chainId: 1,
    contract: CONTRACT,
    expected,
    range: { fromBlock: '101', toBlock: sources[0].headers.at(-1).number },
    sources,
  });
  assert.equal(accepted.last.number, String(f.number(108) - 1));
  assert.equal(accepted.next.number, String(f.number(108)));
  assert.equal(accepted.events.length, 15);
  const report = {
    spacing,
    unrelated,
    span: Number(accepted.last.number) - 100,
    events: accepted.events.length,
    retainedHeaders: accepted.headers.length,
    generatedHeaders: f.generatedHeaders(),
    realElapsedMs: performance.now() - start,
    virtualQuotaMs: f.clock.now(),
    sources: pair.map((s) => ({ rpc: s.rpc.counters, acquisition: s.counters })),
  };
  return { accepted, report };
}
test('lazy empty-gap and unrelated transaction growth changes bounded selected work, never per-transaction receipts', async () => {
  const small = await witness(1),
    gap = await witness(8192),
    dense = await witness(8192, 4096);
  assert.equal(gap.report.span, 65535);
  assert.ok(gap.report.generatedHeaders < 100);
  assert.ok(gap.report.retainedHeaders < 16);
  assert.equal(gap.report.generatedHeaders, dense.report.generatedHeaders);
  for (const r of [small, gap, dense])
    for (const s of r.report.sources) assert.equal(s.rpc.methods.eth_getTransactionReceipt ?? 0, 0);
  assert.ok(dense.report.sources[0].rpc.bytes > gap.report.sources[0].rpc.bytes);
  assert.deepEqual(gap.accepted.events, dense.accepted.events);
  console.log('WORK_GROWTH', JSON.stringify([small.report, gap.report, dense.report]));
});
test('explicit numeric coverage, sparse identities and day pairs fail closed', async () => {
  const { accepted } = await witness(64);
  for (const mutate of [
    (b) => (b.range.fromBlock = '102'),
    (b) => (b.range.toBlock = String(BigInt(b.range.toBlock) + 1n)),
    (b) => b.sources.forEach((s) => (s.previous.timestamp = s.headers[0].timestamp)),
    (b) => b.sources.forEach((s) => (s.next.parentHash = hash(999))),
    (b) => b.sources.forEach((s) => (s.headers[1].timestamp = s.headers[0].timestamp)),
  ]) {
    const b = structuredClone(accepted.batch);
    mutate(b);
    assert.throws(() => validateBatch(b));
  }
  const unknown = structuredClone(accepted.batch);
  unknown.sources.forEach((s) => (s.operator = null));
  assert.doesNotThrow(() => validateBatch(unknown));
  const shared = structuredClone(accepted.batch);
  shared.sources.forEach((s) => (s.operator = 'shared'));
  assert.throws(() => validateBatch(shared), /upstreams/);
});
test('old all-header quota floor alone consumes fourteen nominal quota days at 3,628,800 blocks', () => {
  assert.equal((2 * 3628800) / 360 / 60 / 24, 14);
});

test('seed format and source policy reject unsupported historical metadata explicitly', async () => {
  const { manifestSchema } = await import('../../src/worker/bootstrap/manifest.ts');
  const { policySchema } = await import('../../src/providers/source.ts');
  assert.equal(manifestSchema.shape.formatVersion.safeParse(1).success, false);
  assert.equal(manifestSchema.shape.formatVersion.parse(3), 3);
  assert.equal(policySchema.shape.completeness.safeParse('receipts').success, false);
});
