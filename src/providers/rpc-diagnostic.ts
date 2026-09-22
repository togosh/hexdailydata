import { createHash } from 'node:crypto';
import { z } from 'zod';
import { selectors, topics } from './abi.ts';
import { liveSelectors } from './live-abi.ts';
import type { RpcCall } from './rpc.ts';

const MAX_RECORD = 8192;
const MAX_PREVIEW = 1024;
const own = (v: object, key: string) => Object.hasOwn(v, key);
const object = (v: unknown): Record<string, unknown> | null =>
  v !== null && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : null;
function clip(text: string, bytes: number) {
  let out = '';
  for (const c of text) {
    if (Buffer.byteLength(out + c) > bytes) break;
    out += c;
  }
  return out;
}
function identity(row: { id?: unknown }) {
  if (!own(row, 'id')) return { type: 'missing' };
  const id = row.id;
  const type = id === null ? 'null' : typeof id;
  // Arbitrary string IDs can contain credentials. Our requests use numeric IDs.
  return {
    type,
    ...(id === null || typeof id === 'number' || typeof id === 'boolean'
      ? { value: id }
      : typeof id === 'string' && /^\d{1,16}$/.test(id)
        ? { value: id }
        : { omitted: true }),
  };
}
function message(value: unknown) {
  if (typeof value !== 'string') return { type: typeof value, omitted: true };
  const clean = value.replace(/[\p{Cc}\p{Cf}]/gu, ' ');
  // Omit suspicious prose wholesale: no URLs, paths, query strings, credentials,
  // addresses, calldata, cookies or error.data are useful envelope evidence.
  if (
    /[\/\\@?=&]|https?:|%[0-9a-f]{2}|authorization|bearer|cookie|password|secret|token|api[ _-]?key|\b(key|auth|credential|jwt|session|passwd)\b|0x[0-9a-f]{9}|[\p{L}\p{N}_-]{33}/iu.test(
      clean,
    )
  )
    return { type: 'string', omitted: true };
  const text = clip(clean, 256);
  return { text, truncated: text !== clean, controlsRemoved: clean !== value };
}
const quantity = (v: unknown) =>
  typeof v === 'string' && /^0x[0-9a-f]{1,64}$/.test(v) ? v : undefined;
const block = (v: unknown) => {
  if (v === 'latest' || v === 'finalized') return v;
  return quantity(v);
};
function request(call: RpcCall & { id?: number }, contract: string) {
  const summary: Record<string, unknown> = { id: identity(call), method: call.method };
  const first = object(call.params[0]);
  if (call.method === 'eth_getLogs' && first) {
    summary.fromBlock = quantity(first.fromBlock);
    summary.toBlock = quantity(first.toBlock);
    if (first.address === contract) summary.contract = contract;
    summary.topics =
      Array.isArray(first.topics) && Array.isArray(first.topics[0])
        ? [
            ...new Set(
              first.topics[0].filter((v: unknown) => Object.values(topics).includes(v as string)),
            ),
          ]
        : [];
  } else if (call.method === 'eth_call') {
    const selector = typeof first?.data === 'string' ? first.data.slice(0, 10) : '';
    if ([...Object.values(selectors), ...Object.values(liveSelectors)].includes(selector))
      summary.selector = selector;
    summary.block = block(call.params[1]);
    const pin = object(call.params[1]);
    if (typeof pin?.blockHash === 'string' && /^0x[0-9a-f]{64}$/.test(pin.blockHash))
      summary.blockHash = pin.blockHash;
  } else if (call.method === 'eth_getBlockByNumber') summary.block = block(call.params[0]);
  else if (call.method === 'eth_getCode') summary.block = block(call.params[1]);
  else if (call.method === 'eth_getTransactionReceipt')
    summary.transactionHash = quantity(call.params[0]);
  return summary;
}

export type RpcDiagnostic = ReturnType<RpcExchange['failure']>;
const diagnostics = new WeakMap<object, RpcDiagnostic>();
export function rpcDiagnostic(error: unknown): RpcDiagnostic | undefined {
  for (let depth = 0; depth < 4 && error instanceof Error; depth++, error = error.cause) {
    const value = diagnostics.get(error);
    if (value) return value;
  }
  return undefined;
}
export function attachRpcDiagnostic(error: unknown, diagnostic: RpcDiagnostic) {
  if (error instanceof Error && !rpcDiagnostic(error)) diagnostics.set(error, diagnostic);
}
/** Parser messages can echo arbitrary provider bytes and trigger legacy substring
 * classifiers. Keep the parser class but replace its untrusted message/issues. */
export function safeRpcError(error: unknown) {
  if (error instanceof SyntaxError) return new SyntaxError('Invalid RPC response JSON.');
  if (error instanceof z.ZodError)
    return z.never({ error: 'Invalid RPC response envelope.' }).safeParse(null).error!;
  return error;
}

/** One exchange's byte facts; never owns a response body or changes admission.
 * The canary wrapper shares this with RpcClient, including failures before yield. */
