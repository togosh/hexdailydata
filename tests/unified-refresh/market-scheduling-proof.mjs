// Focused actual native mixed fixture. All data/time are explicitly synthetic.
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
const hash = (b) => createHash('sha256').update(b).digest('hex');
export async function schedulingProof(x) {
  const {
    root,
    mode,
    result,
    facts,
    writer,
    reader,
    lagging,
    store,
    initialRows,
    initialCsv,
    heldExport,
    app,
    auth,
    read,
    children,
  } = x;
  assert.equal(result.status, 'OFFLINE_OPERATING_COMPLETE', JSON.stringify(result).slice(-6000));
  assert.equal(result.accounting.status, 'CLOSED');
  assert.equal(result.accounting.pending, null);
  assert.equal(result.maximumPublicationWriters, 1);
  assert.equal(result.accounting.maxPhysical, 1);
  assert.equal(children.size, 0);
  const jobs = [];
  for (const j of result.jobs)
    jobs.push({ ...j, result: await read(join(root, 'operating', j.receipt.file)) });
  const markets = jobs.filter((j) => j.family === 'market' && j.status === 'QUALIFIED_ADOPTED');
  assert(
    markets.length >= (mode === 'scheduling-mixed' ? 2 : 1),
    'FULL_QUALIFIED_MARKET_PUBLICATIONS',
  );
  assert(jobs.some((j) => j.family === 'gas' && j.status === 'QUALIFIED_ADOPTED'));
  assert(jobs.some((j) => j.family === 'protocol' && j.status === 'QUALIFIED_ADOPTED'));
  assert(jobs.some((j) => j.family === 'trade' && j.publication === 'changed'));
  const part = jobs.find((j) => j.family === 'participants');
  assert.equal(part.status, 'QUALIFIED_ADOPTED');
  const partAt = Date.parse(part.result.publications[0].adoptedAt) / 1000;
  let crossing = null;
  for (const j of markets) {
    const p = join(root, 'operating', j.job, 'COLLECTION_READY.json');
    if (existsSync(p)) {
      const ready = await read(p),
        published = Date.parse(j.result.publications[0].adoptedAt) / 1000;
      if (ready.at < partAt && partAt < published)
        crossing = { ready, participantAdoptedAt: partAt, marketAdoptedAt: published };
    }
  }
  if (mode === 'scheduling-mixed')
    assert(crossing, 'QUALIFIED_COLLECTION_BEFORE_PARTICIPANT_THEN_MARKET_PUBLICATION');
  const intervals = [],
    noDispatch = [],
    matrix = [];
  for (const j of jobs) {
    const jr = join(root, 'operating', j.job),
      native = await read(join(jr, 'NATIVE_CLOSURE.json'));
    assert(
      native.accountingClosed &&
        native.pending === null &&
        native.resultMatchesClosedMessage &&
        !native.ipcError &&
        !j.result.error,
      JSON.stringify({ j: j.job, native, error: j.result.error }),
    );
    matrix.push({
      job: j.job,
      family: j.family,
      status: j.status,
      publication: j.publication,
      startedAt: j.startedAt,
      completedAt: j.completedAt,
      native,
      emitter: await read(join(jr, 'COMPLETION_EMITTER.json')),
    });
    const rows =
      j.family === 'trade'
        ? j.result.source.accounting.requests
        : (await fs.readFile(join(jr, 'LEDGER.jsonl'), 'utf8'))
            .trim()
            .split('\n')
            .filter(Boolean)
            .map(JSON.parse);
    for (const row of rows) {
      const folder =
        j.family === 'trade'
          ? join(jr, String(row.attempt).padStart(2, '0'))
          : join(jr, 'captures', String(row.attempt).padStart(5, '0'));
      const end = await read(join(folder, 'PHYSICAL_CLOSED.json'));
      if (existsSync(join(folder, 'PHYSICAL_STARTED.json'))) {
        const start = await read(join(folder, 'PHYSICAL_STARTED.json'));
        assert.equal(start.nonce, end.nonce);
        intervals.push({ job: j.job, permit: start.permit, start: start.at, end: end.closedAt });
      } else {
        const p = await read(
          join(root, 'operating', 'PERMIT_' + String(end.permit).padStart(8, '0') + '.json'),
        );
        assert.equal(end.noChildStarted, true);
        assert.equal(row.chargedBytes, p.bytes);
        assert.equal(row.chargedEntities, p.objects);
        assert.equal(row.retryable, false);
        assert.equal(row.usable, false);
        noDispatch.push({ job: j.job, permit: p, capture: row, closure: end });
      }
    }
  }
  intervals.sort((a, b) => a.permit - b.permit);
  for (let i = 1; i < intervals.length; i++)
    assert(intervals[i].start + 0.002 >= intervals[i - 1].end + 1, 'GLOBAL_PACING');
  assert(
    intervals.some((i) => i.end - i.start > 0.5),
    'NONZERO_PHYSICAL_TIMING',
  );
  if (mode === 'scheduling-overload') {
    assert.equal(noDispatch.length, 1, 'EXACT_BOUNDED_INFEASIBLE_REFUSAL');
    const miss = jobs.find((j) => j.scheduling === 'KNOWN_CLOSED_NO_DISPATCH_NEXT_CONFIGURED_SLOT');
    assert(
      miss && markets.some((j) => j.startedAt > miss.completedAt),
      'LATER_CONFIGURED_SLOT_NO_PERMANENT_QUARANTINE',
    );
    assert(!result.accounting.disabled.includes('market'));
  } else assert.equal(noDispatch.length, 0);
  const timeline = facts.filter((f) => f.job.startsWith('timeline-'));
  assert(timeline.length >= 20, 'INDEPENDENT_API_TIMELINE');
  const servedMarkets = [];
  for (const j of markets) {
    const update = await read(join(root, 'operating', j.job, 'ROUND_1_UPDATE.json'));
    const hex = update.readings.find((r) => r.kind === 'market'),
      liquidity = update.readings.find((r) => r.kind === 'tracked-liquidity');
    const served = timeline.find(
      (f) =>
        f.hexPriceUsd === hex.value &&
        f.trackedLiquidityUsd === liquidity.value &&
        f.freshness.HEX.observedAtUtc === hex.observedAtUtc &&
        f.freshness.liquidity.observedAtUtc === liquidity.observedAtUtc &&
        f.queriedAtUnixSeconds >= Date.parse(j.result.publications[0].adoptedAt) / 1000,
    );
    assert(served, 'NORMAL_API_SERVES_EXACT_PUBLISHED_MARKET_' + j.job);
    servedMarkets.push({
      job: j.job,
      firstIndependentSample: served,
      updateSha256: j.result.publications[0].publication.updateSha256,
    });
  }
  for (const f of timeline)
    for (const key of ['HEX', 'liquidity']) {
      const reading = f.marketObservations.find((r) =>
        key === 'HEX' ? r.kind === 'market' && r.asset === 'HEX' : r.kind === 'tracked-liquidity',
      );
      assert(reading);
      const age = f.queriedAtUnixSeconds - Date.parse(reading.observedAtUtc) / 1000;
      assert.equal(f.freshness[key].ageSeconds, Math.max(0, Math.floor(age)));
      assert.equal(f.freshness[key].observedAtUtc, reading.observedAtUtc);
      assert.equal(f.freshness[key].status, age > 300 ? 'stale' : 'fresh');
    }
  assert.equal(timeline.at(-1).freshness.HEX.status, 'stale');
  assert.equal(timeline.at(-1).freshness.liquidity.status, 'stale');
  assert(
    timeline.some(
      (f, i) =>
        i > 0 &&
        f.freshness.HEX.observedAtUtc === timeline[i - 1].freshness.HEX.observedAtUtc &&
        f.hexPriceUsd === timeline[i - 1].hexPriceUsd &&
        f.freshness.HEX.ageSeconds > timeline[i - 1].freshness.HEX.ageSeconds,
    ),
    'UNCHANGED_OBSERVATION_AGES',
  );
  assert(
    timeline.some((f) => f.freshness.ETH.status === 'stale' && f.ethPriceUsd !== null),
    'EMPTY_SAMPLE_PRESERVES_AGING',
  );
  await lagging.refresh(undefined, true);
  assert.equal(lagging.status().error, null);
  assert.equal(lagging.status().productVersion, writer.status().productVersion);
  const final = lagging.productDaily.capture(),
    chunks = [];
  for await (const b of heldExport.stream) chunks.push(b);
  await heldExport.released;
  assert.equal(hash(Buffer.concat(chunks)), hash(initialCsv));
  for (const old of initialRows.filter((r) => r.dateUtc <= '2026-10-09')) {
    const after = final.rows.find((r) => r.dateUtc === old.dateUtc);
    for (const k of ['btcPriceUsd', 'ethPriceUsd', 'btcRecordedAtUtc', 'ethRecordedAtUtc'])
      assert.equal(after[k], old[k]);
  }
  const url = '/api/v2/downloads/' + final.bundleId + '/daily';
  assert.notEqual((await app.inject(url)).statusCode, 200);
  assert.equal((await app.inject({ url, headers: auth() })).body, final.csv.toString());
  assert.equal((await app.inject({ url, method: 'HEAD', headers: auth() })).statusCode, 200);
  const { auditJournal, verifyMarketCertificate } =
    await import('../../dist/services/product-daily/storage.js');
  await verifyMarketCertificate(store.root, final);
  return {
    synthetic: true,
    qualifiedMarkets: markets.length,
    matrix,
    crossing,
    noDispatch,
    intervals,
    timeline,
    servedMarkets,
    journal: await auditJournal(store.root),
    heldExportCoherent: true,
    historyPreserved: true,
  };
}
