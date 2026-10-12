// Actual queue pump with saved R4 reserve shape; no physical response or completion is simulated here.
import '../mainline/deny-network.mjs';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { OperatingOwner, digest } from '../../scripts/unified-refresh/operating.mjs';
const T = resolve(process.argv[2]),
  W = resolve(new URL('../..', import.meta.url).pathname.replace(/^\/(.:)/, '$1'));
assert(T.endsWith('hex-liquidity-scheduling-r1'));
const R = await fs.mkdtemp(join(T, 'fixtures/scheduling-queue-'));
const read = async (p) => JSON.parse(await fs.readFile(p));
const base = await read(join(W, 'config/hex-liquidity-scheduling-offline-r1.json'));
const saved = await read(
  join(T, 'reference/r4/session/market-00000002/combined-reservations/00036.json'),
);
const allowance = (await read(join(T, 'reference/r4/session/market-00000002/ADMISSION.json')))
  .allowance;
const sort = (x) =>
  Array.isArray(x)
    ? x.map(sort)
    : x && typeof x === 'object'
      ? Object.fromEntries(
          Object.keys(x)
            .sort()
            .map((k) => [k, sort(x[k])]),
        )
      : x;
const cases = [];
for (const scenario of [
  'near-reserve',
  'aged-waiter',
  'shortened-child-expiry',
  'durable-crossing',
  'exact-control-boundary',
]) {
  let time = base.startsAt + saved.offset;
  const root = join(R, scenario),
    owner = await OperatingOwner.open(
      root,
      structuredClone(base),
      { mode: 'SYNTHETIC', now: () => time },
      { sourceBinding: '1'.repeat(64) },
    );
  const id = 'market-00000002',
    a = {
      family: 'market',
      job: id,
      startedAtUnixSeconds: base.startsAt,
      deadlineUnixSeconds: base.startsAt + 600,
      networkClosesAtUnixSeconds: base.startsAt + 560,
      allowance,
    };
  await fs.mkdir(join(root, id, 'combined-reservations'), { recursive: true });
  const ar = Buffer.from(JSON.stringify(a));
  await fs.writeFile(join(root, id, 'ADMISSION.json'), ar);
  await fs.writeFile(join(root, id, 'combined-reservations/00036.json'), JSON.stringify(saved));
  const j = await owner.register('market', digest(ar), id, a.deadlineUnixSeconds, allowance);
  j.lastAttempt = 35;
  for (const p of ['graph', 'rpc']) {
    j.spent[p].attempts = saved.countersBefore[p + 'Attempts'];
    j.spent[p].bytes = saved.countersBefore[p + 'ChargedBytes'];
    owner.state.totals[p] = { ...j.spent[p] };
  }
  j.marketSchedule = {
    controlIndex: 0,
    openedPools: [0, 1],
    retries: structuredClone(saved.countersBefore.retrySpent),
    prior: null,
  };
  const folder = join(root, id, 'captures/00036');
  await fs.mkdir(folder, { recursive: true });
  const body = Buffer.from(
    JSON.stringify({
      jsonrpc: '2.0',
      id: 1,
      method: saved.query.method,
      params: saved.query.params,
    }) + '\n',
  );
  const request = {
    job: saved.query,
    method: 'POST',
    url: 'https://rpc.pulsechain.com/',
    bodyBytes: body.length,
    bodySha256: digest(body),
    preparedAt: new Date(time * 1000).toISOString(),
  };
  const raw = Buffer.from(JSON.stringify(request));
  await fs.writeFile(join(folder, 'request.json'), raw);
  await fs.writeFile(join(folder, 'request.body'), body);
  const market = {
    type: 'operating-permit',
    activation: owner.state.activation,
    job: id,
    admissionSha256: digest(ar),
    ordinal: 1,
    requestPath: join(folder, 'request.json'),
    requestSha256: digest(raw),
    querySha256: digest(JSON.stringify(sort(saved.query))),
    protocol: 'rpc',
    endpoint: '0',
    attempt: 36,
    retry: 0,
    bytes: 4096,
    objects: 2,
    expiresAt: time + 30,
    reserved: { ...saved.reserved.counts, endpointAttempts: saved.reserved.endpointAttempts },
  };
  const tid = 'trade-00000001',
    th = 'a'.repeat(64);
  const tb = {
    httpAttempts: 6,
    httpExtras: 3,
    httpChargedBytes: 6 * 2162688,
    chargedEntities: 120000,
  };
  await owner.register('trade', th, tid, time + 600, tb);
  await fs.mkdir(join(root, tid));
  const tq = {
      method: 'GET',
      url: 'https://www.bitstamp.net/api/v2/markets/',
      attempt: 1,
      retryOrdinal: 0,
    },
    tr = Buffer.from(JSON.stringify(tq));
  await fs.writeFile(join(root, tid, 'request.json'), tr);
  const trade = {
    type: 'operating-permit',
    activation: owner.state.activation,
    job: tid,
    admissionSha256: th,
    ordinal: 1,
    requestPath: join(root, tid, 'request.json'),
    requestSha256: digest(tr),
    querySha256: digest(JSON.stringify(sort(tq))),
    protocol: 'http',
    endpoint: tq.url,
    attempt: 1,
    retry: 0,
    bytes: 2162688,
    objects: 20000,
    expiresAt: time + 40,
  };
  const tp = owner.control(tid, trade).catch((e) => ({ error: String(e) }));
  if (scenario === 'aged-waiter') owner.queue[0].queuedAt = time - 32;
  if (scenario === 'shortened-child-expiry') market.expiresAt = time + 3;
  const mp = owner.control(id, market).catch((e) => ({ error: String(e) }));
  if (scenario === 'exact-control-boundary') time = base.startsAt + 252;
  if (scenario === 'durable-crossing') {
    const receipt = owner.receipt.bind(owner);
    owner.receipt = async (...args) => {
      await receipt(...args);
      if (args[0].startsWith('PERMIT_')) time = base.startsAt + 252;
    };
  }
  await owner.pump();
  const expected = scenario === 'aged-waiter' ? tid : id;
  assert.equal(owner.state.pending.job, expected);
  const granted = await (expected === id ? mp : tp);
  assert.equal(
    granted.permit.dispatchAllowed === false,
    ['shortened-child-expiry', 'durable-crossing', 'exact-control-boundary'].includes(scenario),
  );
  assert.equal(owner.state.nextRequest, 2); // no second physical permission while pending
  await owner.pump();
  assert.equal(owner.state.nextRequest, 2);
  owner.state.status = 'UNKNOWN';
  await owner.save();
  for (const q of owner.queue.splice(0)) q.reject(Error('SYNTHETIC_TEST_STOP_PENDING_RETAINED'));
  await Promise.all([mp, tp]);
  await owner.lock.close();
  assert(owner.state.pending);
  cases.push({
    scenario,
    status: 'PASS',
    first: expected,
    permit: granted.permit,
    chargedPendingPreserved: true,
    physicalRequests: 0,
  });
}
await fs.writeFile(
  join(R, 'RESULT.json'),
  JSON.stringify(
    {
      status: 'PASS',
      synthetic: true,
      networkRequests: 0,
      genuineAdmissions: 0,
      kind: 'ACTUAL_OWNER_ONLY_NO_COLLECTOR_CLAIM',
      cases,
    },
    null,
    2,
  ),
);
console.log(JSON.stringify({ status: 'PASS', root: R, cases: cases.length }));
