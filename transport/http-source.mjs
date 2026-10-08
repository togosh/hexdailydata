import http from 'node:http';
import https from 'node:https';
import { performance } from 'node:perf_hooks';

export const LIMITS = Object.freeze({ requestBytes: 16384, responseBytes: 4194304, headerBytes: 16384, timeoutMs: 5000 });
export const TRANSFER_TOPIC = '0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef';
const address = value => typeof value === 'string' && /^0x[0-9a-f]{40}$/.test(value);
const hash = value => typeof value === 'string' && /^0x[0-9a-f]{64}$/.test(value);
const quantity = value => typeof value === 'string' && /^0x(0|[1-9a-f][0-9a-f]{0,13})$/.test(value) && BigInt(value) <= BigInt(Number.MAX_SAFE_INTEGER);
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const keys = (value, expected) => object(value) && Object.keys(value).length === expected.length && expected.every(k => Object.hasOwn(value, k));

// Never retain native errors, abort reasons, endpoint strings or response bodies.
export class SourceError extends Error {
  constructor(code, metadata = {}) {
    super(code);
    this.name = 'SourceError';
    this.code = code;
    Object.assign(this, metadata);
  }
}
const fail = code => { throw new SourceError(code); };
function bound(value, fallback, ceiling) {
  const n = value ?? fallback;
  if (!Number.isSafeInteger(n) || n < 1 || n > ceiling) fail('CONFIG_BOUND');
  return n;
}

function encode(request, token, recipient) {
  // Snapshot plain data before serialization: no getters/toJSON can change the
  // method or destination after validation. Inputs are the verifier's own data.
  function plain(value, depth = 0) {
    if (depth > 5) fail('REQUEST_SHAPE');
    if (value === null || ['string', 'number', 'boolean'].includes(typeof value)) {
      if (typeof value === 'string' && value.length > LIMITS.requestBytes) fail('REQUEST_SIZE');
      return value;
    }
    if (!object(value) && !Array.isArray(value)) fail('REQUEST_SHAPE');
    if (![Object.prototype, Array.prototype, null].includes(Object.getPrototypeOf(value))) fail('REQUEST_SHAPE');
    const descriptors = Object.getOwnPropertyDescriptors(value);
    if (Reflect.ownKeys(descriptors).length > 20) fail('REQUEST_SHAPE');
    const out = Array.isArray(value) ? [] : Object.create(null);
    for (const [key, d] of Object.entries(descriptors)) {
      if (Array.isArray(value) && key === 'length') continue;
      if (!d.enumerable || !Object.hasOwn(d, 'value') || key === 'toJSON') fail('REQUEST_SHAPE');
      Object.defineProperty(out, key, { value: plain(d.value, depth + 1), enumerable: true, writable: true, configurable: true });
    }
    return out;
  }
  const r = plain(request);
  if (!keys(r, ['jsonrpc', 'id', 'method', 'params']) || r.jsonrpc !== '2.0' ||
      !Number.isSafeInteger(r.id) || !Array.isArray(r.params)) fail('REQUEST_SHAPE');
  const p = r.params;
  let valid = false;
  switch (r.method) {
    case 'eth_chainId': valid = p.length === 0; break;
    case 'eth_getBlockByNumber':
      valid = p.length === 2 && p[1] === false && (['latest', 'finalized'].includes(p[0]) || quantity(p[0])); break;
    case 'eth_getCode':
      // Includes the observed sender, which the unchanged verifier must inspect.
      valid = p.length === 2 && address(p[0]) && quantity(p[1]); break;
    case 'eth_getTransactionByHash':
    case 'eth_getTransactionReceipt': valid = p.length === 1 && hash(p[0]); break;
    case 'eth_getLogs': {
      const f = p[0];
      valid = p.length === 1 && keys(f, ['address', 'fromBlock', 'toBlock', 'topics']) &&
        f.address === token && quantity(f.fromBlock) && quantity(f.toBlock) &&
        BigInt(f.toBlock) >= BigInt(f.fromBlock) && BigInt(f.toBlock) - BigInt(f.fromBlock) < 256n &&
        Array.isArray(f.topics) && f.topics.length === 3 && f.topics[0] === TRANSFER_TOPIC &&
        f.topics[1] === null && f.topics[2] === '0x' + '0'.repeat(24) + recipient.slice(2);
      break;
    }
  }
  if (!valid) fail('REQUEST_POLICY');
  const body = JSON.stringify(r);
  if (Buffer.byteLength(body) > LIMITS.requestBytes) fail('REQUEST_SIZE');
  return { body, id: r.id };
}

