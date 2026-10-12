import { canonical } from '../../dist/services/source-update/generation.js';
// Repeatable OFFLINE mode in the existing coordinator. No public authority here.
import fs from 'node:fs/promises';
import { resolve, join, dirname } from 'node:path';
import { randomUUID, createHash } from 'node:crypto';
import { permitLiability, settlementEvidence } from './operating-validation.mjs';
import { marketTiming, marketGranted, marketSettled, queuePriority } from './market-scheduling.mjs';
import {
  liveOperating,
  liveOperatingFormat,
  boundaryOperatingFormat,
  validateBoundedOperating,
  operatingPolicy,
} from './operating-authority.mjs';
import { fileURLToPath } from 'node:url';
const repo = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
export const operatingTask = 'HDD-REPEATABLE-REFRESH-OPERATIONS-R1';
export const operatingFormat = 'unified-operating-offline-1';
export const operatingFamilies = ['trade', 'market', 'gas', 'protocol', 'participants'];
export const protocols = ['http', 'graph', 'rpc'];
export const digest = (b) => createHash('sha256').update(b).digest('hex');
const hash = (x) => digest(JSON.stringify(x));
const check = (ok, why) => {
  if (!ok) throw Error(why);
};
const exact = (x, keys) =>
  check(x && Object.keys(x).sort().join(',') === [...keys].sort().join(','), 'OPERATING_FIELDS');
const integer = (x, min, max) =>
  check(Number.isSafeInteger(x) && x >= min && x <= max, 'OPERATING_INTEGER');
export function validateOperating(c) {
  if ([liveOperatingFormat, boundaryOperatingFormat].includes(c?.format))
    return validateBoundedOperating(c);
  exact(c, [
    'format',
    'mode',
    'startsAt',
    'expiresAt',
    'families',
    'total',
    'rolling',
    'storage',
    'participants',
  ]);
  check(c.format === operatingFormat && c.mode === 'OFFLINE_ONLY', 'OPERATING_OFFLINE_ONLY');
  integer(c.startsAt, 1, 9999999999);
  integer(c.expiresAt, c.startsAt + 120, c.startsAt + 86400);
  exact(c.families, operatingFamilies);
  for (const f of operatingFamilies) {
    const p = c.families[f];
    exact(p, ['enabled', 'period', 'deadline', ...(Object.hasOwn(p, 'offset') ? ['offset'] : [])]);
    check(typeof p.enabled === 'boolean', 'OPERATING_ENABLED');
    integer(p.period, 30, 86400);
    integer(p.deadline, 90, 1800);
    if (p.offset !== undefined) integer(p.offset, 0, p.period - 1);
  }
  const limits = (v) => {
    exact(v, protocols);
    for (const p of protocols) {
      exact(v[p], ['attempts', 'bytes', 'objects', 'extras']);
      integer(v[p].attempts, 0, 20000);
      integer(v[p].bytes, 0, 2 ** 32);
      integer(v[p].objects, 0, 10000000);
      integer(v[p].extras, 0, v[p].attempts);
    }
  };
  limits(c.total);
  exact(c.rolling, ['seconds', 'limits']);
  integer(c.rolling.seconds, 60, 3600);
  limits(c.rolling.limits);
  for (const p of protocols)
    for (const k of ['attempts', 'bytes', 'objects', 'extras'])
      check(c.rolling.limits[p][k] <= c.total[p][k], 'OPERATING_ROLLING_TOTAL');
  exact(c.storage, ['bytes', 'entries', 'jobs']);
  integer(c.storage.bytes, 1024 ** 2, 8 * 1024 ** 3);
  integer(c.storage.entries, 100, 100000);
  integer(c.storage.jobs, 1, 10000);
  exact(c.participants, ['maximumWindowBlocks', 'maximumActivationBlocks']);
  integer(c.participants.maximumWindowBlocks, 1, 4096);
  integer(c.participants.maximumActivationBlocks, 0, 65536);
  return c;
}
export function operatingAdmission(a) {
  if (a?.operatingFormat === undefined) return false;
  if (liveOperating(a)) return true;
  if (a.operatingFormat === boundaryOperatingFormat) {
    check(
      a.authorityTaskId === operatingPolicy.task &&
        a.parentMode === 'DENIED_NETWORK_TEST' &&
        a.synthetic === true &&
        a.clockMode === 'REAL_EPOCH' &&
        operatingPolicy.public.families[a.family]?.enabled !== false &&
        Object.hasOwn(operatingPolicy.public.childAllowances, a.family),
      'OPERATING_BOUNDARY_MODE',
    );
    return true;
  }
  check(
    a.operatingFormat === operatingFormat &&
      a.authorityTaskId === operatingTask &&
      a.parentMode === 'OFFLINE_ONLY' &&
      a.synthetic === true,
    'EXACT_OPERATING_OFFLINE_AUTHORITY',
  );
  check(
    /^[a-f0-9]{64}$/.test(a.parentProfileSha256) &&
      /^[a-f0-9]{64}$/.test(a.sourceBindingSha256) &&
      /^[a-f0-9-]{36}$/.test(a.activation) &&
      /^[a-z]+-[0-9]{8}$/.test(a.job) &&
      operatingFamilies.includes(a.family),
    'OPERATING_BINDING',
  );
  return true;
}
const zeros = () =>
  Object.fromEntries(protocols.map((p) => [p, { attempts: 0, bytes: 0, objects: 0, extras: 0 }]));
