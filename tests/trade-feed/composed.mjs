import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { PassThrough, Writable } from 'node:stream';
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { mkdir, writeFile, readFile, cp, lstat } from 'node:fs/promises';
import { runJob } from '../../scripts/refresh-data.mjs';
import { ParticipantRegistry } from '../../dist/services/source-update/refresh.js';
import { ProductDailyStore } from '../../dist/services/product-daily/store.js';
import { publishStoredMarket } from '../../dist/services/product-daily/storage.js';
import { sha } from '../../dist/services/source-update/generation.js';
import { fixture, auth } from '../market-feed/access-fixture.mjs';
import { guard } from './budget.mjs';
const put = (p, v) => writeFile(p, JSON.stringify(v) + '\n');
export async function composed({ R, real, base, save }) {
  const root = join(R, 'fixtures/composed-' + Date.now());
  await mkdir(root);
  // An isolated exact compact clone: no base re-admission or original pointer write.
  await cp(real.productDaily.root, join(root, 'product'), {
    recursive: true,
    force: false,
    errorOnExist: true,
  });
  await cp(real.root, join(root, 'participants'), {
    recursive: true,
    force: false,
    errorOnExist: true,
  });
  const ownerPath = join(root, 'product/STORAGE_OWNER.json');
  const owner = JSON.parse(await readFile(ownerPath));
  await put(ownerPath, { ...owner, root: join(root, 'product'), nonce: randomUUID() });
  const clonedStatePath = join(root, 'product/STORAGE.json');
  const clonedState = JSON.parse(await readFile(clonedStatePath));
  await put(clonedStatePath, { ...clonedState, owner: sha(await readFile(ownerPath)) });
  const statePath = join(root, 'product/STORAGE.json'),
    pointerPath = join(root, 'product/CURRENT.json');
  const originalState = await readFile(statePath),
    originalPointer = await readFile(pointerPath);
  const state = JSON.parse(originalState),
    rollback = state.rollback;
  // Fixture construction of a previously admitted HDS reader. These two fixture
  // files return to the unmodified close seed before the actual writer runs.
  const hds = JSON.parse(await readFile(join(root, 'product', rollback.version, 'metadata.json')));
  const records = (await readFile(join(root, 'product/journal/00000001.ndjson'), 'utf8'))
    .trim()
    .split('\n')
    .map(JSON.parse);
  const oldRecord = records.find((r) => r.sequence === 22);
  assert(oldRecord);
  await put(statePath, {
    ...state,
    current: rollback,
    rollback: null,
    journalSelected: rollback,
    sequence: 22,
    head: hds.marketStorage.head,
    archiveHead: oldRecord.archiveHash,
  });
  await put(pointerPath, rollback);
  const delayed = new ProductDailyStore(
    join(root, 'product'),
    real.productDaily.capture().metadata.pair,
  );
  await delayed.load();
  assert.equal(delayed.capture().metadata.marketStorage.sequence, 22);
  await writeFile(statePath, originalState);
  await writeFile(pointerPath, originalPointer);
  async function productOnly() {
    const store = new ProductDailyStore(
      join(root, 'product'),
      real.productDaily.capture().metadata.pair,
    );
    await store.load();
    return {
      root: join(root, 'participants'),
      productDaily: store,
      capture: () => ({ product: store.capture(), release() {} }),
      refresh: async () => {},
      close: async () => {},
      publishProduct: async (update, options) => {
        const lease = await store.acquireWriter();
        let result;
        try {
          result = await publishStoredMarket(
            store,
            lease,
            update,
            options.beforeCommit,
            undefined,
            options.captureReference,
          );
        } finally {
          await store.releaseWriter(lease);
        }
        const p = JSON.parse(await readFile(join(root, 'participants/CURRENT.json')));
        await put(join(root, 'participants/CURRENT.json'), { ...p, product: result.selected });
        return result;
      },
    };
  }
  const writer = base
    ? await ParticipantRegistry.open(join(root, 'participants'), join(root, 'product'), base)
    : await productOnly();
  const reader = base
    ? await ParticipantRegistry.open(writer.root, writer.productDaily.root, base)
    : await productOnly();
  const f = guard(
    await fixture({
      ...(base ? { participants: reader } : {}),
      productDaily: reader.productDaily,
      sourceGenerations: base,
    }),
  );
  const old = reader.capture(),
    held = reader.productDaily.openExport(
      old.product,
      old.product.bundleId,
      'daily',
      new AbortController().signal,
    );
  const jobRoot = join(root, 'session');
  await mkdir(jobRoot);
  await mkdir(join(jobRoot, 'temp'));
  await put(join(jobRoot, 'ADMISSION.json'), {
    task: 'HDD-BTC-ETH-CURRENT-REFERENCE-FRESHNESS-R2',
    family: 'trade',
    jobRoot,
    nonce: 'synthetic-fixture',
  });
  const outcomes = [],
    rawRows = [],
    nowSecond = Math.floor(Date.now() / 1000) - 3;
  let count = 0;
  async function capture(label, body) {
    const attempt = ++count,
      dir = join(jobRoot, String(attempt).padStart(2, '0'));
    await mkdir(dir);
    const raw = Buffer.from(JSON.stringify(body)),
      objects = 1 + body.length;
    const binding = { attempt, bodySha256: sha(raw), bodyBytes: raw.length, objects };
    await writeFile(join(dir, 'response.body'), raw);
    await put(join(dir, 'AUDIT.json'), {
      method: 'GET',
      url:
        label === 'markets'
          ? 'https://www.bitstamp.net/api/v2/markets/'
          : 'https://www.bitstamp.net/api/v2/transactions/' +
            label.slice(0, 3).toLowerCase() +
            'usd/?time=minute',
      attempt,
      nonce: 'synthetic-fixture',
      closed: true,
      complete: true,
      status: 200,
      integrityFailure: null,
      label,
      bodySha256: sha(raw),
      chargedObjects: objects,
    });
    return binding;
  }
  function fakeSpawn() {
    const child = new EventEmitter();
    child.stdout = new PassThrough();
    child.stderr = new PassThrough();
    child.exitCode = null;
    child.signalCode = null;
    let resolveAnswer;
    child.stdin = new Writable({
      write(b, _, done) {
        resolveAnswer(JSON.parse(b.toString()));
        done();
      },
    });
    const exchange = (type, cycle, extra = {}) =>
      new Promise((resolve) => {
        resolveAnswer = resolve;
        child.stdout.write(
          JSON.stringify({ type, cycle, expiresAtUnixSeconds: Date.now() / 1000 + 30, ...extra }) +
            '\n',
        );
      });
    setImmediate(async () => {
      try {
        const markets = ['BTC', 'ETH'].map((a) => ({
          market_symbol: a.toLowerCase() + 'usd',
          base_currency: a,
          counter_currency: 'USD',
          market_type: 'SPOT',
          trading: 'Enabled',
        }));
        assert((await exchange('markets', 0, { markets: await capture('markets', markets) })).ok);
        for (let cycle = 1; cycle <= 3; cycle++) {
          assert((await exchange('begin', cycle)).ok);
          // Second cycle is a different same-second price with larger ID; third no-op.
          const id = cycle === 1 ? '10' : '11',
            bindings = {};
          for (const asset of ['BTC', 'ETH']) {
            const rows = [
              {
                date: String(nowSecond),
                tid: id,
                price: asset === 'BTC' ? (cycle === 1 ? '80000.0001' : '80001.0002') : '2500.0003',
              },
            ];
            bindings[asset.toLowerCase()] = await capture(`${asset}_${cycle}`, rows);
            rawRows.push({ asset, cycle, ...rows[0] });
          }
          const answer = await exchange('qualified', cycle, bindings);
          assert(answer.ok, JSON.stringify(answer));
          outcomes.push(answer);
        }
        const accounting = { status: 'CLOSED', pending: null, attempts: 7, synthetic: true };
        const result = { status: 'COMPLETE_FRESH_CYCLES', accounting };
        await put(join(jobRoot, 'ACCOUNTING.json'), accounting);
        await put(join(jobRoot, 'RESULT.json'), result);
        child.stdout.write(JSON.stringify({ type: 'closed', result }) + '\n');
        child.exitCode = 0;
        child.emit('exit', 0, null);
        child.stdout.end();
        child.stderr.end();
        child.emit('close', 0, null);
      } catch (e) {
        child.stderr.write(String(e));
        child.exitCode = 2;
        child.emit('exit', 2, null);
        child.stdout.end();
        child.stderr.end();
        child.emit('close', 2, null);
      }
    });
    return child;
  }
  try {
    const result = await runJob({
      jobRoot,
      admission: {
        task: 'HDD-BTC-ETH-CURRENT-REFERENCE-FRESHNESS-R2',
        family: 'trade',
        job: 'synthetic-three-slots',
      },
      registry: writer,
      spawnChild: fakeSpawn,
      deadline: performance.now() + 90000,
      onAdoption: async (selected, check) => {
        await new Promise((r) => setTimeout(r, 1050));
        f.controls.now = Date.now();
        check();
        const response = await f.inject('/api/v2/live');
        assert.equal(response.statusCode, 200, response.body);
        assert.equal(response.json().datasetVersion, selected.product.version);
        return response.json();
      },
    });
    assert.equal(result.status, 'QUALIFIED_ADOPTED', JSON.stringify(result));
    assert.equal(result.publications.length, 3);
    assert(
      result.publications[0].publication.changed &&
        result.publications[1].publication.changed &&
        !result.publications[2].publication.changed,
    );
    const newest = writer.productDaily.capture();
    assert.equal(newest.metadata.marketStorage.sequence, 25);
    assert.equal(
      await lstat(join(writer.productDaily.root, old.product.version)).catch(() => null),
      null,
      'close intermediate pruned',
    );
    await delayed.refresh();
    assert.equal(delayed.capture().version, newest.version, JSON.stringify(delayed.reloadStatus()));
    const chunks = [];
    for await (const b of held.stream) chunks.push(b);
    await held.released;
    assert.equal(sha(Buffer.concat(chunks)), sha(old.product.csv));
    const csv = await f.inject({
      url: '/api/v2/downloads/' + newest.bundleId + '/daily',
      headers: auth(),
    });
    assert.equal(csv.statusCode, 200);
    assert.equal(sha(csv.body), sha(newest.csv));
    assert.deepEqual(newest.rows.slice(0, old.product.rows.length), old.product.rows);
    await save(base ? 'COMPOSED_TESTS' : 'COORDINATOR_PRODUCT_ONLY_TESTS', {
      status: 'PASS',
      synthetic: true,
      externalRequests: 0,
      actualPairedRegistryTested: Boolean(base),
      limitation: base
        ? null
        : 'Participant control facade injected; actual product writer, native coordinator message path and standalone API exercised. Does not qualify full paired application preflight.',
      result,
      rawRows,
      cases: [
        'actual runJob trade phase and publisher',
        base
          ? 'actual paired normal API adoption without restart'
          : 'actual standalone normal API adoption; paired control facade is synthetic',
        'same-second higher numeric ID and changed value',
        'exact third-cycle no-op',
        'delayed HDS22 reader adopts trade25 after close23 pruning',
        'held original close export coherence',
        'full protected CSV and unchanged existing cells',
      ],
    });
  } finally {
    old.release();
    await f.close();
    await reader.close();
    await writer.close();
  }
}
