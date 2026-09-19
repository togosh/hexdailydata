import assert from 'node:assert/strict';
import { SyncEngine } from '../../src/worker/sync/engine.ts';
import { CanonicalWriter } from '../../src/services/projections/writer.ts';
import { hash } from './fixture.mjs';

export async function recoveryCases({
  test,
  writer,
  reader,
  db,
  chain,
  pair,
  budget,
  clock,
  snapshot,
}) {
  const signal = new AbortController().signal;
  let sync = new SyncEngine(writer, reader, pair(369), '/evidence');
  await test('single-block source disagreement, false empty, cancellation and competing writer preserve checkpoint', async () => {
    const before = await snapshot();
    for (const mode of ['empty', 'different']) {
      const corrupt = chain.source(
        369,
        'fixture-two',
        clock,
        (rows, requests) =>
          rows.map((r, i) => {
            const method = requests[i].method;
            if (mode === 'empty' && method === 'eth_getLogs') return { ...r, result: [] };
            if (
              mode === 'different' &&
              ['eth_getLogs', 'eth_getTransactionReceipt'].includes(method)
            ) {
              const copy = structuredClone(r),
                logs = method === 'eth_getLogs' ? copy.result : copy.result.logs;
              if (logs.length) logs[0].data = '0x' + '0'.repeat(64);
              return copy;
            }
            return r;
          }),
        budget,
      );
      const broken = new SyncEngine(writer, reader, [pair(369)[0], corrupt], '/evidence');
      await assert.rejects(() => broken.once(signal, chain.plain(361)), /Incomplete|disagreement/);
      assert.deepEqual(await snapshot(), before);
    }
    const stopped = new AbortController();
    stopped.abort(new Error('cancelled fixture'));
    await assert.rejects(() => sync.once(stopped.signal, chain.plain(361)), /cancelled/);
    const competitor = await db('worker');
    await assert.rejects(() => CanonicalWriter.acquire(competitor, 369), /already active/);
    assert.deepEqual(await snapshot(), before);
  });
  await test('before-commit rollback and after-commit lost acknowledgement recover from durable cursor', async () => {
    const before = await snapshot();
    const failed = new SyncEngine(writer, reader, pair(369), '/evidence', {
      beforeCommit: async () => {
        throw new Error('injected precommit');
      },
    });
    await assert.rejects(() => failed.once(signal, chain.plain(361)), /precommit/);
    assert.deepEqual(await snapshot(), before);
    const lost = new SyncEngine(writer, reader, pair(369), '/evidence', {
      afterCommit: async () => {
        throw new Error('injected lost ack');
      },
    });
    await assert.rejects(() => lost.once(signal, chain.plain(361)), /lost ack/);
    assert.equal((await sync.cursor()).block_number, '361');
    sync = new SyncEngine(writer, reader, pair(369), '/evidence');
    await sync.once(signal, chain.plain(362));
    await sync.audit(signal);
    assert.equal(
      (
        await reader.query(
          'SELECT count(*) FROM hdd.transfers_recent WHERE origin_chain_id=369 AND block_number=361',
        )
      ).rows[0].count,
      '64',
    );
  });
  function reorg(from, delta) {
    for (let n = from; n <= chain.last; n++) {
      const h = chain.headers.get(n);
      h.hash = hash(n + delta);
      h.parentHash = hash(n - 1 + (n === from ? 0 : delta));
      for (const log of chain.logs.get(n)) log.blockHash = h.hash;
      for (const tx of h.transactions) chain.receipts.get(tx).blockHash = h.hash;
    }
  }
  await test('automatic in-window reorg rewinds/replays; finalized and beyond-window disagreement pause', async () => {
    const before = await sync.cursor();
    reorg(356, 10000);
    sync = new SyncEngine(writer, reader, pair(369), '/evidence');
    await sync.once(signal, chain.plain(362));
    await sync.audit(signal);
    assert.ok(BigInt((await sync.cursor()).revision) > BigInt(before.revision));
    assert.equal((await sync.cursor()).rewind_floor, before.rewind_floor);
    const worker = await db('worker');
    await worker.query("UPDATE hdd.sync_state SET finality='finalized' WHERE chain_id=369");
    reorg(356, 20000);
    const frozen = await snapshot();
    sync = new SyncEngine(writer, reader, pair(369), '/evidence');
    await assert.rejects(() => sync.once(signal, chain.plain(362)), /Finalized/);
    assert.deepEqual(await snapshot(), frozen);
    await worker.query("UPDATE hdd.sync_state SET finality='confirmed' WHERE chain_id=369");
    reorg(181, 30000);
    const beyond = await snapshot();
    sync = new SyncEngine(writer, reader, pair(369), '/evidence');
    await assert.rejects(() => sync.once(signal, chain.plain(362)), /beyond retained/);
    assert.deepEqual(await snapshot(), beyond);
  });
}
