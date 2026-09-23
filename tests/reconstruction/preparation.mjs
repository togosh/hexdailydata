import assert from 'node:assert/strict';
import { readFile, copyFile } from 'node:fs/promises';
import fs from 'node:fs/promises';
import { syncBuiltinESMExports } from 'node:module';
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
  environment,
} from './fixture.mjs';

export async function preparationTests({ root, test, reset, child }) {
  await test('nullable saved provider metadata prepares read-only, never constructs transport, and changed metadata refuses', async () => {
    await reset();
    const clock = clockAt(),
      prior = await seeded(root, clock);
    const observed = await json('tests/reconstruction/observed-profile.json');
    prior.profile.ethereum = observed.ethereum;
    // Only synthetic rows in this disposable database receive saved metadata shape.
    await admin((c) =>
      c.query("UPDATE hdd.source_history SET sources=jsonb_set(sources,'{providers}',$1::jsonb)", [
        JSON.stringify(
          observed.ethereum.map((s) => ({
            id: s.id,
            operator: s.operator,
            accountGroup: s.accountGroup,
            endpointAlias: s.endpointEnv,
          })),
        ),
      ]),
    );
    const p = await newPlan(root, prior);
    const records = () =>
      admin(async (c) => (await c.query('SELECT * FROM hdd.source_history')).rows);
    const before = await records();
    let constructions = 0;
    const options = {
      env: { ...environment(p), HDD_V2_ALLOW_LIVE_RPC: 'false', HDD_V2_RECONSTRUCTION_OPT_IN: '' },
      transport: () => {
        constructions++;
        throw Error('Provider construction forbidden');
      },
    };
    const checked = await executeBulk(p, 'check', clock, options);
    const prepared = await executeBulk(p, 'prepare', clock, options);
    for (const key of ['start', 'deadline', 'segment', 'pendingSql', 'audited'])
      assert.equal(prepared[key], null);
    for (const key of ['http', 'logical', 'chargedBytes', 'observedBytes', 'milestone'])
      assert.equal(prepared[key], 0);
    assert.equal(prepared.pending, false);
    assert.equal(prepared.status, 'prepared');
    const changed = await newPlan(root, prior);
    changed.profile.ethereum[0].operator = 'Changed synthetic claim';
    await inputs(changed);
    await assert.rejects(
      executeBulk(changed, 'prepare', clock, {
        ...options,
        env: {
          ...environment(changed),
          HDD_V2_ALLOW_LIVE_RPC: 'false',
          HDD_V2_RECONSTRUCTION_OPT_IN: '',
        },
      }),
      /source identity mismatch/,
    );
    const after = await records();
    assert.deepEqual(after, before);
    assert.equal(constructions, 0);
    await save('nullable-prepare', {
      classification: 'SYNTHETIC_SQL_ONLY',
      checked,
      prepared,
      before,
      after,
      constructions,
    });
  });
  await test('close declared milestones pause with complete collectible evidence and fresh resume never repeats the first audit', async () => {
    await reset();
    const clock = clockAt(),
      prior = await seeded(root, clock),
      p = await newPlan(root, prior, { target: '357', milestones: ['356', '357'] });
    await executeBulk(p, 'prepare', clock);
    const first = await child(p, 'run');
    assert.equal(first.code, 3);
    assert.equal(first.state.status, 'paused');
    assert.equal(first.state.phase, 'milestone-audited');
    assert.equal(first.state.milestone, 1);
    assert.equal(first.state.accepted.header.number, '356');
    assert.deepEqual(first.state.audited, first.state.accepted);
    assert(first.state.canonicalAtPause);
    assert.equal(first.state.audit, null);
    const comparison = await readFile(p.storagePath + '/comparisons.jsonl'),
      result = await readFile(p.storagePath + '/audit-result.json');
    const audit = JSON.parse(result);
    assert.equal(comparison.length, audit.coverage.bytes);
    assert(audit.coverage.sources.every((s) => s.count === audit.count));
    await copyFile(
      p.storagePath + '/comparisons.jsonl',
      '/evidence/milestone-356-comparisons.jsonl',
    );
    await copyFile(p.storagePath + '/audit-result.json', '/evidence/milestone-356-result.json');
    assert.deepEqual(await readFile('/evidence/milestone-356-comparisons.jsonl'), comparison);
    assert.deepEqual(await readFile('/evidence/milestone-356-result.json'), result);
    const second = await child(p, 'resume');
    assert.equal(second.code, 0);
    assert.equal(second.state.status, 'complete');
    assert.equal(second.state.phase, 'complete');
    assert.equal(second.state.milestone, 2);
    assert.equal(second.state.accepted.header.number, '357');
    assert.equal(second.state.start, first.state.start);
    assert.equal(second.state.deadline, first.state.deadline);
    assert.equal(second.state.digest, first.state.digest);
    const calls = (r) => r.attempts.flatMap((a) => a.calls);
    // Finality observations may be ahead of the milestones; replay ranges and balance pins may not.
    assert(
      calls(first)
        .filter((c) => c.method === 'eth_getLogs')
        .every((c) => BigInt(c.params[0].toBlock) <= 356n),
    );
    const balances = (r) =>
      calls(r).filter((c) => c.method === 'eth_call' && c.params[0].data.startsWith('0x70a08231'));
    const hash = (n) => '0x' + BigInt(n).toString(16).padStart(64, '0');
    assert(balances(first).every((c) => c.params[1].blockHash !== hash(357)));
    assert(balances(second).every((c) => c.params[1].blockHash !== hash(356)));
    const attempts = [...first.attempts, ...second.attempts];
    assert.equal(second.state.http, attempts.length);
    assert.equal(
      second.state.logical,
      attempts.reduce((n, a) => n + a.logical, 0),
    );
    assert.equal(
      second.state.chargedBytes,
      attempts.reduce((n, a) => n + a.bytes, 0),
    );
    assert(
      second.state.http < p.segment.http,
      'Both milestones fit the work allowance without the new barrier',
    );
    assert(second.state.highWater - second.state.start < p.segment.milliseconds);
    await save('close-milestones', {
      plan: p,
      first,
      second,
      firstComparisonBytes: comparison.length,
      firstAudit: audit,
    });
  });
  await test('non-final milestone deadline, save, cancellation and cleanup faults remain terminal', async () => {
    const outcomes = [];
    for (const kind of ['deadline', 'milestone-save', 'cancel', 'cleanup']) {
      await reset();
      const clock = clockAt(),
        prior = await seeded(root, clock),
        p = await newPlan(root, prior, { target: '357', milestones: ['356', '357'] }),
        f = fixture(p, clock),
        original = fs.rename;
      await executeBulk(p, 'prepare', clock);
      const options = { fixture: f };
      if (kind === 'deadline')
        options.sessionHooks = {
          beforeFinalSave: async () => {
            clock.time += 3600000;
          },
        };
      else
        options.afterMilestone = async () => {
          if (kind === 'milestone-save') {
            fs.rename = async (from, to) => {
              if (String(to).endsWith('/reconstruction.json'))
                throw Error('Injected milestone save failure');
              return original(from, to);
            };
            syncBuiltinESMExports();
          } else if (kind === 'cancel') {
            await admin((c) =>
              c.query(
                "SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE usename='hdd_v2_api' AND datname=current_database()",
              ),
            );
          } else {
            await fs.rename(p.storagePath + '/.maintenance.lock', p.storagePath + '/.lost-lock');
            await fs.writeFile(p.storagePath + '/.maintenance.lock', '');
          }
        };
      let state;
      try {
        state = await executeBulk(p, 'run', clock, options);
      } finally {
        fs.rename = original;
        syncBuiltinESMExports();
      }
      assert.equal(state.status, 'blocked', kind);
      assert.equal(state.terminal, true);
      assert.equal(state.accepted.header.number, '356');
      await assert.rejects(executeBulk(p, 'resume', clock));
      outcomes.push({ kind, state });
    }
    await save('milestone-finalization-faults', outcomes);
  });
}
