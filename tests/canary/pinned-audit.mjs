import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import { setTimeout as pause } from 'node:timers/promises';
import pg from 'pg';
import { connect, databaseConfig } from '../../dist/db/connect.js';
import { runCanary } from '../../dist/operator/canary.js';
import { canaryPlanSchema } from '../../dist/operator/canary-plan.js';
import {
  beginAuditSnapshot,
  canonicalEvidence,
  inspectAuditTarget,
  AuditScope,
} from '../../dist/operator/canary-audit.js';
import { auditState } from '../../dist/worker/sync/audit.js';
import { profileBinding, profileSources } from '../../dist/worker/sync/profile.js';
import { digest, hex } from '../../dist/services/projections/input.js';
import { totalColumns } from '../../dist/services/projections/reduce.js';
import { ProviderBudget } from '../../dist/providers/budget.js';
import { CanarySession } from '../../dist/operator/canary-session.js';
import { prefixPlan, prefixEnvironment, prefixFixture, endpoints } from './prefix-fixture.mjs';
import { inputs } from './fixture.mjs';
import { FakeClock, memoryCooldown, hash } from '../sync/fixture.mjs';

const signal = new AbortController().signal;
const json = async (p) => JSON.parse(await readFile(p, 'utf8'));
async function admin(work) {
  const db = new pg.Client({
    host: 'db',
    database: 'hexdailydata_v2',
    user: 'hdd_v2_admin',
    password: process.env.HDD_V2_ADMIN_PASSWORD,
  });
  await db.connect();
  try {
    return await work(db);
  } finally {
    await db.end();
  }
}
export async function pinnedAuditTests({ root, test, reset }) {
  let base, fixture, expected, original, admission;
  const clock = new FakeClock();
  clock.time = Date.now();
  const path = (p) => p.storagePath + '/plan.json',
    approval = (p) => p.storagePath + '/approval.json';
  const execute = (p, command, options = {}) =>
    runCanary([command, path(p), approval(p)], signal, {
      env: prefixEnvironment(p),
      clock,
      transport: fixture.transport,
      ...options,
    });
  async function readTarget(p = base) {
    const reader = await connect(databaseConfig('api')),
      owner = await connect(databaseConfig('worker'));
    try {
      await owner.query('SET default_transaction_read_only=on');
      await beginAuditSnapshot(reader, 3600000);
      return await inspectAuditTarget(reader, owner, p.profile, admission);
    } finally {
      await reader.end();
      await owner.end();
    }
  }
  async function fresh(change) {
    const value = structuredClone(base),
      storage = root + '/' + randomUUID();
    Object.assign(value, {
      session: randomUUID(),
      storagePath: storage,
      quotaPath: storage + '/quota',
      sessionPath: storage + '/canary.json',
    });
    Object.assign(value, {
      allowHeadObservation: false,
      ranges: [{ chain: 1, from: '103', to: '103' }],
      methods: ['eth_chainId', 'eth_getBlockByNumber', 'eth_getCode', 'eth_call'],
    });
    value.phases = [
      {
        kind: 'pinned-audit',
        purpose: 'Synthetic retained-checkpoint read-only audit',
        admission,
        inventoryDigest: expected.inventoryDigest,
        canonicalDigest: expected.canonical.digest,
        priorSession: base.session,
        priorStorageIdentity: original.storage,
        priorQuotaIdentity: original.quota,
        priorDispatchFloor: 0,
        cadence: base.phases[0].cadence,
        endpoints,
      },
    ];
    change?.(value);
    const p = canaryPlanSchema.parse(value);
    await inputs(p);
    return p;
  }
  await test('pinned audit fixture: real compiled nonempty prefix, 31 complete accounts including zero and >2^53, no retained live DB', async () => {
    base = prefixPlan(root + '/' + randomUUID());
    await inputs(base);
    fixture = prefixFixture(base, clock);
    await execute(base, 'prepare');
    const result = await execute(base, 'run');
    assert.equal(result.status, 'complete', result.reason);
    original = await json(base.sessionPath);
    await admin(async (db) => {
      for (let n = 1; n <= 29; n++)
        await db.query('INSERT INTO hdd.accounts VALUES(1,$1,0,0,0,103,103)', [
          Buffer.from(n.toString(16).padStart(40, '0'), 'hex'),
        ]);
    });
    const db = await connect(databaseConfig('api'));
    try {
      const current = (await db.query('SELECT * FROM hdd.current_state WHERE chain_id=1')).rows[0];
      const cursor = (await db.query('SELECT * FROM hdd.sync_state WHERE chain_id=1')).rows[0];
      const header = (
        await db.query('SELECT * FROM hdd.blocks_recent WHERE chain_id=1 AND number=103')
      ).rows[0];
      const counts = {};
      for (const t of [
        'accounts',
        'stakes',
        'share_schedule',
        'daily_stats',
        'blocks_recent',
        'events',
        'transfers_recent',
        'checkpoints_recent',
        'undo_recent',
        'live_metrics',
        'export_bundles',
      ])
        counts[t] = (await db.query('SELECT count(*)::text AS n FROM hdd.' + t)).rows[0].n;
      admission = {
        volume: process.env.HDD_V2_PROJECT + '_db_data',
        checkpoint: {
          number: header.number,
          hash: hex(header.hash),
          parentHash: hex(header.parent_hash),
          timestamp: header.timestamp,
        },
        revision: cursor.revision,
        sourceBindingDigest: digest(profileBinding(base.profile, 1)),
        counts,
        current: Object.fromEntries(['contract_day', ...totalColumns].map((k) => [k, current[k]])),
      };
      assert.equal(counts.accounts, '31');
      assert(BigInt(current.circulating_hearts) > 2n ** 53n);
      assert(BigInt(counts.stakes) > 0n);
    } finally {
      await db.end();
    }
    expected = await readTarget();
    assert.equal(expected.inventory[0].hearts, '0');
  });
  await test('pinned admission rejects exact identity/content changes before constructing providers; old common-prefix still empty-only', async () => {
    for (const change of [
      (p) => (p.instance = randomUUID()),
      (p) => (p.phases[0].admission.checkpoint.number = '104'),
      (p) => (p.phases[0].admission.checkpoint.hash = hash(999)),
      (p) => (p.phases[0].admission.checkpoint.parentHash = hash(999)),
      (p) => (p.phases[0].admission.checkpoint.timestamp = '1575339999'),
      (p) => (p.phases[0].admission.revision = '999'),
      (p) => (p.phases[0].admission.sourceBindingDigest = 'a'.repeat(64)),
      (p) => (p.phases[0].admission.counts.stakes = '999'),
      (p) => (p.phases[0].admission.current.locked_hearts = '999'),
      (p) => (p.phases[0].inventoryDigest = 'a'.repeat(64)),
      (p) => (p.phases[0].canonicalDigest = 'a'.repeat(64)),
      (p) => (p.profile.ethereum[0].accountGroup = 'wrong'),
    ]) {
      let p;
      // Number changes must update the authorized one-point interval to reach the SQL guard.
      p = await fresh((q) => {
        q.phases[0].admission = structuredClone(admission);
        change(q);
        q.ranges[0].from = q.ranges[0].to = q.phases[0].admission.checkpoint.number;
      });
      let constructed = 0;
      await assert.rejects(
        execute(p, 'prepare', {
          transport: () => {
            constructed++;
            throw Error('forbidden');
          },
        }),
      );
      assert.equal(constructed, 0);
    }
    const p = prefixPlan(root + '/' + randomUUID());
    await inputs(p);
    await assert.rejects(execute(p, 'prepare'), /empty/i);
    const alias = await fresh((q) => {
      q.storagePath = base.storagePath;
      q.quotaPath = base.quotaPath;
      q.sessionPath = base.sessionPath;
    });
    await assert.rejects(execute(alias, 'prepare'), /filesystem identities/);
    // Restore only the fixture's plan/approval input files overwritten by inputs().
    await inputs(base);
    await admin((db) =>
      db.query(
        "INSERT INTO hdd.chains SELECT 369,contract_address,code_hash,'fork',369,103,$1,104,$2 FROM hdd.chains WHERE chain_id=1",
        [Buffer.from(hash(103).slice(2), 'hex'), Buffer.from(hash(104).slice(2), 'hex')],
      ),
    );
    await assert.rejects(execute(await fresh(), 'prepare'), /only constructor-origin1/);
    await admin((db) => db.query('DELETE FROM hdd.chains WHERE chain_id=369'));
    for (const sql of [
      "UPDATE hdd.schema_migrations SET sha256='invalid' WHERE version=5",
      'UPDATE hdd.schema_migrations SET version=6 WHERE version=5',
    ]) {
      await admin(async (db) => {
        await db.query('BEGIN');
        await db.query(sql);
        await db.query('COMMIT');
      });
      const p = await fresh();
      await assert.rejects(execute(p, 'prepare'), /migration|schema/);
      await admin((db) =>
        db.query('UPDATE hdd.schema_migrations SET version=5,sha256=$1 WHERE version IN (5,6)', [
          expected.migrations[4].sha256,
        ]),
      );
    }
    assert.equal((await readTarget()).canonical.digest, expected.canonical.digest);
  });
  await test('pinned read-only protection and bounded snapshot survives >15s; real API role and worker lock role deny writes', async () => {
    for (const role of ['api', 'worker']) {
      const c = await connect(databaseConfig(role));
      try {
        await c.query('SET default_transaction_read_only=on');
        await beginAuditSnapshot(c, 60000);
        assert.equal((await c.query('SHOW statement_timeout')).rows[0].statement_timeout, '15s');
        await assert.rejects(
          c.query('UPDATE hdd.current_state SET raw_share_rate=raw_share_rate WHERE chain_id=1'),
          /read-only|permission/i,
        );
        await c.query('ROLLBACK');
        if (role === 'api') {
          await beginAuditSnapshot(c, 60000);
          await pause(16000);
          assert.equal((await c.query('SELECT count(*) FROM hdd.accounts')).rows[0].count, '31');
        }
      } finally {
        await c.end();
      }
    }
    assert.equal((await readTarget()).canonical.digest, expected.canonical.digest);
  });
  await test('pinned compiled successful two probes then 10/10/10/1 per source; exact SQL/schema/sequence equality and spent guards', async () => {
    const p = await fresh(),
      calls = [];
    const raw = fixture.transport;
    const options = {
      transport: (endpoint) => {
        const t = raw(endpoint);
        return async (body, ...args) => {
          calls.push({ source: endpoints.indexOf(endpoint), calls: JSON.parse(body) });
          return t(body, ...args);
        };
      },
    };
    await execute(p, 'prepare', options);
    const result = await execute(p, 'run', options);
    assert.equal(result.status, 'complete', result.reason);
    assert.equal(result.audit.unchanged, true);
    for (const progress of result.audit.progress) {
      assert.equal(progress.probeComplete, true);
      assert.equal(progress.verifiedAccounts, 31);
      assert.equal(progress.completedBatches, 4);
      assert.equal(progress.complete, true);
    }
    const balance = calls.filter(
      (r) => r.calls[0].method === 'eth_call' && r.calls[0].params[0].data.startsWith('0x70a08231'),
    );
    assert.deepEqual(
      balance.map((r) => [r.source, r.calls.length]),
      [
        [0, 1],
        [1, 1],
        [0, 10],
        [0, 10],
        [0, 10],
        [0, 1],
        [1, 10],
        [1, 10],
        [1, 10],
        [1, 1],
      ],
    );
    assert.equal(
      balance.reduce((n, r) => n + r.calls.length, 0),
      64,
    );
    assert.equal(Math.ceil(1676 / 10) * 2, 336);
    assert.equal(1676 * 2, 3352);
    assert.equal(1676 * 2 + 2, 3354);
    const text = await readFile(p.sessionPath, 'utf8');
    for (const command of ['run', 'resume'])
      await assert.rejects(execute(p, command), /spent|resume/);
    assert.equal(await readFile(p.sessionPath, 'utf8'), text);
    assert.equal((await readTarget()).canonical.digest, expected.canonical.digest);
    const reader = await connect(databaseConfig('api'));
    try {
      const ordinaryCalls = [];
      const sources = profileSources(
        p.profile,
        1,
        (s) => {
          const t = raw(endpoints[p.profile.ethereum.indexOf(s)]);
          return async (body, ...args) => {
            const batch = JSON.parse(body);
            if (batch[0].params[0]?.data?.startsWith('0x70a08231'))
              ordinaryCalls.push(batch.length);
            return t(body, ...args);
          };
        },
        new ProviderBudget('worker', memoryCooldown(), clock),
      );
      await auditState(reader, 1, sources, signal);
      assert.deepEqual(ordinaryCalls, [30, 1, 30, 1]);
    } finally {
      await reader.end();
    }
  });
  await test('pinned scope rejects unapproved methods/addresses/pins/batches/sources and requires exact observed four-field header', async () => {
    const p = await fresh(),
      phase = p.phases[0],
      scope = new AuditScope(p, phase, expected.inventory, p.profile.ethereum[0].id);
    const balance = {
      method: 'eth_call',
      params: [
        {
          to: p.profile.contract,
          data: '0x70a08231' + expected.inventory[0].address.slice(2).padStart(64, '0'),
        },
        { blockHash: phase.admission.checkpoint.hash, requireCanonical: true },
      ],
    };
    assert.throws(() => scope.request(1, [balance]), /unverified/);
    const header = { method: 'eth_getBlockByNumber', params: ['0x67', false], id: 1 };
    const wire = {
      ...fixture.f.headers.get(103),
      number: '0x67',
      timestamp: '0x' + BigInt(phase.admission.checkpoint.timestamp).toString(16),
    };
    scope.response([header], JSON.stringify([{ id: 1, result: wire }]));
    scope.request(1, [balance]);
    const invalid = [
      {
        method: 'eth_getLogs',
        params: [{ address: p.profile.contract, fromBlock: '0x67', toBlock: '0x67' }],
      },
      { method: 'eth_getBlockByNumber', params: ['latest', false] },
      { method: 'eth_getBlockByNumber', params: ['finalized', false] },
      { method: 'eth_getBlockByNumber', params: ['0xb4', false] },
      { ...balance, params: [balance.params[0], '0x67'] },
      {
        ...balance,
        params: [
          balance.params[0],
          { blockHash: phase.admission.checkpoint.hash, requireCanonical: false },
        ],
      },
      { ...balance, params: [balance.params[0], { blockHash: hash(1), requireCanonical: true }] },
      {
        ...balance,
        params: [
          { to: p.profile.contract, data: '0x70a08231' + 'f'.repeat(64) },
          balance.params[1],
        ],
      },
      {
        ...balance,
        params: [{ to: '0x' + 'ee'.repeat(20), data: balance.params[0].data }, balance.params[1]],
      },
      {
        ...balance,
        params: [
          { to: p.profile.contract, data: '0x6a210a0e' + '0'.repeat(128) },
          balance.params[1],
        ],
      },
      { method: 'eth_getTransactionReceipt', params: [hash(10000)] },
    ];
    for (const c of invalid) assert.throws(() => scope.request(1, [c]));
    assert.throws(() => scope.request(1, Array(11).fill(balance)));
    assert.throws(() => scope.request(369, [balance]));
    assert.throws(() => new AuditScope(p, phase, expected.inventory, 'alternate'));
    assert.throws(
      () =>
        scope.response(
          [header],
          JSON.stringify([{ id: 1, result: { ...wire, parentHash: hash(1) } }]),
        ),
      /header/,
    );
  });
  await test('pinned failure coverage: sourceB value/ABI/ID/hash failures retain sourceA and unchanged canonical state', async () => {
    for (const mode of ['value', 'abi', 'missing', 'conflict', 'hash']) {
      const p = await fresh();
      let injected = false;
      const options = {
        transport: (endpoint) => {
          const t = fixture.transport(endpoint);
          return async (body, ...args) => {
            const request = JSON.parse(body),
              r = await t(body, ...args);
            if (
              endpoint !== endpoints[1] ||
              request.length !== 10 ||
              !request[0].params[0]?.data?.startsWith('0x70a08231')
            )
              return r;
            const chunks = [];
            for await (const c of r.body) chunks.push(c);
            const rows = JSON.parse(Buffer.concat(chunks));
            injected = true;
            if (mode === 'value') rows[0].result = '0x' + '1'.padStart(64, '0');
            if (mode === 'abi') rows[0].result = '0x01';
            if (mode === 'missing') rows.pop();
            if (mode === 'conflict') rows[0].error = { code: -32000 };
            if (mode === 'hash') rows[0].id = 99999;
            return {
              ...r,
              body: (async function* () {
                yield Buffer.from(JSON.stringify(rows));
              })(),
            };
          };
        },
      };
      await execute(p, 'prepare', options);
      const result = await execute(p, 'run', options);
      assert(injected);
      assert.equal(result.status, 'stopped');
      assert.equal(result.audit.progress[0].verifiedAccounts, 31);
      assert.equal(result.audit.progress[1].verifiedAccounts, 0);
      assert.equal(result.audit.progress[1].pending.count, 10);
      assert.equal(result.audit.unchanged, true);
      assert.equal(result.terminal, true);
      assert.equal(result.pending, false);
      if (['missing', 'conflict', 'hash'].includes(mode)) assert(result.rpcDiagnostic);
      assert.equal((await readTarget()).canonical.digest, expected.canonical.digest);
    }
  });
  await test('pinned timeout exhausts only three retries at ten calls, retains 8MiB charges and no smaller/provider fallback', async () => {
    const p = await fresh(),
      sizes = [];
    const options = {
      transport: (endpoint) => {
        const t = fixture.transport(endpoint);
        return async (body, active, ...args) => {
          const calls = JSON.parse(body);
          if (
            endpoint === endpoints[1] &&
            calls.length === 10 &&
            calls[0].params[0]?.data?.startsWith('0x70a08231')
          ) {
            sizes.push(calls.length);
            throw Error('Provider timeout.');
          }
          return t(body, active, ...args);
        };
      },
    };
    await execute(p, 'prepare', options);
    const result = await execute(p, 'run', options);
    assert.equal(result.status, 'stopped');
    assert.deepEqual(sizes, [10, 10, 10, 10]);
    assert.equal(result.uncertainAttempts, 4);
    assert.equal(result.chargedBytes - result.observedBytes, 4 * 8388608);
    assert.equal(result.audit.progress[0].verifiedAccounts, 31);
    assert.equal(result.audit.progress[1].verifiedAccounts, 0);
    assert.equal(result.audit.accounting[1].rpc.retries, 3);
    assert.equal(result.audit.unchanged, true);
    assert(result.rpcDiagnostic);
  });
  await test('pinned competing lock refuses before egress; connection loss and fresh committed drift stop completion', async () => {
    for (const [a, b] of [
      [4244, 0],
      [4244, 1],
      [4250, 0],
      [4242, 1],
      [4242, 369],
    ]) {
      const blocker = await connect(databaseConfig('worker'));
      try {
        await blocker.query('SELECT pg_advisory_lock($1::int,$2::int)', [a, b]);
        const p = await fresh();
        await assert.rejects(execute(p, 'prepare'), /active|exclusive/);
      } finally {
        await blocker.end();
      }
    }
    const p = await fresh();
    let sent = 0,
      killed = false;
    await execute(p, 'prepare');
    const result = await execute(p, 'run', {
      transport: (endpoint) => {
        const t = fixture.transport(endpoint);
        return async (body, ...args) => {
          sent++;
          const r = await t(body, ...args);
          if (!killed) {
            killed = true;
            await admin((db) =>
              db.query(
                "SELECT pg_terminate_backend(pid) FROM pg_locks WHERE locktype='advisory' AND classid=4242 AND objid=369 AND granted",
              ),
            );
            await pause(30);
          }
          return r;
        };
      },
    });
    assert.equal(result.status, 'stopped');
    assert.equal(sent, 1);
    assert.equal((await readTarget()).canonical.digest, expected.canonical.digest);
    const drift = await fresh();
    await execute(drift, 'prepare');
    let changed = false;
    const originalFile = await readFile(base.sessionPath, 'utf8');
    const r = await execute(drift, 'run', {
      sessionHooks: {
        beforeDispatch: async () => {
          if (!changed) {
            changed = true;
            await admin((db) =>
              db.query('UPDATE hdd.sync_state SET ranking_day=99 WHERE chain_id=1'),
            );
          }
        },
      },
    });
    assert.equal(r.status, 'stopped');
    assert.equal(r.audit.unchanged, false);
    assert.equal(await readFile(base.sessionPath, 'utf8'), originalFile);
    await admin((db) =>
      db.query('UPDATE hdd.sync_state SET ranking_day=$1 WHERE chain_id=1', [
        expected.cursor.ranking_day,
      ]),
    );
    assert.equal((await readTarget()).canonical.digest, expected.canonical.digest);
  });
  await test('pinned expired SQL snapshot cancels before a later dispatch and cannot reconnect to continue', async () => {
    const p = await fresh();
    await execute(p, 'prepare');
    const query = pg.Client.prototype.query;
    let reader,
      sends = 0,
      expired = false;
    pg.Client.prototype.query = function (text, ...args) {
      if (
        this.connectionParameters.user === 'hdd_v2_api' &&
        text === 'BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY'
      )
        reader = this;
      return query.call(this, text, ...args);
    };
    try {
      const result = await execute(p, 'run', {
        sessionHooks: {
          beforeDispatch: async () => {
            if (!expired) {
              expired = true;
              await reader.query(
                "SELECT set_config('idle_in_transaction_session_timeout','10',true)",
              );
              await pause(100);
            }
          },
        },
        transport: (endpoint) => {
          const t = fixture.transport(endpoint);
          return async (...args) => {
            sends++;
            return t(...args);
          };
        },
      });
      assert.equal(result.status, 'stopped');
      assert(expired);
      assert.equal(sends, 0);
      assert.equal(
        result.audit.unchanged,
        null,
        'Lost snapshot cannot claim equality from the old snapshot',
      );
    } finally {
      pg.Client.prototype.query = query;
    }
    assert.equal((await readTarget()).canonical.digest, expected.canonical.digest);
  });
  await test('pinned failed final save never reports complete and old prefix session remains immutable', async () => {
    const p = await fresh();
    await execute(p, 'prepare');
    const result = await execute(p, 'run', {
      sessionHooks: {
        beforeFinalSave: async () => {
          throw Error('Synthetic final save failure');
        },
      },
    });
    assert.equal(result.status, 'stopped');
    assert.equal(result.audit.unchanged, true);
    assert.equal((await json(p.sessionPath)).status, 'stopped');
    assert.deepEqual(await json(base.sessionPath), original);
    assert.equal((await readTarget()).canonical.digest, expected.canonical.digest);
    await reset();
  });
}
