import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import { syncBuiltinESMExports } from 'node:module';
import { admin, json } from './fixture.mjs';
import { auditFixture } from './audit-only-fixture.mjs';

export async function auditOnlyFaults({ test, fresh, clock, audited, unchanged }) {
  await test('audit persistence, reserve, exclusion, ending and fresh snapshot faults refuse completion', async () => {
    const outcomes = [];
    for (const kind of [
      'save',
      'reserve',
      'sql-exclusion',
      'ending-header',
      'fresh-snapshot',
      'final-expiry',
    ]) {
      const p = await fresh(),
        f = auditFixture(p, clock),
        originalRename = fs.rename,
        originalStatfs = fs.statfs;
      let fired = false,
        state;
      const transport = f.transport;
      if (kind === 'ending-header') {
        const counts = new Map();
        f.transport = (endpoint) => {
          const raw = transport(endpoint);
          return async (body, ...args) => {
            const response = await raw(body, ...args),
              calls = JSON.parse(body);
            if (calls.some((c) => c.method === 'eth_getBlockByNumber')) {
              const count = (counts.get(endpoint) ?? 0) + 1;
              counts.set(endpoint, count);
              if (count >= 3) {
                const chunks = [];
                for await (const b of response.body) chunks.push(b);
                const rows = JSON.parse(Buffer.concat(chunks));
                for (const r of rows) if (r.result?.hash) r.result.hash = '0x' + 'f'.repeat(64);
                return {
                  ...response,
                  body: (async function* () {
                    yield Buffer.from(JSON.stringify(rows));
                  })(),
                };
              }
            }
            return response;
          };
        };
      }
      try {
        // This pre-opened administrator is only an explicit adversarial fixture actor.
        // Its injected mutation/loss is outside the operator's no-write statement witness.
        await admin(async (c) => {
          const externalQuery = c.query.bind(c);
          state = (
            await audited(p, 'run', {
              fixture: f,
              boundary: async () => {
                if (fired) return;
                if (kind === 'reserve') {
                  fired = true;
                  fs.statfs = async () => ({ bsize: 4096n, bavail: 1n, blocks: 2n });
                  syncBuiltinESMExports();
                }
                if (kind === 'sql-exclusion') {
                  fired = true;
                  await externalQuery(
                    "SELECT pg_terminate_backend(pid) FROM pg_locks WHERE locktype='advisory' AND classid=4242 AND objid=1 AND granted",
                  );
                }
              },
              auditHooks: {
                afterAppend: async () => {
                  if (kind !== 'save' || fired) return;
                  fired = true;
                  fs.rename = async (from, to) => {
                    if (String(to).endsWith('/reconstruction.json'))
                      throw Error('Synthetic state persistence failure');
                    return originalRename(from, to);
                  };
                  syncBuiltinESMExports();
                },
                afterPage: async () => {
                  if (kind !== 'fresh-snapshot' || fired) return;
                  fired = true;
                  await externalQuery(
                    "INSERT INTO hdd.accounts VALUES(1,decode(repeat('fe',20),'hex'),0,0,0,355,355)",
                  );
                },
              },
              sessionHooks: {
                beforeFinalSave: async () => {
                  if (kind === 'final-expiry') clock.time += 3600000;
                },
              },
            })
          ).state;
        });
      } finally {
        fs.rename = originalRename;
        fs.statfs = originalStatfs;
        syncBuiltinESMExports();
        if (kind === 'fresh-snapshot')
          await admin((c) =>
            c.query("DELETE FROM hdd.accounts WHERE address=decode(repeat('fe',20),'hex')"),
          );
      }
      assert.equal(state.status, 'blocked', JSON.stringify({ kind, state }));
      assert.notEqual(state.phase, 'complete');
      if (kind === 'save') {
        const disk = await json(p.storagePath + '/reconstruction.json');
        assert.equal(disk.audit.sources[0].count, 0);
        await assert.rejects(audited(p, 'resume'), /failure marker/);
      }
      if (['ending-header', 'fresh-snapshot'].includes(kind)) assert.equal(state.audited, null);
      await unchanged(p);
      outcomes.push({ kind, state });
    }
    return outcomes;
  });
  await test('actual SQL inventory, revision and header drift refuse before provider dispatch', async () => {
    const outcomes = [];
    for (const kind of ['inventory', 'revision', 'header']) {
      const p = await fresh();
      if (kind === 'inventory')
        await admin((c) =>
          c.query("INSERT INTO hdd.accounts VALUES(1,decode(repeat('fe',20),'hex'),0,0,0,355,355)"),
        );
      if (kind === 'revision')
        await admin((c) =>
          c.query('UPDATE hdd.sync_state SET revision=revision+1 WHERE chain_id=1'),
        );
      if (kind === 'header')
        await admin((c) =>
          c.query(
            "UPDATE hdd.blocks_recent SET hash=decode(repeat('ff',32),'hex') WHERE chain_id=1 AND number=355",
          ),
        );
      const f = auditFixture(p, clock);
      let state;
      try {
        state = (await audited(p, 'run', { fixture: f })).state;
        assert.equal(state.status, 'blocked');
        assert.equal(f.attempts.length, 0);
      } finally {
        if (kind === 'inventory')
          await admin((c) =>
            c.query("DELETE FROM hdd.accounts WHERE address=decode(repeat('fe',20),'hex')"),
          );
        if (kind === 'revision')
          await admin((c) =>
            c.query('UPDATE hdd.sync_state SET revision=$1 WHERE chain_id=1', [
              p.admission.revision,
            ]),
          );
        if (kind === 'header')
          await admin((c) =>
            c.query('UPDATE hdd.blocks_recent SET hash=$1 WHERE chain_id=1 AND number=355', [
              Buffer.from(p.admission.checkpoint.hash.slice(2), 'hex'),
            ]),
          );
      }
      await unchanged(p);
      outcomes.push({ kind, state });
    }
    return outcomes;
  });
  await test('retry-after and restart quarantine survive an audit-only segment pause', async () => {
    const p = await fresh({
      segment: { milliseconds: 3600000, http: 1, logical: 12000, bytes: 268435456 },
    });
    const first = await audited(p, 'run', { fixture: auditFixture(p, clock, 'cooldown') });
    assert.equal(first.state.status, 'paused');
    assert.equal(first.state.http, 1);
    const second = await audited(p, 'resume');
    assert.equal(second.state.status, 'paused');
    assert.equal(second.state.http, 2);
    assert.equal(second.state.start, first.state.start);
    assert(second.attempts[0].at - first.attempts[0].at >= 120000);
    await unchanged(p);
    return { first, second };
  });
}
