// Genuine seed restored once; all changed values below live only in a derived synthetic root.
import assert from 'node:assert/strict';
import { readFile, writeFile, mkdir, mkdtemp, lstat } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { spawn } from 'node:child_process';
import { keccak_256 } from '@noble/hashes/sha3.js';
import {
  SavedSourceGenerations,
  sha,
  canonical,
} from '../../dist/services/source-update/generation.js';
import { ACCEPTED } from '../../dist/contracts/saved-generation.js';
import { ParticipantRegistry } from '../../dist/services/source-update/refresh.js';
import { restoreParticipants } from '../../scripts/participant-refresh-backup.mjs';
import { deriveFixture } from '../unified-refresh/fixture-state.mjs';
import {
  applyMarketUpdate,
  marketEvidence,
  marketCheckpoints,
  preserveMarketHistory,
} from '../../dist/services/product-daily/market.js';
import { runJob } from '../../scripts/refresh-data.mjs';
import { fixture, auth, keys, wire, until } from '../market-feed/access-fixture.mjs';
import { PageCursors } from '../../dist/services/queries/cursor.js';
import { ProductQuery, ReadingSchema } from '../../dist/contracts/product-daily.js';
const R = process.env.HDD_TASK_ROOT;
assert(R?.endsWith('btc-eth-reference-feed-r1'));
const save = (name, v) =>
  writeFile(join(R, 'evidence', name + '.json'), JSON.stringify(v, null, 2) + '\n');
const root = await mkdtemp(join(R, 'temp/composed-'));
const receipt = { root, synthetic: true, externalRequests: 0, cases: [] };
let base, real, reg, reader, f, unblock;
const leases = [],
  actualDateNow = Date.now;
