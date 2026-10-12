// Independent market closing-time calculation. No child-supplied priority or deadline.
import fs from 'node:fs/promises';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
const hash = (b) => createHash('sha256').update(b).digest('hex');
const need = (ok, why) => {
  if (!ok) throw Error('MARKET_SCHEDULE_' + why);
};
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const descriptors = ['pools', 'meta', 'rpc'].flatMap((kind) =>
  [0, 1].map((endpoint) => ({ kind, endpoint, maxRows: kind === 'rpc' ? 64 : 32 })),
);
const kind = (q) => (q.kind === 'rpc' ? 'rpc' : 'graph');
const capacity = (q) =>
  q.kind === 'rpc'
    ? !q.method || q.method === 'eth_getBlockByNumber'
      ? 524288
      : 4096
    : { meta: 65536, pools: 262144 }[q.kind];
const signature = (q) => [q.kind, q.endpoint, q.maxRows];
const keys = [
  'graphAttempts',
  'rpcAttempts',
  'graphChargedBytes',
  'rpcChargedBytes',
  'chargedEntities',
];
// FIFO aging is parent-owned. A market may move forward only for its independently
// proved control deadline; a feasible market cannot bypass a 31-second waiter.
export const queuePriority = (queuedAt, timing) =>
  Math.min(queuedAt + 31, timing?.controlDeadline ?? Infinity);
export function marketReserve(q, controls, ordinal, pools, limits) {
  const p = kind(q),
    control = controls.length < 6;
  const slot = (control ? 'control' : 'data') + (p === 'rpc' ? 'Rpc' : 'Graph');
  const cap = control
    ? limits['control' + (p === 'rpc' ? 'Rpc' : 'Graph') + 'Extras']
    : limits[p + 'Extras'] - limits['control' + (p === 'rpc' ? 'Rpc' : 'Graph') + 'Extras'];
  const used = Number(ordinal > 0);
  need(pools[slot] + used <= cap, 'EXTRAS');
  const remaining = Math.max(0, Math.min(2 - ordinal, cap - pools[slot] - used));
  const jobs = [q, ...Array(remaining).fill(q), ...controls];
  let wait = [15, 60].slice(ordinal, ordinal + remaining).reduce((a, b) => a + b, 0);
  for (const p2 of ['graph', 'rpc']) {
    const candidates = controls.filter((x) => kind(x) === p2);
    if (control && p === p2) candidates.push(q);
    let extras = Math.max(
      0,
      limits['control' + (p2 === 'rpc' ? 'Rpc' : 'Graph') + 'Extras'] -
        pools['control' + (p2 === 'rpc' ? 'Rpc' : 'Graph')] -
        (control && p === p2 ? used : 0),
    );
    if (control && p === p2) extras = Math.max(0, extras - remaining);
    extras = Math.min(extras, 2 * candidates.length);
    if (extras) {
      const largest = candidates.reduce((a, b) => (capacity(a) >= capacity(b) ? a : b));
      jobs.push(
        ...Array(extras).fill({
          ...largest,
          maxRows: Math.max(...candidates.map((x) => x.maxRows)),
        }),
      );
      wait += 60 * extras;
    }
  }
  const counts = Object.fromEntries(keys.map((k) => [k, 0])),
    endpointAttempts = [0, 0];
  for (const j of jobs) {
    need(Number.isSafeInteger(capacity(j)), 'METHOD');
    counts[kind(j) + 'Attempts']++;
    counts[kind(j) + 'ChargedBytes'] += capacity(j);
    counts.chargedEntities += j.maxRows;
    if (j.kind === 'rpc') endpointAttempts[j.endpoint]++;
  }
  return {
    counts,
    endpointAttempts,
    physicalAttempts: jobs.length,
    waitSeconds: wait,
    seconds: 31 * jobs.length + wait,
    slot,
    control,
  };
}

