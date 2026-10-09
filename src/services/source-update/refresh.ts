import { readFile, mkdir, open, rename, unlink, realpath, lstat, readdir } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { ACCEPTED } from '../../contracts/saved-generation.ts';
import {
  ParticipantDescriptorSchema,
  participantLimits,
  type ParticipantDescriptor,
} from '../../contracts/participant-update.ts';
import { PairSchema, type ProductPair } from '../../contracts/product-daily.ts';
import { SavedSourceGenerations, canonical, sha } from './generation.ts';
import { ProductDailyStore, admitProduct, type AdmittedProduct } from '../product-daily/store.ts';
import {
  publishStoredMarket,
  verifyMarketCertificate,
  verifyStoredTransition,
} from '../product-daily/storage.ts';
import { preserveParticipantProduct, preserveMarketHistory } from '../product-daily/market.ts';

const hash = z.string().regex(/^[0-9a-f]{64}$/);
const pointer = z.strictObject({
  generation: hash,
  descriptorSha256: hash.nullable(),
  product: z.strictObject({ version: hash, manifestSha256: hash }),
});
type Pointer = z.infer<typeof pointer>;
type Selected = {
  pointer: Pointer;
  product: AdmittedProduct;
  source: SavedSourceGenerations;
  held: number;
};
const same = (a: unknown, b: unknown) => canonical(a) === canonical(b);
async function bytes(root: string, name: string, max = 65536) {
  const p = join(root, name);
  if ((await realpath(p)) !== resolve(p)) throw Error('PARTICIPANT_PATH_ALIAS');
  const s = await lstat(p);
  if (!s.isFile() || s.isSymbolicLink() || s.size > max) throw Error('PARTICIPANT_FILE_BOUND');
  const b = await readFile(p);
  if (b.length !== s.size) throw Error('PARTICIPANT_FILE_CHANGED');
  return b;
}
async function put(
  root: string,
  name: string,
  value: unknown,
  replace = false,
  beforeRename?: () => void,
  afterStage?: () => void | Promise<void>,
) {
  const b = Buffer.isBuffer(value) ? value : Buffer.from(canonical(value) + '\n');
  const path = join(root, replace ? 'pending-' + randomUUID() : name),
    f = await open(path, 'wx');
  try {
    await f.writeFile(b);
    await f.sync();
  } finally {
    await f.close();
  }
  if (replace) {
    await afterStage?.();
    beforeRename?.();
    await rename(path, join(root, name));
  }
}
export function participantPair(view: SavedSourceGenerations): ProductPair {
  const i = view.identity;
  return PairSchema.parse({
    generation: i.generation,
    holderDatasetVersion: i.familyVersions.tokenHolders,
    stakeDatasetVersion: i.familyVersions.stakeStarts,
    holderRecordCount: i.holderRows,
    stakeStartRecordCount: i.stakeRows,
    baseObservedAtUtc: '2026-10-05T15:48:05Z',
    observedAtUtc: i.snapshot.observedAtUtc,
    coverage: 'accepted_base_plus_observed_updates',
  });
}
/** One selector for a compatible immutable participant view and product snapshot. */
export class ParticipantRegistry {
  private current: Selected;
  private retained = new Set<Selected>();
  private refreshing: Promise<void> | undefined;
  private retiring: Promise<void> = Promise.resolve();
  private error: string | null = null;
  private checked = -Infinity;
  private closed = false;
  private failedOwner: string | undefined;
  private prepared = new Map<string, SavedSourceGenerations>();
  private constructor(
    readonly root: string,
    readonly productDaily: ProductDailyStore,
    readonly base: SavedSourceGenerations,
    selected: Selected,
  ) {
    this.current = selected;
    this.retained.add(selected);
  }
  static async initialize(root: string, store: ProductDailyStore, base: SavedSourceGenerations) {
    root = resolve(root);
    await mkdir(root);
    if ((await realpath(root)) !== root) throw Error('PARTICIPANT_ROOT_ALIAS');
    const product = store.capture();
    if (
      base.selection !== ACCEPTED.generation ||
      !same(product.metadata.pair, participantPair(base))
    )
      throw Error('PARTICIPANT_SEED_PAIR');
    const selected: Pointer = {
      generation: base.selection,
      descriptorSha256: null,
      product: { version: product.version, manifestSha256: product.manifestSha256 },
    };
    await put(root, 'SEED.json', {
      format: 'participant-registry-1',
      pair: participantPair(base),
      selected,
      baseBindings: ACCEPTED.baseBindings,
      acceptedOverlayRoot: base.root,
      productRoot: store.root,
    });
    await put(root, 'CURRENT.json', selected);
    return new ParticipantRegistry(root, store, base, {
      pointer: selected,
      product,
      source: base,
      held: 0,
    });
  }
  static async open(root: string, productRoot: string, base: SavedSourceGenerations) {
    root = resolve(root);
    for (const name of ['SELECTION.lock', 'INTENT.json'])
      if (
        await lstat(join(root, name)).catch((e) => {
          if (e.code === 'ENOENT') return null;
          throw e;
        })
      )
        throw Error('PARTICIPANT_ACTIVE_OR_UNKNOWN_PUBLICATION');
    const seed = JSON.parse((await bytes(root, 'SEED.json')).toString());
    if (
      seed.format !== 'participant-registry-1' ||
      !same(seed.baseBindings, ACCEPTED.baseBindings) ||
      !same(seed.pair, participantPair(base))
    )
      throw Error('PARTICIPANT_SEED_IDENTITY');
    const p = pointer.parse(JSON.parse((await bytes(root, 'CURRENT.json')).toString()));
    let view = base;
    try {
      view = await this.loadView(root, p, base);
      const store = new ProductDailyStore(productRoot, participantPair(view));
      await store.load();
      const product = store.capture();
      if (!same(p.product, { version: product.version, manifestSha256: product.manifestSha256 }))
        throw Error('PARTICIPANT_PRODUCT_POINTER');
      return new ParticipantRegistry(root, store, base, {
        pointer: p,
        product,
        source: view,
        held: 0,
      });
    } catch (e) {
      if (view !== base) await view.close();
      throw e;
    }
  }
  private static async segment(root: string, generation: string) {
    hash.parse(generation);
    const folder = join(root, generation);
    const raw = await bytes(folder, 'DESCRIPTOR.json');
    const d = ParticipantDescriptorSchema.parse(JSON.parse(raw.toString()));
    const { generation: g, ...body } = d;
    if (g !== generation || sha(canonical(body)) !== g)
      throw Error('PARTICIPANT_DESCRIPTOR_IDENTITY');
    const updateRaw = await bytes(folder, 'UPDATE.json', participantLimits.overlayBytes);
    if (sha(updateRaw) !== d.updateFileSha256) throw Error('PARTICIPANT_UPDATE_RAW_IDENTITY');
    const update = JSON.parse(updateRaw.toString());
    const proof = JSON.parse((await bytes(folder, 'PROOF.json')).toString());
    const index = await bytes(folder, 'INDEX.json', participantLimits.indexBytes);
    if (
      sha(canonical(update)) !== d.updateSha256 ||
      sha(canonical(proof)) !== d.proofSha256 ||
      sha(index) !== d.indexSha256
    )
      throw Error('PARTICIPANT_SEGMENT_IDENTITY');
    return { d, update, proof, index, descriptorSha256: sha(raw) };
  }
  private static async loadView(root: string, p: Pointer, start: SavedSourceGenerations) {
    if (p.generation === start.selection) return start;
    const chain: Awaited<ReturnType<typeof ParticipantRegistry.segment>>[] = [];
    let g = p.generation,
      total = 0;
    while (g !== start.selection) {
      if (chain.length >= participantLimits.segments || g === ACCEPTED.generation)
        throw Error('PARTICIPANT_CHAIN_ANCESTRY');
      const segment = await this.segment(root, g);
      total += Buffer.byteLength(canonical(segment.update)) + segment.index.length;
      if (total > participantLimits.overlayBytes) throw Error('PARTICIPANT_SEGMENT_CHAIN_BOUND');
      if (!chain.length && segment.descriptorSha256 !== p.descriptorSha256)
        throw Error('PARTICIPANT_POINTER_BINDING');
      chain.push(segment);
      g = segment.d.predecessor;
    }
    let view = start;
    try {
      for (const s of chain.reverse()) {
        const next = await view.consecutiveFork(root, s.update, s.proof);
        if (!same(next.descriptor, s.d) || !next.index.equals(s.index)) {
          await next.view.close();
          throw Error('PARTICIPANT_REPLAY_IDENTITY');
        }
        if (view !== start) await view.close();
        view = next.view;
      }
      return view;
    } catch (e) {
      if (view !== start) await view.close();
      throw e;
    }
  }
  async refresh(now = performance.now(), force = false) {
    if (this.closed) throw Error('PARTICIPANT_REGISTRY_CLOSED');
    if (this.refreshing) return this.refreshing;
    if (!force && now - this.checked < 1000) return;
    this.checked = now;
    this.refreshing = (async () => {
      let candidate: SavedSourceGenerations | undefined;
      try {
        if (
          await lstat(join(this.root, 'SELECTION.lock')).catch((e) => {
            if (e.code === 'ENOENT') return null;
            throw e;
          })
        )
          return;
        const raw = await bytes(this.root, 'CURRENT.json'),
          p = pointer.parse(JSON.parse(raw.toString()));
        if (same(p, this.current.pointer)) {
          if (
            !same(
              JSON.parse((await bytes(this.productDaily.root, 'CURRENT.json')).toString()),
              p.product,
            )
          )
            throw Error('PARTICIPANT_PRODUCT_POINTER');
          this.error = null;
          return;
        }
        candidate =
          this.prepared.get(p.generation) ??
          (await ParticipantRegistry.loadView(this.root, p, this.current.source));
        // Even a prepared view must remain bound to the exact durable descriptor and payloads.
        const descriptor =
          p.generation === this.current.pointer.generation
            ? this.current.pointer.descriptorSha256
            : (await ParticipantRegistry.segment(this.root, p.generation)).descriptorSha256;
        if (descriptor !== p.descriptorSha256 || candidate.selection !== p.generation)
          throw Error('PARTICIPANT_PREPARED_IDENTITY');
        const product = await admitProduct(
          join(this.productDaily.root, p.product.version),
          p.product.manifestSha256,
        );
        if (!same(product.metadata.pair, participantPair(candidate)))
          throw Error('PARTICIPANT_MIXED_SELECTION');
        await verifyMarketCertificate(this.productDaily.root, product, this.current.product);
        preserveMarketHistory(this.current.product, product);
        if (!(await bytes(this.root, 'CURRENT.json')).equals(raw))
          throw Error('PARTICIPANT_POINTER_CHANGED');
        await this.productDaily.adoptCoordinated(product, participantPair(candidate));
        const next = { pointer: p, product, source: candidate, held: 0 };
        this.retained.add(next);
        this.current = next;
        this.prepared.delete(p.generation);
        candidate = undefined;
        this.error = null;
        await this.retire();
      } catch (e) {
        this.error = e instanceof Error ? e.message : String(e);
        if (
          candidate &&
          !this.prepared.has(candidate.selection) &&
          ![...this.retained].some((s) => s.source === candidate)
        )
          await candidate.close();
      }
    })();
    try {
      await this.refreshing;
    } finally {
      this.refreshing = undefined;
    }
  }
  capture() {
    if (this.closed) throw Error('PARTICIPANT_REGISTRY_CLOSED');
    const held = this.current;
    held.held++;
    let released = false;
    return {
      product: held.product,
      sourceGenerations: held.source,
      productDaily: this.productDaily,
      release: () => {
        if (!released) {
          released = true;
          held.held--;
          void this.retire();
        }
      },
    };
  }
  status() {
    return {
      generation: this.current.pointer.generation,
      productVersion: this.current.product.version,
      error: this.error,
      retained: this.retained.size,
    };
  }
  private retire() {
    this.retiring = this.retiring
      .then(async () => {
        const states = [...this.retained];
        const previous = states.filter((x) => x !== this.current).at(-1);
        const removed = states.filter((s) => s !== this.current && s !== previous && !s.held);
        for (const s of removed) this.retained.delete(s);
        for (const source of new Set(removed.map((s) => s.source)))
          if (
            source !== this.base &&
            ![...this.retained].some((s) => s.source === source) &&
            ![...this.prepared.values()].includes(source)
          )
            await source.close();
      })
      .catch((e) => {
        this.error = e instanceof Error ? e.message : String(e);
      });
    return this.retiring;
  }
  private async storedBytes() {
    const entries = await readdir(this.root, { withFileTypes: true });
    if (entries.length > participantLimits.segments * 4 + 32)
      throw Error('PARTICIPANT_STORAGE_ENTRIES');
    let total = 0;
    for (const e of entries) {
      if (e.isSymbolicLink()) throw Error('PARTICIPANT_STORAGE_ALIAS');
      if (e.isDirectory()) {
        if (!/^[0-9a-f]{64}$/.test(e.name)) throw Error('PARTICIPANT_STORAGE_DIRECTORY');
        const files = await readdir(join(this.root, e.name), { withFileTypes: true });
        if (files.length > 8) throw Error('PARTICIPANT_STORAGE_ENTRIES');
        for (const f of files) {
          if (!f.isFile() || f.isSymbolicLink()) throw Error('PARTICIPANT_STORAGE_FILE');
          total += (await lstat(join(this.root, e.name, f.name))).size;
        }
      } else if (e.isFile()) total += (await lstat(join(this.root, e.name))).size;
      else throw Error('PARTICIPANT_STORAGE_FILE');
      if (total > participantLimits.overlayBytes) throw Error('PARTICIPANT_STORAGE_BOUND');
    }
    return total;
  }
  /** Checked local admission precedes one coordinated pointer; no provider calls here. */
  async publish(
    update: unknown,
    proof: unknown,
    options: {
      beforeCommit?: () => void;
      fault?: (phase: string) => void | Promise<void>;
      captureReference?: unknown;
    } = {},
  ) {
    await this.refresh(performance.now(), true);
    if (this.error) throw Error(this.error);
    const before = this.current;
    if (before.held < 0 || this.closed) throw Error('PARTICIPANT_REGISTRY_CLOSED');
    const lock = await open(join(this.root, 'SELECTION.lock'), 'wx');
    let intent = false,
      done = false;
    const owner = randomUUID();
    await lock.writeFile(canonical({ owner, pid: process.pid }));
    await lock.sync();
    let writer: Awaited<ReturnType<ProductDailyStore['acquireWriter']>> | undefined;
    let admitted: Awaited<ReturnType<SavedSourceGenerations['consecutiveFork']>> | undefined;
    try {
      if (!same(JSON.parse((await bytes(this.root, 'CURRENT.json')).toString()), before.pointer))
        throw Error('PARTICIPANT_PREDECESSOR_POINTER');
      const replay = before.pointer.descriptorSha256
        ? await ParticipantRegistry.segment(this.root, before.pointer.generation)
        : null;
      if (replay && same(replay.update, update) && same(replay.proof, proof)) {
        if (replay.descriptorSha256 !== before.pointer.descriptorSha256)
          throw Error('PARTICIPANT_REPLAY_POINTER');
        return { selected: before.pointer, idempotent: true };
      }
      admitted = await before.source.consecutiveFork(this.root, update, proof);
      const planned =
        Buffer.byteLength(canonical(admitted.update)) +
        Buffer.byteLength(canonical(admitted.proof)) +
        admitted.index.length +
        65536;
      if ((await this.storedBytes()) + planned > participantLimits.overlayBytes)
        throw Error('PARTICIPANT_STORAGE_BOUND');
      const d = admitted.descriptor,
        folder = join(this.root, d.generation);
      await mkdir(folder);
      for (const [name, value] of Object.entries({
        'UPDATE.json': admitted.update,
        'PROOF.json': admitted.proof,
        'INDEX.json': admitted.index,
        'DESCRIPTOR.json': d,
      }))
        await put(folder, name, value);
      const descriptorSha256 = sha(await bytes(folder, 'DESCRIPTOR.json'));
      const pair = participantPair(admitted.view);
      const productUpdate = {
        readings: [],
        liquidityHistory: [],
        receiptSha256: d.proofSha256,
        participantPair: { previous: before.product.metadata.pair, next: pair, descriptorSha256 },
      };
      writer = await this.productDaily.acquireWriter();
      this.productDaily.authorizeParticipantPair(writer, before.product.metadata.pair, pair);
      await put(this.root, 'INTENT.json', {
        owner,
        previous: before.pointer,
        generation: d.generation,
        descriptorSha256,
        productUpdate,
      });
      intent = true;
      await options.fault?.('before-product');
      const result = await publishStoredMarket(
        this.productDaily,
        writer,
        productUpdate,
        options.beforeCommit,
        () => {},
        options.captureReference ?? null,
      );
      await options.fault?.('after-product');
      const selected: Pointer = {
        generation: d.generation,
        descriptorSha256,
        product: result.selected,
      };
      options.beforeCommit?.();
      await put(this.root, 'CURRENT.json', selected, true, options.beforeCommit, () =>
        options.fault?.('participant-stage'),
      );
      await options.fault?.('after-pointer');
      await put(folder, 'PUBLICATION.json', {
        previous: before.pointer,
        selected,
        metrics: admitted.view.metrics,
        owner,
      });
      this.prepared.set(d.generation, admitted.view);
      admitted = undefined;
      await unlink(join(this.root, 'INTENT.json'));
      intent = false;
      done = true;
      await options.fault?.('acknowledgement');
      return { selected, productUpdate, publication: result };
    } finally {
      try {
        if (writer)
          await this.productDaily.releaseWriter(writer, this.productDaily.writerUncertain(writer));
      } finally {
        if (admitted) await admitted.view.close();
        await lock.close();
        if (done || !intent) await unlink(join(this.root, 'SELECTION.lock'));
        else this.failedOwner = owner;
      }
    }
  }
  /** Product-only writes use the same lock order and coherent pointer as participant writes. */
  async publishProduct(
    update: unknown,
    options: {
      beforeCommit?: () => void;
      fault?: (phase: string) => void | Promise<void>;
      captureReference?: unknown;
    } = {},
  ) {
    await this.refresh(performance.now(), true);
    if (this.error || this.closed) throw Error(this.error ?? 'PARTICIPANT_REGISTRY_CLOSED');
    if (!update || typeof update !== 'object' || 'participantPair' in update)
      throw Error('PRODUCT_ONLY_UPDATE_REQUIRED');
    const before = this.current,
      owner = randomUUID();
    const lock = await open(join(this.root, 'SELECTION.lock'), 'wx');
    let writer: Awaited<ReturnType<ProductDailyStore['acquireWriter']>> | undefined;
    let intent = false,
      done = false;
    try {
      await lock.writeFile(canonical({ owner, pid: process.pid }));
      await lock.sync();
      if (!same(JSON.parse((await bytes(this.root, 'CURRENT.json')).toString()), before.pointer))
        throw Error('PARTICIPANT_PREDECESSOR_POINTER');
      writer = await this.productDaily.acquireWriter();
      await put(this.root, 'INTENT.json', {
        kind: 'product',
        owner,
        previous: before.pointer,
        generation: before.pointer.generation,
        descriptorSha256: before.pointer.descriptorSha256,
        productUpdate: update,
      });
      intent = true;
      await options.fault?.('before-product');
      const publication = await publishStoredMarket(
        this.productDaily,
        writer,
        update,
        options.beforeCommit,
        () => {},
        options.captureReference ?? null,
      );
      await options.fault?.('after-product');
      const selected: Pointer = { ...before.pointer, product: publication.selected };
      await put(this.root, 'CURRENT.json', selected, true, options.beforeCommit, () =>
        options.fault?.('participant-stage'),
      );
      await options.fault?.('after-pointer');
      await unlink(join(this.root, 'INTENT.json'));
      intent = false;
      done = true;
      await options.fault?.('acknowledgement');
      return publication;
    } finally {
      try {
        if (writer)
          await this.productDaily.releaseWriter(writer, this.productDaily.writerUncertain(writer));
      } finally {
        await lock.close();
        if (done || !intent) await unlink(join(this.root, 'SELECTION.lock'));
        else this.failedOwner = owner;
      }
    }
  }
  /** Only this instance's known closed writer may settle its exact saved intent. */
  async recoverOwnedFailure() {
    if (!this.failedOwner) throw Error('UNKNOWN_PARTICIPANT_WRITER_OWNERSHIP');
    const owner = this.failedOwner,
      raw = await bytes(this.root, 'INTENT.json'),
      intent = JSON.parse(raw.toString());
    const lock = JSON.parse((await bytes(this.root, 'SELECTION.lock')).toString());
    if (
      intent.owner !== owner ||
      lock.owner !== owner ||
      !same(intent.previous, this.current.pointer)
    )
      throw Error('PARTICIPANT_RECOVERY_OWNERSHIP');
    for (const name of ['SELECTION.lock', 'PENDING.json', 'COMMITTED.json'])
      if (
        await lstat(join(this.productDaily.root, name)).catch((e) => {
          if (e.code === 'ENOENT') return null;
          throw e;
        })
      )
        throw Error('PRODUCT_WRITER_OR_SETTLEMENT_UNKNOWN');
    const productPointer = JSON.parse(
      (await bytes(this.productDaily.root, 'CURRENT.json')).toString(),
    );
    const currentPointer = pointer.parse(
      JSON.parse((await bytes(this.root, 'CURRENT.json')).toString()),
    );
    let selected = intent.previous,
      outcome = 'ABORTED_BEFORE_PRODUCT';
    if (!same(productPointer, intent.previous.product)) {
      const product = await admitProduct(
        join(this.productDaily.root, productPointer.version),
        productPointer.manifestSha256,
      );
      await verifyMarketCertificate(this.productDaily.root, product, this.current.product);
      await verifyStoredTransition(
        this.productDaily.root,
        product,
        this.current.product,
        intent.productUpdate,
      );
      if (intent.kind === 'product') preserveMarketHistory(this.current.product, product);
      else preserveParticipantProduct(this.current.product, product);
      const expectedPair =
        intent.kind === 'product'
          ? this.current.product.metadata.pair
          : intent.productUpdate.participantPair.next;
      if (!same(product.metadata.pair, expectedPair)) throw Error('RECOVERY_PRODUCT_PAIR');
      selected = {
        generation: intent.generation,
        descriptorSha256: intent.descriptorSha256,
        product: productPointer,
      };
      const view = await ParticipantRegistry.loadView(this.root, selected, this.current.source);
      if (!same(product.metadata.pair, participantPair(view))) {
        if (view !== this.current.source) await view.close();
        throw Error('RECOVERY_VIEW_PAIR');
      }
      this.prepared.set(view.selection, view);
      outcome = 'COMPLETED_SAVED_PUBLICATION';
    }
    if (!same(currentPointer, intent.previous) && !same(currentPointer, selected))
      throw Error('RECOVERY_POINTER_CONFLICT');
    await put(this.root, 'CURRENT.json', selected, true);
    await put(this.root, 'RECOVERY-' + owner + '.json', {
      owner,
      outcome,
      intentSha256: sha(raw),
      selected,
      providerRequests: 0,
    });
    await rename(
      join(this.root, 'INTENT.json'),
      join(this.root, 'CLOSED_INTENT-' + owner + '.json'),
    );
    await rename(
      join(this.root, 'SELECTION.lock'),
      join(this.root, 'CLOSED_LOCK-' + owner + '.json'),
    );
    this.failedOwner = undefined;
    await this.refresh(performance.now(), true);
    return { outcome, selected };
  }
  async close() {
    await this.retiring;
    if ([...this.retained].some((x) => x.held)) throw Error('PARTICIPANT_REQUESTS_HELD');
    for (const v of new Set(
      [...this.retained].map((x) => x.source).concat([...this.prepared.values()]),
    ))
      if (v !== this.base) await v.close();
    this.retained.clear();
    this.prepared.clear();
    this.closed = true;
  }
}
