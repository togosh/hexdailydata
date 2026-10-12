import '../mainline/deny-network.mjs';
// Cheap synthetic owner/control-state tests. No collector completion or publisher substitute.
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import { join, resolve } from 'node:path';
import {
  OperatingOwner,
  validateOperating,
  operatingAdmission,
  digest,
  atomicOperating,
} from '../../scripts/unified-refresh/operating.mjs';
const W = resolve(new URL('../..', import.meta.url).pathname.replace(/^\/(.:)/, '$1'));
const T = resolve(process.argv[2]);
assert(T.endsWith('hex-liquidity-scheduling-r1'));
const R = await fs.mkdtemp(join(T, 'fixtures/scheduling-boundaries-'));
const source = '1'.repeat(64),
  cases = [];
const config = JSON.parse(
  await fs.readFile(join(W, 'config/hex-liquidity-scheduling-offline-r1.json')),
);
let time = config.startsAt;
const clock = { mode: 'SYNTHETIC', now: () => time };
const fail = async (name, fn, pattern) => {
  await assert.rejects(fn, pattern);
  cases.push(name);
};
const bound = {
  httpAttempts: 6,
  httpExtras: 3,
  httpChargedBytes: 6 * 2162688,
  chargedEntities: 120000,
  graphAttempts: 0,
  graphExtras: 0,
  graphChargedBytes: 0,
  rpcAttempts: 0,
  rpcExtras: 0,
  rpcChargedBytes: 0,
};
const open = async (name) => {
  const r = join(R, name, 'operating');
  return OperatingOwner.open(r, structuredClone(config), clock, { sourceBinding: source });
};
const register = async (o, id) => {
  await fs.mkdir(join(o.root, id));
  await o.register('trade', 'a'.repeat(64), id, time + 600, bound);
};
const envelope = (o, id, type, ordinal, fields = {}) => ({
  type,
  activation: o.state.activation,
  job: id,
  admissionSha256: 'a'.repeat(64),
  ordinal,
  ...fields,
});
const sorted = (x) =>
  x && typeof x === 'object'
    ? Object.fromEntries(
        Object.keys(x)
          .sort()
          .map((k) => [k, x[k]]),
      )
    : x;