const add = (a, b, sign = 1) => {
  for (const p of protocols) for (const k of Object.keys(a[p])) a[p][k] += sign * b[p][k];
};
const fits = (a, b, limit) =>
  protocols.every((p) => Object.keys(a[p]).every((k) => a[p][k] + b[p][k] <= limit[p][k]));
export async function atomicOperating(path, value) {
  const stage = path + '.' + randomUUID() + '.pending';
  const h = await fs.open(stage, 'wx');
  try {
    await h.writeFile(JSON.stringify(value, null, 2) + '\n');
    await h.sync();
  } finally {
    await h.close();
  }
  for (let n = 0; ; n++) {
    try {
      await fs.rename(stage, path);
      break;
    } catch (e) {
      if (!['EPERM', 'EBUSY'].includes(e.code) || n >= 9) throw e;
      await new Promise((r) => setTimeout(r, 5));
    }
  }
}
export async function operatingStatus(root) {
  return JSON.parse(await fs.readFile(join(resolve(root), 'OPERATING_STATE.json')));
}

// Sole durable request/accounting owner. Children can only ask; never write this state.
export class OperatingOwner {
  constructor(root, c, clock, state) {
    this.root = root;
    this.config = c;
    this.clock = clock;
    this.state = state;
    this.queue = [];
    this.waiters = [];
    this.jobs = new Map();
    this.serial = Promise.resolve();
    this.writer = Promise.resolve();
    this.writers = 0;
    this.maxWriters = 0;
  }
  static async open(root, config, clock, { resume = false, sourceBinding } = {}) {
    const c = validateOperating(config);
    check(
      (c.format === operatingFormat ? clock?.mode === 'SYNTHETIC' : clock?.mode === 'REAL_EPOCH') &&
        /^[a-f0-9]{64}$/.test(sourceBinding),
      'SYNTHETIC_OWNER_REQUIRED',
    );
    root = resolve(root);
    if (c.format === liveOperatingFormat)
      check(
        !resume && root === join(operatingPolicy.root, 'session'),
        'OPERATING_PUBLIC_NO_RESUME_OR_RELOCATION',
      );
    await fs.mkdir(root, { recursive: true });
    const now = clock.now();
    check(now >= c.startsAt && now < c.expiresAt, 'OPERATING_ACTIVATION_EXPIRED');
    const lock = await fs.open(join(root, 'OPERATING_OWNER.lock'), 'wx');
    let s;
    try {
      if (resume) {
        s = await operatingStatus(root);
        check(
          s.root === root && s.configSha256 === hash(c) && s.sourceBinding === sourceBinding,
          'OPERATING_RESTART_BINDING',
        );
        check(
          s.status === 'PAUSED' &&
            s.pending === null &&
            s.active.length === 0 &&
            now >= s.lastClock,
          'OPERATING_RESTART_UNSAFE',
        );
        const saved = await fs.readFile(join(root, `PAUSE_${s.run}.json`));
        check(
          JSON.stringify(JSON.parse(saved)) === JSON.stringify(s),
          'OPERATING_RESTART_STATE_ROLLBACK',
        );
        const later = (await fs.readdir(root))
          .filter((n) => /^RUN_[0-9]+_START.json$/.test(n))
          .map((n) => Number(n.split('_')[1]));
        check(Math.max(...later) === s.run, 'OPERATING_RESTART_RUN_ROLLBACK');
        s.run++;
        s.status = 'RUNNING';
      } else {
        try {
          await fs.access(join(root, 'OPERATING_STATE.json'));
          throw Error('OPERATING_ALREADY_EXISTS');
        } catch (e) {
          if (e.code !== 'ENOENT') throw e;
        }
        s = {
          format: c.format,
          clockOrigin: clock.origin ?? null,
          root,
          activation: randomUUID(),
          configSha256: hash(c),
          sourceBinding,
          status: 'RUNNING',
          run: 1,
          nextJob: 1,
          nextRequest: 1,
          lastClock: now,
          lastClosed: null,
          pending: null,
          totals: zeros(),
          rolling: [],
          active: [],
          completed: 0,
          startedByFamily: Object.fromEntries(operatingFamilies.map((f) => [f, 0])),
          participantBlocks: 0,
          due: Object.fromEntries(
            operatingFamilies.map((f) => [f, c.startsAt + (c.families[f].offset ?? 0)]),
          ),
          latest: {},
          feeds: Object.fromEntries(
            operatingFamilies.map((f) => [
              f,
              { lastAttempt: null, lastQualified: null, lastPublication: null, quarantine: null },
            ]),
          ),
          contexts: {},
          disabled: [],
          endpointAttempts: { rpc: [0, 0], graph: [0, 0] },
          maxPhysical: 0,
          externalRequests: c.format === liveOperatingFormat ? null : 0,
          dispatchEvidence: { observedHttpResponses: 0, knownNoNetworkDispatch: 0 },
        };
      }
      await lock.writeFile(
        JSON.stringify({ pid: process.pid, activation: s.activation, run: s.run }) + '\n',
      );
      await lock.sync();
      const owner = new OperatingOwner(root, c, clock, s);
      owner.lock = lock;
      await owner.receipt(`RUN_${s.run}_START.json`, {
        activation: s.activation,
        run: s.run,
        config: s.configSha256,
        priorRequests: s.nextRequest - 1,
        at: now,
      });
      await owner.save();
      return owner;
    } catch (e) {
      await lock.close();
      /* Failed ownership is retained, never force-unlocked. */ throw e;
    }
  }
  exclusive(fn) {
    const p = this.serial.then(fn);
    this.serial = p.catch(() => {});
    return p;
  }
  now() {
    const n = this.clock.now();
    check(n >= this.state.lastClock, 'OPERATING_CLOCK_ROLLBACK');
    this.state.lastClock = n;
    return n;
  }
  async save() {
    const snapshot = structuredClone(this.state);
    const p = (this.writes ?? Promise.resolve()).then(() =>
      atomicOperating(join(this.root, 'OPERATING_STATE.json'), snapshot),
    );
    this.writes = p.catch(() => {});
    await p;
  }
  async receipt(name, v) {
    const h = await fs.open(join(this.root, name), 'wx');
    try {
      await h.writeFile(JSON.stringify(v, null, 2) + '\n');
      await h.sync();
    } finally {
      await h.close();
    }
  }
  async storage(reservation = 0, fresh = true) {
    check(Number.isSafeInteger(reservation) && reservation >= 0, 'OPERATING_STORAGE_RESERVATION');
    const charged = protocols.reduce((n, p) => n + this.state.totals[p].bytes, 0);
    const physicalReserve = [...this.jobs.values()].reduce(
      (n, j) => n + Math.max(...protocols.map((p) => j.caps?.[p]?.bytes ?? 0)),
      0,
    );
    const disk = await fs.statfs(this.root);
    check(
      disk.bavail * disk.bsize - reservation - physicalReserve >= 10 * 1024 ** 3,
      'OPERATING_PROTECTED_FREE',
    );
    if (!fresh && this.storageCache) {
      // A request creates at most 64 capture/control entries. Reserve publication
      // and finalization entries for every active family until the next inventory.
      check(
        this.storageCache.entries +
          64 * (this.state.nextRequest - this.storageCache.nextRequest + 1) +
          2048 * this.jobs.size <
          this.config.storage.entries,
        'OPERATING_STORAGE_ENTRY_RESERVE',
      );
      check(
        this.storageCache.bytes +
          2 * (charged - this.storageCache.charged) +
          reservation +
          physicalReserve <
          this.config.storage.bytes,
        'OPERATING_STORAGE_RESERVE',
      );
      return this.storageCache;
    }
    let bytes = 0,
      entries = 0;
    const walk = async (p) => {
      for (const d of await fs.readdir(p, { withFileTypes: true })) {
        check(!d.isSymbolicLink(), 'OPERATING_STORAGE_LINK');
        entries++;
        check(entries <= this.config.storage.entries, 'OPERATING_STORAGE_ENTRIES');
        const q = join(p, d.name);
        if (d.isDirectory()) await walk(q);
        else {
          const s = await fs.stat(q).catch((e) => {
            if (e.code === 'ENOENT' && /\.(tmp|pending)$/.test(d.name)) return null;
            throw e;
          });
          bytes += s?.size ?? 0;
        }
      }
    };
    await walk(dirname(this.root));
    check(
      bytes + reservation + physicalReserve < this.config.storage.bytes,
      'OPERATING_STORAGE_BYTES',
    );
    check(
      entries + 64 + 2048 * this.jobs.size < this.config.storage.entries,
      'OPERATING_STORAGE_ENTRY_RESERVE',
    );
    this.storageCache = { bytes, entries, charged, nextRequest: this.state.nextRequest };
    return this.storageCache;
  }
  liabilities(except) {
    const n = zeros();
    for (const [id, j] of this.jobs)
      if (id !== except)
        for (const p of protocols)
          for (const k of Object.keys(n[p])) n[p][k] += Math.max(0, j.caps[p][k] - j.spent[p][k]);
    return n;
  }
  endpointLiabilities(except) {
    const n = { rpc: [0, 0], graph: [0, 0] };
    for (const [id, j] of this.jobs)
      if (id !== except)
        for (const p of ['rpc', 'graph'])
          for (const e of [0, 1])
            n[p][e] += Math.max(0, j.endpointCaps[p][e] - j.endpointSpent[p][e]);
    return n;
  }
  checkEndpointReserve(job, protocol, endpoint, reserved = {}) {
    const liabilities = this.endpointLiabilities(job);
    for (const p of ['rpc', 'graph'])
      for (const e of [0, 1]) {
        const own =
          p === 'rpc'
            ? (reserved.endpointAttempts?.[e] ?? Number(protocol === p && endpoint === e))
            : Number(protocol === p && endpoint === e);
        integer(own, 0, 20000);
        check(
          this.state.endpointAttempts[p][e] + liabilities[p][e] + own <=
            Math.floor(this.config.total[p].attempts / 2),
          'OPERATING_ENDPOINT_CONTROL_RESERVE',
        );
      }
  }
  async allocate(family) {
    return this.exclusive(async () => {
      check(
        operatingFamilies.includes(family) &&
          this.config.families[family].enabled &&
          this.state.status === 'RUNNING',
        'OPERATING_ALLOCATION',
      );
      check(
        this.state.completed + this.jobs.size < this.config.storage.jobs,
        'OPERATING_JOB_BOUND',
      );
      if (this.config.maximumJobsByFamily) {
        check(
          this.now() < this.config.admissionEndsAt &&
            this.state.startedByFamily[family] < this.config.maximumJobsByFamily[family],
          'OPERATING_JOB_BOUND',
        );
        this.state.startedByFamily[family]++;
      }
      const id = family + '-' + String(this.state.nextJob++).padStart(8, '0');
      await this.save();
      return id;
    });
  }
  async scheduleNext(family, startedAt) {
    return this.exclusive(async () => {
      const anchor = this.config.startsAt + (this.config.families[family].offset ?? 0);
      this.state.due[family] =
        anchor +
        (Math.floor((startedAt - anchor) / this.config.families[family].period) + 1) *
          this.config.families[family].period;
      await this.save();
    });
  }
  async register(family, admissionHash, job, deadline, allowance) {
    return this.exclusive(async () => {
      check(
        this.state.status === 'RUNNING' && this.now() < this.config.expiresAt,
        'OPERATING_CLOSED',
      );
      check(
        this.config.families[family]?.enabled &&
          ![...this.jobs.values()].some((j) => j.family === family) &&
          this.jobs.size < (this.config.physicalAttemptSubcaps ? 4 : 5),
        'OPERATING_FAMILY_CONCURRENCY',
      );
      check(
        this.state.completed + this.jobs.size < this.config.storage.jobs,
        'OPERATING_JOB_BOUND',
      );
      if (this.config.physicalAttemptSubcaps) {
        check(
          canonical(allowance) === canonical(operatingPolicy.public.childAllowances[family]),
          'OPERATING_EXACT_CHILD_ALLOWANCE',
        );
        check(
          this.now() < this.config.admissionEndsAt && deadline <= this.config.dispatchEndsAt,
          'OPERATING_EXACT_CHILD_DEADLINE',
        );
      }
      const caps = zeros();
      for (const p of protocols)
        if (allowance[p + 'Attempts'])
          Object.assign(caps[p], {
            attempts: allowance[p + 'Attempts'],
            bytes: allowance[p + 'ChargedBytes'],
            objects: allowance.chargedEntities,
            extras: allowance[p + 'Extras'],
          });
      const all = this.liabilities();
      add(all, caps);
      check(fits(this.state.totals, all, this.config.total), 'OPERATING_ACTIVE_RESERVATIONS');
      this.checkAggregate(all);
      const rollingUsed = zeros();
      for (const b of this.state.rolling)
        if (b.at > this.now() - this.config.rolling.seconds) add(rollingUsed, b.cost);
      check(
        fits(rollingUsed, all, this.config.rolling.limits),
        'OPERATING_ROLLING_ADMISSION_RESERVE',
      );
      const j = {
        id: job,
        family,
        admissionHash,
        deadline,
        caps,
        spent: zeros(),
        endpointCaps: {
          rpc: [0, 1].map(() => Math.floor(caps.rpc.attempts / 2)),
          graph:
            family === 'participants'
              ? [caps.graph.attempts, 0]
              : [caps.graph.attempts, caps.graph.attempts],
        },
        endpointSpent: { rpc: [0, 0], graph: [0, 0] },
        phase: 'RUNNING',
        lastAttempt: 0,
        lastSettled: 0,
      };
      const endpoints = this.endpointLiabilities();
      for (const p of ['rpc', 'graph'])
        for (const e of [0, 1])
          check(
            this.state.endpointAttempts[p][e] + endpoints[p][e] + j.endpointCaps[p][e] <=
              Math.floor(this.config.total[p].attempts / 2),
            'OPERATING_ENDPOINT_ADMISSION_RESERVE',
          );
      this.jobs.set(job, j);
      this.state.active.push({ id: job, family, admissionHash, deadline });
      this.state.feeds[family].lastAttempt = { job, startedAt: this.now(), admissionHash };
      await this.save();
      return j;
    });
  }
  async finish(job, result, fact = null) {
    return this.exclusive(async () => {
      const j = this.jobs.get(job);
      check(j, 'OPERATING_JOB_UNKNOWN');
      if (
        this.state.pending?.job === job ||
        result.publicationUncertain ||
        result.native?.known === false
      )
        this.state.status = 'UNKNOWN';
      this.jobs.delete(job);
      this.state.active = this.state.active.filter((x) => x.id !== job);
      this.state.completed++;
      this.state.latest[j.family] = {
        job,
        status: result.status,
        at: this.now(),
        ...(fact ? { receipt: fact.receipt } : {}),
      };
      const feed = this.state.feeds[j.family];
      feed.lastAttempt = { ...feed.lastAttempt, completedAt: this.now(), status: result.status };
      feed.quarantine = this.state.disabled.includes(j.family) ? 'KNOWN_CLOSED_FAILURE' : null;
      if (fact && result.publications?.length) {
        const times = [];
        const collect = (v, path = 'values') => {
          if (!v || typeof v !== 'object') return;
          for (const [k, x] of Object.entries(v)) {
            if (k === 'observedAtUtc' && typeof x === 'string')
              times.push({ path: path + '.' + k, atUtc: x });
            else if (x && typeof x === 'object') collect(x, path + '.' + k);
          }
        };
        const last = result.publications.at(-1);
        collect(last.publication.values);
        const timestamp = last.publication.pin?.timestamp ?? result.source?.frontier?.timestamp;
        if (Number.isSafeInteger(timestamp))
          times.push({
            path: 'sourcePin.timestamp',
            atUtc: new Date(timestamp * 1000).toISOString(),
          });
        check(times.length <= 16, 'OPERATING_OBSERVATION_TIME_BOUND');
        feed.lastQualified = { job, receipt: fact.receipt, sourceTimes: times };
        feed.lastPublication = {
          job,
          receipt: fact.receipt,
          at: last.adoptedAt,
          selection: last.selected,
          outcome: fact.publication,
        };
      }
      await this.save();
    });
  }
  control(job, m) {
    const j = this.jobs.get(job);
    check(
      j &&
        m.activation === this.state.activation &&
        m.job === job &&
        m.admissionSha256 === j.admissionHash,
      'OPERATING_CONTROL_BINDING',
    );
    check(
      this.state.status === 'RUNNING' || m.type === 'operating-settle',
      'OPERATING_CONTROL_CLOSED',
    );
    check(
      Number.isSafeInteger(m.ordinal) && m.ordinal === (j.controlOrdinal ?? 0) + 1,
      'OPERATING_CONTROL_ORDINAL',
    );
    j.controlOrdinal = m.ordinal;
    if (m.type === 'operating-wait') {
      check(
        Number.isFinite(m.seconds) && m.seconds >= 0 && m.seconds <= 600,
        'OPERATING_WAIT_BOUND',
      );
      check(
        this.now() + m.seconds < Math.min(j.deadline, this.config.expiresAt),
        'OPERATING_WAIT_EXPIRED',
      );
      j.phase = 'WAIT';
      return new Promise((resolve, reject) =>
        this.waiters.push({ job, at: this.now() + m.seconds, resolve, reject }),
      );
    }
    if (m.type === 'operating-permit') {
      j.phase = 'PERMIT';
      return new Promise((resolve, reject) =>
        this.queue.push({ job, m, resolve, reject, queuedAt: this.now() }),
      );
    }
    if (m.type === 'operating-settle') return this.exclusive(() => this.settle(job, m));
    throw Error('OPERATING_CONTROL_TYPE');
  }
  async pump() {
    return this.exclusive(async () => {
      const now = this.now();
      for (const w of [...this.waiters])
        if (w.at <= now || now >= (this.jobs.get(w.job)?.deadline ?? 0)) {
          this.waiters.splice(this.waiters.indexOf(w), 1);
          const j = this.jobs.get(w.job);
          if (j) j.phase = 'RUNNING';
          if (!j || now >= j.deadline) w.reject(Error('OPERATING_WAIT_EXPIRED'));
          else w.resolve({ ok: true, now });
        }
      if (
        this.state.status !== 'RUNNING' ||
        now >= (this.config.dispatchEndsAt ?? this.config.expiresAt)
      ) {
        for (const q of this.queue.splice(0)) q.reject(Error('OPERATING_DISPATCH_CLOSED'));
        return;
      }
      if (
        this.state.pending ||
        (this.state.lastClosed !== null && now < this.state.lastClosed + 1) ||
        !this.queue.length
      )
        return;
      // Bounded control-deadline preference with parent-owned FIFO aging.
      // At most one queued request per admitted family; an active request is never preempted.
      for (const entry of [...this.queue]) {
        try {
          const job = this.jobs.get(entry.job),
            m = entry.m;
          check(job && Number.isFinite(m.expiresAt), 'OPERATING_QUEUED_BINDING');
          entry.priorityAt = queuePriority(entry.queuedAt);
          if (job.family === 'market') {
            const path = resolve(m.requestPath);
            check(
              path.startsWith(resolve(this.root, job.id) + '\\') ||
                path.startsWith(resolve(this.root, job.id) + '/'),
              'OPERATING_REQUEST_PATH',
            );
            const raw = await fs.readFile(path);
            check(raw.length <= 32768 && digest(raw) === m.requestSha256, 'OPERATING_REQUEST_HASH');
            await permitLiability(job.family, raw, m, repo);
            entry.timing = await marketTiming(this.root, job, m, raw, this.now());
            entry.priorityAt = queuePriority(entry.queuedAt, entry.timing);
          }
        } catch (e) {
          this.queue.splice(this.queue.indexOf(entry), 1);
          if (this.jobs.has(entry.job)) this.jobs.get(entry.job).phase = 'RUNNING';
          entry.reject(e);
        }
      }
      this.queue.sort((a, b) => a.priorityAt - b.priorityAt || a.queuedAt - b.queuedAt);
      if (!this.queue.length) return;
      const item = this.queue.shift(),
        { job, m } = item,
        j = this.jobs.get(job);
      try {
        check(
          j && now < j.deadline && now < m.expiresAt && m.attempt === j.lastAttempt + 1,
          'OPERATING_PERMIT_EXPIRY_OR_ORDINAL',
        );
        check(protocols.includes(m.protocol), 'OPERATING_PROTOCOL');
        integer(m.bytes, 1, 8 * 1024 ** 2);
        integer(m.objects, 0, 200000);
        integer(m.retry, 0, j.family === 'participants' ? 5 : 2);
        check(
          /^[a-f0-9]{64}$/.test(m.querySha256) && typeof m.endpoint === 'string',
          'OPERATING_QUERY_BINDING',
        );
        const path = resolve(m.requestPath);
        check(
          path.startsWith(resolve(this.root, job) + '\\') ||
            path.startsWith(resolve(this.root, job) + '/'),
          'OPERATING_REQUEST_PATH',
        );
        const raw = await fs.readFile(path);
        check(raw.length <= 32768 && digest(raw) === m.requestSha256, 'OPERATING_REQUEST_HASH');
        await permitLiability(j.family, raw, m, repo);
        const timing =
          j.family === 'market' ? await marketTiming(this.root, j, m, raw, this.now()) : null;
        // The real child validates the exact method/query and all control reservations again after queuing.
        const cost = zeros();
        Object.assign(cost[m.protocol], {
          attempts: 1,
          bytes: m.bytes,
          objects: m.objects,
          extras: Number(m.retry > 0),
        });
        this.state.rolling = this.state.rolling.filter(
          (b) => b.at > now - this.config.rolling.seconds,
        );
        const used = zeros();
        for (const b of this.state.rolling) add(used, b.cost);
        const protection = this.liabilities(job);
        add(protection, cost);
        this.checkAggregate(protection);
        check(
          fits(j.spent, cost, j.caps) &&
            fits(this.state.totals, protection, this.config.total) &&
            fits(used, protection, this.config.rolling.limits),
          'OPERATING_BUDGET',
        );
        this.checkEndpointReserve(job, m.protocol, Number(m.endpoint), m.reserved ?? {});
        if (m.reserved) {
          const r = zeros();
          for (const p of protocols)
            Object.assign(r[p], {
              attempts: m.reserved[p + 'Attempts'] ?? 0,
              bytes: m.reserved[p + 'ChargedBytes'] ?? 0,
              objects: 0,
              extras: 0,
            });
          r[m.protocol].objects = m.reserved.chargedEntities ?? m.objects;
          add(r, this.liabilities(job));
          this.checkAggregate(r);
          check(
            fits(this.state.totals, r, this.config.total) &&
              fits(used, r, this.config.rolling.limits),
            'OPERATING_CONTROL_RESERVE',
          );
        }
        await this.storage(m.bytes * 2 + 131072, false);
        const parentBefore = await this.parentSnapshot();
        const permit = {
          activation: this.state.activation,
          run: this.state.run,
          id: this.state.nextRequest++,
          job,
          attempt: m.attempt,
          nonce: randomUUID(),
          protocol: m.protocol,
          closureMode: this.config.format,
          endpoint: m.endpoint,
          requestPath: path,
          querySha256: m.querySha256,
          requestSha256: m.requestSha256,
          retry: m.retry,
          bytes: m.bytes,
          objects: m.objects,
          expiresAt: Math.min(
            m.expiresAt,
            j.deadline,
            this.config.dispatchEndsAt ?? this.config.expiresAt,
          ),
          at: now,
          ...(timing ? { scheduling: timing, queuedAt: item.queuedAt } : {}),
        };
        // A settlement-only reservation is NOT authority to start a worker.
        // The child has already durably reserved its attempt; preserve that full
        // liability and require its ordinary enclosing no-dispatch proof.
        if (timing && this.now() >= timing.latestDispatch) permit.dispatchAllowed = false;
        add(this.state.totals, cost);
        add(j.spent, cost);
        if (m.protocol !== 'http') {
          this.state.endpointAttempts[m.protocol][Number(m.endpoint)]++;
          j.endpointSpent[m.protocol][Number(m.endpoint)]++;
        }
        this.state.rolling.push({ id: permit.id, at: now, cost });
        this.state.pending = permit;
        this.state.maxPhysical = Math.max(
          this.state.maxPhysical,
          Number(Boolean(this.state.pending)),
        );
        j.lastAttempt = m.attempt;
        if (timing) marketGranted(j, m, timing);
        j.phase = 'RUNNING';
        await this.save();
        await this.receipt(`PERMIT_${String(permit.id).padStart(8, '0')}.json`, permit);
        const dispatchTime = this.now();
        check(
          this.state.status === 'RUNNING' && dispatchTime < permit.expiresAt,
          'OPERATING_FINAL_PERMIT_EXPIRED',
        );
        if (timing && dispatchTime >= timing.latestDispatch && permit.dispatchAllowed !== false) {
          permit.dispatchAllowed = false;
          await this.save();
          await this.receipt(`NO_DISPATCH_${String(permit.id).padStart(8, '0')}.json`, permit);
        }
        item.resolve({
          ok: true,
          now: dispatchTime,
          permit,
          parentBefore,
          parent: await this.parentSnapshot(),
        });
      } catch (e) {
        if (j) j.phase = 'RUNNING';
        item.reject(e);
      }
    });
  }
  async parentSnapshot() {
    const t = this.state.totals;
    return {
      status: this.state.status === 'RUNNING' ? 'ADMITTED' : this.state.status,
      pending: null,
      ...Object.fromEntries(
        protocols.flatMap((p) => [
          [p + 'Attempts', t[p].attempts],
          [p + 'ChargedBytes', t[p].bytes],
          [p + 'Extras', t[p].extras],
        ]),
      ),
      attempts: protocols.reduce((s, p) => s + t[p].attempts, 0),
      chargedEntities: protocols.reduce((s, p) => s + t[p].objects, 0),
      rpcEndpointAttempts: [...this.state.endpointAttempts.rpc],
    };
  }
  checkAggregate(reserved) {
    for (const [p, cap] of Object.entries(this.config.physicalAttemptSubcaps ?? {}))
      check(
        this.state.totals[p].attempts + reserved[p].attempts <= cap,
        'OPERATING_PHYSICAL_SUBCAP',
      );
    if (!this.config.aggregate) return;
    for (const k of ['attempts', 'bytes', 'objects'])
      check(
        protocols.reduce((n, p) => n + this.state.totals[p][k] + reserved[p][k], 0) <=
          this.config.aggregate[k],
        'OPERATING_AGGREGATE_RESERVE',
      );
  }
  async settle(job, m) {
    const p = this.state.pending,
      j = this.jobs.get(job);
    check(
      p &&
        p.job === job &&
        m.permitId === p.id &&
        m.nonce === p.nonce &&
        m.attempt === p.attempt &&
        j.lastSettled < p.attempt,
      'OPERATING_SETTLEMENT_IDENTITY',
    );
    check(typeof m.closed === 'boolean', 'OPERATING_CLOSURE_REQUIRED');
    integer(m.bytes, 0, p.bytes);
    integer(m.objects, 0, p.objects);
    const capture = await settlementEvidence(p, m, j.family);
    if (j.family === 'market') marketSettled(j, capture);
    let startupTimeout = false;
    if (this.state.dispatchEvidence && m.closed) {
      const physical = JSON.parse(
        await fs.readFile(join(dirname(p.requestPath), 'PHYSICAL_CLOSED.json')),
      );
      startupTimeout =
        capture.failureKind === 'transport_timeout' &&
        physical.physicalStarted === false &&
        physical.noChildStarted === false;
      if (Number.isInteger(capture.status) && capture.status >= 100 && capture.status <= 599)
        this.state.dispatchEvidence.observedHttpResponses++;
      else if (physical.noChildStarted === true || physical.physicalStarted === false)
        this.state.dispatchEvidence.knownNoNetworkDispatch++;
    }
    const now = this.now();
    // Unknown/incomplete physical observations keep their entire prior reservation.
    if (m.closed && m.complete) {
      const bucket = this.state.rolling.find((b) => b.id === p.id),
        delta = zeros();
      delta[p.protocol].bytes = p.bytes - m.bytes;
      delta[p.protocol].objects = p.objects - m.objects;
      add(this.state.totals, delta, -1);
      add(j.spent, delta, -1);
      if (bucket) add(bucket.cost, delta, -1);
    }
    if (m.closed) {
      this.state.pending = null;
      this.state.lastClosed = now;
    } else this.state.status = 'UNKNOWN';
    // A proved reaped startup timeout settles liability, but never authorizes
    // retry or another physical dispatch. Retain terminal parent protection.
    if (startupTimeout) this.state.status = 'UNKNOWN';
    j.lastSettled = p.attempt;
    j.phase = 'RUNNING';
    await this.save();
    await this.receipt(`SETTLEMENT_${String(p.id).padStart(8, '0')}.json`, { ...m, at: now });
    if (startupTimeout) throw Error('OPERATING_PRE_NETWORK_TIMEOUT_TERMINAL');
    return { ok: true, now, parent: await this.parentSnapshot() };
  }
  publication(job, fn) {
    const j = this.jobs.get(job);
    check(j, 'OPERATING_PUBLICATION_JOB');
    j.phase = 'PUBLICATION';
    const p = this.writer.then(async () => {
      check(
        this.state.status === 'RUNNING' && this.now() < j.deadline,
        'OPERATING_PUBLICATION_CLOSED',
      );
      this.writers++;
      this.maxWriters = Math.max(this.maxWriters, this.writers);
      try {
        return await fn();
      } finally {
        this.writers--;
        j.phase = 'RUNNING';
      }
    });
    this.writer = p.catch(() => {});
    return p;
  }
  idleTime() {
    if ([...this.jobs.values()].some((j) => ['RUNNING', 'PUBLICATION'].includes(j.phase)))
      return null;
    const times = this.waiters.map((w) => w.at);
    if (this.queue.length && !this.state.pending)
      times.push(Math.max(this.now(), (this.state.lastClosed ?? -1) + 1));
    return times.length ? Math.min(...times) : Infinity;
  }
  async close(status = 'CLOSED') {
    await this.serial;
    await this.writer;
    check(
      this.jobs.size === 0 &&
        this.queue.length === 0 &&
        this.waiters.length === 0 &&
        !this.state.pending,
      'OPERATING_CLOSE_UNKNOWN',
    );
    check(this.state.status === 'RUNNING', 'OPERATING_TERMINAL_PRESERVED');
    this.state.status = status;
    this.now();
    await this.save();
    if (status === 'PAUSED') await this.receipt(`PAUSE_${this.state.run}.json`, this.state);
    await this.lock.close();
    await fs.unlink(join(this.root, 'OPERATING_OWNER.lock'));
  }
}
