// Protocol-specific saved-capture proof; same immutable storage and parent ownership protocol.
import { readFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { hash } from '../dist/history-bootstrap/normalize.js';
import { publishStoredMarket } from '../dist/services/product-daily/storage.js';
import { durableJson } from './market-refresh.mjs';

export async function publishProtocol(store, writer, output, message, active = () => true) {
  const remaining = message.expiresAtUnixSeconds * 1000 - Date.now();
  if (!Number.isFinite(remaining) || remaining <= 0 || remaining > 31000)
    throw Error('PROTOCOL_PUBLICATION_DEADLINE');
  const deadline = performance.now() + Math.min(remaining, 30000);
  const assertCurrent = () => {
    if (performance.now() >= deadline || !active())
      throw Error('PROTOCOL_PUBLICATION_DEADLINE_OR_CLOSED');
  };
  assertCurrent();
  const c = message.cycle;
  if (!Number.isInteger(c) || c < 1 || c > 3 || message.update !== `ROUND_${c}_UPDATE.json`)
    throw Error('PROTOCOL_CYCLE');
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
    throw Error('PROTOCOL_SAVED_BINDING');
  const update = JSON.parse(bytes),
    proof = JSON.parse(auditBytes);
  if (
    proof.kind !== 'HEX_PROTOCOL_AUDIT' ||
    proof.status !== 'PASS' ||
    proof.capturePromotable !== true ||
    proof.cycle !== c ||
    proof.sampleSha256 !== hash(sample) ||
    update.receiptSha256 !== hash(sample)
  )
    throw Error('PROTOCOL_AUDIT_BINDING');
  if (
    update.readings?.length !== 1 ||
    update.readings[0].kind !== 'protocol' ||
    update.liquidityHistory?.length !== 0 ||
    update.methodRevision !== undefined ||
    !update.ledgerAppend
  )
    throw Error('PROTOCOL_ONLY_UPDATE');
  const r = update.readings[0],
    d = proof.details;
  if (
    JSON.stringify(r.globalWords) !== JSON.stringify(d.globalWords) ||
    r.blockHash !== message.pin.hash ||
    r.blockNumber !== message.pin.number ||
    d.context.hash !== message.pin.hash ||
    d.context.number !== message.pin.number ||
    d.ledgerFrom !== update.ledgerAppend.from ||
    d.appendedDays !== update.ledgerAppend.words.length
  )
    throw Error('PROTOCOL_METHOD_BINDING');
  const before = store.capture();
  const result = await publishStoredMarket(store, writer, update, assertCurrent, undefined, {
    output: resolve(output),
    update: message.update,
    updateSha256: hash(bytes),
    audit: auditName,
    auditSha256: hash(auditBytes),
  });
  try {
    assertCurrent();
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
    observedAtUtc: r.observedAtUtc,
    appendedDays: d.appendedDays,
    ledgerEnd: d.ledgerEnd,
    contextualBlock: d.context,
    publishedAt,
    ageAtPublicationSeconds: (Date.parse(publishedAt) - Date.parse(r.observedAtUtc)) / 1000,
    values: r,
    retainedStorage: result.storage,
    retention: result.retention ?? null,
  };
  await durableJson(join(output, `PUBLICATION_${c}.json`), receipt);
  return receipt;
}
