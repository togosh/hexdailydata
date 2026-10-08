// Actual small selected dataset + synthetic current responses; no bulk reader admission.
import assert from 'node:assert/strict';
import { readFile, writeFile, mkdir, mkdtemp, open, lstat, unlink } from 'node:fs/promises';
import { join, basename } from 'node:path';
import { hash } from '../../dist/history-bootstrap/normalize.js';
import { applyMarketUpdate, mergeObservations } from '../../dist/services/product-daily/market.js';
import { productFiles } from '../../dist/services/product-daily/project.js';
import {
  ProductDailyStore,
  writeProductGeneration,
} from '../../dist/services/product-daily/store.js';
import { ProductQuery } from '../../dist/contracts/product-daily.js';
import { PageCursors } from '../../dist/services/queries/cursor.js';
import { publishCycle, main } from '../../scripts/market-refresh.mjs';
import { fixture, auth, keys, cookie, until } from '../market-feed/access-fixture.mjs';
const R = process.env.HDD_TASK_ROOT,
  profile = JSON.parse(await readFile(join(R, 'PRODUCT_PROFILE.json'))),
  selected = (({ version, manifestSha256 }) => ({ version, manifestSha256 }))(
    JSON.parse(await readFile(join(R, 'INPUTS.json'))).selectedSmallGeneration,
  );
await mkdir(join(R, 'scratch'), { recursive: true });
const dir = await mkdtemp(join(R, 'scratch/publication-'));
const files = { ...selected, files: {} };
for (const n of [
  'MANIFEST.json',
  'daily.ndjson',
  'daily.csv',
  'metadata.json',
  'exceptions.ndjson',
])
  files.files[n] = await readFile(join(profile.productRoot, selected.version, n));
const pointer = ({ version, manifestSha256 }) => ({ version, manifestSha256 });
async function setup(name) {
  const root = join(dir, name);
  await writeProductGeneration(root, files);
  const s = new ProductDailyStore(root, profile.pair);
  await s.select(selected);
  return s;
}
const writer = await setup('normal'),
  reader = new ProductDailyStore(writer.root, profile.pair);
await reader.load();
const old = reader.capture(),
  exceptions = files.files['exceptions.ndjson'].toString().trim().split('\n').map(JSON.parse),
  base = { ...old, exceptions };
const composed = JSON.parse(await readFile(join(R, 'evidence/COMPOSED_CLIENT.json'))),
  output = join(dir, 'checked-input');
await mkdir(output);
for (let n = 1; n <= 3; n++)
  for (const suffix of ['UPDATE', 'AUDIT', 'SEALED'])
    await writeFile(
      join(output, `ROUND_${n}_${suffix}.json`),
      await readFile(join(composed.root, `ROUND_${n}_${suffix}.json`)),
    );
const updates = await Promise.all(
  [1, 2, 3].map((n) => readFile(join(output, `ROUND_${n}_UPDATE.json`)).then(JSON.parse)),
);
assert.equal(await main([]), 2);
const f = await fixture({ productDaily: reader });
f.controls.now = Date.now();
let checks = [],
  comparisons = 0,
  refreshCalls = 0,
  originalRefresh = reader.refresh.bind(reader);
