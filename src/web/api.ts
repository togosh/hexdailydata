import { useEffect, useRef, useState } from 'react';
import type { z } from 'zod';

export class RequestError extends Error {
  status: number;
  constructor(status: number, code = '') {
    super(
      code === 'not_indexed'
        ? 'The index is catching up; this bounded lookup is inconclusive.'
        : status === 409
          ? 'The observation changed or expired. Restart this selection.'
          : status === 429
            ? 'Request allowance reached. Try again later.'
            : status === 404
              ? 'No matching resource was confirmed.'
              : status === 410
                ? 'This download has retired. Refresh the catalog.'
                : 'Data is unavailable. Please try again.',
    );
    this.status = status;
  }
}
export const endpoint = (path: string, query: Record<string, string | number | undefined> = {}) => {
  const params = new URLSearchParams({ chain: 'pulsechain' });
  for (const [key, value] of Object.entries(query))
    if (value !== undefined) params.set(key, String(value));
  return '/api/v2' + path + '?' + params.toString();
};
export async function request<T>(
  url: string,
  schema: z.ZodType<T>,
  signal: AbortSignal,
): Promise<T> {
  const bounded = AbortSignal.any([signal, AbortSignal.timeout(12000)]);
  const response = await fetch(url, {
    signal: bounded,
    credentials: 'same-origin',
    cache: 'no-store',
  });
  if (!response.headers.get('content-type')?.includes('application/json')) {
    await response.body?.cancel();
    throw new RequestError(503);
  }
  const reader = response.body?.getReader();
  if (!reader) throw new RequestError(503);
  const decoder = new TextDecoder();
  let bytes = 0,
    text = '';
  try {
    for (;;) {
      const part = await reader.read();
      if (part.done) break;
      bytes += part.value.byteLength;
      if (bytes > 2 * 1024 * 1024) throw new RequestError(503);
      text += decoder.decode(part.value, { stream: true });
    }
    text += decoder.decode();
    const json = JSON.parse(text);
    if (!response.ok)
      throw new RequestError(
        response.status,
        typeof json?.error?.code === 'string' ? json.error.code : '',
      );
    const parsed = schema.safeParse(json);
    if (!parsed.success) throw new RequestError(503);
    const value = parsed.data;
    if (value && typeof value === 'object' && 'chain' in value && value.chain !== 'pulsechain')
      throw new RequestError(503);
    return value;
  } finally {
    await reader.cancel().catch(() => {});
  }
}

export function useResource<T>(url: string | null, schema: z.ZodType<T>, poll = false) {
  const [state, setState] = useState<{
    url: string | null;
    data?: T;
    error?: string;
    status?: number;
    loading: boolean;
  }>({ url, loading: !!url });
  const [version, setVersion] = useState(0);
  const refresh = () => setVersion((v) => v + 1);
  const schemaRef = useRef(schema);
  schemaRef.current = schema;
  useEffect(() => {
    if (!url) return;
    let active = true;
    let pending: AbortController | undefined;
    const load = async () => {
      if (pending) return;
      const controller = new AbortController();
      pending = controller;
      setState((s) => ({
        // A retry is not recovery: retain same-resource errors until a successful response.
        ...(s.url === url ? s : {}),
        url,
        loading: true,
      }));
      try {
        const data = await request(url, schemaRef.current, controller.signal);
        if (active) setState({ url, data, loading: false });
      } catch (e) {
        if (active)
          setState((s) => ({
            url,
            ...(s.data !== undefined ? { data: s.data } : {}),
            loading: false,
            error:
              e instanceof RequestError
                ? e.message
                : 'Connection unavailable. Refresh to try again.',
            status: e instanceof RequestError ? e.status : 503,
          }));
      } finally {
        pending = undefined;
      }
    };
    void load();
    const visible = () => {
      if (document.visibilityState === 'visible') void load();
    };
    const timer = poll ? setInterval(visible, 60000) : undefined;
    if (poll) document.addEventListener('visibilitychange', visible);
    return () => {
      active = false;
      pending?.abort();
      clearInterval(timer);
      document.removeEventListener('visibilitychange', visible);
    };
  }, [url, version, poll]);
  return { ...(state.url === url ? state : { url, loading: !!url }), refresh };
}
export function useClock() {
  const [now, setNow] = useState(Date.now);
  useEffect(() => {
    const tick = () => {
      if (document.visibilityState === 'visible') setNow(Date.now());
    };
    const timer = setInterval(tick, 1000);
    document.addEventListener('visibilitychange', tick);
    return () => {
      clearInterval(timer);
      document.removeEventListener('visibilitychange', tick);
    };
  }, []);
  return now;
}
