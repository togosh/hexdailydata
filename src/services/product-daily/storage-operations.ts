/** Small immutable local-operation ledger. Never opens the referenced output directories. */
import { open, readdir, lstat } from 'node:fs/promises';
import { resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { hash, stable } from '../../history-bootstrap/normalize.ts';
import { storageBytes, safeStoragePath } from './storage.ts';

export type OperationState = {
  operationSequence: number;
  operationHead: string;
  operationBytes: number;
  operationEntries: number;
};
export type Reservation = {
  id: string;
  sequence: number;
  sha256: string;
  kind: 'capture' | 'backup';
  output: string;
  bytes: number;
  entries: number;
};
const name = (n: number) => `operations/${String(n).padStart(8, '0')}.json`;
const settledName = (n: number) => `operations/${String(n).padStart(8, '0')}.settled.json`;
const equal = (a: unknown, b: unknown) => stable(a) === stable(b);
type Event = {
  sequence: number;
  previous: string;
  action: 'reserve' | 'settle';
  reservation: Reservation;
  bytes: number;
  entries: number;
  operationBytes: number;
  operationEntries: number;
  head: string;
};
async function readEvent(root: string, n: number): Promise<Event> {
  const raw = await storageBytes(root, name(n), 4096),
    value = JSON.parse(raw.toString());
  const { head, ...body } = value;
  if (
    value.sequence !== n ||
    hash(stable(body)) !== head ||
    !['reserve', 'settle'].includes(value.action) ||
    !Number.isSafeInteger(value.operationBytes) ||
    value.operationBytes < 0 ||
    !Number.isSafeInteger(value.operationEntries) ||
    value.operationEntries < 0
  )
    throw Error('OPERATION_EVENT');
  return value;
}
export async function verifyOperationFrontier(root: string, s: OperationState) {
  if (s.operationSequence === 0) {
    if (s.operationBytes || s.operationEntries) throw Error('OPERATION_COUNTERS');
    return;
  }
  const e = await readEvent(root, s.operationSequence);
  if (
    e.head !== s.operationHead ||
    e.operationBytes !== s.operationBytes ||
    e.operationEntries !== s.operationEntries
  )
    throw Error('OPERATION_COUNTERS');
}
export async function auditOperations(root: string, s: OperationState) {
  await verifyOperationFrontier(root, s);
  const files: string[] = [];
  const reservations = new Map<string, Reservation>(),
    settled = new Set<string>();
  let bytes = 0,
    entries = 0,
    head: string | undefined;
  for (let n = 1; n <= s.operationSequence; n++) {
    const e = await readEvent(root, n);
    files.push(name(n));
    if (head && e.previous !== head) throw Error('OPERATION_CHAIN');
    const r = e.reservation;
    if (
      !Number.isSafeInteger(r.bytes) ||
      r.bytes < 0 ||
      !Number.isSafeInteger(r.entries) ||
      r.entries < 0 ||
      !Number.isSafeInteger(e.bytes) ||
      e.bytes < 0 ||
      !Number.isSafeInteger(e.entries) ||
      e.entries < 0
    )
      throw Error('OPERATION_AMOUNT');
    if (e.action === 'reserve') {
      if (
        reservations.has(r.id) ||
        r.sequence !== n ||
        r.sha256 !==
          hash(
            stable({
              id: r.id,
              sequence: r.sequence,
              kind: r.kind,
              output: r.output,
              bytes: r.bytes,
              entries: r.entries,
            }),
          )
      )
        throw Error('OPERATION_RESERVATION');
      reservations.set(r.id, r);
      bytes += r.bytes;
      entries += r.entries;
    } else {
      if (
        settled.has(r.id) ||
        !equal(reservations.get(r.id), r) ||
        e.bytes > r.bytes ||
        e.entries > r.entries
      )
        throw Error('OPERATION_SETTLEMENT');
      settled.add(r.id);
      const proof = JSON.parse(
        (await storageBytes(root, settledName(r.sequence), 4096)).toString(),
      );
      if (!equal(proof, { reservation: r, eventSequence: n, eventHead: e.head }))
        throw Error('OPERATION_SETTLEMENT_PROOF');
      files.push(settledName(r.sequence));
      bytes += e.bytes - r.bytes;
      entries += e.entries - r.entries;
    }
    bytes += e.action === 'settle' ? 8192 : 4096;
    entries += e.action === 'settle' ? 2 : 1;
    if (e.operationBytes !== bytes || e.operationEntries !== entries)
      throw Error('OPERATION_COUNTERS');
    head = e.head;
  }
  if (
    bytes !== s.operationBytes ||
    entries !== s.operationEntries ||
    (head && head !== s.operationHead)
  )
    throw Error('OPERATION_COUNTERS');
  if (
    !equal(
      (await readdir(await safeStoragePath(root, 'operations'))).sort(),
      files.map((f) => f.slice(11)).sort(),
    )
  )
    throw Error('OPERATION_ORPHAN');
  return {
    status: 'PASS',
    events: s.operationSequence,
    bytes,
    entries,
    files,
    unresolved: [...reservations.values()]
      .filter((r) => r.kind === 'capture' && !settled.has(r.id))
      .map((r) => ({ id: r.id, output: r.output, bytes: r.bytes, entries: r.entries })),
  };
}
async function append(
  root: string,
  s: OperationState,
  action: 'reserve' | 'settle',
  r: Reservation,
  bytes: number,
  entries: number,
) {
  await verifyOperationFrontier(root, s);
  if (s.operationSequence >= 8192) throw Error('OPERATION_ENTRY_BOUND');
  const body = {
    sequence: s.operationSequence + 1,
    previous: s.operationHead,
    action,
    reservation: r,
    bytes,
    entries,
    operationBytes:
      s.operationBytes +
      (action === 'settle' ? 8192 : 4096) +
      bytes -
      (action === 'settle' ? r.bytes : 0),
    operationEntries:
      s.operationEntries +
      (action === 'settle' ? 2 : 1) +
      entries -
      (action === 'settle' ? r.entries : 0),
  };
  const event = { ...body, head: hash(stable(body)) },
    raw = Buffer.from(stable(event));
  if (raw.length > 4096) throw Error('OPERATION_RECORD_BOUND');
  if (action === 'settle') {
    // Exclusive direct tombstone prevents double settlement without replaying lifetime history.
    // A crash leaves the writer uncertain; maintenance audits both proof and event.
    const proof = await open(await safeStoragePath(root, settledName(r.sequence)), 'wx');
    try {
      await proof.writeFile(
        stable({ reservation: r, eventSequence: event.sequence, eventHead: event.head }),
      );
      await proof.sync();
    } finally {
      await proof.close();
    }
  }
  const f = await open(await safeStoragePath(root, name(event.sequence)), 'wx');
  try {
    await f.writeFile(raw);
    await f.sync();
  } finally {
    await f.close();
  }
  return {
    operationSequence: event.sequence,
    operationHead: event.head,
    operationBytes: event.operationBytes,
    operationEntries: event.operationEntries,
  };
}
export async function reserveOperation(
  root: string,
  s: OperationState,
  kind: Reservation['kind'],
  output: string,
  bytes: number,
  entries: number,
) {
  await verifyOperationFrontier(root, s);
  const body = {
    id: randomUUID(),
    sequence: s.operationSequence + 1,
    kind,
    output: resolve(output),
    bytes,
    entries,
  };
  const reservation = { ...body, sha256: hash(stable(body)) };
  return { reservation, state: await append(root, s, 'reserve', reservation, bytes, entries) };
}
export async function validateSettlement(
  root: string,
  s: OperationState,
  r: Reservation,
  output: string,
  bytes: number,
  entries: number,
) {
  await verifyOperationFrontier(root, s);
  if (!Number.isSafeInteger(r.sequence) || r.sequence < 1 || r.sequence > s.operationSequence)
    throw Error('WRONG_OR_SETTLED_OPERATION');
  const reserve = await readEvent(root, r.sequence);
  let settled = false;
  try {
    await lstat(await safeStoragePath(root, settledName(r.sequence)));
    settled = true;
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e;
  }
  if (
    !equal(reserve.reservation, r) ||
    reserve.action !== 'reserve' ||
    r.kind !== 'capture' ||
    resolve(output) !== r.output ||
    settled ||
    !Number.isSafeInteger(bytes) ||
    bytes < 0 ||
    !Number.isSafeInteger(entries) ||
    entries < 0 ||
    bytes > r.bytes ||
    entries > r.entries
  )
    throw Error('WRONG_OR_SETTLED_OPERATION');
}
export async function settleOperation(
  root: string,
  s: OperationState,
  r: Reservation,
  output: string,
  bytes: number,
  entries: number,
) {
  await validateSettlement(root, s, r, output, bytes, entries);
  return append(root, s, 'settle', r, bytes, entries);
}