reader.refresh = async (...a) => {
  refreshCalls++;
  return originalRefresh(...a);
};
try {
  const before = refreshCalls;
  for (const key of [keys.invalid, keys.revoked])
    assert.equal((await f.inject({ url: '/api/v2/live', headers: auth(key) })).statusCode, 401);
  assert.equal(refreshCalls, before, 'Access must precede local reader refresh');
  const oldLive = await f.inject('/api/v2/live');
  assert.equal(oldLive.statusCode, 200);
  const query = ProductQuery.parse({ from: '2026-10-01', to: '2026-10-08', limit: '2' }),
    cursors = new PageCursors();
  const page = reader.read(old, query, 'daily', cursors, Date.now(), 'public');
  const lease = await writer.acquireWriter();
  const rival = new ProductDailyStore(writer.root, profile.pair);
  await rival.load();
  await assert.rejects(rival.acquireWriter(), /EEXIST/);
  await assert.rejects(rival.select(selected), /EEXIST/);
  const sealed = JSON.parse(await readFile(join(output, 'ROUND_1_SEALED.json'))),
    raw = await readFile(join(output, 'ROUND_1_UPDATE.json'));
  const pub = await publishCycle(writer, lease, output, {
    cycle: 1,
    update: 'ROUND_1_UPDATE.json',
    updateSha256: hash(raw),
    pin: sealed.pin,
    sealedAt: sealed.sealedAt,
    expiresAtUnixSeconds: Date.now() / 1000 + 29,
  });
  await originalRefresh(10000);
  assert.equal(reader.capture(), old, 'Lease holds the old reader');
  await writer.releaseWriter(lease);
  await originalRefresh(12000);
  assert.equal(reader.capture().version, pub.selected.version);
  assert.equal(old.version, selected.version);
  const fresh = await f.inject('/api/v2/live');
  assert.equal(fresh.json().datasetVersion, pub.selected.version);
  assert.notEqual(oldLive.headers.etag, fresh.headers.etag);
  assert.throws(() =>
    reader.read(
      reader.capture(),
      { ...query, cursor: page.nextCursor },
      'daily',
      cursors,
      Date.now(),
      'public',
    ),
  );
  checks.push(
    'actual captured update -> lease -> immutable select -> distinct running reader adoption; old held snapshot; cursor/ETag separation',
  );
  const first = writer.capture();
  const firstBase = { ...first, exceptions };
  assert.equal(
    productFiles(applyMarketUpdate(firstBase, updates[0])).version,
    first.version,
    'idempotent repeat',
  );
  assert.equal((await writer.select(pointer(first))).changed, false);
  const conflict = structuredClone(updates[0]);
  conflict.readings[0].value = '999';
  assert.throws(() => applyMarketUpdate(firstBase, conflict), /SAME_TIME/);
  const secondFiles = productFiles(applyMarketUpdate(firstBase, updates[1]));
  await writeProductGeneration(writer.root, secondFiles);
  await writer.select(pointer(secondFiles));
  await originalRefresh(14000);
  assert.equal(reader.capture().version, secondFiles.version);
  const held = reader.capture();
  for (let n = 0; n < 20; n++) await originalRefresh(15000 + n * 1000);
  assert.equal(reader.capture(), held);
  assert.equal(reader.reloadStatus().retainedGenerations, 1);
  // Same generation means only the small pointer/lock checks; no re-admission.
  const md = join(writer.root, held.version, 'MANIFEST.json'),
    mdBytes = await readFile(md);
  await writeFile(md, 'synthetic damaged manifest');
  await originalRefresh(40000);
  assert.equal(reader.capture(), held);
  await writeFile(md, mdBytes);
  for (let i = 0; i < old.rows.length; i++)
    for (const [k, v] of Object.entries(old.rows[i]))
      if (!['trackedLiquidityUsd', 'liquidityRecordedAtUtc'].includes(k)) {
        assert.equal(held.rows[i][k], v);
        comparisons++;
      }
  assert.deepEqual(held.metadata.liquidityHistory, old.metadata.liquidityHistory);
  const observation = held.metadata.readings.find(
    (r) => r.kind === 'market' && r.asset === 'HEX',
  ).observedAtUtc;
  assert.equal(reader.live(held, Date.parse(observation) + 300000).freshness.HEX.status, 'fresh');
  assert.equal(reader.live(held, Date.parse(observation) + 301000).freshness.HEX.status, 'stale');
  assert.equal(
    reader.live(held, Date.parse(observation) + 301000).freshness.HEX.observedAtUtc,
    observation,
  );
  const rollover = structuredClone(updates[2]);
  for (const r of rollover.readings) r.observedAtUtc = '2026-10-09T00:01:00Z';
  rollover.receiptSha256 = 'e'.repeat(64);
  const realNow = Date.now;
  try {
    Date.now = () => Date.parse('2026-10-11T00:00:00Z');
    const rolled = applyMarketUpdate({ ...held, exceptions }, rollover);
    assert.equal(rolled.rows.at(-1).dateUtc, '2026-10-09');
    assert.equal(rolled.rows.at(-1).hexPriceUsd, null);
    assert.deepEqual(rolled.metadata.liquidityHistory, old.metadata.liquidityHistory);
    const many = Array.from({ length: 4096 }, (_, i) => ({
      ...updates[0].readings[0],
      observedAtUtc: new Date(Date.parse(observation) + i * 1000).toISOString(),
    }));
    assert.equal(mergeObservations([], many).length, 4096);
    assert.throws(
      () => mergeObservations(many, [{ ...many[0], observedAtUtc: '2026-10-10T00:00:00Z' }]),
      /MARKET_HISTORY_BOUND/,
    );
  } finally {
    Date.now = realNow;
  }
  checks.push(
    'idempotence; same-time conflicts; unchanged pointer fast path; bounded current cache; 4096 ceiling; UTC rollover; stale timestamps; original daily/history preservation',
  );
  // Failed/unknown pointer admission keeps the known generation.
  const disk = await readFile(join(writer.root, 'CURRENT.json'));
  await writeFile(
    join(writer.root, 'CURRENT.json'),
    JSON.stringify({ version: 'b'.repeat(64), manifestSha256: 'c'.repeat(64) }),
  );
  await originalRefresh(42000);
  assert.equal(reader.capture(), held);
  assert(reader.reloadStatus().error);
  await writeFile(join(writer.root, 'CURRENT.json'), disk);
  const unauthBefore = refreshCalls,
    download = '/api/v2/downloads/' + held.bundleId + '/daily';
  assert([401, 403].includes((await f.inject(download)).statusCode));
  assert.equal(refreshCalls, unauthBefore);
  const paid = await f.inject({ url: download, headers: auth() });
  assert.equal(paid.statusCode, 200, paid.body);
  assert.equal(paid.body, held.csv.toString());
  assert(
    [401, 403].includes(
      (await f.inject({ url: download, headers: { 'if-none-match': paid.headers.etag } }))
        .statusCode,
    ),
  );
  for (const url of [
    '/api/v2/live',
    '/api/v2/home',
    '/api/v2/daily?from=2026-10-01&to=2026-10-08',
  ]) {
    const g = await f.inject({ url, headers: auth() });
    assert.equal(g.statusCode, 200, g.body);
    const h = await f.inject({ url, method: 'HEAD', headers: auth() });
    assert.equal(h.statusCode, 200);
    assert.equal(h.body, '');
    assert.equal(h.headers.etag, g.headers.etag);
    const c = await f.inject({
      url,
      method: 'HEAD',
      headers: { ...auth(), 'if-none-match': g.headers.etag },
    });
    assert.equal(c.statusCode, 304);
    assert.equal(c.body, '');
  }
  const home = (await f.inject('/api/v2/home')).json(),
    live = (await f.inject('/api/v2/live')).json();
  assert.deepEqual(home.live, live);
  const oldCapture = reader.capture.bind(reader);
  reader.capture = () => {
    throw Error('SYNTHETIC_READ_FAILURE');
  };
  assert.equal((await f.inject({ url: '/api/v2/live', headers: auth() })).statusCode, 503);
  reader.capture = oldCapture;
  await until(() => f.events.some((e) => e.stage === 'finalize' && e.success === false));
  for (const url of [
    '/data/product/CURRENT.json',
    '/data/product/' + held.version + '/daily.csv',
    '/ACCOUNTING.json',
  ])
    assert.equal((await f.inject(url)).statusCode, 404);
  checks.push(
    'actual auth-before-refresh; paid GET/HEAD/304 holds; failed read release; authenticated exact CSV; no static data exposure; Home/Live coherence',
  );
} finally {
  await f.close();
}
// CAS and interrupted publication retain lock/pointer rather than guessing settlement.
for (const kind of ['cas', 'interrupted']) {
  const s = await setup(kind),
    next = productFiles(applyMarketUpdate({ ...s.capture(), exceptions }, updates[0]));
  await writeProductGeneration(s.root, next);
  const lease = await s.acquireWriter(),
    oldPointer = await readFile(join(s.root, 'CURRENT.json'));
  await assert.rejects(
    s.select(pointer(next), {
      writer: lease,
      beforePublish: async () => {
        if (kind === 'cas') await writeFile(join(s.root, 'CURRENT.json'), '{}');
        else throw Error('SYNTHETIC_INTERRUPTION');
      },
    }),
    kind === 'cas' ? /POINTER_CHANGED/ : /INTERRUPTION/,
  );
  assert.equal(s.capture().version, selected.version);
  await assert.rejects(s.releaseWriter(lease), /UNCERTAIN/);
  assert((await lstat(join(s.root, 'SELECTION.lock'))).isFile());
  if (kind === 'interrupted')
    assert.deepEqual(await readFile(join(s.root, 'CURRENT.json')), oldPointer);
}
checks.push(
  'competing writer refused; compare-and-swap detects pointer drift; interrupted publication leaves durable uncertain lock',
);
const result = {
  status: 'PASS',
  synthetic: true,
  checks,
  comparisons,
  fullBaseAdmissions: 0,
  externalRequests: 0,
  fixtureRoot: dir,
};
await writeFile(
  join(R, 'evidence/PUBLICATION_TESTS_' + basename(dir) + '.json'),
  JSON.stringify(result, null, 2) + '\n',
  { flag: 'wx' },
);
console.log(JSON.stringify(result));