const request = async (o, id, n = 1) => {
  const p = join(o.root, id, String(n).padStart(2, '0'));
  await fs.mkdir(p);
  const q = {
    method: 'GET',
    url: 'https://www.bitstamp.net/api/v2/markets/',
    label: 'markets',
    attempt: n,
    retryOrdinal: 0,
    nonce: 'synthetic',
    dispatchByUnixSeconds: time + 535,
  };
  const raw = Buffer.from(JSON.stringify(q) + '\n'),
    path = join(p, 'request.json');
  await fs.writeFile(path, raw);
  return {
    requestPath: path,
    requestSha256: digest(raw),
    querySha256: digest(JSON.stringify(sorted(q))),
    protocol: 'http',
    endpoint: q.url,
    attempt: n,
    retry: 0,
    bytes: 2162688,
    objects: 20000,
    expiresAt: time + 30,
  };
};
const capture = async (p, { closed = true, complete = true } = {}) => {
  const folder = resolve(p.requestPath, '..'),
    body = Buffer.from('[]\n');
  await fs.writeFile(join(folder, 'response.body'), body);
  const r = {
    attempt: p.attempt,
    closed,
    complete,
    bodySha256: digest(body),
    chargedObjects: complete ? 1 : 20000,
    native: { reaped: closed },
  };
  const raw = Buffer.from(JSON.stringify(r));
  await fs.writeFile(join(folder, 'AUDIT.json'), raw);
  await fs.writeFile(
    join(folder, 'response.json'),
    JSON.stringify({ childReaped: closed, connectionClosed: closed }),
  );
  if (closed)
    await fs.writeFile(
      join(folder, 'PHYSICAL_CLOSED.json'),
      JSON.stringify({
        permit: p.id,
        nonce: p.nonce,
        job: p.job,
        attempt: p.attempt,
        connectionClosed: true,
        childReaped: true,
      }),
    );
  return {
    permitId: p.id,
    nonce: p.nonce,
    attempt: p.attempt,
    closed,
    complete,
    bytes: 2162688,
    objects: r.chargedObjects,
    receiptSha256: digest(raw),
  };
};
try {
  assert.throws(() => validateOperating({ ...config, mode: 'PUBLIC' }), /OFFLINE/);
  cases.push('no public operating authority');
  assert.throws(() => validateOperating({ ...config, extra: true }), /FIELDS/);
  cases.push('strict configuration');
  assert.throws(() => operatingAdmission({ operatingFormat: config.format }), /AUTHORITY/);
  cases.push('no wildcard historical grant');
  let o = await open('serial'),
    id = 'trade-00000001';
  await register(o, id);
  await fail(
    'same-root second owner',
    () => OperatingOwner.open(o.root, config, clock, { sourceBinding: source }),
    /EEXIST/,
  );
  const r = await request(o, id);
  let promise = o.control(id, envelope(o, id, 'operating-permit', 1, r));
  await o.pump();
  const granted = await promise,
    p = granted.permit;
  assert.equal(o.state.totals.http.attempts, 1);
  assert.equal(o.state.totals.http.objects, 20000);
  assert(o.state.pending);
  cases.push('durable worst liability before permit');
  const m = await capture(p);
  await fail(
    'tampered settlement refund refused',
    () => o.control(id, envelope(o, id, 'operating-settle', 2, { ...m, objects: 0 })),
    /SETTLEMENT_VALUES/,
  );
  assert.equal(o.state.totals.http.objects, 20000);
  assert(o.state.pending);
  await o.control(id, envelope(o, id, 'operating-settle', 3, m));
  assert.equal(o.state.totals.http.objects, 1);
  assert.equal(o.state.pending, null);
  await fail(
    'duplicate settlement refused',
    () => o.control(id, envelope(o, id, 'operating-settle', 4, m)),
    /SETTLEMENT_IDENTITY/,
  );
  await o.finish(id, { status: 'SYNTHETIC_OWNER_UNIT_ONLY' });
  await o.close();
  o = await open('unknown');
  id = 'trade-00000001';
  await register(o, id);
  promise = o.control(id, envelope(o, id, 'operating-permit', 1, await request(o, id)));
  await o.pump();
  const u = (await promise).permit;
  await o.control(
    id,
    envelope(o, id, 'operating-settle', 2, await capture(u, { closed: false, complete: false })),
  );
  assert.equal(o.state.status, 'UNKNOWN');
  assert.equal(o.state.totals.http.objects, 20000);
  assert.equal(o.state.pending.id, u.id);
  await o.lock.close();
  cases.push('unknown closure retains protection and full charges');
  o = await open('tamper');
  id = 'trade-00000001';
  await register(o, id);
  promise = o.control(
    id,
    envelope(o, id, 'operating-permit', 1, { ...(await request(o, id)), bytes: 1 }),
  );
  const caught = promise.catch((e) => e);
  await o.pump();
  assert.match(String(await caught), /LIABILITY_MISMATCH/);
  assert.equal(o.state.totals.http.attempts, 0);
  await o.finish(id, { status: 'REFUSED' });
  await o.close();
  cases.push('query liability tamper before physical dispatch');
  o = await open('expired-permit');
  id = 'trade-00000001';
  await register(o, id);
  promise = o.control(id, envelope(o, id, 'operating-permit', 1, await request(o, id)));
  const expiry = caughtPromise(promise);
  time += 31;
  await o.pump();
  assert.match(String(await expiry), /EXPIRY/);
  await o.finish(id, { status: 'REFUSED' });
  await o.close();
  cases.push('queue time consumes request deadline');
  o = await open('clock');
  time -= 1;
  assert.throws(() => o.now(), /CLOCK_ROLLBACK/);
  await o.lock.close();
  time += 1;
  cases.push('clock rollback refuses');
  time = config.startsAt;
  o = await open('endpoint-reserve');
  const allowance = {
    ...bound,
    httpAttempts: 0,
    rpcAttempts: 12,
    rpcChargedBytes: 1048576,
    rpcExtras: 0,
  };
  await o.register('gas', 'a'.repeat(64), 'gas-00000001', time + 600, allowance);
  await o.register('protocol', 'a'.repeat(64), 'protocol-00000002', time + 600, allowance);
  o.state.endpointAttempts.rpc[0] = Math.floor(config.total.rpc.attempts / 2) - 6;
  assert.throws(
    () => o.checkEndpointReserve('gas-00000001', 'rpc', 0, { endpointAttempts: [1, 0] }),
    /ENDPOINT_CONTROL_RESERVE/,
  );
  o.checkEndpointReserve('gas-00000001', 'rpc', 1, { endpointAttempts: [0, 1] });
  await o.finish('gas-00000001', { status: 'RESERVE_UNIT' });
  await o.finish('protocol-00000002', { status: 'RESERVE_UNIT' });
  await o.close();
  cases.push('asymmetric endpoint usage protects other active closing liabilities');
  o = await open('admission-protection');
  await o.register('gas', 'a'.repeat(64), 'gas-00000001', time + 600, allowance);
  o.state.endpointAttempts.rpc[0] = Math.floor(config.total.rpc.attempts / 2) - 6;
  await fail(
    'new admission cannot borrow existing endpoint controls',
    () => o.register('protocol', 'a'.repeat(64), 'protocol-00000002', time + 600, allowance),
    /ENDPOINT_ADMISSION_RESERVE/,
  );
  assert.equal(o.jobs.size, 1);
  o.checkEndpointReserve('gas-00000001', 'rpc', 0, { endpointAttempts: [6, 0] });
  o.state.endpointAttempts.rpc[0] = 0;
  const used = structuredClone(o.state.totals);
  used.rpc.attempts = config.rolling.limits.rpc.attempts - 12;
  o.state.rolling.push({ at: time, cost: used });
  await fail(
    'new admission cannot borrow existing rolling controls',
    () => o.register('protocol', 'a'.repeat(64), 'protocol-00000002', time + 600, allowance),
    /ROLLING_ADMISSION_RESERVE/,
  );
  await o.finish('gas-00000001', { status: 'RESERVE_UNIT' });
  await o.close();
  o = await open('queued-publication-stop');
  await register(o, 'trade-00000001');
  let releaseWriter,
    entered = false;
  const firstWriter = o.publication(
    'trade-00000001',
    () =>
      new Promise((resolve) => {
        releaseWriter = resolve;
      }),
  );
  await new Promise((resolve) => setImmediate(resolve));
  const secondWriter = caughtPromise(
    o.publication('trade-00000001', () => {
      entered = true;
    }),
  );
  o.state.status = 'UNKNOWN';
  releaseWriter();
  await firstWriter;
  assert.match(String(await secondWriter), /PUBLICATION_CLOSED/);
  assert.equal(entered, false);
  assert.equal(o.maxWriters, 1);
  await o.lock.close();
  cases.push('cancelled queued publication cannot enter writer; one writer maximum');
  o = await open('entry-limit');
  o.storageCache = {
    entries: config.storage.entries - 1,
    bytes: 0,
    charged: 0,
    nextRequest: o.state.nextRequest,
  };
  await fail(
    'cached entry reservation refuses before permit',
    () => o.storage(0, false),
    /ENTRY_RESERVE/,
  );
  await o.close();
  o = await open('final-expiry');
  id = 'trade-00000001';
  await register(o, id);
  const finalRequest = await request(o, id);
  const receipt = o.receipt.bind(o);
  o.receipt = async (...args) => {
    await receipt(...args);
    if (args[0].startsWith('PERMIT_')) time += 31;
  };
  promise = caughtPromise(o.control(id, envelope(o, id, 'operating-permit', 1, finalRequest)));
  await o.pump();
  assert.match(String(await promise), /FINAL_PERMIT_EXPIRED/);
  assert(o.state.pending);
  assert.equal(o.state.totals.http.attempts, 1);
  await o.lock.close();
  cases.push('durable-write delay cannot renew permit; charged pending protected');
  o = await open('duplicate-family');
  await register(o, 'trade-00000001');
  await fail(
    'same-family duplicate admission',
    () => o.register('trade', 'b'.repeat(64), 'trade-00000002', time + 600, bound),
    /FAMILY_CONCURRENCY/,
  );
  await o.finish('trade-00000001', { status: 'UNIT_REFUSAL_ONLY' });
  await o.close();
  o = await open('cancel-queued');
  await register(o, 'trade-00000001');
  const waiting = caughtPromise(
    o.control(
      'trade-00000001',
      envelope(o, 'trade-00000001', 'operating-permit', 1, await request(o, 'trade-00000001')),
    ),
  );
  o.state.status = 'UNKNOWN';
  await o.pump();
  assert.match(String(await waiting), /DISPATCH_CLOSED/);
  assert.equal(o.state.totals.http.attempts, 0);
  await o.lock.close();
  cases.push('cancelled queued request cannot obtain physical permission');
  o = await open('total-exhausted');
  o.state.totals.http.attempts = config.total.http.attempts;
  await fail(
    'total cap cannot admit a new job',
    () => register(o, 'trade-00000001'),
    /ACTIVE_RESERVATIONS/,
  );
  await o.close();
  const offsets = structuredClone(config);
  offsets.families.market.offset = offsets.families.market.period;
  assert.throws(() => validateOperating(offsets), /INTEGER/);
  cases.push('offline offsets strictly below original period');
  await marketBoundaries(R, T, cases);
  await fs.writeFile(
    join(R, 'RESULT.json'),
    JSON.stringify(
      { status: 'PASS', synthetic: true, externalRequests: 0, genuineBaseAdmissions: 0, cases },
      null,
      2,
    ) + '\n',
  );
  console.log(JSON.stringify({ status: 'PASS', root: R, cases }));
} catch (e) {
  await fs.writeFile(
    join(R, 'FAILURE.json'),
    JSON.stringify({ status: 'FAIL', error: String(e), stack: e.stack, cases }, null, 2) + '\n',
  );
  throw e;
}
function caughtPromise(p) {
  return p.catch((e) => e);
}