function envelope(raw, id) {
  let data;
  try { data = JSON.parse(raw); } catch { fail('RESPONSE_JSON'); }
  if (!object(data) || data.jsonrpc !== '2.0' || data.id !== id ||
      Object.hasOwn(data, 'result') === Object.hasOwn(data, 'error') ||
      Object.keys(data).some(k => !['jsonrpc', 'id', 'result', 'error'].includes(k))) fail('RESPONSE_ENVELOPE');
  // JSON.parse accepts repeated members; refuse ambiguous envelopes (including
  // escaped aliases). Nested result semantics still belong to HexVerifier.
  let depth = 0;
  const seen = new Set();
  for (let i = 0; i < raw.length; i++) {
    if (raw[i] === '"') {
      const start = i++;
      for (; i < raw.length; i++) {
        if (raw[i] === '\\') i++;
        else if (raw[i] === '"') break;
      }
      let next = i + 1;
      while (/\s/.test(raw[next] ?? '') && next < raw.length) next++;
      if (depth === 1 && raw[next] === ':') {
        const name = JSON.parse(raw.slice(start, i + 1));
        if (seen.has(name)) fail('RESPONSE_ENVELOPE');
        seen.add(name);
      }
    } else if (raw[i] === '{' || raw[i] === '[') depth++;
    else if (raw[i] === '}' || raw[i] === ']') depth--;
  }
  if (Object.hasOwn(data, 'error') && (!object(data.error) || !Number.isSafeInteger(data.error.code) ||
      typeof data.error.message !== 'string' || Object.keys(data.error).some(k => !['code', 'message', 'data'].includes(k)))) fail('RESPONSE_ENVELOPE');
}

/** Explicit construction performs no I/O. Call close() and await it before
 * disposing the owner. fixture is an opt-in literal-loopback test boundary. */
