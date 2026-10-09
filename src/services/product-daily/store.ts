import { readFile, readdir, lstat, mkdir, open, rename, realpath, unlink } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { Readable } from 'node:stream';
import { z } from 'zod';
import { hash, stable, csv } from '../../history-bootstrap/normalize.ts';
import {
  ProductRowSchema,
  ProductMetadataSchema,
  productSchemaVersion,
  productMetrics,
  digest,
  type ProductRow,
  type ProductMetadata,
  type ProductQueryValue,
  type ProductPair,
} from '../../contracts/product-daily.ts';
import { PageCursors } from '../queries/cursor.ts';
import { restart } from '../../api/errors.ts';
import { columns, validateReadings, readingKey } from './project.ts';
import { validateMarketHistory, preserveMarketHistory } from './market.ts';
import { verifyMarketCertificate } from './storage.ts';

const names = ['daily.ndjson', 'daily.csv', 'metadata.json', 'exceptions.ndjson'];
const manifestSchema = z.strictObject({
  schemaVersion: z.literal(productSchemaVersion),
  version: digest,
  files: z.record(
    z.string(),
    z.strictObject({
      bytes: z
        .number()
        .int()
        .nonnegative()
        .max(64 * 1024 * 1024),
      sha256: digest,
    }),
  ),
});
const pointerSchema = z.strictObject({ version: digest, manifestSha256: digest });
type Pointer = z.infer<typeof pointerSchema>;
export type ProductWriter = { readonly token: symbol; readonly root: string };
export type AdmittedProduct = {
  version: string;
  manifestSha256: string;
  rows: readonly ProductRow[];
  metadata: ProductMetadata;
  csv: Buffer;
  bundleId: string;
};
const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);
function freeze<T>(v: T): T {
  if (v && typeof v === 'object') {
    for (const child of Object.values(v)) freeze(child);
    Object.freeze(v);
  }
  return v;
}
async function bounded(path: string, max: number) {
  const s = await lstat(path);
  if (!s.isFile() || s.isSymbolicLink() || s.size > max) throw Error('PRODUCT_FILE_BOUND');
  const b = await readFile(path);
  if (b.length !== s.size) throw Error('PRODUCT_FILE_CHANGED');
  return b;
}
export async function admitProduct(
  directory: string,
  expectedManifestSha256: string,
): Promise<AdmittedProduct> {
  digest.parse(expectedManifestSha256);
  const root = resolve(directory);
  if ((await realpath(root)) !== root || (await lstat(root)).isSymbolicLink())
    throw Error('PRODUCT_DIRECTORY_ALIAS');
  if (!same((await readdir(root)).sort(), [...names, 'MANIFEST.json'].sort()))
    throw Error('PRODUCT_MEMBERS');
  const bytes = await bounded(join(root, 'MANIFEST.json'), 8192);
  if (hash(bytes) !== expectedManifestSha256) throw Error('PRODUCT_MANIFEST_DIGEST');
  const manifest = manifestSchema.parse(JSON.parse(bytes.toString()));
  if (
    !same(Object.keys(manifest.files).sort(), [...names].sort()) ||
    hash(stable({ schemaVersion: productSchemaVersion, files: manifest.files })) !==
      manifest.version
  )
    throw Error('PRODUCT_IDENTITY');
  const files: Record<string, Buffer> = {};
  for (const name of names) {
    const b = await bounded(join(root, name), 64 * 1024 * 1024),
      expected = manifest.files[name]!;
    if (b.length !== expected.bytes || hash(b) !== expected.sha256)
      throw Error('PRODUCT_FILE_DIGEST');
    files[name] = b;
  }
  const metadata = ProductMetadataSchema.parse(JSON.parse(files['metadata.json']!.toString()));
  validateReadings(metadata.readings);
  if (!files['daily.ndjson']!.toString().endsWith('\n')) throw Error('PRODUCT_TRUNCATED');
  const rows = files['daily.ndjson']!.toString()
    .trimEnd()
    .split('\n')
    .map((line) => ProductRowSchema.parse(JSON.parse(line)));
  if (
    rows.length !== metadata.rows ||
    rows[0]?.dateUtc !== metadata.from ||
    rows.at(-1)?.dateUtc !== metadata.through
  )
    throw Error('PRODUCT_DOMAIN');
  for (let i = 0; i < rows.length; i++) {
    const row = rows[i]!;
    if (i && row.contractDay !== rows[i - 1]!.contractDay + 1) throw Error('PRODUCT_DAY_ORDER');
    for (const t of [
      row.snapshotRecordedAtUtc,
      row.priceRecordedAtUtc,
      row.btcRecordedAtUtc,
      row.ethRecordedAtUtc,
      row.plsRecordedAtUtc,
      row.gasRecordedAtUtc,
      row.liquidityRecordedAtUtc,
    ])
      if (t && new Date(t).toISOString().slice(0, 10) !== row.dateUtc)
        throw Error('PRODUCT_RECORD_DATE');
    if (row.estimatedPenaltiesHEX !== null || row.simpleAnnualizedPayoutRatePercent !== null)
      throw Error('UNQUALIFIED_CROSS_PERIOD_CALCULATION');
  }
  if (!files['daily.csv']!.equals(Buffer.from(csv(rows, columns))))
    throw Error('PRODUCT_CSV_MISMATCH');
  validateMarketHistory(rows, metadata);
  const v = manifest.version,
    bundleId = `${v.slice(0, 8)}-${v.slice(8, 12)}-4${v.slice(13, 16)}-8${v.slice(17, 20)}-${v.slice(20, 32)}`;
  const csvBytes = files['daily.csv']!;
  return Object.freeze({
    version: v,
    manifestSha256: expectedManifestSha256,
    rows: freeze(rows),
    metadata: freeze(metadata),
    get csv() {
      return Buffer.from(csvBytes);
    },
    bundleId,
  });
}
async function ownedRoot(root: string) {
  await mkdir(root, { recursive: true });
  if ((await realpath(root)) !== resolve(root)) throw Error('PRODUCT_ROOT_ALIAS');
}
export async function writeProductGeneration(
  root: string,
  product: { version: string; files: Record<string, Buffer>; manifestSha256: string },
) {
  root = resolve(root);
  await ownedRoot(root);
  digest.parse(product.version);
  const directory = join(root, product.version);
  const exists = await lstat(directory).catch((e: NodeJS.ErrnoException) => {
    if (e.code === 'ENOENT') return null;
    throw e;
  });
  if (exists) return admitProduct(directory, product.manifestSha256);
  const lock = await open(join(root, product.version + '.lock'), 'wx');
  let done = false;
  try {
    const stage = join(root, 'pending-' + randomUUID());
    await mkdir(stage);
    if (!same(Object.keys(product.files).sort(), [...names, 'MANIFEST.json'].sort()))
      throw Error('PRODUCT_FILES');
    for (const [name, b] of Object.entries(product.files)) {
      const file = await open(join(stage, name), 'wx');
      try {
        await file.writeFile(b);
        await file.sync();
      } finally {
        await file.close();
      }
    }
    await admitProduct(stage, product.manifestSha256);
    await rename(stage, directory);
    done = true;
    return await admitProduct(directory, product.manifestSha256);
  } finally {
    await lock.close();
    if (done) await unlink(join(root, product.version + '.lock'));
  }
}
export class ProductDailyStore {
  readonly root: string;
  private current: AdmittedProduct | undefined;
  private selecting = false;
  private writer:
    | { lease: ProductWriter; handle: Awaited<ReturnType<typeof open>>; uncertain: boolean }
    | undefined;
  private reloading: Promise<void> | undefined;
  private checkedAt = -Infinity;
  private reloadError: string | null = null;
  constructor(
    root: string,
    private readonly pair: ProductPair,
  ) {
    this.root = resolve(root);
  }
  capture() {
    if (!this.current) throw Error('PRODUCT_NOT_INITIALIZED');
    return this.current;
  }
  assertWriter(lease: ProductWriter) {
    if (this.writer?.lease !== lease) throw Error('PRODUCT_WRITER_OWNERSHIP');
  }
  markWriterUncertain(lease: ProductWriter) {
    this.assertWriter(lease);
    this.writer!.uncertain = true;
  }
  settleWriter(lease: ProductWriter) {
    this.assertWriter(lease);
    this.writer!.uncertain = false;
  }
  writerUncertain(lease: ProductWriter) {
    this.assertWriter(lease);
    return this.writer!.uncertain;
  }
  async load() {
    if (this.selecting) throw Error('PRODUCT_SELECTION_BUSY');
    this.selecting = true;
    try {
      return await this.loadCurrent();
    } finally {
      this.selecting = false;
    }
  }
  private async loadCurrent() {
    const p = pointerSchema.parse(
      JSON.parse((await bounded(join(this.root, 'CURRENT.json'), 4096)).toString()),
    );
    const next = await admitProduct(join(this.root, p.version), p.manifestSha256);
    this.checkPair(next);
    await verifyMarketCertificate(this.root, next);
    this.current = next;
    return next;
  }
  private checkPair(next: AdmittedProduct) {
    if (!same(next.metadata.pair, this.pair)) throw Error('PRODUCT_MIXED_PAIR');
  }
  /** One small local pointer check per second. Failed/unknown candidates retain LKG. */
  async refresh(now = performance.now()) {
    if (this.reloading) return this.reloading;
    if (this.selecting || this.writer || now - this.checkedAt < 1000) return;
    this.checkedAt = now;
    this.reloading = (async () => {
      try {
        if (
          await lstat(join(this.root, 'SELECTION.lock')).catch((e: NodeJS.ErrnoException) => {
            if (e.code === 'ENOENT') return null;
            throw e;
          })
        )
          return;
        const raw = await bounded(join(this.root, 'CURRENT.json'), 4096);
        const p = pointerSchema.parse(JSON.parse(raw.toString()));
        if (p.version === this.current?.version && p.manifestSha256 === this.current.manifestSha256)
          return;
        const receipt = await bounded(join(this.root, 'admitted-' + p.version + '.json'), 4096);
        if (!same(JSON.parse(receipt.toString()), p)) throw Error('PRODUCT_NOT_ADMITTED');
        const next = await admitProduct(join(this.root, p.version), p.manifestSha256);
        this.checkPair(next);
        if (!this.current) throw Error('PRODUCT_NOT_INITIALIZED');
        await verifyMarketCertificate(this.root, next, this.current);
        let authorizedRollback = false;
        const recovery = await bounded(join(this.root, 'RECOVERY.json'), 4096).catch(
          (e: NodeJS.ErrnoException) => {
            if (e.code === 'ENOENT') return null;
            throw e;
          },
        );
        if (recovery) {
          const r = JSON.parse(recovery.toString());
          const owner = await bounded(join(this.root, 'STORAGE_OWNER.json'), 4096);
          authorizedRollback =
            r.format === 'market-rollback-1' &&
            r.root === this.root &&
            r.owner === hash(owner) &&
            r.from?.version === this.current.version &&
            r.from?.manifestSha256 === this.current.manifestSha256 &&
            same(r.selected, p);
        }
        if (
          !authorizedRollback &&
          Date.parse(next.metadata.effectiveAtUtc) <=
            Date.parse(this.current.metadata.effectiveAtUtc)
        )
          throw Error('PRODUCT_NOT_NEWER');
        if (!authorizedRollback) preserveMarketHistory(this.current, next);
        if (!(await bounded(join(this.root, 'CURRENT.json'), 4096)).equals(raw))
          throw Error('PRODUCT_POINTER_CHANGED');
        if (
          await lstat(join(this.root, 'SELECTION.lock')).catch((e: NodeJS.ErrnoException) => {
            if (e.code === 'ENOENT') return null;
            throw e;
          })
        )
          return;
        this.current = next;
        this.reloadError = null;
      } catch (e) {
        this.reloadError = e instanceof Error ? e.message : String(e);
      }
    })();
    try {
      await this.reloading;
    } finally {
      this.reloading = undefined;
    }
  }
  reloadStatus() {
    return { error: this.reloadError, retainedGenerations: this.current ? 1 : 0 };
  }
  /** Shared with manual selectors: acquire before any refresh-provider work. */
  async acquireWriter(): Promise<ProductWriter> {
    if (this.selecting || this.writer) throw Error('PRODUCT_SELECTION_BUSY');
    const handle = await open(join(this.root, 'SELECTION.lock'), 'wx');
    try {
      const disk = pointerSchema.parse(
        JSON.parse((await bounded(join(this.root, 'CURRENT.json'), 4096)).toString()),
      );
      if (
        !this.current ||
        disk.version !== this.current.version ||
        disk.manifestSha256 !== this.current.manifestSha256
      )
        throw Error('PRODUCT_POINTER_CHANGED');
      const lease = Object.freeze({ token: Symbol('product-writer'), root: this.root });
      await handle.writeFile(stable({ pid: process.pid, version: disk.version }));
      await handle.sync();
      this.writer = { lease, handle, uncertain: false };
      return lease;
    } catch (e) {
      await handle.close();
      await unlink(join(this.root, 'SELECTION.lock'));
      throw e;
    }
  }
  async releaseWriter(lease: ProductWriter, retainUncertain = false) {
    if (this.writer?.lease !== lease) throw Error('PRODUCT_WRITER_OWNERSHIP');
    const owned = this.writer;
    this.writer = undefined;
    await owned.handle.close();
    if (owned.uncertain || retainUncertain)
      throw Error('PRODUCT_PUBLICATION_UNCERTAIN_LOCK_RETAINED');
    await unlink(join(this.root, 'SELECTION.lock'));
  }
  async select(
    pointer: Pointer,
    options: {
      rollback?: boolean;
      beforePublish?: () => Promise<void>;
      beforeCommit?: () => void;
      writer?: ProductWriter;
    } = {},
  ) {
    if (this.selecting) throw Error('PRODUCT_SELECTION_BUSY');
    this.selecting = true;
    let lock: Awaited<ReturnType<typeof open>> | undefined;
    let completed = false,
      mutationStarted = false;
    try {
      await ownedRoot(this.root);
      if (options.writer) {
        if (this.writer?.lease !== options.writer) throw Error('PRODUCT_WRITER_OWNERSHIP');
      } else {
        if (this.writer) throw Error('PRODUCT_SELECTION_BUSY');
        lock = await open(join(this.root, 'SELECTION.lock'), 'wx');
      }
      pointerSchema.parse(pointer);
      const next = await admitProduct(join(this.root, pointer.version), pointer.manifestSha256);
      this.checkPair(next);
      const disk = await bounded(join(this.root, 'CURRENT.json'), 4096).catch(
        (e: NodeJS.ErrnoException) => {
          if (e.code === 'ENOENT') return null;
          throw e;
        },
      );
      if (disk) {
        const p = pointerSchema.parse(JSON.parse(disk.toString()));
        if (!this.current) await this.loadCurrent();
        else if (
          p.version !== this.current.version ||
          p.manifestSha256 !== this.current.manifestSha256
        )
          throw Error('PRODUCT_POINTER_CHANGED');
      }
      const previous = this.current;
      await verifyMarketCertificate(this.root, next, previous, Boolean(options.writer));
      if (previous?.version === next.version) {
        completed = true;
        return { changed: false, version: next.version };
      }
      if (options.rollback) {
        const receipt = await bounded(join(this.root, 'admitted-' + next.version + '.json'), 4096);
        if (!same(JSON.parse(receipt.toString()), pointer)) throw Error('ROLLBACK_NOT_ADMITTED');
      } else if (previous) {
        if (
          Date.parse(next.metadata.effectiveAtUtc) <= Date.parse(previous.metadata.effectiveAtUtc)
        )
          throw Error('PRODUCT_NOT_NEWER');
        if (
          next.metadata.from !== previous.metadata.from ||
          next.metadata.through < previous.metadata.through
        )
          throw Error('PRODUCT_COVERAGE_REGRESSION');
        for (const old of previous.metadata.readings) {
          const fresh = next.metadata.readings.find((r) => readingKey(r) === readingKey(old));
          if (!fresh || Date.parse(fresh.observedAtUtc) < Date.parse(old.observedAtUtc))
            throw Error('READING_REGRESSION');
        }
        preserveMarketHistory(previous, next);
      }
      mutationStarted = true;
      if (options.writer && this.writer) this.writer.uncertain = true;
      const stage = join(this.root, 'selection-' + randomUUID() + '.json');
      const f = await open(stage, 'wx');
      try {
        await f.writeFile(stable(pointer));
        await f.sync();
      } finally {
        await f.close();
      }
      const admission = join(this.root, 'admitted-' + next.version + '.json');
      const receipt = await open(admission, 'wx').catch((e: NodeJS.ErrnoException) => {
        if (e.code === 'EEXIST') return null;
        throw e;
      });
      if (receipt) {
        try {
          await receipt.writeFile(stable(pointer));
          await receipt.sync();
        } finally {
          await receipt.close();
        }
      } else if (!same(JSON.parse((await bounded(admission, 4096)).toString()), pointer))
        throw Error('ADMISSION_COLLISION');
      await options.beforePublish?.();
      const still = await bounded(join(this.root, 'CURRENT.json'), 4096).catch(
        (e: NodeJS.ErrnoException) => {
          if (e.code === 'ENOENT') return null;
          throw e;
        },
      );
      if (disk ? !still?.equals(disk) : still !== null) throw Error('PRODUCT_POINTER_CHANGED');
      options.beforeCommit?.();
      await rename(stage, join(this.root, 'CURRENT.json'));
      this.current = next;
      if (options.writer && this.writer) this.writer.uncertain = false;
      completed = true;
      return { changed: true, version: next.version };
    } finally {
      if (lock) {
        await lock.close();
        if (completed || !mutationStarted) await unlink(join(this.root, 'SELECTION.lock'));
      }
      this.selecting = false;
    }
  }
  read(
    snapshot: AdmittedProduct,
    q: ProductQueryValue,
    route: string,
    cursors: PageCursors,
    now: number,
    access: string,
  ) {
    const binding = hash(
      stable([route, q.chain, q.from, q.to, q.metric ?? null, q.asset ?? null, q.limit, access]),
    );
    const cursor = cursors.decode(q.cursor, binding, now);
    if (cursor && cursor.identity !== snapshot.version) throw restart();
    const lower = Math.max(
      0,
      Math.round((Date.parse(q.from) - Date.parse(snapshot.metadata.from)) / 86400000),
    );
    const upper = Math.min(
      snapshot.rows.length,
      Math.round((Date.parse(q.to) - Date.parse(snapshot.metadata.from)) / 86400000) + 1,
    );
    const offset = cursor ? Number(cursor.key) : lower;
    if (
      cursor &&
      (!/^\d+$/.test(cursor.key) ||
        !Number.isSafeInteger(offset) ||
        offset < lower ||
        offset > upper)
    )
      throw restart();
    const items =
      upper > offset ? snapshot.rows.slice(offset, Math.min(upper, offset + q.limit)) : [];
    const next = offset + items.length;
    return {
      schemaVersion: productSchemaVersion,
      datasetVersion: snapshot.version,
      chain: 'pulsechain' as const,
      from: q.from,
      to: q.to,
      metric: q.metric ?? null,
      asset: q.asset ?? null,
      units: Object.fromEntries(Object.entries(productMetrics).map(([k, v]) => [k, v[1]])),
      coverage: snapshot.metadata.coverage,
      priceSegments: snapshot.metadata.priceSegments,
      methods: snapshot.metadata.methods,
      credits: snapshot.metadata.credits,
      items,
      nextCursor:
        next < upper
          ? cursors.encode(binding, snapshot.version, String(next), now, cursor?.expires)
          : null,
    };
  }
  live(snapshot: AdmittedProduct, now: number) {
    const m = snapshot.metadata;
    const freshness = (
      at: string | null,
      seconds: number,
      reason: string,
      base: string | null = null,
    ) => ({
      status:
        at === null
          ? ('unavailable' as const)
          : now - Date.parse(base ?? at) > seconds * 1000
            ? ('stale' as const)
            : ('fresh' as const),
      observedAtUtc: at,
      baseObservedAtUtc: base,
      ageSeconds:
        at === null ? null : Math.max(0, Math.floor((now - Date.parse(base ?? at)) / 1000)),
      staleAfterSeconds: seconds,
      reason,
    });
    const values = {
      hexPriceUsd: null,
      btcPriceUsd: null,
      ethPriceUsd: null,
      plsPriceUsd: null,
      trackedLiquidityUsd: null,
      gasPriceWei: null,
      baseFeeWei: null,
      priorityFeeWei: null,
    } as Record<string, string | null>;
    const groups: Record<string, ReturnType<typeof freshness>> = {
      savedState: freshness(
        m.pair.observedAtUtc,
        3600,
        'Saved base plus observed updates; not full target inventory.',
        m.pair.baseObservedAtUtc,
      ),
      protocol: freshness(null, 300, 'No qualified current global/share-rate observation.'),
      payout: freshness(
        m.ledgerObservedAtUtc,
        86400,
        'Historical materialized ledger; no current-day estimate.',
      ),
      HEX: freshness(null, 300, 'Historical reference quotes are not live spot observations.'),
      BTC: freshness(null, 300, 'USD benchmark not qualified.'),
      ETH: freshness(null, 300, 'USD benchmark not qualified.'),
      PLS: freshness(null, 300, 'USD quote not qualified.'),
      gas: freshness(null, 60, 'Gas feed not qualified.'),
      liquidity: freshness(null, 300, 'Pool valuation not qualified.'),
    };
    let pool: { chainId: 369; address: string; dex: string; version: string } | null = null;
    let trackedSet: {
      id: string;
      poolCount: number;
      measure: 'two-sided source reserveUSD estimate' | 'reserve-based source-derived USD estimate';
      methodRevision?: 'pulsex-four-pool-derived-usd-2';
      coverage: 'bounded contemporary HEX-pool cohort';
    } | null = null;
    for (const r of m.readings) {
      if (r.kind === 'market') {
        values[
          (
            {
              HEX: 'hexPriceUsd',
              BTC: 'btcPriceUsd',
              ETH: 'ethPriceUsd',
              PLS: 'plsPriceUsd',
            } as const
          )[r.asset]
        ] = r.value;
        groups[r.asset] = freshness(
          r.observedAtUtc,
          300,
          'Admitted spot observation; served time is not observation time.',
        );
      } else if (r.kind === 'gas') {
        values.gasPriceWei = r.gasPriceWei;
        values.baseFeeWei = r.baseFeeWei;
        values.priorityFeeWei = r.priorityFeeWei;
        groups.gas = freshness(
          r.observedAtUtc,
          60,
          'wei per gas, not transaction gas used or total fee.',
        );
      } else if (r.kind === 'tracked-liquidity') {
        values.trackedLiquidityUsd = r.value;
        groups.liquidity = freshness(
          r.observedAtUtc,
          300,
          'Source-derived two-sided USD estimate for an identified bounded HEX-pool cohort; not all HEX liquidity.',
        );
        trackedSet = {
          id: r.set.id,
          poolCount: r.set.pools.length,
          measure: r.set.measure,
          ...(r.set.methodRevision ? { methodRevision: r.set.methodRevision } : {}),
          coverage: r.set.coverage,
        };
      } else {
        values.trackedLiquidityUsd = r.value;
        groups.liquidity = freshness(
          r.observedAtUtc,
          300,
          'One identified pool valuation, not all-market liquidity.',
        );
        pool = { chainId: r.chainId, address: r.poolAddress, dex: r.dex, version: r.version };
      }
    }
    return {
      schemaVersion: productSchemaVersion,
      datasetVersion: snapshot.version,
      chain: 'pulsechain' as const,
      servedAtUtc: new Date(Math.floor(now / 1000) * 1000).toISOString(),
      ...values,
      tshareRateHEX: null,
      currentDayPayoutHEX: null,
      savedHolderRecordCount: m.pair.holderRecordCount,
      savedStakeStartRecordCount: m.pair.stakeStartRecordCount,
      positiveBalanceAddressCount: null,
      activeStakerCount: null,
      coverage: m.pair.coverage,
      freshness: groups,
      pool,
      trackedSet,
    };
  }
  home(snapshot: AdmittedProduct, now: number) {
    return {
      schemaVersion: productSchemaVersion,
      datasetVersion: snapshot.version,
      chain: 'pulsechain' as const,
      daily:
        snapshot.rows.findLast((r) => r.snapshotRecordedAtUtc !== null) ?? snapshot.rows.at(-1)!,
      live: this.live(snapshot, now),
      methods: snapshot.metadata.methods,
      credits: snapshot.metadata.credits,
      liquidityHistory: snapshot.rows
        .slice(-90)
        .map((r) => ({ dateUtc: r.dateUtc, value: r.trackedLiquidityUsd })),
    };
  }
  catalog(snapshot: AdmittedProduct) {
    return {
      status: 'release_gated' as const,
      datasetVersion: snapshot.version,
      datasets: ['daily'] as const,
      reason:
        'Selected daily CSV is implemented; public release requires account/backend and redistribution qualification.',
    };
  }
  openExport(snapshot: AdmittedProduct, bundle: string, dataset: string, signal: AbortSignal) {
    if (bundle !== snapshot.bundleId || dataset !== 'daily') return { status: 'retired' as const };
    signal.throwIfAborted();
    const stream = Readable.from([snapshot.csv], { signal });
    const released = new Promise<void>((done) => stream.once('close', done));
    return {
      status: 'available' as const,
      stream,
      released,
      etag: '"sha256-' + hash(snapshot.csv) + '"',
      bytes: String(snapshot.csv.length),
    };
  }
}
