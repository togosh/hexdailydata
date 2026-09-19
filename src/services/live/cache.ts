/** JSON-only values: byte accounting includes keys and encoded values, with bounded entry overhead. */
export class ByteCache<T> {
  private entries = new Map<string, { value: T; expires: number; bytes: number }>();
  readonly maximum: number;
  bytes = 0;
  evictions = 0;
  constructor(maximum: number) {
    if (!Number.isSafeInteger(maximum) || maximum < 1) throw new Error('Invalid cache bound.');
    this.maximum = maximum;
  }
  get size() {
    return this.entries.size;
  }
  get(key: string, now: number): T | undefined {
    this.expire(now);
    const row = this.entries.get(key);
    if (!row) return;
    this.entries.delete(key);
    this.entries.set(key, row);
    return structuredClone(row.value);
  }
  expire(now: number) {
    for (const [key, row] of this.entries) if (row.expires <= now) this.remove(key);
  }
  private remove(key: string) {
    const row = this.entries.get(key);
    if (row) {
      this.bytes -= row.bytes;
      this.entries.delete(key);
    }
  }
  put(key: string, value: T, expires: number, now: number) {
    this.expire(now);
    this.remove(key);
    const bytes = Buffer.byteLength(key) + Buffer.byteLength(JSON.stringify(value)) + 256;
    if (bytes > this.maximum || expires <= now) return;
    while (this.bytes + bytes > this.maximum) {
      this.remove(this.entries.keys().next().value!);
      this.evictions++;
    }
    this.entries.set(key, { value: structuredClone(value), expires, bytes });
    this.bytes += bytes;
  }
}
