// Paired oracle proof, same coordinated publisher and immutable journal.
import { readFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { hash } from '../dist/history-bootstrap/normalize.js';
import { publishStoredMarket } from '../dist/services/product-daily/storage.js';
import { durableJson } from './market-refresh.mjs';

export async function publishReference(
  store,
  writer,
  output,
  message,
  active = () => true,
  publish = publishStoredMarket,
) {
  const remaining = message.expiresAtUnixSeconds * 1000 - Date.now();
  if (!(remaining > 0 && remaining <= 31000)) throw Error('REFERENCE_PUBLICATION_DEADLINE');
  const deadline = performance.now() + Math.min(remaining, 30000);
  const check = () => {
    if (performance.now() >= deadline || !active()) throw Error('REFERENCE_PUBLICATION_CLOSED');
  };
  check();
  const c = message.cycle;
  if (![1, 2].includes(c) || message.update !== `ROUND_${c}_UPDATE.json`)
    throw Error('REFERENCE_CYCLE');
  const bytes = await readFile(join(output, message.update));
  const auditName = `ROUND_${c}_AUDIT.json`,
    auditBytes = await readFile(join(output, auditName));
  const sample = await readFile(join(output, `ROUND_${c}_SAMPLE.json`));
  if (
    bytes.length > 65536 ||
    auditBytes.length > 262144 ||
    sample.length > 65536 ||
    hash(bytes) !== message.updateSha256 ||
    hash(auditBytes) !== message.auditSha256
  )
    throw Error('REFERENCE_SAVED_BINDING');
  const update = JSON.parse(bytes),
    proof = JSON.parse(auditBytes);
  if (
    proof.kind !== 'BTC_ETH_REFERENCE_AUDIT' ||
    proof.status !== 'PASS' ||
    proof.capturePromotable !== true ||
    proof.cycle !== c ||
    proof.sampleSha256 !== hash(sample) ||
    update.receiptSha256 !== hash(sample)
  )
    throw Error('REFERENCE_AUDIT_BINDING');
  if (
    Object.keys(update).sort().join(',') !== 'liquidityHistory,readings,receiptSha256' ||
    update.liquidityHistory.length !== 0 ||
    update.readings.length !== 2 ||
    update.readings.map((r) => r.asset).join(',') !== 'BTC,ETH' ||
    JSON.stringify(update.readings) !== JSON.stringify(proof.details.readings) ||
    proof.details.pin.hash !== message.pin.hash ||
    proof.details.pin.number !== message.pin.number
  )
    throw Error('REFERENCE_PAIRED_ONLY_UPDATE');
  for (const r of update.readings) {
    const age = (Date.now() - Date.parse(r.observedAtUtc)) / 1000;
    if (r.kind !== 'reference' || r.chainId !== 1 || !(age >= 0 && age <= 86400))
      throw Error('REFERENCE_PROMOTION_AGE');
    const tuple = proof.details.rounds[r.asset],
      n = BigInt(tuple.answer),
      d = 100000000n;
    const value =
      String(n / d) +
      (n % d
        ? '.' +
          String(n % d)
            .padStart(8, '0')
            .replace(/0+$/, '')
        : '');
    if (
      r.roundId !== tuple.roundId ||
      r.value !== value ||
      r.observedAtUtc !== new Date(Number(tuple.updatedAt) * 1000).toISOString()
    )
      throw Error('REFERENCE_RAW_TUPLE_BINDING');
  }
  const before = store.capture();
  const result = await publish(store, writer, update, check, undefined, {
    output: resolve(output),
    update: message.update,
    updateSha256: hash(bytes),
    audit: auditName,
    auditSha256: hash(auditBytes),
  });
  try {
    check();
  } catch (e) {
    e.publicationUncertain = true;
    throw e;
  }
  const publishedAt = new Date().toISOString();
  const receipt = {
    cycle: c,
    previous: before.version,
    selected: result.selected,
    changed: result.changed,
    updateSha256: hash(bytes),
    publishedAt,
    pin: proof.details.pin,
    pinning: proof.details.pinning,
    sameRound: proof.details.sameRound,
    values: update.readings,
    agesAtPublicationSeconds: Object.fromEntries(
      update.readings.map((r) => [
        r.asset,
        (Date.parse(publishedAt) - Date.parse(r.observedAtUtc)) / 1000,
      ]),
    ),
    retainedStorage: result.storage,
    retention: result.retention ?? null,
  };
  await durableJson(join(output, `PUBLICATION_${c}.json`), receipt);
  return receipt;
}