export class RpcExchange {
  private hash = createHash('sha256');
  bytes = 0;
  complete = false;
  status: number | null = null;
  retryAfter: string | null = null;
  binding: { networkChainId: 1 | 369; originChainId: 1 | 369 } | null = null;
  readonly source: string;
  readonly calls: (RpcCall & { id?: number })[];
  readonly contract: string;
  readonly attempt: number;
  readonly started: number;
  readonly deadline: number;
  constructor(
    source: string,
    calls: (RpcCall & { id?: number })[],
    contract: string,
    attempt: number,
    started: number,
    deadline: number,
  ) {
    this.source = source;
    this.calls = calls;
    this.contract = contract;
    this.attempt = attempt;
    this.started = started;
    this.deadline = deadline;
  }
  observe(chunk: Uint8Array) {
    this.bytes += chunk.byteLength;
    this.hash.update(chunk);
  }
  headers(status: number, retry: string | null) {
    this.status = status;
    this.retryAfter =
      retry &&
      (/^\d{1,10}$/.test(retry) ||
        /^[A-Z][a-z]{2}, \d{2} [A-Z][a-z]{2} \d{4} \d{2}:\d{2}:\d{2} GMT$/.test(retry))
        ? retry
        : null;
  }
  failure(stage: 'rpc' | 'prefix', ended: number, body?: Uint8Array, fallback = 'transport') {
    let reason = fallback;
    let parsed: unknown;
    let parseOk = false;
    if (body && this.complete) {
      try {
        parsed = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(body));
        parseOk = true;
      } catch {
        reason = 'parse';
      }
    }
    const rows = Array.isArray(parsed) ? parsed : object(parsed) ? [parsed] : [];
    const received = rows.slice(0, Math.min(this.calls.length, 104)).map((v) => {
      const row = object(v);
      if (!row) return { rowType: v === null ? 'null' : typeof v };
      const error = object(row.error);
      return {
        id: identity(row),
        resultPresent: own(row, 'result'),
        errorPresent: own(row, 'error'),
        ...(error
          ? {
              observedUntrustedError: {
                code:
                  typeof error.code === 'number' && Number.isSafeInteger(error.code)
                    ? error.code
                    : null,
                ...(own(error, 'message') ? { message: message(error.message) } : {}),
              },
            }
          : {}),
      };
    });
    if (parseOk) {
      const objects = rows.map(object);
      if (!Array.isArray(parsed)) reason = 'envelope';
      else if (rows.length !== this.calls.length) reason = 'batch-size';
      else if (objects.some((r) => !r || !own(r, 'id'))) reason = 'missing-id';
      else if (objects.some((r) => typeof r!.id !== 'number' || !Number.isInteger(r!.id)))
        reason = 'invalid-id';
      else if (new Set(objects.map((r) => r!.id)).size !== rows.length) reason = 'duplicate-id';
      else if (objects.some((r) => !this.calls.some((c) => c.id === r!.id)))
        reason = 'unexpected-id';
      else if (objects.some((r) => own(r!, 'result') && own(r!, 'error')))
        reason = 'both-result-error';
      else if (objects.some((r) => !own(r!, 'result') && !own(r!, 'error')))
        reason = 'neither-result-error';
      else if (
        objects.some(
          (r) =>
            r!.jsonrpc !== '2.0' ||
            Object.keys(r!).some((k) => !['jsonrpc', 'id', 'result', 'error'].includes(k)) ||
            (own(r!, 'error') && !Number.isInteger(object(r!.error)?.code)),
        )
      )
        reason = 'envelope';
      else if (objects.some((r) => own(r!, 'error'))) reason = 'correlated-rpc-error';
      else reason = fallback;
    }
    if (this.status !== null && this.status !== 200) reason = 'http';
    const value = {
      version: 1 as const,
      source: /^[a-zA-Z0-9_-]{1,64}$/.test(this.source) ? this.source : 'provider',
      stage,
      reason,
      accepted: false as const,
      cleanupFailed: false,
      binding: this.binding,
      attempt: this.attempt,
      started: this.started,
      ended,
      deadline: Number.isFinite(this.deadline) ? this.deadline : null,
      httpStatus: this.status,
      retryAfter: this.retryAfter,
      observedBytes: this.bytes,
      streamComplete: this.complete,
      sha256: this.hash.copy().digest('hex'),
      digestScope: this.complete ? 'complete-body' : 'observed-prefix',
      requestBatchSize: this.calls.length,
      responseBatchSize: parseOk && Array.isArray(parsed) ? rows.length : null,
      requests: this.calls.slice(0, 104).map((c) => request(c, this.contract)),
      received,
      truncatedRequests: Math.max(0, this.calls.length - 104),
      truncatedRows: rows.length - received.length,
      // A structural preview, never a raw-body prefix (which may be result data).
      preview: '',
      previewTruncated: false,
    };
    const preview = JSON.stringify({ reason, received });
    value.preview = clip(preview, MAX_PREVIEW);
    value.previewTruncated = value.preview !== preview;
    while (Buffer.byteLength(JSON.stringify(value)) > MAX_RECORD) {
      if (value.received.length >= value.requests.length && value.received.length) {
        value.received.pop();
        value.truncatedRows++;
      } else if (value.requests.length) {
        value.requests.pop();
        value.truncatedRequests++;
      } else break;
    }
    return value;
  }
}
