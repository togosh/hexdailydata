// Spawned Python stdio and actual maintained orchestration, synthetic fixture transport only.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { readFile, writeFile, mkdtemp, lstat } from 'node:fs/promises';
import { join, resolve, basename } from 'node:path';
import { hash } from '../../dist/history-bootstrap/normalize.js';
import {
  ProductDailyStore,
  writeProductGeneration,
} from '../../dist/services/product-daily/store.js';
import { runRefresh, main } from '../../scripts/market-refresh.mjs';
import { fixture } from '../market-feed/access-fixture.mjs';
const R = process.env.HDD_TASK_ROOT,
  W = resolve('.'),
  profile = JSON.parse(await readFile(join(R, 'PRODUCT_PROFILE.json'))),
  ptr = (({ version, manifestSha256 }) => ({ version, manifestSha256 }))(
    JSON.parse(await readFile(join(R, 'INPUTS.json'))).selectedSmallGeneration,
  );
const seed = { ...ptr, files: {} };
for (const n of [
  'MANIFEST.json',
  'daily.ndjson',
  'daily.csv',
  'metadata.json',
  'exceptions.ndjson',
])
  seed.files[n] = await readFile(join(profile.productRoot, ptr.version, n));
const original = JSON.parse(await readFile(join(R, 'evidence/PREFLIGHT_CANDIDATE_2.json'))),
  records = [];
for (const fail of [false, true]) {
  const d = await mkdtemp(join(R, 'scratch/ipc-')),
    productRoot = join(d, 'product'),
    output = join(d, 'session'),
    profilePath = join(d, 'PROFILE.json'),
    preflightPath = join(d, 'PREFLIGHT.json');
  await writeProductGeneration(productRoot, seed);
  const writer = new ProductDailyStore(productRoot, profile.pair);
  await writer.select(ptr);
  await writeFile(profilePath, JSON.stringify({ ...profile, productRoot }));
  const base = await readFile(join(R, 'evidence/BASE_PIN.json'));
  await writeFile(join(d, 'BASE_PIN.json'), base);
  const pre = {
    ...original,
    verdict: 'PASS',
    synthetic: true,
    profilePath,
    profileSha256: hash(await readFile(profilePath)),
    trialRoot: output,
    productRoot,
    runtimeFiles: {},
    sourceFiles: {},
  };
  for (const p of Object.keys(original.runtimeFiles))
    pre.runtimeFiles[p] = hash(await readFile(join(W, p)));
  for (const p of Object.keys(original.sourceFiles))
    pre.sourceFiles[p] = hash(await readFile(join(W, 'scripts/market-refresh', p)));
  await writeFile(preflightPath, JSON.stringify(pre));
  // Public CLI cannot consume a synthetic PASS; only this explicit in-process transport seam can.
  await assert.rejects(
    main(['trial', '--profile', profilePath, '--output', output, '--preflight', preflightPath]),
    /SYNTHETIC_BINDING/,
  );
  const reader = new ProductDailyStore(productRoot, profile.pair);
  await reader.load();
  const f = await fixture({ productDaily: reader });
  let spawned = 0;
  const adopted = [];
  const run = await runRefresh(
    { mode: fail ? 'once' : 'trial', profilePath, output, preflightPath },
    {
      testLaunchCollector: (exe, args, opts) => {
        spawned++;
        assert.equal(exe, 'python');
        assert(args[2].endsWith('collector.py'));
        return spawn(
          exe,
          [...args.slice(0, 2), join(W, 'tests/market-refresh/ipc-fixture.py'), ...args.slice(3)],
          { ...opts, env: { ...opts.env, HDD_TASK_ROOT: R } },
        );
      },
      onBegin: async () => {
        if (fail) throw Error('SYNTHETIC_CONTROLLER_REFUSAL');
      },
      onPublished: async (receipt) => {
        await reader.refresh(performance.now() + 10000 + receipt.cycle * 2000);
        const response = await f.inject('/api/v2/live');
        assert.equal(response.statusCode, 200);
        assert.equal(response.json().datasetVersion, receipt.selected.version);
        adopted.push(response.json().datasetVersion);
        return { status: 'SYNTHETIC_ADOPTED' };
      },
    },
  );
  await f.close();
  assert.equal(spawned, 1);
  if (fail) {
    assert.equal(run.status, 'PARTIAL');
    assert.equal(run.collector.accounting.attempts, 0);
    assert.equal(run.publications.length, 0);
  } else {
    assert.equal(run.status, 'COMPLETE_FINITE_TRIAL');
    assert.equal(run.exit.code, 0);
    assert.equal(new Set(adopted).size, 3);
    assert.equal(run.collector.accounting.attempts, 148);
  }
  for (const n of ['SELECTION.lock', 'MARKET_REFRESH.lock'])
    assert.equal(
      await lstat(join(productRoot, n)).catch((e) => {
        if (e.code === 'ENOENT') return null;
        throw e;
      }),
      null,
    );
  records.push({
    directory: d,
    status: run.status,
    nativeExit: run.exit,
    adopted,
    attempts: run.collector.accounting.attempts,
    synthetic: true,
  });
}
await writeFile(
  join(R, 'evidence/IPC_COMPOSED_' + basename(records[0].directory) + '.json'),
  JSON.stringify({ status: 'PASS', networkRequests: 0, fullBaseAdmissions: 0, records }, null, 2) +
    '\n',
  { flag: 'wx' },
);
console.log(JSON.stringify({ status: 'PASS', records }));
