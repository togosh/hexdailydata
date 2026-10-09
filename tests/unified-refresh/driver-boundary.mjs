import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { runJob, runUnified } from '../../scripts/refresh-data.mjs';
const R = process.env.HDD_TASK_ROOT,
  root = await mkdtemp(join(R, 'temp/driver-boundary-'));
const result = { synthetic: true, externalRequests: 0, cases: [], root };
const json = (p, v) => writeFile(p, JSON.stringify(v) + '\n');
for (const mode of ['exit-before-close', 'queued-after-error']) {
  const jobRoot = join(root, mode);
  await mkdir(jobRoot);
  const source = { status: 'PARTIAL', accounting: { status: 'CLOSED', pending: null } };
  await json(join(jobRoot, 'ACCOUNTING.json'), source.accounting);
  await json(join(jobRoot, 'RESULT.json'), source);
  let publications = 0;
  const spawnChild = () => {
    const c = new EventEmitter();
    c.stdin = new PassThrough();
    c.stdout = new PassThrough();
    c.stderr = new PassThrough();
    c.pid = 0;
    setImmediate(() => {
      if (mode === 'queued-after-error')
        c.stdout.write(
          JSON.stringify({ type: 'invalid', expiresAtUnixSeconds: Date.now() / 1000 + 20 }) + '\n',
        );
      c.stdout.write(
        JSON.stringify({
          type: 'qualified',
          cycle: 1,
          expiresAtUnixSeconds: Date.now() / 1000 + 20,
        }) + '\n',
      );
      if (mode === 'exit-before-close') {
        c.exitCode = 2;
        c.emit('exit', 2, null);
      }
      setTimeout(() => {
        c.stdout.write(JSON.stringify({ type: 'closed', result: source }) + '\n');
        c.stdout.end();
        c.stderr.end();
        c.emit('close', 2, null);
      }, 30);
    });
    return c;
  };
  await assert.rejects(
    runJob({
      jobRoot,
      admission: { family: 'market' },
      registry: { publishProduct: () => publications++ },
      onAdoption: () => publications++,
      spawnChild,
      deadline: performance.now() + 5000,
    }),
    /EXPIRED_JOB|UNEXPECTED_COLLECTOR_PHASE/,
  );
  assert.equal(publications, 0);
  result.cases.push(mode + ': zero publication');
}
{
  const jobRoot = join(root, 'native-cutoff');
  await mkdir(jobRoot);
  await mkdir(join(jobRoot, 'temp'));
  let child;
  const start = performance.now();
  await assert.rejects(
    runJob({
      jobRoot,
      admission: { family: 'market' },
      registry: {},
      onAdoption: () => {},
      spawnChild: (_exe, _args, options) =>
        (child = spawn(process.execPath, ['-e', 'setTimeout(()=>{},60000)'], options)),
      deadline: start + 2500,
    }),
    /NATIVE_DEADLINE_CLOSED/,
  );
  assert.notEqual(child.exitCode, null);
  assert(performance.now() - start < 5000);
  result.cases.push('actual owned native child killed/reaped within bounded cutoff');
}
{
  const taskRoot = join(root, 'stalled-admission');
  await mkdir(taskRoot);
  await mkdir(join(taskRoot, 'product'));
  await mkdir(join(taskRoot, 'participants'));
  await writeFile(
    join(taskRoot, 'REQUEST_PLAN.json'),
    await readFile(join(R, 'REQUEST_PLAN.json')),
  );
  const preflightPath = join(taskRoot, 'PREFLIGHT.json');
  await json(preflightPath, {
    verdict: 'PASS',
    taskId: 'HDD-UNIFIED-REFRESH-OPERATION-R1',
    taskRoot,
    synthetic: true,
    runtimeFiles: {},
    inputFiles: {},
    marketSourceFiles: {},
    initialGeneration: 'x',
    initialProductVersion: 'y',
  });
  const original = performance.now.bind(performance);
  let offset = 0;
  performance.now = () => original() + offset;
  let launched = 0;
  try {
    const r = await runUnified({
      taskRoot,
      preflightPath,
      registry: {
        root: join(taskRoot, 'participants'),
        productDaily: { root: join(taskRoot, 'product') },
        status: () => ({ generation: 'x', productVersion: 'y', error: null }),
        refresh: async () => {
          offset += 2700001;
        },
        capture: () => {
          throw Error('LOCAL_STALL_REACHED');
        },
      },
      onAdoption: () => {},
      spawnChild: () => {
        launched++;
        throw Error('MUST_NOT_DISPATCH');
      },
    });
    assert.equal(launched, 0);
    assert.equal(r.status, 'PARTIAL');
    assert.equal(r.networkClosureKnown, true);
    assert.match(r.failure, /PARENT_NEW_JOB_CUTOFF/);
    result.cases.push('parent deadline cannot renew after local stall; zero dispatch');
  } finally {
    performance.now = original;
  }
}
{
  const jobRoot = join(root, 'stalled-publication');
  await mkdir(jobRoot);
  let guardEntered = false;
  const spawnChild = () => {
    const c = new EventEmitter();
    c.stdin = new PassThrough();
    c.stdout = new PassThrough();
    c.stderr = new PassThrough();
    c.pid = 0;
    setImmediate(() => {
      c.stdout.write(
        JSON.stringify({
          type: 'qualified',
          cycle: 1,
          expiresAtUnixSeconds: Date.now() / 1000 + 20,
        }) + '\n',
      );
      setTimeout(() => {
        c.exitCode = 2;
        c.emit('exit', 2, null);
        c.stdout.end();
        c.stderr.end();
        c.emit('close', 2, null);
      }, 30);
    });
    return c;
  };
  const began = performance.now();
  await assert.rejects(
    runJob({
      jobRoot,
      admission: { family: 'gas' },
      registry: {},
      onAdoption: () => {},
      spawnChild,
      storageGuard: () => {
        guardEntered = true;
        return new Promise(() => {});
      },
      deadline: began + 2500,
    }),
    /PUBLICATION_SETTLEMENT_UNKNOWN/,
  );
  assert(guardEntered);
  assert(performance.now() - began < 3000);
  result.cases.push(
    'stalled local publisher after native exit returns bounded publication uncertainty',
  );
}
result.status = 'PASS';
result.closed = true;
await json(join(R, 'evidence', 'DRIVER_BOUNDARIES_' + Date.now() + '.json'), result);
console.log(JSON.stringify(result));
