// Independent permit liabilities and saved-receipt binding. Native validators
// still enforce complete family query/method/pin semantics at physical dispatch.
import fs from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { createHash } from 'node:crypto';
const h = (b) => createHash('sha256').update(b).digest('hex');
const sorted = (x) =>
  Array.isArray(x)
    ? x.map(sorted)
    : x && typeof x === 'object'
      ? Object.fromEntries(
          Object.keys(x)
            .sort()
            .map((k) => [k, sorted(x[k])]),
        )
      : x;
const assert = (c, e) => {
  if (!c) throw Error(e);
};
const read = async (p) => JSON.parse(await fs.readFile(p));
const rpc = ['https://rpc.pulsechain.com/', 'https://rpc-pulsechain.g4mm4.io/'];
const trades = [
  'https://www.bitstamp.net/api/v2/markets/',
  'https://www.bitstamp.net/api/v2/transactions/btcusd/?time=minute',
  'https://www.bitstamp.net/api/v2/transactions/ethusd/?time=minute',
];
export async function permitLiability(family, raw, m, repo) {
  const request = JSON.parse(raw),
    q = family === 'trade' ? request : request.job;
  assert(h(Buffer.from(JSON.stringify(sorted(q)))) === m.querySha256, 'OPERATING_QUERY_HASH');
  let protocol, bytes, objects, endpoint;
  if (family === 'trade') {
    assert(
      request.method === 'GET' &&
        trades.includes(request.url) &&
        request.attempt === m.attempt &&
        request.retryOrdinal === m.retry &&
        !('headers' in request),
      'OPERATING_TRADE_REQUEST',
    );
    protocol = 'http';
    bytes = 2162688;
    objects = 20000;
    endpoint = request.url;
  } else {
    assert(
      request.method === 'POST' && q && Number.isInteger(q.endpoint) && [0, 1].includes(q.endpoint),
      'OPERATING_POST_REQUEST',
    );
    protocol = q.kind === 'rpc' ? 'rpc' : 'graph';
    endpoint = String(q.endpoint);
    if (protocol === 'rpc') assert(request.url === rpc[q.endpoint], 'OPERATING_RPC_ENDPOINT');
    else if (family === 'participants')
      assert(
        request.url === 'https://graph.pulsechain.com/subgraphs/name/pulsechain/hex',
        'OPERATING_HEX_ENDPOINT',
      );
    else {
      const s = await read(join(repo, 'scripts/market-refresh/SCOPE.json'));
      assert(
        family === 'market' && request.url === s.graphEndpoints[q.endpoint],
        'OPERATING_MARKET_ENDPOINT',
      );
    }
    if (family === 'market') {
      bytes =
        q.kind === 'rpc'
          ? q.method === 'eth_getBlockByNumber'
            ? 524288
            : 4096
          : { meta: 65536, pools: 262144 }[q.kind];
      objects = q.kind === 'rpc' ? (q.method === 'eth_getBlockByNumber' ? 64 : 2) : 32;
    } else if (family === 'gas') {
      bytes = {
        eth_chainId: 16384,
        eth_getBlockByNumber: 1048576,
        eth_gasPrice: 16384,
        eth_maxPriorityFeePerGas: 16384,
        eth_feeHistory: 262144,
        eth_getTransactionByHash: 262144,
        eth_getTransactionReceipt: 262144,
      }[q.method];
      objects =
        q.method === 'eth_getTransactionReceipt'
          ? 1024
          : ['eth_getBlockByNumber', 'eth_feeHistory'].includes(q.method)
            ? 128
            : 16;
    } else if (family === 'protocol') {
      const method =
        q.method === 'eth_call'
          ? {
              '0xf04b5fa0': 'global',
              '0x18160ddd': 'supply',
              '0x6a210a0e': 'range',
              '0x90de6871': 'daily',
            }[q.params?.[0]?.data?.slice(0, 10)]
          : q.method;
      bytes = {
        eth_chainId: 4096,
        eth_getBlockByNumber: 1048576,
        eth_getCode: 262144,
        global: 16384,
        supply: 16384,
        range: 65536,
        daily: 16384,
      }[method];
      objects = q.method === 'eth_getBlockByNumber' ? 128 : 40;
    } else if (family === 'participants') {
      bytes =
        q.kind === 'rpc'
          ? q.method === 'eth_chainId'
            ? 16384
            : 262144
          : ({ meta: 32768, parents: 524288, witness: 1048576 }[q.kind] ??
            (q.family === 'tokenHolders' ? 524288 : 2097152));
      objects =
        q.kind === 'rpc'
          ? q.method === 'eth_chainId'
            ? 4
            : 4096
          : q.kind === 'meta'
            ? 4
            : (q.family === 'stakeStarts' ? 3 : 1) * q.first + 4;
    }
    assert(q.maxRows === objects, 'OPERATING_OBJECT_LIABILITY');
    const body = await fs.readFile(join(dirname(m.requestPath), 'request.body'));
    assert(
      body.length === request.bodyBytes && h(body) === request.bodySha256,
      'OPERATING_BODY_BINDING',
    );
  }
  assert(
    bytes &&
      m.protocol === protocol &&
      m.endpoint === endpoint &&
      m.bytes === bytes &&
      m.objects === objects,
    'OPERATING_LIABILITY_MISMATCH',
  );
  return { protocol, bytes, objects, endpoint };
}
export async function settlementEvidence(p, m, family) {
  const folder = dirname(p.requestPath),
    name = family === 'trade' ? 'AUDIT.json' : 'capture.json',
    raw = await fs.readFile(join(folder, name));
  assert(raw.length <= 262144 && h(raw) === m.receiptSha256, 'OPERATING_SETTLEMENT_RECEIPT_HASH');
  const r = JSON.parse(raw);
  assert(r.attempt === p.attempt, 'OPERATING_SETTLEMENT_ATTEMPT');
  const optional = async (name) =>
    fs.readFile(join(folder, name)).catch((e) => {
      if (e.code === 'ENOENT') return null;
      throw e;
    });
  const savedBody = await optional('response.body');
  const body = savedBody ?? Buffer.alloc(0);
  assert(
    h(body) === (family === 'trade' ? r.bodySha256 : r.responseSha256),
    'OPERATING_SETTLEMENT_BODY',
  );
  const closed = family === 'trade' ? r.closed : r.closureKnown,
    complete = family === 'trade' ? r.complete : r.complete && r.entityRows !== null;
  const bytes = family === 'trade' ? 2162688 : r.chargedBytes,
    objects = family === 'trade' ? r.chargedObjects : r.chargedEntities;
  assert(
    m.closed === closed &&
      m.complete === Boolean(complete) &&
      m.bytes === bytes &&
      m.objects === objects,
    'OPERATING_SETTLEMENT_VALUES',
  );
  const transportRaw = await optional(family === 'trade' ? 'response.json' : 'transport.json');
  const transport = transportRaw ? JSON.parse(transportRaw) : null;
  if (savedBody === null || transport === null) {
    assert(
      family === 'trade' &&
        closed === true &&
        !complete &&
        r.native?.reaped === true &&
        (r.native.exit !== null || r.native.ownership?.childStarted === false) &&
        m.objects === p.objects &&
        m.bytes === p.bytes &&
        !r.status &&
        r.bodyBytes === body.length,
      'OPERATING_ABSENT_CAPTURE_REFUSED',
    );
    const phases = (await optional('PHASES.ndjson')) ?? Buffer.alloc(0);
    assert(
      phases.length <= 8192 && h(phases) === r.phaseSha256 && phases.length === r.phaseBytes,
      'OPERATING_ABSENT_PHASE_BINDING',
    );
    const events = phases
      .toString('utf8')
      .split('\n')
      .filter(Boolean)
      .map((x) => JSON.parse(x));
    assert(
      (events.at(-1)?.event ?? 'worker_entry_not_established') === r.lastEstablishedPhase &&
        events.some((x) => x.event === 'dns_tcp_tls_connection_begin') ===
          Boolean(r.networkConnectionBegan),
      'OPERATING_ABSENT_PHASE_VALUES',
    );
  }
  // A timed-out worker can leave the default (not closed) transport envelope.
  // Only the enclosing process's exact reaping proof can establish its closure.
  const enclosingTimeout =
    ['unified-operating-public-1', 'unified-operating-denied-boundary-1'].includes(p.closureMode) &&
    family !== 'trade' &&
    closed === true &&
    !complete &&
    r.failureKind === 'transport_timeout' &&
    r.status === null &&
    r.childStarted === true &&
    r.childReaped === true &&
    r.connectionClosed === true &&
    r.responseBytes === 0 &&
    body.length === 0 &&
    transport?.status === null &&
    transport?.complete === false &&
    transport?.connectionClosed === false &&
    m.bytes === p.bytes &&
    m.objects === p.objects;
  const noDispatch =
    ['unified-operating-public-1', 'unified-operating-denied-boundary-1'].includes(p.closureMode) &&
    family !== 'trade' &&
    closed === true &&
    !complete &&
    r.failureKind === 'local_reserve_refusal' &&
    r.complete === false &&
    r.status === null &&
    r.childStarted === false &&
    r.childReaped === false &&
    r.noChildStarted === true &&
    r.connectionClosed === true &&
    r.responseBytes === 0 &&
    body.length === 0 &&
    r.usable === false &&
    r.retryable === false &&
    r.entityRows === null &&
    transport?.failureKind === 'local_reserve_refusal' &&
    transport?.status === null &&
    transport?.complete === false &&
    transport?.childStarted === false &&
    transport?.childReaped === false &&
    transport?.noChildStarted === true &&
    transport?.connectionClosed === true &&
    m.bytes === p.bytes &&
    m.objects === p.objects;
  if (closed && transport && family !== 'trade')
    assert(
      noDispatch ||
        ((p.closureMode === 'unified-operating-offline-1'
          ? transport.childReaped === true
          : r.childReaped === true) &&
          (transport.connectionClosed === true || enclosingTimeout)),
      'OPERATING_NATIVE_CLOSURE_RECEIPT',
    );
  if (closed) {
    const physical = await read(join(folder, 'PHYSICAL_CLOSED.json'));
    if (enclosingTimeout)
      assert(
        physical.syntheticResponse === false &&
          physical.noChildStarted === false &&
          physical.native?.childStarted === true &&
          physical.native?.childReaped === true &&
          Number.isInteger(physical.native?.exitCode) &&
          physical.proofOwnerPid !== physical.workerPid,
        'OPERATING_TIMEOUT_ENCLOSING_PROOF',
      );
    if (p.closureMode === 'unified-operating-public-1')
      assert(
        physical.syntheticResponse === false && physical.deniedBoundaryTest === false,
        'OPERATING_REAL_CLOSURE_REQUIRED',
      );
    assert(
      physical.permit === p.id &&
        physical.nonce === p.nonce &&
        physical.job === p.job &&
        physical.attempt === p.attempt &&
        physical.connectionClosed === true &&
        (physical.childReaped === true || physical.noChildStarted === true),
      'OPERATING_PHYSICAL_CLOSURE_BINDING',
    );
    if (physical.syntheticResponse === false) {
      const n = physical.native;
      const noChild = physical.noChildStarted === true;
      assert(
        n &&
          n.ownerPid === physical.proofOwnerPid &&
          n.workerPid === physical.workerPid &&
          (noChild
            ? n.childStarted === false && n.workerPid === null && n.exitCode === null
            : n.childReaped === true && n.exitCode !== null),
        'OPERATING_ENCLOSING_NATIVE_PROOF',
      );
      const started = await optional('PHYSICAL_STARTED.json');
      assert(Boolean(started) === physical.physicalStarted, 'OPERATING_PHYSICAL_START_PROOF');
      if (started) assert(JSON.parse(started).workerPid === n.workerPid, 'OPERATING_REAP_PID');
      if (noChild) {
        const proof = JSON.parse(await fs.readFile(join(folder, 'NATIVE_NO_DISPATCH.json')));
        assert(
          (family === 'trade' || noDispatch) &&
            !started &&
            proof.ownerPid === n.ownerPid &&
            proof.permit === p.id &&
            proof.nonce === p.nonce &&
            proof.networkRequests === 0 &&
            proof.requestSha256 === p.requestSha256,
          'OPERATING_NO_CHILD_PROOF',
        );
        if (family !== 'trade')
          assert(
            proof.reason === 'COMBINED_POST_GRANT_RESERVE_REFUSAL',
            'OPERATING_NO_DISPATCH_REASON',
          );
      }
    }
  }
  if (family === 'trade' && closed) assert(r.native.reaped === true, 'OPERATING_TRADE_REAP');
  return r;
}
