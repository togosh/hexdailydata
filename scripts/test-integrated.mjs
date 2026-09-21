// One concrete Task09 acceptance sequence, using the existing release/operator harness.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { randomUUID, createHash } from 'node:crypto';
import {
  mkdirSync,
  readFileSync,
  writeFileSync,
  appendFileSync,
  existsSync,
  renameSync,
  copyFileSync,
} from 'node:fs';
import { resolve, join, relative, isAbsolute } from 'node:path';
import { setTimeout as pause } from 'node:timers/promises';
import net from 'node:net';
import { ingress } from '../tests/integration/ingress.mjs';

const cycles = Number(process.argv.find((a) => a.startsWith('--cycles='))?.split('=')[1] ?? 30);
const modelOnly = process.argv.includes('--model-only');
const mixedSmoke = process.argv.includes('--mixed-smoke');
const mixedOnly = process.argv.includes('--mixed-only');
const capacity = process.argv.includes('--capacity');
const capacitySmoke = process.argv.includes('--capacity-smoke');
assert.ok(!capacity || mixedOnly, 'Capacity selector requires mixed-only');
assert.ok(!capacitySmoke || capacity, 'Capacity smoke requires capacity selector');
assert.ok(!mixedSmoke || cycles === 1, 'Mixed smoke uses --cycles=1');
assert.ok(!mixedOnly || (cycles === 0 && !mixedSmoke && !modelOnly), 'Mixed-only uses --cycles=0');
assert.ok(
  [0, 1, 30].includes(cycles),
  'Use 0/1 for explicitly incomplete smoke or 30 for acceptance.',
);
const evidence = resolve(
  process.env.HDD_V2_INTEGRATED_EVIDENCE ?? 'artifacts/task-09/run-' + randomUUID().slice(0, 8),
);
const rel = relative(resolve('artifacts/task-09'), evidence);
assert.ok(
  rel && !rel.startsWith('..') && !isAbsolute(rel) && !existsSync(evidence),
  'New Task09 evidence required',
);
mkdirSync(evidence, { recursive: true });
// Only ordinary OS/runtime discovery is inherited. No provider, DB, NODE_OPTIONS or live profile.
const env = {};
for (const name of [
  'PATH',
  'Path',
  'SystemRoot',
  'SYSTEMROOT',
  'WINDIR',
  'COMSPEC',
  'PATHEXT',
  'TEMP',
  'TMP',
  'USERPROFILE',
  'APPDATA',
  'LOCALAPPDATA',
  'PROGRAMDATA',
  'ProgramFiles',
  'ProgramFiles(x86)',
  'HOMEDRIVE',
  'HOMEPATH',
])
  if (process.env[name] !== undefined) env[name] = process.env[name];
env.HDD_V2_ALLOW_LIVE_RPC = 'false';
let serial = 0,
  configuration,
  monitor,
  closeIngress;
const commands = [],
  readSamples = [];
