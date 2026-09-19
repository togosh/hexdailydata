import type pg from 'pg';
import { createHash, randomUUID } from 'node:crypto';
import { open, mkdir, readdir, rename, lstat } from 'node:fs/promises';
import { join } from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import { datasetRows, csvLine, datasets, definitions, type Dataset } from './datasets.ts';
import { bundleSchema, snapshotIdentity, type Bundle } from './manifest.ts';
import {
  exportRoot,
  reserve,
  syncDirectory,
  removeBundle,
  member,
  digestHandle,
  fingerprint,
  uuid,
  maxBundleBytes,
  readerGraceMs,
  readerTimeoutMs,
  maxReaders,
  jobTimeoutMs,
} from './files.ts';

type Connect = () => Promise<pg.Client>;
type Hook = (stage: string, id: string) => Promise<void>;
const bundleLock = `SELECT pg_try_advisory_lock(hashtextextended($1,4247)) AS held`;
const unlock = `SELECT pg_advisory_unlock(hashtextextended($1,4247))`;
/** Single DB authority; directory names never advertise a bundle. One builder globally. */
export class ExportService {
  readonly connect: Connect;
  readonly root: string;
  private verified = new Map<string, Map<Dataset, string>>();
  private manifests = new Map<string, string>();
  private attempts = new Map<string, string>();
  private refreshing: Promise<void> | undefined;
  private readers = 0;
  constructor(connect: Connect, root: string) {
    this.connect = connect;
    this.root = root;
  }
  private async verify(bundle: Bundle, signal: AbortSignal, checked?: Map<Dataset, string>) {
    const manifest = await member(this.root, bundle.id, 'manifest');
    try {
      if (
        (await manifest.stat()).size > 32768 ||
        !isDeepStrictEqual(bundleSchema.parse(JSON.parse(await manifest.readFile('utf8'))), bundle)
      )
        throw new Error('Manifest differs from publication authority.');
    } finally {
      await manifest.close();
    }
    const prints = new Map<Dataset, string>();
    for (const f of bundle.files) {
      const h = await member(this.root, bundle.id, f.dataset);
      try {
        const before = fingerprint(await h.stat());
        if (checked) {
          if (checked.get(f.dataset) !== before) throw new Error('Verified bundle file replaced.');
          prints.set(f.dataset, before);
          continue;
        }
        const actual = await digestHandle(h, signal);
        if (
          actual.sha256 !== f.sha256 ||
          actual.bytes !== f.bytes ||
          fingerprint(await h.stat()) !== before
        )
          throw new Error('Bundle integrity mismatch.');
        prints.set(f.dataset, before);
      } finally {
        await h.close();
      }
    }
    this.verified.set(bundle.id, prints);
    this.manifests.set(bundle.id, JSON.stringify(bundle));
  }
  /** Read-only, coalesced refresh. No marker creation, publication, retirement or fsync. */
  refresh(signal: AbortSignal): Promise<void> {
    if (this.refreshing) return this.refreshing;
    const work = this.refreshPublications(signal).finally(() => {
      this.refreshing = undefined;
    });
    this.refreshing = work;
    return work;
  }
  private async refreshPublications(signal: AbortSignal) {
    await exportRoot(this.root, false);
    const c = await this.connect();
    let rows;
    try {
      ({ rows } = await c.query(
        "SELECT id,manifest FROM hdd.export_bundles WHERE status='available' ORDER BY chain_id,slot LIMIT 4",
      ));
    } finally {
      await c.end();
    }
    const retained = new Set(rows.map((r) => r.id));
    for (const map of [this.verified, this.manifests, this.attempts])
      for (const id of map.keys()) if (!retained.has(id)) map.delete(id);
    for (const r of rows) {
      signal.throwIfAborted();
      try {
        const bundle = bundleSchema.parse(r.manifest);
        if (bundle.id !== r.id) throw new Error('Publication identity mismatch.');
        const identity = JSON.stringify(bundle);
        const stats: string[] = [];
        for (const name of ['manifest', ...datasets] as const) {
          let h;
          try {
            h = await member(this.root, r.id, name);
            stats.push(fingerprint(await h.stat()));
          } catch {
            stats.push('missing');
          } finally {
            await h?.close();
          }
        }
        const attempt = identity + stats.join('|');
        if (this.attempts.get(r.id) === attempt) continue;
        this.verified.delete(r.id);
        this.manifests.delete(r.id);
        this.attempts.set(r.id, attempt);
        await this.verify(bundle, signal);
      } catch {
        signal.throwIfAborted();
        this.verified.delete(r.id);
        this.manifests.delete(r.id);
      }
    }
  }
  async startup(signal: AbortSignal) {
    this.verified.clear();
    this.manifests.clear();
    this.attempts.clear();
    const c = await this.connect();
    try {
      const {
        rows: [role],
      } = await c.query('SELECT current_user AS name');
      if (role.name !== 'hdd_v2_worker') {
        try {
          await this.refresh(signal);
        } catch {
          signal.throwIfAborted();
        }
        return;
      }
      await exportRoot(this.root);
      const { rows } = await c.query(
        "SELECT id,manifest FROM hdd.export_bundles WHERE status='available'",
      );
      for (const r of rows) {
        signal.throwIfAborted();
        try {
          await this.verify(bundleSchema.parse(r.manifest), signal);
        } catch (e) {
          signal.throwIfAborted();
          if (role.name === 'hdd_v2_worker')
            await c.query("UPDATE hdd.export_bundles SET status='unavailable' WHERE id=$1", [r.id]);
        }
      }
    } finally {
      await c.end();
    }
  }
  async catalog(chain: 1 | 369) {
    const c = await this.connect();
    try {
      const { rows } = await c.query(
        'SELECT id,slot,manifest,status FROM hdd.export_bundles WHERE chain_id=$1 ORDER BY slot LIMIT 2',
        [chain],
      );
      const bundles: (Bundle & { slot: 'current' | 'prior' })[] = [];
      for (const row of rows) {
        const b = bundleSchema.parse(row.manifest);
        if (
          row.status === 'available' &&
          row.id === b.id &&
          this.verified.has(b.id) &&
          this.manifests.get(b.id) === JSON.stringify(b)
        ) {
          let valid = true;
          for (const f of b.files) {
            let h;
            try {
              h = await member(this.root, b.id, f.dataset);
              if (fingerprint(await h.stat()) !== this.verified.get(b.id)!.get(f.dataset))
                valid = false;
            } catch {
              valid = false;
            } finally {
              await h?.close();
            }
          }
          if (valid) bundles.push({ ...b, slot: row.slot });
          else this.verified.delete(b.id);
        }
      }
      return { status: bundles.length ? ('available' as const) : ('rebuilding' as const), bundles };
    } finally {
      await c.end();
    }
  }
  async openStream(id: string, dataset: Dataset, signal: AbortSignal) {
    if (!uuid.test(id) || !datasets.includes(dataset))
      throw new Error('Invalid download identity.');
    if (this.readers >= maxReaders) return { status: 'unavailable' as const };
    // Reserve admission before any asynchronous work, including connection setup.
    this.readers++;
    let c: pg.Client | undefined;
    let h,
      locked = false,
      handed = false;
    try {
      c = await this.connect();
      const {
        rows: [l],
      } = await c.query('SELECT pg_try_advisory_lock_shared(hashtextextended($1,4247)) AS held', [
        id,
      ]);
      if (!l.held) return { status: 'unavailable' as const };
      locked = true;
      const {
        rows: [r],
      } = await c.query('SELECT status,manifest FROM hdd.export_bundles WHERE id=$1', [id]);
      if (!r || r.status !== 'available') return { status: 'retired' as const };
      if (!this.verified.has(id)) return { status: 'unavailable' as const };
      const b = bundleSchema.parse(r.manifest),
        f = b.files.find((f) => f.dataset === dataset)!;
      if (b.id !== id || this.manifests.get(id) !== JSON.stringify(b))
        return { status: 'unavailable' as const };
      try {
        h = await member(this.root, id, dataset);
        if (fingerprint(await h.stat()) !== this.verified.get(id)!.get(dataset))
          throw new Error('Changed file.');
      } catch {
        this.verified.delete(id);
        return { status: 'unavailable' as const };
      }
      signal.throwIfAborted();
      const stream = h.createReadStream({ autoClose: true, start: 0, signal });
      const connection = c;
      const timer = setTimeout(
        () => stream.destroy(new Error('Download time bound exceeded.')),
        readerTimeoutMs,
      );
      timer.unref();
      const released = new Promise<void>((resolve) =>
        stream.once('close', () => {
          clearTimeout(timer);
          void connection
            .query('SELECT pg_advisory_unlock_shared(hashtextextended($1,4247))', [id])
            .catch(() => {})
            .then(() => connection.end().catch(() => {}))
            .then(() => {
              this.readers--;
              resolve();
            });
        }),
      );
      c.on('error', () => stream.destroy(new Error('Download lock lost.')));
      c.on('end', () => {
        if (!stream.destroyed) stream.destroy(new Error('Download lock ended.'));
      });
      handed = true;
      return {
        status: 'available' as const,
        stream,
        released,
        etag: '"sha256-' + f.sha256 + '"',
        bytes: f.bytes,
        bundle: b,
      };
    } finally {
      if (!handed) {
        try {
          await h?.close().catch(() => {});
          if (locked)
            await c!
              .query('SELECT pg_advisory_unlock_shared(hashtextextended($1,4247))', [id])
              .catch(() => {});
          await c?.end().catch(() => {});
        } finally {
          this.readers--;
        }
      }
    }
  }
  /** Worker-only maintenance. Holds builder lock and never follows unrecognized paths. */
  private async clean(c: pg.Client) {
    const { rows } = await c.query('SELECT id FROM hdd.export_bundles');
    const referenced = new Set(rows.map((r) => r.id));
    for (const name of await readdir(this.root)) {
      if (name === '.hdd-exports' || referenced.has(name)) continue;
      if (!uuid.test(name) && !/^\.work-[0-9a-f-]{36}$/.test(name))
        throw new Error('Unknown entry in export root.');
      const {
        rows: [l],
      } = await c.query(bundleLock, [name]);
      if (!l.held) throw new Error('Retired reader still protects storage.');
      try {
        await removeBundle(this.root, name);
      } finally {
        await c.query(unlock, [name]);
      }
    }
  }
  async build(chain: 1 | 369, signal: AbortSignal, hook: Hook = async () => {}) {
    const controller = new AbortController();
    const timer = setTimeout(
      () => controller.abort(new Error('Export job time bound exceeded.')),
      jobTimeoutMs,
    );
    timer.unref();
    const bounded = AbortSignal.any([signal, controller.signal]);
    const c = await this.connect();
    let builder = false,
      snapshot = false,
      pin = false,
      renamed = false,
      committing = false;
    const id = randomUUID(),
      work = '.work-' + id;
    const checked = new Map<Dataset, string>();
    let prior: string | undefined;
    const onLost = () => controller.abort(new Error('Export connection/lock lost.'));
    c.on('error', onLost);
    c.on('end', onLost);
    try {
      const {
        rows: [l],
      } = await c.query('SELECT pg_try_advisory_lock(4248,0) AS held');
      if (!l.held) throw new Error('Export builder already active.');
      builder = true;
      await exportRoot(this.root);
      await reserve(this.root);
      await this.clean(c);
      const {
        rows: [p],
      } = await c.query(
        "SELECT id,published_at FROM hdd.export_bundles WHERE chain_id=$1 AND slot='prior'",
        [chain],
      );
      if (p) {
        if (Date.now() - p.published_at.getTime() < readerGraceMs)
          throw new Error('Publication paused for prior bundle grace.');
        const {
          rows: [lock],
        } = await c.query(bundleLock, [p.id]);
        if (!lock.held) throw new Error('Publication paused for active prior readers.');
        prior = p.id;
        // Keep both published bundles until durable replacement. The exclusive lease
        // pauses new prior readers; it cannot displace an already active reader.
      }
      await mkdir(join(this.root, work), { mode: 0o700 });
      await c.query('SELECT pg_advisory_lock_shared(4243,0)');
      pin = true;
      await c.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
      snapshot = true;
      await c.query("SET LOCAL statement_timeout='120s'");
      await c.query("SET LOCAL idle_in_transaction_session_timeout='120s'");
      const identity = await snapshotIdentity(c, chain);
      await hook('snapshot', id);
      const files: Bundle['files'] = [];
      let total = 0;
      for (const dataset of datasets) {
        bounded.throwIfAborted();
        const h = await open(join(this.root, work, dataset + '.csv'), 'wx', 0o600);
        const digest = createHash('sha256');
        let rows = 0n,
          bytes = 0;
        async function write(data: string) {
          const b = Buffer.from(data);
          digest.update(b);
          bytes += b.length;
          total += b.length;
          if (total > maxBundleBytes) throw new Error('Export size bound exceeded.');
          await h.writeFile(b);
        }
        let streamFailure: unknown;
        try {
          await write(csvLine(definitions[dataset].columns.map((c) => c.name)));
          let batch = '';
          for await (const row of datasetRows(c, dataset, chain, bounded)) {
            batch += csvLine(row);
            rows++;
            if (batch.length >= 65536) {
              await write(batch);
              batch = '';
              await reserve(this.root);
              await hook('chunk', id);
            }
          }
          if (batch) await write(batch);
          await hook('file-sync', id);
          await h.sync();
        } catch (error) {
          streamFailure = error;
          throw error;
        } finally {
          await h.close().catch((error) => {
            if (!streamFailure) throw error;
          });
        }
        files.push({
          dataset,
          rows: rows.toString(),
          bytes: String(bytes),
          sha256: digest.digest('hex'),
          columns: definitions[dataset].columns,
        });
      }
      const bundle = bundleSchema.parse({
        id,
        formatVersion: 1,
        calculationVersion: 'hex-native-1',
        createdAt: new Date().toISOString(),
        ...identity,
        files,
      });
      const mh = await open(join(this.root, work, 'manifest.json'), 'wx', 0o600);
      try {
        await mh.writeFile(JSON.stringify(bundle) + '\n');
        await mh.sync();
      } finally {
        await mh.close();
      }
      // Verify private bytes independently of the streaming digest before rename.
      for (const f of files) {
        const h = await open(join(this.root, work, f.dataset + '.csv'), 'r');
        try {
          const before = fingerprint(await h.stat());
          const d = await digestHandle(h, bounded);
          if (
            d.sha256 !== f.sha256 ||
            d.bytes !== f.bytes ||
            before !== fingerprint(await h.stat())
          )
            throw new Error('Stream verification mismatch.');
          checked.set(f.dataset, before);
        } finally {
          await h.close();
        }
      }
      await hook('verified', id);
      await c.query('COMMIT');
      snapshot = false;
      await hook('directory-sync', id);
      await syncDirectory(join(this.root, work));
      bounded.throwIfAborted();
      await hook('before-rename', id);
      try {
        await lstat(join(this.root, id));
        throw new Error('Duplicate immutable bundle ID.');
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      }
      await rename(join(this.root, work), join(this.root, id));
      renamed = true;
      await hook('after-rename', id);
      await syncDirectory(this.root);
      await hook('durable', id);
      bounded.throwIfAborted();
      await c.query('BEGIN');
      snapshot = true;
      // Native rewind conflicts are serialized against this short publication transaction.
      const {
        rows: [s],
      } = await c.query('SELECT * FROM hdd.sync_state WHERE chain_id=$1 FOR UPDATE', [chain]);
      // Forward changes are allowed: bytes retain their captured identity. A rewind crossing
      // that identity invalidates it, even if a later forward sync reaches the same height.
      const {
        rows: [accepted],
      } = await c.query(
        `SELECT ($2::bigint=$3::bigint AND $4::bytea=$5::bytea) OR EXISTS
        (SELECT 1 FROM hdd.checkpoints_recent WHERE chain_id=$1 AND revision=$6 AND block_number=$2) AS ok`,
        [
          chain,
          identity.currentIndex.blockNumber,
          s.block_number,
          Buffer.from(identity.currentIndex.blockHash, 'hex'),
          s.block_hash,
          identity.currentIndex.revision,
        ],
      );
      if (!accepted.ok) throw new Error('Export snapshot was rewound.');
      await hook('before-publication', id);
      if (prior) await c.query('DELETE FROM hdd.export_bundles WHERE id=$1', [prior]);
      await c.query(
        "UPDATE hdd.export_bundles SET slot='prior',published_at=clock_timestamp() WHERE chain_id=$1 AND slot='current'",
        [chain],
      );
      await c.query(
        "INSERT INTO hdd.export_bundles(id,chain_id,slot,status,manifest) VALUES($1,$2,'current','available',$3)",
        [id, chain, JSON.stringify(bundle)],
      );
      await hook('inside-publication', id);
      bounded.throwIfAborted();
      committing = true;
      await c.query('COMMIT');
      snapshot = false;
      await hook('after-commit', id);
      committing = false;
      if (prior) {
        this.verified.delete(prior);
        this.manifests.delete(prior);
        this.attempts.delete(prior);
        await removeBundle(this.root, prior);
      }
      await this.verify(bundle, bounded, checked);
      return bundle;
    } catch (error) {
      if (snapshot) await c.query('ROLLBACK').catch(() => {});
      if (committing) {
        const recovery = await this.connect();
        try {
          const {
            rows: [r],
          } = await recovery.query('SELECT manifest FROM hdd.export_bundles WHERE id=$1', [id]);
          if (r) {
            const b = bundleSchema.parse(r.manifest);
            if (prior) {
              this.verified.delete(prior);
              this.manifests.delete(prior);
              this.attempts.delete(prior);
              await removeBundle(this.root, prior);
            }
            await this.verify(b, signal, checked);
            return b;
          }
        } finally {
          await recovery.end();
        }
      }
      if (builder && !renamed)
        await removeBundle(this.root, work).catch((cleanup) => {
          if (error instanceof Error) error.message += '; cleanup: ' + (cleanup as Error).message;
        });
      throw error;
    } finally {
      clearTimeout(timer);
      if (pin) await c.query('SELECT pg_advisory_unlock_shared(4243,0)').catch(() => {});
      if (prior) await c.query(unlock, [prior]).catch(() => {});
      if (builder) await c.query('SELECT pg_advisory_unlock(4248,0)').catch(() => {});
      c.removeListener('error', onLost);
      c.removeListener('end', onLost);
      await c.end().catch(() => {});
    }
  }
}
