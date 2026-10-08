// A finite view of one already-guarded pool for reminder/outbox work. The
// accepted helpers keep their SQL and transactions; expiry destroys only leases
// acquired by this view. Late pool acquisitions are retired before use.
export function maintenancePool(pool, { signal, milliseconds = 5000 }) {
  const controller = new AbortController();
  const combined = signal ? AbortSignal.any([signal, controller.signal]) : controller.signal;
  const deadline = performance.now() + milliseconds;
  const leased = new Set();
  const pending = new Set();
  let closed = false;
  const refuse = () => {
    if (closed || combined.aborted || performance.now() >= deadline)
      throw Error('MAINTENANCE_DEADLINE');
  };
  const retire = () => { for (const lease of [...leased]) lease.release(true); };
  combined.addEventListener('abort', retire, { once: true });
  const timer = setTimeout(() => controller.abort(), milliseconds);

  async function connect() {
    refuse();
    const acquiring = pool.connect();
    pending.add(acquiring);
    let raw;
    try { raw = await acquiring; }
    finally { pending.delete(acquiring); }
    try { refuse(); } catch (error) { raw.release(true); throw error; }
    let released = false;
    const lease = new Proxy(raw, {
      get(target, key) {
        if (key === 'release') return (destroy = false) => {
          if (released) return;
          released = true;
          leased.delete(lease);
          raw.release(destroy);
        };
        if (key === 'query') return (...args) => {
          refuse();
          return raw.query(...args);
        };
        const value = Reflect.get(target, key);
        return typeof value === 'function' ? value.bind(target) : value;
      },
    });
    leased.add(lease);
    return lease;
  }
  const view = {
    connect,
    async query(...args) {
      const q = await connect();
      try { return await q.query(...args); }
      finally { q.release(combined.aborted); }
    },
  };
  return {
    pool: view, signal: combined, deadline,
    async close() {
      closed = true;
      clearTimeout(timer);
      controller.abort();
      combined.removeEventListener('abort', retire);
      // The caller supplies a pool with a <=3-second acquisition timeout.
      await Promise.allSettled([...pending]);
    },
  };
}