export async function marketTiming(root, j, m, raw, now) {
  const admissionRaw = await fs.readFile(join(root, j.id, 'ADMISSION.json'));
  need(admissionRaw.length <= 262144 && hash(admissionRaw) === j.admissionHash, 'ADMISSION');
  const a = JSON.parse(admissionRaw),
    q = JSON.parse(raw).job;
  need(a.family === 'market' && a.job === j.id && a.deadlineUnixSeconds === j.deadline, 'JOB');
  need(
    Number.isFinite(a.startedAtUnixSeconds) &&
      Number.isFinite(a.networkClosesAtUnixSeconds) &&
      Number.isFinite(m.expiresAt) &&
      a.networkClosesAtUnixSeconds > a.startedAtUnixSeconds &&
      a.networkClosesAtUnixSeconds <= j.deadline - a.allowance.publication - 5,
    'NETWORK_END',
  );
  const path = join(
    root,
    j.id,
    'combined-reservations',
    String(m.attempt).padStart(5, '0') + '.json',
  );
  const bytes = await fs.readFile(path);
  need(bytes.length <= 16384, 'BOUND');
  const r = JSON.parse(bytes),
    state = j.marketSchedule ?? {
      controlIndex: 0,
      openedPools: [],
      retries: { dataGraph: 0, controlGraph: 0, dataRpc: 0, controlRpc: 0 },
      prior: null,
    };
  need(r.attempt === m.attempt && r.ordinal === m.retry && same(r.query, q), 'QUERY');
  need(
    Number.isFinite(r.offset) && r.offset >= 0 && r.offset <= now - a.startedAtUnixSeconds + 0.01,
    'OFFSET',
  );
  need(same(r.countersBefore.retrySpent, state.retries), 'RETRY_LINEAGE');
  for (const p of ['graph', 'rpc'])
    for (const [k, field] of [
      ['attempts', 'Attempts'],
      ['bytes', 'ChargedBytes'],
    ])
      need(r.countersBefore[p + field] === j.spent[p][k], 'COUNTER_LINEAGE');
  if (m.retry)
    need(
      state.prior?.querySha256 === m.querySha256 && state.prior.retry + 1 === m.retry,
      'EXACT_RETRY',
    );
  let index = state.controlIndex;
  // Match the independent saved auditor: a repeated opened-pool endpoint begins
  // closing. The child's phase flag cannot manufacture a larger urgency reserve.
  const expectedClosing =
    index > 0 || (q.kind === 'pools' && state.openedPools.includes(q.endpoint));
  need(r.closing === expectedClosing, 'CONTROL_PHASE');
  if (r.closing) {
    need(state.openedPools.includes(0) && state.openedPools.includes(1), 'UNOPENED_CLOSE');
    if (!m.retry) {
      need(index < 6 && same(signature(q), signature(descriptors[index])), 'CONTROL_ORDER');
      index++;
    } else
      need(index > 0 && same(signature(q), signature(descriptors[index - 1])), 'CONTROL_RETRY');
  } else need(index === 0, 'REOPENED_DATA');
  need(same(r.controls, descriptors.slice(index)), 'CONTROL_SET');
  const expected = marketReserve(q, r.controls, m.retry, state.retries, a.allowance);
  const value = {
    ...expected,
    finishOffset: r.offset + expected.seconds,
    publicationSeconds: a.allowance.publication,
  };
  delete value.seconds;
  need(
    Object.keys(value).every((k) => same(value[k], r.reserved[k])) &&
      Object.keys(value).length === Object.keys(r.reserved).length,
    'RESERVATION',
  );
  need(
    same(m.reserved, { ...expected.counts, endpointAttempts: expected.endpointAttempts }),
    'IPC_RESERVE',
  );
  const latest =
    Math.min(a.networkClosesAtUnixSeconds, j.deadline - a.allowance.publication) - expected.seconds;
  return {
    latestDispatch: Math.min(m.expiresAt - 3, latest),
    controlDeadline: latest,
    reserveSeconds: expected.seconds,
    reservationSha256: hash(bytes),
    controlIndex: index,
    slot: expected.slot,
    closing: r.closing,
    query: q,
  };
}

export function marketGranted(j, m, timing) {
  const s = (j.marketSchedule ??= {
    controlIndex: 0,
    openedPools: [],
    retries: { dataGraph: 0, controlGraph: 0, dataRpc: 0, controlRpc: 0 },
    prior: null,
  });
  s.controlIndex = timing.controlIndex;
  if (m.retry) s.retries[timing.slot]++;
  s.prior = {
    querySha256: m.querySha256,
    retry: m.retry,
    query: timing.query,
    closing: timing.closing,
  };
}
export function marketSettled(j, capture) {
  const s = j.marketSchedule;
  if (capture.usable && s?.prior && !s.prior.closing && s.prior.query.kind === 'pools')
    if (!s.openedPools.includes(s.prior.query.endpoint)) s.openedPools.push(s.prior.query.endpoint);
}
