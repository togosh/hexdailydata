import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { resolve } from 'node:path';
import { prefixPlan } from './prefix-fixture.mjs';
import { canaryPlanSchema } from '../../dist/operator/canary-plan.js';
import { CanarySession } from '../../dist/operator/canary-session.js';
import { digest } from '../../dist/services/projections/input.js';
import { totalColumns } from '../../dist/services/projections/reduce.js';
import { FakeClock, A, hash } from '../sync/fixture.mjs';
import {
  checkAuditBindings,
  auditPostgresImage,
  auditDatabaseCommand,
} from '../../scripts/operator/audit-bindings.mjs';
import { rpcDiagnostic } from '../../dist/providers/rpc-diagnostic.js';

const inventory = [{ address: A, hearts: '0' }];
function plan() {
  const base = prefixPlan('/unused', {
    project: 'hexdailydata-v2-audit-test',
    instance: 'b602a42a-8403-45f3-b18e-5c2363c47ef6',
  });
  return canaryPlanSchema.parse({
    ...base,
    allowHeadObservation: false,
    ranges: [{ chain: 1, from: '103', to: '103' }],
    methods: ['eth_chainId', 'eth_getBlockByNumber', 'eth_getCode', 'eth_call'],
    phases: [
      {
        kind: 'pinned-audit',
        purpose: 'Synthetic no-network guard witness',
        cadence: base.phases[0].cadence,
        endpoints: base.phases[0].endpoints,
        admission: {
          volume: 'hexdailydata-v2-retained-test_db_data',
          checkpoint: {
            number: '103',
            hash: hash(103),
            parentHash: hash(102),
            timestamp: '1575363601',
          },
          revision: '1',
          sourceBindingDigest: 'a'.repeat(64),
          counts: Object.fromEntries(
            [
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
            ].map((k) => [k, k === 'accounts' ? '1' : '0']),
          ),
          current: { contract_day: 0, ...Object.fromEntries(totalColumns.map((k) => [k, '0'])) },
        },
        inventoryDigest: digest(inventory),
        canonicalDigest: 'b'.repeat(64),
        priorSession: randomUUID(),
        priorStorageIdentity: '1:1',
        priorQuotaIdentity: '1:2',
        priorDispatchFloor: 0,
      },
    ],
  });
}
function setup(hooks = {}, guard = async () => {}) {
  const p = plan(),
    clock = new FakeClock();
  clock.time = 100000;
  const state = {
    start: 100000,
    deadline: 3700000,
    highWater: 100000,
    http: 0,
    logical: 0,
    chargedBytes: 0,
    observedBytes: 0,
    uncertainAttempts: 0,
    pending: false,
    terminal: false,
    status: 'running',
    phase: 0,
    results: [],
    reason: '',
    audit: { ended: null, secondary: [], before: 'b'.repeat(64), after: null, unchanged: null },
  };
  const session = new CanarySession(p, state, clock, hooks);
  session.save = async () => {};
  const context = { inventory, guard };
  return { p, clock, state, session, context };
}
const body = JSON.stringify([{ jsonrpc: '2.0', id: 1, method: 'eth_chainId', params: [] }]);
const reply = () => ({
  status: 200,
  retryAfter: null,
  body: (async function* () {
    yield Buffer.from('[{"jsonrpc":"2.0","id":1,"result":"0x171"}]');
  })(),
});
async function drain(response) {
  for await (const _ of response.body) {
  }
  await response.close?.();
}

