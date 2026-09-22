import assert from 'node:assert/strict';
import { randomUUID, createHash } from 'node:crypto';
import { readFile, writeFile, rename } from 'node:fs/promises';
import { runCanary } from '../../dist/operator/canary.js';
import { CanarySession } from '../../dist/operator/canary-session.js';
import { connect, databaseConfig } from '../../dist/db/connect.js';
import { tables } from '../../dist/worker/bootstrap/manifest.js';
import { dayBoundaryPlan, prefixEnvironment, prefixFixture } from './prefix-fixture.mjs';
import { inputs } from './fixture.mjs';
import { FakeClock } from '../sync/fixture.mjs';
const signal = new AbortController().signal;
const sha = (v) => createHash('sha256').update(v).digest('hex');

export async function exactSnapshot() {
  const c = await connect(databaseConfig('worker'));
  try {
    const value = {};
    for (const [table, keys] of Object.entries(tables))
      value[table] = (await c.query(`SELECT * FROM hdd.${table} ORDER BY ${keys.join(',')}`)).rows;
    return value;
  } finally {
    await c.end();
  }
}
export async function diagnosticTests({ root, test, reset }) {
  // Process/container opt-ins stay absent/false. Only the existing synthetic env
  // argument satisfies unchanged authority checks, with a mandatory raw fixture.
  assert.equal(process.env.HDD_V2_ALLOW_LIVE_RPC, 'false');
  assert.equal(process.env.HDD_V2_CANARY_OPT_IN, undefined);
  await test('compiled RPC diagnostics preserve exact committed SQL across client/wrapper/day-transition rejection and failed final save', async () => {
    for (const mode of [
      'client',
      'wrapper',
      'close',
      'final-save',
      'settlement-save',
      'retry-refusal',
    ]) {
      const wrapper = mode === 'wrapper' || mode === 'settlement-save';
      const retryRefusal = mode === 'retry-refusal';
      const p = dayBoundaryPlan(root + '/' + randomUUID());
      await inputs(p);
      const clock = new FakeClock();
      clock.time = Date.now();
      const f = prefixFixture(p, clock),
        env = prefixEnvironment(p);
      const args = [p.storagePath + '/plan.json', p.storagePath + '/approval.json'];
      await runCanary(['prepare', ...args], signal, { env, clock });
      let before,
        request,
        responseBody,
        sends = 0,
        commits = 0,
        rejected = false;
      const transport = (endpoint) => {
        const raw = f.transport(endpoint);
        return async (body, active, deadline) => {
          sends++;
          assert.equal(rejected, false, 'fatal envelope must prevent next dispatch');
          const calls = JSON.parse(body);
          if (
            calls.some((c) => c.method === 'eth_getLogs' && BigInt(c.params[0].fromBlock) >= 356n)
          ) {
            assert.ok(commits >= 1);
            before = await exactSnapshot();
            assert.equal(before.sync_state[0].block_number, '355');
            assert.equal(before.daily_stats.length, 0);
            request = calls;
            responseBody = Buffer.from(
              JSON.stringify(
                calls.map((c) => ({
                  jsonrpc: '2.0',
                  id: wrapper ? c.id + 1000 : c.id,
                  ...(retryRefusal ? {} : { result: null }),
                  error: {
                    code: retryRefusal ? -32000 : -32005,
                    message: 'Synthetic network timeout disagreement range; not the lost response',
                  },
                })),
              ),
            );
            rejected = true;
            if (mode === 'settlement-save') await rename(p.storagePath, p.storagePath + '-moved');
            return {
              status: retryRefusal ? 503 : 200,
              retryAfter: retryRefusal ? '3600' : null,
              body: (async function* () {
                yield responseBody;
              })(),
              close: async () => {
                if (mode === 'close') throw Error('Synthetic close failed.');
              },
            };
          }
          return raw(body, active, deadline);
        };
      };
      const errors = [],
        originalError = console.error;
      console.error = (...v) => {
        errors.push(v.join(' '));
        originalError(...v);
      };
      let result;
      try {
        result = await runCanary(['run', ...args], signal, {
          env,
          clock,
          transport,
          hooks: {
            afterCommit: async () => {
              commits++;
            },
          },
          cleanupHook:
            mode === 'close'
              ? async () => {
                  throw Error('Synthetic cleanup failed.');
                }
              : undefined,
          sessionHooks:
            mode === 'final-save'
              ? {
                  beforeFinalSave: async () => {
                    await rename(p.storagePath, p.storagePath + '-moved');
                  },
                }
              : undefined,
        });
      } finally {
        console.error = originalError;
      }
      assert.ok(rejected);
      const after = await exactSnapshot();
      assert.deepEqual(
        after,
        before,
        'all canonical fields/receipts/undo/schedule exactly unchanged',
      );
      assert.equal(result.status, 'stopped');
      assert.equal(result.results.length, 0);
      assert.equal(result.phase, 0);
      assert.equal(result.http, sends);
      assert.match(
        result.reason,
        retryRefusal
          ? /Provider work cannot meet deadline/
          : wrapper
            ? /Common prefix missing response/
            : /Missing\/conflicting RPC/,
      );
      const d = result.rpcDiagnostic;
      assert.equal(
        d.reason,
        retryRefusal ? 'http' : wrapper ? 'unexpected-id' : 'both-result-error',
      );
      assert.equal(d.stage, wrapper ? 'prefix' : 'rpc');
      assert.deepEqual(d.binding, { originChainId: 1, networkChainId: 369 });
      assert.equal(d.attempt, sends);
      assert.equal(d.requests[0].fromBlock, request[0].params[0].fromBlock);
      assert.equal(d.requests[0].toBlock, request[0].params[0].toBlock);
      assert.equal(d.requests[0].id.value, request[0].id);
      assert.equal(d.received[0].id.value, request[0].id + (wrapper ? 1000 : 0));
      assert.equal(d.received[0].observedUntrustedError.code, retryRefusal ? -32000 : -32005);
      assert.equal(d.httpStatus, retryRefusal ? 503 : 200);
      assert.equal(d.observedBytes, responseBody.length);
      assert.equal(d.sha256, sha(responseBody));
      assert.equal(d.streamComplete, true);
      assert.equal(d.accepted, false);
      assert.equal(
        result.prefix.accounting.reduce((n, a) => n + a.rpc.retries, 0),
        retryRefusal ? 1 : 0,
      );
      if (mode === 'close') {
        assert.equal(d.cleanupFailed, true);
        assert.match(result.prefix.secondary.join(' '), /Synthetic cleanup/);
      }
      if (mode === 'final-save' || mode === 'settlement-save') {
        assert.equal(result.diagnosticPersistence, 'failed');
        const logged = errors
          .map((s) => JSON.parse(s))
          .find((r) => r.event === 'canary_finalization_failed');
        assert.deepEqual(logged.rpcDiagnostic, d);
        assert.equal(logged.diagnosticPersistence, 'failed');
        const prior = JSON.parse(await readFile(p.storagePath + '-moved/canary.json', 'utf8'));
        assert.equal(
          prior.rpcDiagnostic,
          undefined,
          'failed final save never claims durable evidence',
        );
      } else {
        assert.equal(result.diagnosticPersistence, 'saved');
        const loaded = await CanarySession.load(p, clock);
        assert.deepEqual(loaded.state, result);
        assert.equal(loaded.state.terminal, true);
        const frozen = await readFile(p.sessionPath);
        await assert.rejects(
          runCanary(['resume', ...args], signal, { env, clock, transport }),
          /resume/,
        );
        assert.deepEqual(await readFile(p.sessionPath), frozen);
      }
      await writeFile(
        `/evidence/rpc-diagnostic-${mode}.json`,
        JSON.stringify(
          {
            fixture: 'SYNTHETIC ONLY; NOT THE LOST LIVE RESPONSE',
            mode,
            commits,
            sends,
            request,
            syntheticResponse: JSON.parse(responseBody),
            result,
            before,
            after,
            exactSqlEqual: true,
            realProviderCalls: 0,
            errors,
          },
          null,
          2,
        ),
      );
      await reset();
    }
  });
  await test('copied diagnostic-free prior-format TEST state stays spent with no fabricated evidence', async () => {
    const p = dayBoundaryPlan(root + '/' + randomUUID());
    await inputs(p);
    const clock = new FakeClock();
    clock.time = Date.now();
    const s = await CanarySession.prepare(p, clock);
    await s.start(false);
    await s.finish('stopped', 'Synthetic prior-format terminal fixture; diagnostic unavailable.');
    const bytes = await readFile(p.sessionPath);
    const copied = JSON.parse(bytes);
    assert.equal(Object.hasOwn(copied, 'rpcDiagnostic'), false);
    const loaded = await CanarySession.load(p, clock);
    assert.equal(loaded.state.rpcDiagnostic, undefined);
    assert.deepEqual(loaded.state, s.state);
    await assert.rejects(loaded.start(true), /resume/);
    await assert.rejects(loaded.start(false), /Use run/);
    assert.deepEqual(await readFile(p.sessionPath), bytes);
    copied.reason = 'tampered';
    await writeFile(p.sessionPath, JSON.stringify(copied));
    await assert.rejects(CanarySession.load(p, clock), /checksum/);
    await writeFile(
      '/evidence/rpc-diagnostic-prior-format.json',
      JSON.stringify(
        {
          fixture: 'NEW TEST STATE ONLY; no historical file or volume read',
          state: s.state,
          spentPreserved: true,
          fileUnchangedBeforeDeliberateTamper: true,
          checksumTamperRejected: true,
          diagnosticAvailable: false,
        },
        null,
        2,
      ),
    );
  });
}