export function createHttpSource(options) {
  let url;
  try {
    if (!object(options) || typeof options.endpoint !== 'string' || options.endpoint.length > 4096 || /[\s#]/.test(options.endpoint)) fail('CONFIG_ENDPOINT');
    url = new URL(options.endpoint);
    if (url.href !== options.endpoint || url.username || url.password) fail('CONFIG_ENDPOINT');
  } catch { fail('CONFIG_ENDPOINT'); }
  const fixture = options.fixture;
  if (fixture !== undefined && (!object(fixture) || fixture.loopbackOnly !== true ||
      !['127.0.0.1', '[::1]'].includes(url.hostname))) fail('CONFIG_LOOPBACK');
  if (url.protocol !== 'https:' && !(fixture && url.protocol === 'http:')) fail('CONFIG_HTTPS');
  if (!address(options.token) || !address(options.recipient)) fail('CONFIG_ADDRESS');
  if (fixture?.ca !== undefined && typeof fixture.ca !== 'string' && !Buffer.isBuffer(fixture.ca)) fail('CONFIG_CA');
  const token = options.token, recipient = options.recipient;
  const timeoutMs = bound(options.timeoutMs, LIMITS.timeoutMs, LIMITS.timeoutMs);
  const maxBytes = bound(options.maxResponseBytes, LIMITS.responseBytes, LIMITS.responseBytes);
  const maxHeaderSize = bound(options.maxHeaderBytes, LIMITS.headerBytes, LIMITS.headerBytes);
  const protocol = url.protocol === 'https:' ? https : http;
  const agent = new protocol.Agent({ keepAlive: false, maxSockets: 1, maxTotalSockets: 1, maxFreeSockets: 0,
    ...(fixture?.ca === undefined ? {} : { ca: Buffer.isBuffer(fixture.ca) ? Buffer.from(fixture.ca) : fixture.ca }),
    rejectUnauthorized: true });
  const counts = { invocations: 0, attempts: 0, completed: 0, failed: 0, refused: 0, receivedBytes: 0, elapsedMs: 0, lastCode: null, lastStatus: null };
  let closed = false, active = null;
  async function source(request, signal) {
    counts.invocations++;
    let encoded;
    try {
      if (closed) fail('SOURCE_CLOSED');
      if (active) fail('SOURCE_BUSY');
      if (!(signal instanceof AbortSignal)) fail('REQUEST_SIGNAL');
      if (signal.aborted) fail('ABORTED');
      encoded = encode(request, token, recipient);
    } catch (error) { counts.refused++; throw error instanceof SourceError ? error : new SourceError('REQUEST_SHAPE'); }
    const start = performance.now(), deadline = start + timeoutMs;
    let req, res, socket, timer, error, raw, requestClosed = false, socketClosed = true;
    let done;
    const retired = new Promise(resolve => { done = resolve; });
    let chunks = [], size = 0, ended = false, settled = false;
    const retire = () => {
      if (settled || !requestClosed || !socketClosed) return;
      settled = true;
      clearTimeout(timer);
      signal.removeEventListener('abort', onAbort);
      chunks = [];
      counts.elapsedMs += performance.now() - start;
      counts.lastCode = error?.code ?? null;
      if (error) counts.failed++; else counts.completed++;
      active = null;
      done();
    };
    const stop = (code, metadata) => {
      if (!error) error = new SourceError(code, metadata);
      chunks = [];
      res?.destroy();
      req?.destroy();
      socket?.destroy();
    };
    const onAbort = () => stop('ABORTED');
    const timely = () => {
      if (signal.aborted) { stop('ABORTED'); return false; }
      if (performance.now() >= deadline) { stop('TIMEOUT'); return false; }
      return !error;
    };
    active = { retired, stop };
    signal.addEventListener('abort', onAbort, { once: true });
    timer = setTimeout(() => stop('TIMEOUT'), timeoutMs);
    counts.lastStatus = null;
    try {
      counts.attempts++;
      req = protocol.request(url, { method: 'POST', agent, maxHeaderSize,
        headers: { 'content-type': 'application/json', accept: 'application/json', 'accept-encoding': 'identity',
          'content-length': Buffer.byteLength(encoded.body), connection: 'close' } });
      req.on('socket', value => {
        socket = value; socketClosed = false;
        socket.once('close', () => { socketClosed = true; retire(); });
        if (error) socket.destroy();
      });
      req.once('close', () => {
        requestClosed = true;
        if (!ended && !error) stop('PREMATURE_CLOSE');
        socket?.destroy();
        retire();
      });
      req.on('error', e => stop(e.code === 'HPE_HEADER_OVERFLOW' ? 'HEADER_SIZE' :
        /CERT|TLS|SSL|SELF_SIGNED|UNABLE_TO_VERIFY|UNABLE_TO_GET_ISSUER/.test(String(e.code)) ? 'TLS_FAILURE' : 'IO_FAILURE'));
      req.on('upgrade', (_response, upgraded) => { socket = upgraded; stop('HTTP_UPGRADE'); });
      req.on('response', response => {
        res = response;
        counts.lastStatus = res.statusCode;
        res.on('error', () => stop('PREMATURE_CLOSE'));
        res.on('aborted', () => stop('PREMATURE_CLOSE'));
        if (!timely()) return;
        if (res.statusCode !== 200) {
          const retry = res.headers['retry-after'];
          stop('HTTP_STATUS', { status: res.statusCode,
            ...(typeof retry === 'string' && /^\d{1,6}$/.test(retry) ? { retryAfterSeconds: Number(retry) } : {}) });
          return;
        }
        const encoding = res.headers['content-encoding'];
        if (encoding !== undefined && encoding.toLowerCase().trim() !== 'identity') { stop('CONTENT_ENCODING'); return; }
        const length = res.headers['content-length'];
        if (length !== undefined && (!/^\d+$/.test(length) || BigInt(length) > BigInt(maxBytes))) { stop('RESPONSE_SIZE'); return; }
        res.on('data', chunk => {
          size += chunk.length;
          counts.receivedBytes += chunk.length;
          if (!timely()) return;
          if (size > maxBytes) { stop('RESPONSE_SIZE'); return; }
          chunks.push(chunk);
        });
        res.once('end', () => {
          if (!timely()) return;
          if (!res.complete || (length !== undefined && BigInt(length) !== BigInt(size))) { stop('PREMATURE_CLOSE'); return; }
          try {
            // Decode once, after bounded byte accumulation: split codepoints are
            // intact and fatal decoding rejects incomplete/invalid UTF-8.
            raw = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(Buffer.concat(chunks, size));
          } catch { stop('RESPONSE_UTF8'); return; }
          try { envelope(raw, encoded.id); } catch (e) { stop(e.code ?? 'RESPONSE_ENVELOPE'); return; }
          if (!timely()) return;
          ended = true;
          chunks = [];
          // Explicitly close even a peer that advertises keep-alive. The ticket
          // stays owned until both ClientRequest and socket close events arrive.
          socket?.destroy();
        });
      });
      req.end(encoded.body);
    } catch { stop('IO_FAILURE'); if (!req) { requestClosed = true; retire(); } }
    await retired;
    if (error) throw error;
    return raw;
  }
  async function close() {
    closed = true;
    const current = active;
    current?.stop('SOURCE_CLOSED');
    agent.destroy();
    if (current) await current.retired;
  }
  return Object.freeze({ source, close, status: () => ({ ...counts, active: active ? 1 : 0, closed }) });
}