test('audit plan remains one fixed read-only mode with unchanged hard ceilings', () => {
  const p = plan();
  assert.deepEqual(canaryPlanSchema.parse(p), p);
  for (const change of [
    (q) => (q.allowHeadObservation = true),
    (q) => q.phases.push(q.phases[0]),
    (q) => (q.ranges[0].to = '104'),
    (q) => q.methods.push('eth_getLogs'),
    (q) => (q.phases[0].priorSession = q.session),
    (q) => (q.caps.http = 501),
    (q) => (q.caps.logical = 5001),
    (q) => (q.caps.bytes = 134217729),
    (q) => (q.caps.responseBytes = 8388608),
  ]) {
    const q = structuredClone(p);
    change(q);
    assert.equal(canaryPlanSchema.safeParse(q).success, false);
  }
});
test('audit gate keeps quarantine/prior floor/12-per-minute spacing and single body settlement', async () => {
  const x = setup();
  x.p.phases[0].priorDispatchFloor = 165000;
  const starts = [];
  let active = 0,
    peak = 0;
  const transport = x.session.transport(
    1,
    async () => {
      starts.push(x.clock.now());
      peak = Math.max(peak, ++active);
      const r = reply();
      return {
        ...r,
        close: async () => {
          active--;
        },
      };
    },
    x.p.profile.ethereum[0].id,
    x.context,
  );
  try {
    for (let i = 0; i < 15; i++)
      await drain(await transport(body, new AbortController().signal, Infinity));
    assert.equal(starts[0], 165000);
    assert.equal(peak, 1);
    assert.equal(active, 0);
    for (let i = 1; i < starts.length; i++) assert(starts[i] - starts[i - 1] >= 2100);
    assert(starts.every((t) => starts.filter((s) => s > t - 60000 && s <= t).length <= 12));
    assert.equal(x.state.http, 15);
    assert.equal(x.state.chargedBytes, x.state.observedBytes);
    assert.equal(x.state.pending, false);
  } finally {
    await x.session.close();
  }
});
test('audit checks original deadlines after persistence and SQL guard; late bodies keep uncertainty charge', async () => {
  for (const position of ['persistence', 'sql', 'body']) {
    let x,
      sends = 0;
    x = setup(
      position === 'persistence'
        ? {
            beforeDispatch: async () => {
              x.clock.time += 101;
            },
          }
        : {},
      async () => {
        if (position === 'sql') x.clock.time += 101;
      },
    );
    x.state.start = 0;
    x.p.phases[0].priorDispatchFloor = 0;
    const t = x.session.transport(
      1,
      async () => {
        sends++;
        return {
          status: 200,
          retryAfter: null,
          body: (async function* () {
            if (position === 'body') x.clock.time += 101;
            yield Buffer.from('[{"jsonrpc":"2.0","id":1,"result":"0x171"}]');
          })(),
        };
      },
      x.p.profile.ethereum[0].id,
      x.context,
    );
    try {
      await assert.rejects(
        async () => drain(await t(body, new AbortController().signal, 100100)),
        (e) => {
          if (position === 'body') assert(rpcDiagnostic(e));
          return /deadline/.test(e.message);
        },
      );
      assert.equal(sends, position === 'body' ? 1 : 0);
      assert.equal(x.state.chargedBytes, 8388608);
      assert.equal(x.state.pending, false);
    } finally {
      await x.session.close();
    }
  }
});
test('audit exhausted allowance and cancelled SQL context dispatch no extra request', async () => {
  const x = setup();
  x.state.http = x.p.caps.http;
  let sent = 0;
  const t = x.session.transport(
    1,
    async () => {
      sent++;
      return reply();
    },
    x.p.profile.ethereum[0].id,
    x.context,
  );
  try {
    await assert.rejects(t(body, new AbortController().signal), /HTTP/);
    assert.equal(sent, 0);
  } finally {
    await x.session.close();
  }
  const y = setup({}, async () => {
    throw Error('Pinned audit snapshot lost.');
  });
  try {
    await assert.rejects(
      y.session.transport(
        1,
        async () => {
          sent++;
          return reply();
        },
        y.p.profile.ethereum[0].id,
        y.context,
      )(body, new AbortController().signal),
      /snapshot lost/,
    );
    assert.equal(sent, 0);
    assert.equal(y.state.chargedBytes, 8388608);
  } finally {
    await y.session.close();
  }
});
for (const kind of ['pinned-audit', 'common-continue', 'audit-only'])
  test(
    kind +
      ' selected graph rejects missing/extraneous mounts, wrong instance, existing state and competing DB',
    () => {
      const p = plan(),
        volume = { Name: p.phases[0].admission.volume, Labels: { 'hdd.v2.instance': p.instance } },
        states = ['state', 'quota'].map((Name) => ({
          Name,
          Labels: { 'hdd.v2.audit-session': p.session },
        }));
      const graph = {
        name: p.project,
        services: {
          db: {
            image: auditPostgresImage,
            entrypoint: ['postgres'],
            read_only: true,
            cpus: 1.25,
            mem_limit: '2684354560',
            networks: { private: {} },
            volumes: [{ type: 'volume', source: 'data', target: '/var/lib/postgresql/data' }],
          },
          operator: {
            image: p.release,
            entrypoint: ['node', 'dist/operator/main.js'],
            read_only: true,
            cpus: 0.5,
            mem_limit: '1073741824',
            networks: { private: {}, egress: {} },
            secrets: [{ source: 'api' }, { source: 'worker' }],
            volumes: [
              { type: 'volume', source: 'state', target: p.storagePath },
              { type: 'volume', source: 'quota', target: p.quotaPath },
              { type: 'bind', source: '/input', target: '/input', read_only: true },
            ],
            environment: {
              HDD_V2_DB_INSTANCE: p.instance,
              HDD_V2_PROJECT: p.project,
              HDD_V2_DB_HOST: 'db',
              HDD_V2_DB_NAME: 'hexdailydata_v2',
              HDD_V2_STORAGE_PATH: p.storagePath,
              HDD_V2_PROVIDER_STATE: p.quotaPath,
              HDD_V2_CANARY_RELEASE: p.release,
              HDD_V2_ALLOW_LIVE_RPC: 'false',
            },
          },
        },
        networks: { private: { internal: true }, egress: {} },
        volumes: {
          data: { external: true, name: volume.Name },
          state: { external: true, name: 'state' },
          quota: { external: true, name: 'quota' },
        },
      };
      p.phases[0].kind = kind;
      if (kind === 'audit-only') {
        Object.assign(p, {
          kind: 'common-history-reconstruction',
          auditOnly: true,
          admission: p.phases[0].admission,
          run: p.session,
        });
        for (const s of states) s.Labels = { 'hdd.v2.reconstruction-run': p.run };
        Object.assign(graph.services.operator.environment, {
          HDD_V2_RECONSTRUCTION_RELEASE: p.release,
          HDD_V2_REVIEWED_COMMIT: p.reviewedCommit,
        });
        graph.services.db.command = auditDatabaseCommand(p);
        for (const command of [
          undefined,
          ['-D', '/var/lib/postgresql/data'],
          ['-D', '/var/lib/postgresql/data', '-c', 'default_transaction_read_only=off'],
        ]) {
          const changed = structuredClone(graph);
          changed.services.db.command = command;
          assert.throws(() => checkAuditBindings(p, changed, volume, states, []));
        }
      }
      assert.equal(
        checkAuditBindings(p, graph, volume, states, []).canonicalSql,
        kind === 'common-continue' ? 'origin1-writer-only' : 'read-only',
      );
      for (const change of [
        (g) => (g.volumes.data.external = false),
        (g) => (g.services.worker = {}),
        (g) => (g.services.db.ports = ['5432']),
        (g) =>
          g.services.operator.volumes.push({ type: 'volume', source: 'old', target: '/backup' }),
        (g) => (g.services.operator.environment.HDD_V2_ALLOW_LIVE_RPC = 'true'),
        (g) => (g.services.db.entrypoint = ['docker-entrypoint.sh']),
      ]) {
        const g = structuredClone(graph);
        change(g);
        assert.throws(() => checkAuditBindings(p, g, volume, states, []));
      }
      assert.throws(() => checkAuditBindings(p, graph, { ...volume, Labels: {} }, states, []));
      assert.throws(() => checkAuditBindings(p, graph, volume, [], []));
      assert.throws(() =>
        checkAuditBindings(p, graph, volume, states, [
          {
            Mounts: [{ Type: 'volume', Name: volume.Name }],
            Config: {
              Labels: { 'com.docker.compose.project': 'another' },
              Image: auditPostgresImage,
            },
          },
        ]),
      );
    },
  );
test('actual supervisor refuses a spent marker before Docker/config/provider work', () => {
  const root = resolve(
    process.env.HDD_V2_CANARY_EVIDENCE ?? 'artifacts/task-10/canary-unit',
    'marker-test-' + randomUUID(),
  );
  mkdirSync(root, { recursive: true });
  writeFileSync(root + '/invocation.json', '{"spent":true}\n');
  writeFileSync(root + '/overlay.yaml', 'services: {}\n');
  const result = spawnSync(
    process.execPath,
    ['scripts/operator/canary-once.mjs', root, root + '/overlay.yaml'],
    { encoding: 'utf8' },
  );
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /already spent/);
});
