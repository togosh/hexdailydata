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

export async function capturedBody(output, binding, label) {
  if (!Number.isInteger(binding?.attempt) || binding.attempt < 1 || binding.attempt > 14)
    throw Error('TRADE_CAPTURE_ATTEMPT');
  const dir = join(output, String(binding.attempt).padStart(2, '0'));
  const p = join(dir, 'response.body');
  if ((await stat(p)).size > 2097152) throw Error('TRADE_CAPTURE_BOUND');
  const raw = await readFile(p),
    audit = JSON.parse(await readFile(join(dir, 'AUDIT.json')));
  const admissionRaw = await readFile(join(output, 'ADMISSION.json'));
  if (admissionRaw.length > 262144) throw Error('TRADE_ADMISSION_BOUND');
  const admission = JSON.parse(admissionRaw);
  const url =
    label === 'markets'
      ? 'https://www.bitstamp.net/api/v2/markets/'
      : /^(BTC|ETH)_[1-3]$/.test(label)
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
  if (![1, 2, 3].includes(c)) throw Error('TRADE_CYCLE');
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
