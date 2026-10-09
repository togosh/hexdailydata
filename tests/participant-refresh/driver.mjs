// Injected native-close/late-publication guard through the actual maintained driver.
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { runParticipantRefresh } from '../../scripts/participant-refresh.mjs';
import { canonical, sha } from '../../dist/services/source-update/generation.js';
import { ACCEPTED } from '../../dist/contracts/saved-generation.js';
const R = process.env.HDD_TASK_ROOT,
  results = [];
for (const late of [false, true]) {
  const root = await mkdtemp(join(R, 'evidence/fixtures/driver-'));
  await mkdir(join(root, 'evidence'));
  const output = join(root, 'session');
  const current = { generation: ACCEPTED.generation, productVersion: 'a'.repeat(64) };
  const preflight = {
    taskId: 'HDD-PARTICIPANT-CATCHUP-REFRESH-R1',
    verdict: 'PASS',
    synthetic: true,
    trialRoot: output,
    runtimeFiles: {},
    inputFiles: {},
    initialGeneration: current.generation,
    initialProductVersion: current.productVersion,
  };
  const path = join(root, 'PREFLIGHT.json');
  await writeFile(path, JSON.stringify(preflight));
  let commits = 0;
  const registry = {
    status: () => current,
    publish: async (_u, _p, options) => {
      await new Promise((r) => setTimeout(r, 40));
      options.beforeCommit();
      commits++;
      throw Error('Must not reach publication after native exit');
    },
  };
  const spawnChild = () => {
    const child = new EventEmitter();
    Object.assign(child, {
      stdin: new PassThrough(),
      stdout: new PassThrough(),
      stderr: new PassThrough(),
      exitCode: null,
      signalCode: null,
      pid: 123,
    });
    const send = (v) => child.stdout.write(JSON.stringify(v) + '\n');
    void (async () => {
      await mkdir(output);
      const accounting = { status: 'CLOSED', pending: null };
      const result = { status: 'PARTIAL', completedWindows: 0, accounting };
      await writeFile(join(output, 'ACCOUNTING.json'), JSON.stringify(accounting));
      await writeFile(join(output, 'RESULT.json'), JSON.stringify(result));
      if (late) {
        const base = {
            number: 27724947,
            hash: '0x688b4ce6c991cd8fa6d3012e3a6a063755e056e6e856aac7664dfb34046651e3',
            timestamp: 1791257475,
          },
          target = { number: 27724948, hash: '0x' + 'b'.repeat(64), timestamp: 1791257485 };
        const proof = { synthetic: true };
        const raw = Buffer.from(JSON.stringify(proof));
        await writeFile(join(output, 'WINDOW_1_AUDIT.json'), raw);
        const draft = {
          schemaVersion: 2,
          complete: true,
          predecessor: current.generation,
          base,
          target,
          deployment: ACCEPTED.deployment,
          changes: { tokenHolders: [], stakeStarts: [] },
          sourceCounts: {
            tokenHolders: 0,
            stakeStarts: 0,
            stakeEnds: 0,
            stakeGoodAccountings: 0,
            affectedParents: 0,
          },
          fullTargetInventoryProven: false,
          deletionsSupported: false,
          reorgSafetyProven: false,
        };
        await writeFile(join(output, 'WINDOW_1_DRAFT.json'), JSON.stringify(draft));
        send({
          type: 'qualified',
          window: 1,
          expiresAtUnixSeconds: Date.now() / 1000 + 120,
          auditFileSha256: sha(raw),
          proofSha256: sha(canonical(proof)),
        });
        await new Promise((r) => setTimeout(r, 20));
      }
      send({ type: 'closed', result });
      child.exitCode = 2;
      child.emit('exit', 2, null);
      child.stdout.end();
      child.stderr.end();
      child.emit('close', 2, null);
    })().catch((e) => child.emit('error', e));
    return child;
  };
  const r = await runParticipantRefresh({
    taskRoot: root,
    preflightPath: path,
    registry,
    spawnChild,
    onAdoption: () => {
      throw Error('No adoption expected');
    },
  });
  assert.equal(commits, 0);
  assert.equal(r.externalSessionCount, 0);
  assert.equal(Boolean(r.error), late);
  results.push({ late, root, status: r.status, error: r.error, commits });
}
await writeFile(
  join(R, 'evidence/DRIVER_TESTS.json'),
  JSON.stringify({ status: 'PASS', synthetic: true, externalRequests: 0, results }, null, 2) + '\n',
);
console.log('Driver close/liveness tests PASS');
