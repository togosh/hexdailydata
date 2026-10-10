// Saved exact GET evidence -> paired update -> existing journal/certificate publisher.
import { readFile, stat } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { sha } from '../dist/services/source-update/generation.js';
import {
  sampleTrades,
  qualifyMarkets,
  freshTradePair,
  compareTrades,
} from '../dist/services/product-daily/trades.js';
import { marketEvidence } from '../dist/services/product-daily/market.js';
import { durableJson } from './market-refresh.mjs';

export const operatingTaskId = 'HDD-BTC-ETH-OPERATING-REFRESH-R1';
export const operatingProfileId = 'operating-16-slots-v1';
const legacyProfile = Object.freeze({ cycles: 3, logical: 7, attempts: 14, extras: 7,
  seconds: 600, dispatch: 535, chargedBytes: 32 * 1024 ** 2, objects: 280000 });
const operatingProfile = Object.freeze({ cycles: 16, logical: 33, attempts: 66, extras: 33,
  seconds: 1200, dispatch: 1135, chargedBytes: 144 * 1024 ** 2, objects: 1320000 });
export function tradeProfile(admission) {
  if (admission.authorityTaskId === operatingTaskId) {
    if (admission.tradeProfileId !== operatingProfileId ||
        admission.job !== 'trade-operating-16-slots' ||
        admission.responseCookiePolicyId !== 'ignore-response-cookies-no-replay-v1')
      throw Error('EXACT_OPERATING_PROFILE');
    return operatingProfile;
  }
  if (admission.tradeProfileId !== undefined) throw Error('OPERATING_PROFILE_IN_OLD_AUTHORITY');
  return legacyProfile;
}
export function validateOperatingScope(scope) {
  const n = scope.network, p = operatingProfile;
  const expected = { maximumPhysicalAttempts: p.attempts, maximumLogicalRequests: p.logical,
    normalGetCount: p.logical, maximumTotalRetries: p.extras,
    maximumSessionSecondsIncludingClosure: p.seconds, maximumNewDispatchOffsetSeconds: p.dispatch,
    maximumChargedBytes: p.chargedBytes, maximumParsedObjectsAcrossResponses: p.objects,
    perAttemptDurableReservationBytes: 2162688, minimumCompleteAttemptAndClosureReserveSeconds: 65 };
  if (scope.taskId !== operatingTaskId || Object.entries(expected).some(([k,v]) => n[k] !== v) ||
      n.plan.cycles !== 16 || n.plan.maximumOrdinaryStartLagSeconds !== 5 ||
      JSON.stringify(n.plan.cycleOffsetsSeconds) !== JSON.stringify(Array.from({length:16},(_,i)=>i*60)))
    throw Error('OPERATING_SCOPE_LIMITS');
  return p;
}

/** Check an ordinary response against its selected view and measured wall clock. */
export function checkTradeService(body, selected, requestStartedAt, responseEndedAt) {
  const served = Date.parse(body.servedAtUtc);
  if (body.datasetVersion !== selected.version || !Number.isFinite(served) ||
      served < Math.floor(requestStartedAt / 1000) * 1000 || served > responseEndedAt)
    throw Error('SERVICE_SELECTION_OR_CLOCK');
  for (const asset of ['BTC','ETH']) {
    const reading = selected.metadata.readings.find(r => r.kind === 'trade' && r.asset === asset);
    const state = body.freshness?.[asset];
    const key = asset === 'BTC' ? 'btcPriceUsd' : 'ethPriceUsd';
    const elapsed = reading ? (requestStartedAt - Date.parse(reading.observedAtUtc)) / 1000 : null;
    const age = elapsed === null ? null : Math.max(0, Math.floor(elapsed));
    if (!reading || body[key] !== reading.value || state?.observedAtUtc !== reading.observedAtUtc ||
        state.ageSeconds !== age || state.staleAfterSeconds !== 300 ||
        state.status !== (elapsed >= 0 && elapsed <= 300 ? 'fresh' : 'stale'))
      throw Error('SERVICE_VALUE_TIME_OR_AGE');
  }
  return { status: ['BTC','ETH'].every(a=>body.freshness[a].status==='fresh') ? 'FRESH' : 'STALE',
    datasetVersion: body.datasetVersion, btcPriceUsd: body.btcPriceUsd, ethPriceUsd: body.ethPriceUsd,
    servedAtUtc: body.servedAtUtc, BTC: body.freshness.BTC, ETH: body.freshness.ETH,
    requestStartedAtUtc: new Date(requestStartedAt).toISOString(), responseEndedAtUtc: new Date(responseEndedAt).toISOString() };
}

