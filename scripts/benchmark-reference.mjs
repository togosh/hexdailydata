// Narrow candidate-only CLI. Default/status are local; run delegates to one finite native owner.
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { resolve, join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import {
  validatePage,
  mergeCandles,
  edgeRequest,
  analyze,
} from '../dist/history-bootstrap/benchmark-reference.js';
import { hash } from '../dist/history-bootstrap/normalize.js';
const W = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const read = async (p) => JSON.parse(await readFile(p, 'utf8'));
const put = (p, v) => writeFile(p, JSON.stringify(v, null, 2) + '\n', { flag: 'wx' });
export async function validate(root, attemptFolder) {
  const q = await read(join(attemptFolder, 'request.json')),
    state = await read(join(root, 'session/ACCOUNTING.json'));
  const old = [];
  for (const n of state.acceptedAttempts)
    old.push(await read(join(root, 'session', String(n).padStart(2, '0'), 'VALIDATION.json')));
  const page = validatePage(
    await readFile(join(attemptFolder, 'response.body')),
    q.logical,
    q.attempt,
  );
  // Check duplicates across all prior accepted pages before any next dispatch.
  mergeCandles([...old.flatMap((p) => p.candles), ...page.candles]);
  const scope = await read(join(root, 'SCOPE.json'));
  const alternative = scope.network.conditionalRequests.find((c) => c.asset === q.logical.asset);
  const edge = edgeRequest(q.logical.asset, [...old, page], alternative.alternatives);
  await put(join(attemptFolder, 'VALIDATION.json'), { ...page, conditionalEdge: edge });
  return {
    continueAcquisition: page.coverage.continueAcquisition,
    conditionalEdge: edge?.id ?? null,
  };
}
export async function analyzeSaved(root) {
  const state = await read(join(root, 'session/ACCOUNTING.json')),
    inputs = await read(join(root, 'INPUTS.json'));
  const hdsRaw = await readFile(join(root, 'inputs/data/BENCHMARK_HISTORY.json'));
  const expected = inputs.archives[0].members.find((m) => m.path === 'data/BENCHMARK_HISTORY.json');
  if (hash(hdsRaw) !== expected.sha256) throw Error('HDS_INPUT_CHANGED');
  const pages = [];
  for (const n of state.acceptedAttempts) {
    const directory = join(root, 'session', String(n).padStart(2, '0'));
    const q = await read(join(directory, 'request.json'));
    const page = validatePage(await readFile(join(directory, 'response.body')), q.logical, n);
    const captured = await read(join(directory, 'VALIDATION.json'));
    const { conditionalEdge, ...original } = captured;
    if (JSON.stringify(page) !== JSON.stringify(original)) throw Error('SAVED_PAGE_CHANGED');
    pages.push(page);
  }
  const result = analyze(
    pages.flatMap((p) => p.candles),
    JSON.parse(hdsRaw),
    inputs.heldHdsCells,
  );
  const out = join(root, 'candidate');
  await mkdir(out, { recursive: true });
  await put(
    join(out, 'DAILY_CANDLES.json'),
    result.candles.filter((c) => c.step === 86400),
  );
  await put(
    join(out, 'HOURLY_CANDLES.json'),
    result.candles.filter((c) => c.step === 3600),
  );
  await writeFile(
    join(out, 'COMPARISONS.ndjson'),
    result.comparisons.map((c) => JSON.stringify(c) + '\n').join(''),
    { flag: 'wx' },
  );
  await put(join(out, 'GAP_CANDIDATES.json'), result.gaps);
  await put(join(out, 'COVERAGE_AND_COMPARISON.json'), {
    domain: result.domain,
    assets: result.assets,
    sessionStatus: state.status,
    sessionOutcome: state.outcome,
    exactTradeTimes: 'unknown',
    productPublication: false,
  });
  await put(join(root, 'evidence/ANALYSIS.json'), {
    status: 'PASS',
    deterministicReplay: true,
    acceptedPages: pages.length,
    sourceRows: pages.reduce((n, p) => n + p.rawOrder.length, 0),
    uniqueCandles: result.candles.length,
    comparisons: result.comparisons.length,
    hdsSha256: hash(hdsRaw),
    publication: false,
  });
  return {
    acceptedPages: pages.length,
    uniqueCandles: result.candles.length,
    comparisons: result.comparisons.length,
  };
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const [command, folder, attempt] = process.argv.slice(2),
    root = folder ? resolve(folder) : null;
  if (command === 'validate' && root && attempt)
    console.log(JSON.stringify(await validate(root, resolve(attempt))));
  else if (command === 'analyze' && root) console.log(JSON.stringify(await analyzeSaved(root)));
  else if (command === 'run' && root) {
    const p = spawnSync(
      'python',
      ['-I', '-S', join(W, 'scripts/benchmark-reference/collector.py'), 'run', root],
      { stdio: 'inherit' },
    );
    process.exitCode = p.status ?? 2;
  } else if (command === 'status' && root)
    console.log(
      await read(join(root, 'session/ACCOUNTING.json')).catch((e) =>
        e.code === 'ENOENT' ? { status: 'UNUSED' } : Promise.reject(e),
      ),
    );
  else
    console.log(
      'No default requests or writes. Candidate-only: status ROOT; reviewed finite run ROOT; offline analyze ROOT. No publication.',
    );
}