function snapshot(reg) {
  const h = reg.capture();
  try {
    return h.product;
  } finally {
    h.release();
  }
}
async function product(reg, update) {
  const result = await reg.publishProduct(update);
  await reg.refresh(undefined, true);
  assert.equal(reg.status().error, null);
  return result;
}
try {
  const selectors = {};
  for (const s of ['decimals()', 'description()', 'aggregator()', 'latestRoundData()'])
    selectors[s] =
      '0x' +
      Buffer.from(keccak_256(new TextEncoder().encode(s)))
        .toString('hex')
        .slice(0, 8);
  assert.deepEqual(selectors, JSON.parse(await readFile(join(R, 'SCOPE.json'))).callSelectors);
  receipt.selectors = selectors;
  const profile = JSON.parse(await readFile(join(R, 'reference/ACCEPTED_PROFILE.json')));
  base = await SavedSourceGenerations.activate({
    root: profile.overlayRoot,
    holdersRoot: profile.holdersRoot,
    stakesRoot: profile.stakesRoot,
  });
  await base.admit(join(base.root, ACCEPTED.generation), { readOnly: true });
  await base.loadSelection();
  const existing = await lstat(join(R, 'runtime')).catch((e) => {
    if (e.code === 'ENOENT') return null;
    throw e;
  });
  if (existing)
    real = await ParticipantRegistry.open(
      join(R, 'runtime/participants'),
      join(R, 'runtime/product'),
      base,
    );
  else {
    const restored = await restoreParticipants(
      join(R, 'seed-backup'),
      join(R, 'runtime'),
      'd732988f0169d1d82452a1e8b11f8db3ef21231f86131650ea72343509ab9627',
      base,
    );
    real = restored.registry;
    await save('GENUINE_SEED_RESTORE', restored.receipt);
    await writeFile(
      join(R, 'PROFILE.json'),
      JSON.stringify(
        { ...profile, participantRoot: real.root, productRoot: real.productDaily.root },
        null,
        2,
      ) + '\n',
      { flag: 'wx' },
    );
  }
  const seed = snapshot(real);
  assert.equal(seed.rows.length, 2503);
  assert.equal(seed.metadata.coverage.ledgerDates, 2502);
  assert.equal(seed.metadata.liquidityHistory.length, 90);
  assert.equal(sha(seed.csv), 'c737116e166e17c92428fe014e7dc3ee972c83b7b9b246477f0293d30f2a34c5');
  await save('ADMITTED_SEED', {
    version: seed.version,
    manifestSha256: seed.manifestSha256,
    pair: seed.metadata.pair,
    coverage: seed.metadata.coverage,
    readings: seed.metadata.readings,
    rows: seed.rows.length,
    csvSha256: sha(seed.csv),
  });
  reg = await deriveFixture(real, join(root, 'synthetic'), base);
  reader = await ParticipantRegistry.open(reg.root, reg.productDaily.root, base);
  f = await fixture({
    participants: reader,
    productDaily: reader.productDaily,
    sourceGenerations: base,
  });
  f.controls.now = Date.now();
  const hold = reader.capture();
  leases.push(hold);
  const original = snapshot(reg),
    cursors = new PageCursors();
  const query = ProductQuery.parse({ from: '2026-10-01', to: '2026-10-10', limit: '1' });
  const oldPage = reader.productDaily.read(
    hold.product,
    query,
    'daily',
    cursors,
    Date.now(),
    'public',
  );
  assert(oldPage.nextCursor);
  const beforeApi = await wire(f.app, '/api/v2/live');
  assert.equal(beforeApi.statusCode, 200);
  const maxTime = Math.max(...original.metadata.readings.map((r) => Date.parse(r.observedAtUtc)));
  const refs = ['BTC', 'ETH'].map((asset, i) => ({
    kind: 'reference',
    asset,
    quote: 'USD',
    chainId: 1,
    observation: 'oracle-reference',
    method: 'chainlink-standard-usd-1',
    roundId: '90',
    value: i ? '3000.12345678' : '60000.12345678',
    observedAtUtc: new Date(maxTime - (600 + i * 20) * 1000).toISOString(),
  }));
  const update = {
    readings: refs,
    liquidityHistory: [],
    receiptSha256: sha('synthetic independent stale pair'),
  };
  for (const r of refs) {
    ReadingSchema.parse(r);
    assert(!ReadingSchema.safeParse({ ...r, chainId: 369 }).success);
    assert(!ReadingSchema.safeParse({ ...r, observation: 'spot' }).success);
  }
  // Both staged readings must remain invisible until a coordinated commit.
  const pending = applyMarketUpdate(
    { rows: original.rows, metadata: original.metadata, exceptions: [] },
    update,
  );
  assert.equal((await f.inject('/api/v2/live')).json().btcPriceUsd, null);
  assert.equal(pending.metadata.effectiveAtUtc, original.metadata.effectiveAtUtc);
  const first = await product(reg, update);
  assert(first.changed);
  await reader.refresh(undefined, true);
  assert.equal(reader.status().error, null);
  assert.equal(reader.status().productVersion, first.selected.version);
  let live = (await f.inject('/api/v2/live')).json();
  assert.equal(live.btcPriceUsd, refs[0].value);
  assert.equal(live.freshness.BTC.observedAtUtc, refs[0].observedAtUtc);
  assert.equal(live.freshness.BTC.status, 'stale');
  const selected = snapshot(reg);
  preserveMarketHistory(original, selected);
  for (const k of ['pair', 'liquidityHistory', 'ledgerSegments'])
    assert.deepEqual(selected.metadata[k], original.metadata[k]);
  assert.deepEqual(
    selected.metadata.readings.filter((r) => r.kind !== 'reference'),
    original.metadata.readings,
  );
  const allowed = new Set(['btcPriceUsd', 'ethPriceUsd', 'btcRecordedAtUtc', 'ethRecordedAtUtc']);
  let comparisons = 0;
  for (const row of original.rows) {
    const got = selected.rows.find((r) => r.dateUtc === row.dateUtc);
    for (const [k, v] of Object.entries(row))
      if (!allowed.has(k)) {
        assert.deepEqual(got[k], v);
        comparisons++;
      }
  }
  for (const r of refs) {
    const row = selected.rows.find((x) => x.dateUtc === r.observedAtUtc.slice(0, 10));
    assert.equal(row[r.asset === 'BTC' ? 'btcPriceUsd' : 'ethPriceUsd'], r.value);
  }
  assert.equal((await product(reg, update)).changed, false);
  assert.equal(reg.status().productVersion, selected.version);
  const bad = { ...update, readings: [{ ...refs[0], value: '1' }, refs[1]] };
  await assert.rejects(reg.publishProduct(bad), /CONFLICT/);
  await reg.recoverOwnedFailure();
  assert.equal(reg.status().productVersion, selected.version);
  await assert.rejects(reg.publishProduct({ ...update, readings: [refs[0]] }), /REFERENCE/);
  await reg.recoverOwnedFailure();
  const afterApi = await f.inject('/api/v2/live');
  assert.notEqual(afterApi.headers.etag, beforeApi.headers.etag);
  assert.throws(() =>
    reader.productDaily.read(
      reader.productDaily.capture(),
      { ...query, cursor: oldPage.nextCursor },
      'daily',
      cursors,
      Date.now(),
      'public',
    ),
  );
  receipt.cases.push({
    case: 'paired stale references, unchanged global clock, preserved all other fields, idempotence, conflict/half-pair refusal, cursor/ETag separation',
    comparisons,
  });
  // Actual native IPC coordinator + the real saved auditor/publisher. Synthetic network only.
  const jobRoot = join(root, 'native');
  await mkdir(jobRoot);
  await mkdir(join(jobRoot, 'temp'));
  const admission = {
    task: 'HDD-BTC-ETH-REFERENCE-FEED-R1',
    family: 'reference',
    job: 'reference-two-cycles',
    jobRoot,
    synthetic: true,
  };
  await writeFile(join(jobRoot, 'ADMISSION.json'), JSON.stringify(admission));
  const native = await runJob({
    jobRoot,
    admission,
    registry: reg,
    deadline: performance.now() + 180000,
    spawnChild: (_exe, _args, options) =>
      spawn('python', ['-I', '-S', resolve('tests/reference-feed/native-fixture.py'), jobRoot], {
        ...options,
        env: { ...options.env, HDD_TASK_ROOT: R },
      }),
    onAdoption: async (selected, check) => {
      await new Promise((r) => setTimeout(r, 1100));
      f.controls.now = Date.now();
      const response = await f.inject('/api/v2/live');
      assert.equal(response.statusCode, 200, response.body);
      assert.equal(response.json().datasetVersion, selected.product.version);
      check();
      return { live: response.json(), pid: process.pid };
    },
  });
  assert.equal(native.status, 'QUALIFIED_ADOPTED', JSON.stringify(native));
  assert.equal(native.publications[0].publication.changed, true);
  assert.equal(native.publications[1].publication.changed, false);
  assert.equal(native.source.accounting.attempts, 62);
  receipt.native = native;
  const postNative = snapshot(reg);
  const refRows = postNative.metadata.readings.filter((r) => r.kind === 'reference');
  // A later permitted old-family synthetic update must retain both reference keys/times.
  const gas = postNative.metadata.readings.find((r) => r.kind === 'gas');
  const nextGas = {
    ...gas,
    gasPriceWei: String(BigInt(gas.gasPriceWei) + 1n),
    observedAtUtc: new Date(Date.now() - 1000).toISOString(),
  };
  await product(reg, {
    readings: [nextGas],
    liquidityHistory: [],
    receiptSha256: sha('synthetic gas after references'),
  });
  await reader.refresh(undefined, true);
  assert.deepEqual(
    snapshot(reg).metadata.readings.filter((r) => r.kind === 'reference'),
    refRows,
  );
  assert.equal(hold.sourceGenerations.selection, original.metadata.pair.generation);
  assert.deepEqual(hold.product.csv, original.csv);
  const stream = reader.productDaily.openExport(
      hold.product,
      hold.product.bundleId,
      'daily',
      new AbortController().signal,
    ),
    chunks = [];
  for await (const b of stream.stream) chunks.push(b);
  await stream.released;
  assert.deepEqual(Buffer.concat(chunks), original.csv);
  hold.release();
  const abort = new AbortController(),
    cancelled = reader.productDaily.openExport(
      reader.productDaily.capture(),
      reader.productDaily.capture().bundleId,
      'daily',
      abort.signal,
    );
  cancelled.stream.on('error', () => {});
  abort.abort();
  await cancelled.released;
  receipt.cases.push(
    'native two-cycle adoption/no-op, same running API, gas preserves reference pair; held compatible CSV and cancellation',
  );
  let reads = 0;
  const refresh = reader.refresh.bind(reader);
  reader.refresh = async (...a) => {
    reads++;
    return refresh(...a);
  };
  for (const key of [keys.invalid, keys.revoked]) {
    const n = reads;
    assert.equal((await f.inject({ url: '/api/v2/live', headers: auth(key) })).statusCode, 401);
    assert.equal(reads, n);
  }
  const current = snapshot(reg),
    down = '/api/v2/downloads/' + current.bundleId + '/daily';
  assert([401, 403].includes((await f.inject(down)).statusCode));
  for (const url of [
    '/api/v2/live',
    '/api/v2/home',
    '/api/v2/daily?from=2026-10-01&to=2026-10-10',
    down,
  ]) {
    const g = await f.inject({ url, headers: auth() });
    assert.equal(g.statusCode, 200, g.body.slice(0, 100));
    const h = await f.inject({ url, method: 'HEAD', headers: auth() });
    assert.equal(h.statusCode, 200);
    assert.equal(h.body, '');
    assert.equal(h.headers.etag, g.headers.etag);
    assert.equal(
      (await f.inject({ url, headers: { ...auth(), 'if-none-match': g.headers.etag } })).statusCode,
      304,
    );
    assert.equal(
      (await f.inject({ url, headers: { ...auth(keys.invalid), 'if-none-match': g.headers.etag } }))
        .statusCode,
      401,
    );
  }
  assert.equal((await f.inject({ url: down, headers: auth() })).body, current.csv.toString());
  for (const p of ['/data/daily.csv', '/participants/CURRENT.json'])
    assert.equal((await f.inject(p)).statusCode, 404);
  for (const p of ['source', 'view', 'generation'])
    assert.equal((await f.inject('/api/v2/live?' + p + '=x')).statusCode, 400);
  // Actual request-held address survives a product-only update without closing its shared reader.
  const holder = await base.holders.rowAt(1, new AbortController().signal),
    url = '/api/v2/addresses/' + holder.reported.holderAddress;
  const before = (await f.inject(url)).json(),
    h = reader.capture(),
    source = h.sourceGenerations;
  h.release();
  const lookup = source.holderByAddress.bind(source);
  let entered = false,
    once = true;
  const gate = new Promise((r) => (unblock = r));
  source.holderByAddress = async (...a) => {
    if (once) {
      once = false;
      entered = true;
      await gate;
    }
    return lookup(...a);
  };
  const heldAddress = wire(f.app, url);
  await until(() => entered);
  await product(reg, {
    readings: [{ ...nextGas, observedAtUtc: new Date(Date.now()).toISOString() }],
    liquidityHistory: [],
    receiptSha256: sha('synthetic held-address update'),
  });
  unblock();
  const after = await heldAddress;
  assert.equal(after.statusCode, 200);
  assert.deepEqual(JSON.parse(after.body), before);
  source.holderByAddress = lookup;
  receipt.cases.push(
    'access-before-read; paid GET/HEAD/304; invalid keys; static CSV protection; held actual address through reference-compatible publication',
  );
  // One small 511/512 boundary in the actual reducer. Quiet references survive compaction.
  const rotation = snapshot(reg),
    meta = structuredClone(rotation.metadata),
    gasReadings = [];
  const firstTime = Math.max(...meta.readings.map((r) => Date.parse(r.observedAtUtc))) + 1000;
  Date.now = () => firstTime + 600000;
  for (let i = 0; i < 511; i++)
    gasReadings.push({ ...nextGas, observedAtUtc: new Date(firstTime + i * 1000).toISOString() });
  meta.marketStorage.checkpoints = marketCheckpoints(marketEvidence(meta));
  meta.observations = gasReadings;
  // Keep checkpoints strictly behind the synthetic recent window and recompute latest values.
  meta.readings = [...meta.readings.filter((r) => r.kind !== 'gas'), gasReadings.at(-1)].sort(
    (a, b) => {
      const key = (r) => (r.kind === 'reference' ? 'market:' + r.asset : r.kind);
      return key(a).localeCompare(key(b));
    },
  );
  const a = applyMarketUpdate(
    { rows: rotation.rows, metadata: meta, exceptions: [] },
    {
      readings: [{ ...nextGas, observedAtUtc: new Date(firstTime + 511000).toISOString() }],
      liquidityHistory: [],
      receiptSha256: sha('synthetic 512'),
    },
  );
  assert.equal(a.metadata.observations.length, 512);
  const b = applyMarketUpdate(a, {
    readings: [{ ...nextGas, observedAtUtc: new Date(firstTime + 512000).toISOString() }],
    liquidityHistory: [],
    receiptSha256: sha('synthetic rotation'),
  });
  assert.equal(b.metadata.observations.length, 1);
  assert.deepEqual(
    b.metadata.readings.filter((r) => r.kind === 'reference'),
    refRows,
  );
  marketEvidence(b.metadata);
  receipt.cases.push('511/512 active-window boundary; exact quiet BTC/ETH checkpoints retained');
  assert.equal(snapshot(real).version, seed.version);
  assert.equal(sha(snapshot(real).csv), sha(seed.csv));
  receipt.status = 'PASS';
} catch (e) {
  receipt.status = 'FAIL';
  receipt.failure = String(e.stack ?? e);
  throw e;
} finally {
  Date.now = actualDateNow;
  if (unblock) unblock();
  for (const h of leases) h.release();
  if (f) await f.close();
  if (reader) await reader.close();
  if (reg) await reg.close();
  if (real) await real.close();
  if (base) await base.close();
  receipt.closed = true;
  await save('COMPOSED_' + root.split(/[\\/]/).at(-1), receipt);
}
console.log(JSON.stringify({ status: receipt.status, root, cases: receipt.cases }));