async function execute(binary, args, label, timeout = 900000) {
  const id = String(++serial).padStart(3, '0'),
    start = Date.now();
  const file = join(evidence, `${id}-${label}.log`);
  writeFileSync(file, ''); // A successful quiet process still has a command receipt.
  const child = spawn(binary, args, { env, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
  let tail = '';
  for (const stream of [child.stdout, child.stderr])
    stream.on('data', (b) => {
      appendFileSync(file, b);
      tail = (tail + b.toString()).slice(-4000);
    });
  const timer = setTimeout(() => child.kill(), timeout);
  const code = await new Promise((yes, no) => {
    child.once('error', no);
    child.once('close', yes);
  });
  clearTimeout(timer);
  commands.push({
    binary,
    args,
    label,
    code,
    started: new Date(start).toISOString(),
    ms: Date.now() - start,
  });
  writeFileSync(join(evidence, 'commands.json'), JSON.stringify(commands, null, 2));
  if (code !== 0) throw Error(`${label} exit=${code}: ${tail}`);
  console.log('PASS', label, Date.now() - start, 'ms');
  return readFileSync(file, 'utf8');
}
const environment = join(evidence, 'source environment');
const host = (command, ...args) =>
  execute(process.execPath, ['scripts/operator/host.mjs', command, environment, ...args], command);
const compose = (args, label, extra = []) =>
  execute(
    'docker',
    ['compose', '-p', configuration.project, '-f', 'compose.yaml', ...extra, ...args],
    label,
  );
const runner = (args, label) =>
  compose(['run', '--rm', '-T', 'runner', 'node', ...args], label, ['-f', 'compose.ops-test.yaml']);
const sample = (label) => runner(['tests/integration/setup.mjs', 'sample', label], label);
const state = {
  startDay: Math.floor((Date.now() / 1000 - 1575331200) / 86400) - 54,
  head: 297,
  label: 'bootstrap',
  epoch: Date.now(),
  started: Date.now(),
};
function setControl(values) {
  Object.assign(state, values);
  const path = join(environment, 'input', 'control.json');
  writeFileSync(path + '.tmp', JSON.stringify(state));
  renameSync(path + '.tmp', path);
}
let originalError;
async function run() {
  const socket = net.createServer();
  await new Promise((r) => socket.listen(0, '127.0.0.1', r));
  const port = socket.address().port;
  await new Promise((r) => socket.close(r));
  await host('init', String(port));
  configuration = JSON.parse(readFileSync(join(environment, 'environment.json'), 'utf8'));
  await host('build');
  configuration = JSON.parse(readFileSync(join(environment, 'environment.json'), 'utf8'));
  Object.assign(env, {
    HDD_V2_PROJECT: configuration.project,
    HDD_V2_DB_INSTANCE: configuration.instance,
    HDD_V2_IMAGE: configuration.built,
    HDD_V2_SECRET_DIR: join(environment, 'secrets'),
    HDD_V2_OPERATOR_INPUT: join(environment, 'input'),
    HDD_V2_HOST_PORT: String(port),
    HDD_V2_OPS_EVIDENCE: evidence,
  });
  await host('provision');
  env.HDD_V2_INTEGRATION_API_ENTRY = 'dist/api/main.js';
  await compose(['up', '-d', '--wait', 'api'], 'offline-api-start', [
    '-f',
    'compose.integration-test.yaml',
  ]);
  closeIngress = await ingress((await compose(['ps', '-q', 'api'], 'api-id')).trim(), port);
  const base = 'http://127.0.0.1:' + port;
  const status = await (await fetch(base + '/api/v2/status')).json();
  assert.equal(status.state, 'uninitialized');
  assert.equal(status.productionReady, false);
  setControl({});
  await runner(['tests/integration/worker.mjs', 'bootstrap'], 'raw-bootstrap');
  if (modelOnly) {
    setControl({ head: 537, label: 'model-witness' });
    await runner(['tests/integration/worker.mjs', 'witness'], 'all-cycle-raw-model');
    writeFileSync(
      join(evidence, 'result.json'),
      JSON.stringify({ status: 'MODEL_WITNESS_ONLY', cycles: 30, bulk: false }),
    );
    return;
  }
  await runner(['tests/integration/setup.mjs', 'bulk'], 'large-shape');
  const retained = resolve('artifacts/task-pulsechain-history/input');
  if (existsSync(join(retained, 'hds-pulsechain.json'))) {
    const receipt = JSON.parse(
      readFileSync(join(retained, 'hds-pulsechain.json.receipt.json'), 'utf8'),
    );
    const raw = readFileSync(join(retained, 'hds-pulsechain.json'));
    assert.equal(raw.length, receipt.savedBytes);
    assert.equal(createHash('sha256').update(raw).digest('hex'), receipt.sha256);
    for (const name of [
      'hds-pulsechain.json',
      'hds-pulsechain.json.receipt.json',
      'selection.json',
    ])
      copyFileSync(join(retained, name), join(environment, 'input', name));
    writeFileSync(
      join(environment, 'input/destination.json'),
      JSON.stringify({
        project: configuration.project,
        instance: configuration.instance,
        purpose: 'new-isolated-history-test',
      }),
    );
    await compose(
      [
        'run',
        '--rm',
        '-T',
        'operator',
        'history',
        'import',
        '/input/hds-pulsechain.json',
        '/input/selection.json',
        '/input/destination.json',
        '/input/hds-pulsechain.json.receipt.json',
      ],
      'retained-hds-import',
    );
    writeFileSync(
      join(evidence, 'hds-identity.json'),
      JSON.stringify({ sha256: receipt.sha256, bytes: raw.length, newDownloadRequests: 0 }),
    );
  } else await runner(['tests/integration/setup.mjs', 'history'], 'synthetic-hds-import');
  await sample('baseline');
  const initial = JSON.parse(readFileSync(join(evidence, 'baseline.json'), 'utf8'));
  assert.ok(
    BigInt(initial.counts.stakes) >= 1000000n && BigInt(initial.counts.accounts) >= 500000n,
  );
  let reading = false;
  monitor = setInterval(async () => {
    if (reading) return;
    reading = true;
    const at = performance.now();
    try {
      const r = await fetch(base + '/api/v2/home', { signal: AbortSignal.timeout(5000) });
      const bytes = (await r.arrayBuffer()).byteLength;
      readSamples.push({ at: Date.now(), ms: performance.now() - at, status: r.status, bytes });
    } catch (e) {
      readSamples.push({ at: Date.now(), ms: performance.now() - at, error: e.name });
    } finally {
      reading = false;
    }
  }, 1000);
  let publication = initial.bundles.find((b) => b.slot === 'current');
  if (mixedOnly) {
    // Reuse the same large shape and raw forward path for a focused load recheck.
    // This does not repeat or replace the thirty separate rollover/retention samples.
    setControl({ head: 537, label: 'mixed-prime', started: Date.now(), epoch: Date.now() });
    await runner(['tests/integration/worker.mjs', 'once'], 'mixed-prime');
    await sample('mixed-prime');
    publication = JSON.parse(readFileSync(join(evidence, 'mixed-prime.json'), 'utf8')).bundles.find(
      (b) => b.slot === 'current',
    );
  }
  for (let day = 1; day <= cycles; day++) {
    // Grace is real elapsed time; no publication timestamp is rewritten to accelerate it.
    if (day > 1)
      await pause(Math.max(0, Date.parse(publication.published_at) + 61000 - Date.now()));
    setControl({
      head: 297 + day * 8,
      label: 'cycle-' + String(day).padStart(2, '0'),
      started: Date.now(),
      epoch: (1575331200 + (state.startDay + 24 + day) * 86400) * 1000,
    });
    await runner(['tests/integration/worker.mjs', 'once'], state.label);
    await sample(state.label);
    const result = JSON.parse(readFileSync(join(evidence, state.label + '.json'), 'utf8'));
    assert.equal(result.cursor.block_number, String(296 + day * 8));
    assert.deepEqual(
      result.unchanged,
      initial.unchanged,
      'Unchanged stake is not rewritten with the date',
    );
    assert.deepEqual(
      result.unchangedAccount,
      initial.unchangedAccount,
      'Unchanged account is not rewritten for the date',
    );
    assert.equal(result.state.contract_day, state.startDay + 24 + day);
    const reported = result.markets.filter((r) => r.source === 'delayed-synthetic-market');
    assert.equal(
      reported.find((r) => r.contract_day === state.startDay + 23 + day)?.observation.coverage,
      day === 12 || day === 13 ? 'missing' : 'partial',
      'Declared one-interval bar or explicit market lag',
    );
    if (day === 14)
      for (const offset of [11, 12, 13])
        assert.equal(
          reported.find((r) => r.contract_day === state.startDay + 24 + offset)?.observation
            .coverage,
          'partial',
          'Two-day source lag caught up',
        );
    assert.ok(result.bundles.length <= 2);
    assert.ok(result.files.length <= 2, 'idle current+prior only');
    const next = result.bundles.find((b) => b.slot === 'current');
    assert.ok(
      next && next.status === 'available' && next.id !== publication.id,
      'Every due daily publication produced real new files',
    );
    publication = next;
    if (day === 1) {
      const previous = JSON.parse(readFileSync(join(evidence, 'worker-cycle-01.json'), 'utf8'));
      setControl({ label: 'no-op', epoch: previous.virtualNow + 60001, started: Date.now() });
      await runner(['tests/integration/worker.mjs', 'once'], 'no-op');
      await sample('no-op');
      const noop = JSON.parse(readFileSync(join(evidence, 'no-op.json'), 'utf8'));
      assert.deepEqual(noop.unchanged, result.unchanged);
      assert.deepEqual(noop.unchangedAccount, result.unchangedAccount);
      assert.equal(
        noop.bundles.find((b) => b.slot === 'current').id,
        next.id,
        'No-op did not republish',
      );
    }
  }
  if (cycles === 30 || mixedSmoke || mixedOnly) {
    clearInterval(monitor);
    await closeIngress();
    closeIngress = undefined;
    await compose(['stop', 'api'], 'base-api-stopped');
    const lastWorker = JSON.parse(
      readFileSync(
        join(
          evidence,
          mixedOnly
            ? 'worker-mixed-prime.json'
            : cycles === 1
              ? 'worker-no-op.json'
              : 'worker-cycle-30.json',
        ),
        'utf8',
      ),
    );
    setControl({
      label: 'mixed',
      started: Date.now(),
      // Continue after the preceding virtual quota window; never rewind persistent cooldown time.
      epoch: lastWorker.virtualNow + 60001,
      capacity,
      capacitySmoke,
    });
    env.HDD_V2_INTEGRATION_API_ENTRY = 'tests/integration/api.mjs';
    await compose(['up', '-d', '--wait', 'api', 'worker'], 'mixed-start', [
      '-f',
      'compose.integration-test.yaml',
    ]);
    closeIngress = await ingress((await compose(['ps', '-q', 'api'], 'mixed-api-id')).trim(), port);
    const ids = (await compose(['ps', '-q'], 'runtime-ids')).trim().split(/\s+/);
    const network = JSON.parse(
      await execute(
        'docker',
        ['network', 'inspect', configuration.project + '_private'],
        'runtime-network',
      ),
    )[0];
    assert.equal(network.Internal, true);
    const runtime = JSON.parse(await execute('docker', ['inspect', ...ids], 'runtime-inspect'));
    assert.ok(
      runtime.every((c) =>
        Object.keys(c.NetworkSettings.Networks).every(
          (n) => n === configuration.project + '_private',
        ),
      ),
    );
    await execute(
      'docker',
      [
        'inspect',
        '--format',
        '{{json .Name}} {{json .HostConfig.NanoCpus}} {{json .HostConfig.Memory}} {{json .Config.User}} {{json .HostConfig.ReadonlyRootfs}} {{json .HostConfig.Privileged}}',
        ...ids,
      ],
      'runtime-limits',
    );
    if (mixedSmoke) {
      let home;
      for (let i = 0; i < 150; i++) {
        home = await (await fetch(base + '/api/v2/home')).json();
        if (home.live?.price?.status === 'fresh') break;
        await pause(1000);
      }
      writeFileSync(join(evidence, 'mixed-smoke-home.json'), JSON.stringify(home, null, 2));
      assert.equal(home.live?.price?.status, 'fresh');
      await compose(['stop', 'api', 'worker'], 'mixed-stop', [
        '-f',
        'compose.integration-test.yaml',
      ]);
      return;
    }
    if (capacitySmoke) {
      await execute(
        process.execPath,
        ['tests/integration/load.mjs', base, evidence],
        'capacity-readiness-only',
        300000,
      );
      await closeIngress();
      closeIngress = undefined;
      await compose(['stop', 'api', 'worker'], 'capacity-smoke-stop', [
        '-f',
        'compose.integration-test.yaml',
      ]);
      await sample('capacity-smoke');
      writeFileSync(
        join(evidence, 'result.json'),
        JSON.stringify({ status: 'READINESS_ONLY_NOT_CAPACITY', cycles }),
      );
      return;
    }
    const mixedResults = await Promise.allSettled([
      execute(
        process.execPath,
        ['tests/integration/load.mjs', base, evidence],
        'mixed-load',
        1200000,
      ),
      (async () => {
        await runner(['tests/integration/queries.mjs'], 'mixed-queries');
        if (capacity) {
          while (!existsSync(join(evidence, 'phases.json'))) await pause(1000);
          const phases = JSON.parse(readFileSync(join(evidence, 'phases.json'), 'utf8'));
          await pause(Math.max(0, phases.healthyStartedAt + 120000 - Date.now()));
        } else await pause(Math.max(0, state.started + 120000 - Date.now()));
        try {
          await compose(['run', '--rm', '-T', 'operator', 'exports'], 'mixed-forced-export');
        } catch (error) {
          // The real scheduler may win this race. Keep the refusal receipt and require
          // a different published bundle below; a busy response alone proves no work.
          if (
            !/^mixed-forced-export exit=1: (Export builder already active\.|Publication paused for prior bundle grace\.|Publication paused for active prior readers\.)\s*$/.test(
              error.message,
            )
          )
            throw error;
          writeFileSync(
            join(evidence, 'export-contention.json'),
            JSON.stringify({ expectedRefusal: error.message }),
          );
        }
      })(),
    ]);
    const mixedFailure = mixedResults.find((r) => r.status === 'rejected');
    if (mixedFailure) throw mixedFailure.reason;
    await compose(['logs', '--no-color', '--tail', '60', 'worker'], 'mixed-worker-progress');
    await closeIngress();
    closeIngress = undefined;
    await compose(['stop', 'api', 'worker'], 'mixed-stop', ['-f', 'compose.integration-test.yaml']);
    const workerEvidence = JSON.parse(readFileSync(join(evidence, 'worker-mixed.json'), 'utf8'));
    const apiEvidence = JSON.parse(readFileSync(join(evidence, 'api-mixed.json'), 'utf8'));
    if (capacity) {
      const path = join(evidence, 'capacity.json'),
        result = JSON.parse(readFileSync(path, 'utf8'));
      for (const row of result.rows) {
        const raw = workerEvidence.requests.filter(
          (r) => r.id === 'api' && r.address === row.path.split('/').at(-1),
        );
        row.work = {
          http: raw.length,
          logical: raw.reduce((n, r) => n + r.logical, 0),
          bytes: raw.reduce((n, r) => n + r.bytes, 0),
        };
        assert.ok(row.work.http <= 4 && row.work.logical <= 128);
      }
      writeFileSync(path, JSON.stringify(result, null, 2));
    }
    const dispatches = [
      ...workerEvidence.budget.dispatches,
      ...apiEvidence.dispatch.dispatches,
    ].sort((a, b) => a.at - b.at);
    const rpc = [...workerEvidence.budget.rpc, ...apiEvidence.dispatch.rpc];
    let activeHttp = 0,
      combinedInflightPeak = Math.max(
        workerEvidence.budget.inflightPeak,
        apiEvidence.dispatch.inflightPeak,
      );
    for (const event of dispatches
      .filter((r) => r.ended > r.at)
      .flatMap((r) => [
        { at: r.at, delta: 1 },
        { at: r.ended, delta: -1 },
      ])
      .sort((a, b) => a.at - b.at || a.delta - b.delta)) {
      activeHttp += event.delta;
      combinedInflightPeak = Math.max(combinedInflightPeak, activeHttp);
    }
    assert.ok(combinedInflightPeak <= 2);
    const rawBytes = workerEvidence.requests.reduce((n, r) => n + r.bytes, 0);
    assert.equal(
      rpc.reduce((n, r) => n + r.bytes, 0),
      rawBytes,
      'Decoded RPC bytes reconcile with raw transports',
    );
    assert.equal(
      rpc.reduce((n, r) => n + r.requests, 0),
      dispatches.length,
    );
    writeFileSync(
      join(evidence, 'transport-summary.json'),
      JSON.stringify(
        {
          rawBytes,
          rpc,
          minimumSpacing: Math.min(...dispatches.slice(1).map((r, i) => r.at - dispatches[i].at)),
          inflight: {
            api: apiEvidence.dispatch.inflightPeak,
            worker: workerEvidence.budget.inflightPeak,
            combinedUpperBound: 2,
            combinedObservedPeak: combinedInflightPeak,
          },
        },
        null,
        2,
      ),
    );
    const peaks = {};
    for (const [lane, http, logical] of [
      ['all', 42, 900],
      ['address', 24, 360],
      ['metrics', 6, 180],
      ['sync', 12, 360],
    ]) {
      const rows = dispatches.filter((r) => lane === 'all' || r.lane === lane);
      let httpPeak = 0,
        logicalPeak = 0;
      for (const row of rows) {
        const window = rows.filter((r) => r.at <= row.at && r.at > row.at - 60000);
        httpPeak = Math.max(httpPeak, window.length);
        logicalPeak = Math.max(
          logicalPeak,
          window.reduce((n, r) => n + r.logical, 0),
        );
      }
      assert.ok(httpPeak <= http && logicalPeak <= logical, `${lane} rolling quota`);
      peaks[lane] = {
        httpPeak,
        logicalPeak,
        attempts: rows.length,
        logical: rows.reduce((n, r) => n + r.logical, 0),
      };
    }
    for (const meter of [workerEvidence.budget, apiEvidence.dispatch]) {
      assert.equal(meter.inflightPeak, 1);
      assert.equal(
        meter.dispatches.length,
        meter.counters.reduce((n, c) => n + c.attempts, 0),
      );
      assert.equal(
        meter.dispatches.reduce((n, r) => n + r.logical, 0),
        meter.counters.reduce((n, c) => n + c.logical, 0),
      );
      assert.ok(meter.counters.every((c) => c.queuePeak <= 8));
    }
    writeFileSync(join(evidence, 'budget-summary.json'), JSON.stringify(peaks, null, 2));
    assert.ok(
      dispatches.slice(1).every((row, i) => row.at - dispatches[i].at >= 1300),
      'Combined actual spacing',
    );
    assert.equal(
      workerEvidence.requests.length,
      dispatches.length,
      'Raw transport reconciles all physical charges',
    );
    assert.equal(
      workerEvidence.requests.reduce((n, r) => n + r.logical, 0),
      dispatches.reduce((n, r) => n + r.logical, 0),
    );
    await sample('retained');
    const retained = JSON.parse(readFileSync(join(evidence, 'retained.json'), 'utf8'));
    assert.ok(
      BigInt(retained.cursor.block_number) > 536n,
      'Mixed worker committed forward progress',
    );
    const current = retained.bundles.find((b) => b.slot === 'current');
    assert.ok(
      current?.status === 'available' && current.id !== publication.id,
      'Mixed scheduling published real new files',
    );
    assert.ok(
      retained.bundles.length <= 2 && retained.files.length <= 2,
      'Mixed idle retention remains bounded',
    );
  }
  writeFileSync(
    join(evidence, 'result.json'),
    JSON.stringify(
      {
        status:
          cycles === 30 ? 'CHECKS_COMPLETED' : mixedOnly ? 'MIXED_ONLY_COMPLETED' : 'SMOKE_ONLY',
        cycles,
        project: configuration.project,
        instance: configuration.instance,
        image: configuration.built,
        readSamples,
        allocation: '2 CPU / 4 GiB combined; browser/load/build/control outside',
        canonicalLimit: 'Large SQL shape has no raw historical provenance or full seed audit',
        live: 'NOT_RUN',
      },
      null,
      2,
    ),
  );
}
try {
  await run();
} catch (e) {
  originalError = e;
  writeFileSync(join(evidence, 'failure.txt'), e.stack);
  console.error(e.message);
  process.exitCode = 1;
} finally {
  clearInterval(monitor);
  if (closeIngress) await closeIngress();
  writeFileSync(join(evidence, 'home-during-cycles.json'), JSON.stringify(readSamples, null, 2));
  if (configuration)
    try {
      await host('destroy', configuration.project);
      writeFileSync(
        join(evidence, 'cleanup.json'),
        JSON.stringify({
          project: configuration.project,
          status: 'removed owned project and volumes',
          priorResourcesTouched: false,
        }),
      );
    } catch (e) {
      writeFileSync(join(evidence, 'cleanup-failure.txt'), e.stack);
      process.exitCode = 1;
      if (!originalError) console.error(e.message);
    }
}
