// Explicit offline qualification only. No collector, endpoint, admission or pointer write.
import { readFile, writeFile } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  qualifyBenchmarkHistory,
  benchmarkDisclosure,
} from '../dist/history-bootstrap/benchmarks.js';
import { hash, stable } from '../dist/history-bootstrap/normalize.js';
export async function qualify(root) {
  root = resolve(root);
  const files = [
    'public-session/03.body',
    'public-session/02.body',
    'Coingecko.js',
    'public-session/09.body',
  ];
  const bytes = await Promise.all(files.map((p) => readFile(join(root, 'inputs', p))));
  const result = qualifyBenchmarkHistory(...bytes);
  const mapping = {
    method: result.history.methodRevision,
    description: benchmarkDisclosure,
    fields: { priceBTC: 'btcPriceUsd', priceETH: 'ethPriceUsd' },
    assets: {
      BTC: {
        id: 'bitcoin',
        quote: 'usd',
        lowerWindowHoursExclusive: -12,
        upperWindowHoursExclusive: 1,
        requiredMatches: 'exactly one',
      },
      ETH: {
        id: 'ethereum',
        quote: 'usd',
        lowerWindowHoursExclusive: -6,
        upperWindowHoursExclusive: 1,
        requiredMatches: 'one or more; first in provider order',
      },
    },
    nominalTargetMilliseconds: '(1575417600 + (currentDay - 1) * 86400) * 1000',
    epochUtc: '2019-12-04T00:00:00.000Z',
    interval: 'daily requested, not a close guarantee',
    sourceDateRule:
      'Original valid UTC record-calendar date; latest whole record. Stable ID/content digest for equivalent ties. Explicit conflicts never fall back.',
    quoteTimes: {
      btcRecordedAtUtc: null,
      ethRecordedAtUtc: null,
      meaning: 'UNKNOWN in retained scalar history',
    },
    zeroMeaning: 'unavailable/error sentinel, never zero-dollar BTC/ETH',
    historicalRevisionProof:
      'Saved method revision supports field meaning; not proof each row was produced by that revision.',
    rights:
      'Code MIT; technical use does not establish commercial market-data redistribution rights.',
    inputs: Object.fromEntries(
      files.map((p, i) => [p, { bytes: bytes[i].length, sha256: hash(bytes[i]) }]),
    ),
    selectionSha256: result.history.selectionSha256,
  };
  const write = (p, v) =>
    writeFile(join(root, p), typeof v === 'string' ? v : JSON.stringify(v, null, 2) + '\n', {
      flag: 'wx',
    });
  await write('FIELD_MAPPING.json', mapping);
  await write('COVERAGE.json', {
    ...result.summary,
    assets: result.coverage,
    exceptions: result.exceptions,
    bucketCount: result.buckets.length,
  });
  await write('data/BENCHMARK_HISTORY.json', result.history);
  const update = {
    readings: [],
    liquidityHistory: [],
    receiptSha256: hash(stable(mapping)),
    benchmarkHistory: result.history,
  };
  await write('data/HISTORY_UPDATE.json', update);
  await write(
    'evidence/CONTRIBUTORS.ndjson',
    result.contributors.map((r) => JSON.stringify(r) + '\n').join(''),
  );
  await write(
    'evidence/SELECTIONS.ndjson',
    result.selections.map((r) => JSON.stringify(r) + '\n').join(''),
  );
  await write('evidence/QUALIFICATION.json', {
    status: 'QUALIFIED_PENDING_INDEPENDENT_METHOD_REVIEW',
    externalRequests: 0,
    selectedHistorySha256: hash(await readFile(join(root, 'data/BENCHMARK_HISTORY.json'))),
    updateSha256: hash(await readFile(join(root, 'data/HISTORY_UPDATE.json'))),
    coverage: result.coverage,
  });
  return {
    status: 'QUALIFIED_PENDING_INDEPENDENT_METHOD_REVIEW',
    buckets: result.buckets.length,
    coverage: result.coverage,
  };
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  if (process.argv[2] === 'qualify' && process.argv.length === 4)
    console.log(JSON.stringify(await qualify(process.argv[3])));
  else
    console.log(
      'Offline only: qualify TASK_ROOT. No default writes, provider calls or publication.',
    );
}