async function marketBoundaries(R, T, cases) {
  const { marketTiming, marketReserve, queuePriority } =
    await import('../../scripts/unified-refresh/market-scheduling.mjs');
  const read = async (p) => JSON.parse(await fs.readFile(p));
  const a = await read(join(T, 'reference/r4/session/market-00000002/ADMISSION.json'));
  const saved = await read(
    join(T, 'reference/r4/session/market-00000002/combined-reservations/00036.json'),
  );
  const root = join(R, 'market-timing');
  await fs.mkdir(join(root, a.job, 'combined-reservations'), { recursive: true });
  const ar = Buffer.from(JSON.stringify(a));
  await fs.writeFile(join(root, a.job, 'ADMISSION.json'), ar);
  const rp = join(root, a.job, 'combined-reservations/00036.json');
  const restore = () => fs.writeFile(rp, JSON.stringify(saved));
  await restore();
  const state = {
    controlIndex: 0,
    openedPools: [0, 1],
    retries: structuredClone(saved.countersBefore.retrySpent),
    prior: null,
  };
  const spent = {
    http: { attempts: 0, bytes: 0, objects: 0, extras: 0 },
    graph: {
      attempts: saved.countersBefore.graphAttempts,
      bytes: saved.countersBefore.graphChargedBytes,
    },
    rpc: {
      attempts: saved.countersBefore.rpcAttempts,
      bytes: saved.countersBefore.rpcChargedBytes,
    },
  };
  const j = {
    id: a.job,
    admissionHash: digest(ar),
    deadline: a.deadlineUnixSeconds,
    spent,
    marketSchedule: state,
  };
  const now = a.startedAtUnixSeconds + saved.offset;
  const raw = Buffer.from(JSON.stringify({ job: saved.query }));
  const m = {
    attempt: 36,
    retry: 0,
    expiresAt: now + 30,
    reserved: { ...saved.reserved.counts, endpointAttempts: saved.reserved.endpointAttempts },
  };
  const t = await marketTiming(root, j, m, raw, now);
  assert.equal(t.reserveSeconds, 308);
  assert(t.latestDispatch > now && t.latestDispatch < now + 8);
  assert.equal(
    (await marketTiming(root, j, m, raw, t.latestDispatch)).latestDispatch,
    t.latestDispatch,
  );
  cases.push(
    'actual R4 reservation: exact 308-second closing reserve and strict latest-dispatch boundary',
  );
  for (const [name, change] of [
    ['controls removed', (r) => r.controls.pop()],
    ['control urgency forged', (r) => (r.closing = true)],
    ['saved counts forged', (r) => r.reserved.counts.rpcAttempts--],
    ['retry pool forged', (r) => r.countersBefore.retrySpent.dataGraph++],
    ['query mutation', (r) => (r.query.method = 'eth_sendTransaction')],
    ['arbitrary offset', (r) => (r.offset = NaN)],
  ]) {
    const r = structuredClone(saved);
    change(r);
    await fs.writeFile(rp, JSON.stringify(r));
    await assert.rejects(() => marketTiming(root, j, m, raw, now), /MARKET_SCHEDULE_/);
    cases.push(name + ' refused');
  }
  await restore();
  await assert.rejects(
    () => marketTiming(root, { ...j, deadline: j.deadline + 1 }, m, raw, now),
    /JOB/,
  );
  cases.push('deadline/source admission binding cannot be enlarged');
  await assert.rejects(
    () => marketTiming(root, j, { ...m, reserved: { ...m.reserved, rpcAttempts: 0 } }, raw, now),
    /IPC_RESERVE/,
  );
  cases.push('IPC control liability cannot mint priority');
  const arbitrary = await marketTiming(
    root,
    j,
    { ...m, priority: -999, latestDispatch: 1 },
    raw,
    now,
  );
  assert.deepEqual(arbitrary, t);
  cases.push('unsolicited child priority has no effect');
  const shorter = await marketTiming(root, j, { ...m, expiresAt: now + 4 }, raw, now);
  assert.equal(queuePriority(now, shorter), queuePriority(now, t));
  assert.equal(queuePriority(now - 32), now - 1);
  assert(queuePriority(now - 32) < queuePriority(now, t));
  cases.push(
    'shortened IPC expiry cannot buy priority; 31-second parent aging prevents feasible-market starvation',
  );
  // Closing flag forged on an already opened pool must fail before any grant.
  const q = { kind: 'pools', endpoint: 0, maxRows: 32 };
  const r = structuredClone(saved);
  r.query = q;
  r.closing = false;
  const calc = marketReserve(q, r.controls, 0, state.retries, a.allowance);
  r.reserved = {
    counts: calc.counts,
    endpointAttempts: calc.endpointAttempts,
    physicalAttempts: calc.physicalAttempts,
    waitSeconds: calc.waitSeconds,
    finishOffset: r.offset + calc.seconds,
    publicationSeconds: a.allowance.publication,
    slot: calc.slot,
    control: calc.control,
  };
  await fs.writeFile(rp, JSON.stringify(r));
  await assert.rejects(
    () =>
      marketTiming(
        root,
        j,
        { ...m, reserved: { ...calc.counts, endpointAttempts: calc.endpointAttempts } },
        Buffer.from(JSON.stringify({ job: q })),
        now,
      ),
    /CONTROL_PHASE/,
  );
  cases.push('recomputed fake opening/closing urgency rejected from settled pool lineage');
  await restore();
  // Native reserve comparison was independently saved by BASELINE_COUNTEREXAMPLE.
  await fs.writeFile(
    join(R, 'MARKET_TIMING.json'),
    JSON.stringify(
      { synthetic: true, savedReservation: saved, computed: t, at: now, boundaryStrict: true },
      null,
      2,
    ),
  );
}