export async function capturedBody(output, binding, label) {
  const admissionRaw = await readFile(join(output, 'ADMISSION.json'));
  if (admissionRaw.length > 262144) throw Error('TRADE_ADMISSION_BOUND');
  const admission = JSON.parse(admissionRaw), profile = tradeProfile(admission);
  if (!Number.isInteger(binding?.attempt) || binding.attempt < 1 || binding.attempt > profile.attempts)
    throw Error('TRADE_CAPTURE_ATTEMPT');
  const dir = join(output, String(binding.attempt).padStart(2, '0'));
  const p = join(dir, 'response.body');
  if ((await stat(p)).size > 2097152) throw Error('TRADE_CAPTURE_BOUND');
  const raw = await readFile(p),
    audit = JSON.parse(await readFile(join(dir, 'AUDIT.json')));
  const parts = /^(BTC|ETH)_([1-9][0-9]*)$/.exec(label);
  const url =
    label === 'markets'
      ? 'https://www.bitstamp.net/api/v2/markets/'
      : parts && Number(parts[2]) <= profile.cycles
        ? 'https://www.bitstamp.net/api/v2/transactions/' +
          label.slice(0, 3).toLowerCase() +
          'usd/?time=minute'
        : null;
  if (
    !url ||
    audit.url !== url ||
    audit.method !== 'GET' ||
    audit.attempt !== binding.attempt ||
    audit.nonce !== admission.nonce ||
    (admission.tradeProfileId && audit.tradeProfileId !== admission.tradeProfileId) ||
    admission.task !== 'HDD-BTC-ETH-CURRENT-REFERENCE-FRESHNESS-R2' ||
    admission.family !== 'trade' ||
    admission.jobRoot !== resolve(output) ||
    !audit.closed ||
    !audit.complete ||
    audit.status !== 200 ||
    audit.integrityFailure ||
    audit.label !== label ||
    audit.bodySha256 !== sha(raw) ||
    binding.bodySha256 !== sha(raw) ||
    binding.bodyBytes !== raw.length ||
    audit.chargedObjects !== binding.objects
  )
    throw Error('TRADE_CAPTURE_BINDING');
  return new TextDecoder('utf-8', { fatal: true }).decode(raw);
}
export async function admitTradeMarkets(output, binding) {
  const result = qualifyMarkets(await capturedBody(output, binding, 'markets'));
  if (result.objects !== binding.objects) throw Error('MARKET_OBJECT_ACCOUNTING');
  await durableJson(join(output, 'MARKET_IDENTITY.json'), {
    status: 'PASS',
    capture: binding,
    ...result,
  });
  return result;
}
export async function publishTrade(store, output, message, active, publish, retained) {
  const c = message.cycle;
  const profile = tradeProfile(JSON.parse(await readFile(join(output, 'ADMISSION.json'))));
  if (!Number.isInteger(c) || c < 1 || c > profile.cycles) throw Error('TRADE_CYCLE');
  const check = () => {
    if (!active() || Date.now() >= message.expiresAtUnixSeconds * 1000)
      throw Error('TRADE_PUBLICATION_DEADLINE');
  };
  check();
  const before = store.capture();
  const evidence = [...marketEvidence(before.metadata), ...retained];
  const btc = sampleTrades(await capturedBody(output, message.btc, `BTC_${c}`), 'BTC', evidence);
  const eth = sampleTrades(await capturedBody(output, message.eth, `ETH_${c}`), 'ETH', evidence);
  if (btc.objects !== message.btc.objects || eth.objects !== message.eth.objects)
    throw Error('TRADE_OBJECT_ACCOUNTING');
  retained.push(...btc.readings, ...eth.readings);
  const readings = [btc.selected, eth.selected].filter(Boolean).map((r) => {
    const old = before.metadata.readings.find((p) => p.kind === 'trade' && p.asset === r.asset);
    return old && compareTrades(r, old) <= 0 ? old : r;
  });
  const audit = {
    status: freshTradePair(readings) ? 'QUALIFIED' : 'UNQUALIFIED',
    cycle: c,
    sessionAdmissionSha256: sha(await readFile(join(output, 'ADMISSION.json'))),
    captured: { BTC: message.btc, ETH: message.eth },
    checkedAtUtc: new Date().toISOString(),
    sampling: 'greatest source second then greatest numeric trade ID; not execution order',
    sourcePrecision: 'second',
    assets: Object.fromEntries(
      [
        ['BTC', btc],
        ['ETH', eth],
      ].map(([asset, s]) => [
        asset,
        {
          shape: s.shape,
          records: s.records,
          selected: s.selected,
          newestSecondCandidates: s.newestSecondCandidates,
          newestSecondDistinctPrices: s.newestSecondDistinctPrices,
        },
      ]),
    ),
    effectiveReadings: readings,
  };
  const auditName = `ROUND_${c}_AUDIT.json`;
  await durableJson(join(output, auditName), audit);
  if (audit.status !== 'QUALIFIED')
    return {
      qualified: false,
      cycle: c,
      reason: 'Empty or stale valid pair; last-good retained',
      previous: before.version,
    };
  const auditRaw = await readFile(join(output, auditName));
  const update = { readings, liquidityHistory: [], receiptSha256: sha(auditRaw) },
    updateName = `ROUND_${c}_UPDATE.json`;
  await durableJson(join(output, updateName), update);
  const updateRaw = await readFile(join(output, updateName));
  const beforeCommit = () => {
    check();
    if (!freshTradePair(readings)) throw Error('TRADE_PROMOTION_AGE');
  };
  beforeCommit();
  let result;
  try {
    result = await publish(update, beforeCommit, {
      output: resolve(output),
      update: updateName,
      updateSha256: sha(updateRaw),
      audit: auditName,
      auditSha256: sha(auditRaw),
    });
    check();
  } catch (e) {
    e.publicationUncertain = true;
    throw e;
  }
  const publishedAt = new Date().toISOString();
  const receipt = {
    qualified: true,
    cycle: c,
    previous: before.version,
    selected: result.selected,
    changed: result.changed,
    values: readings,
    publishedAt,
    agesAtPublicationSeconds: Object.fromEntries(
      readings.map((r) => [
        r.asset,
        (Date.parse(publishedAt) - Date.parse(r.observedAtUtc)) / 1000,
      ]),
    ),
    updateSha256: sha(updateRaw),
    retainedStorage: result.storage,
    retention: result.retention ?? null,
  };
  await durableJson(join(output, `PUBLICATION_${c}.json`), receipt);
  return receipt;
}
