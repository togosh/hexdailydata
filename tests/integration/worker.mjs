import assert from 'node:assert/strict';
import http from 'node:http';
import { writeFile, readFile, readdir, stat } from 'node:fs/promises';
import { runWorker } from '../../dist/worker/main.js';
import { FakeClock } from '../sync/fixture.mjs';
import { connect, databaseConfig } from '../../dist/db/connect.js';
import { configureMarket, importMarketBars } from '../../dist/worker/daily/market.js';
import { DailyService } from '../../dist/worker/daily/service.js';
import {
  control,
  model,
  CONTRACT,
  CODE_HASH,
  finalBlock,
  clockFor,
  meterBudget,
} from './fixture.mjs';

assert.equal(process.env.HDD_V2_ALLOW_LIVE_RPC, 'false');
const mode = process.argv[2],
  c = control(),
  m = model(c, !['bootstrap', 'witness'].includes(mode));
const requests = [];
const budgetEvidence = meterBudget();
const resources = [];
const dailyJobs = [];
const dailyTick = DailyService.prototype.tick;
DailyService.prototype.tick = async function (signal, now, force) {
  const row = { began: Date.now(), virtualNow: now, force: force ?? false };
  dailyJobs.push(row);
  try {
    return await dailyTick.call(this, signal, now, force);
  } finally {
    Object.assign(row, { ended: Date.now(), status: { ...this.status } });
  }
};
let sampling;
async function sampleResources() {
  const directories = [];
  for (const name of await readdir('/exports')) {
    try {
      if (!(await stat('/exports/' + name)).isDirectory()) continue;
      let bytes = 0;
      for (const file of await readdir('/exports/' + name))
        bytes += (await stat('/exports/' + name + '/' + file)).size;
      directories.push({ name, bytes });
    } catch (e) {
      if (e.code !== 'ENOENT') throw e;
    }
  }
  resources.push({
    at: Date.now(),
    rss: process.memoryUsage().rss,
    memory: (await readFile('/sys/fs/cgroup/memory.current', 'utf8')).trim(),
    directories,
  });
}
const resourceTimer = setInterval(() => {
  if (!sampling)
    sampling = sampleResources()
      .catch((e) => resources.push({ error: e.message }))
      .finally(() => {
        sampling = undefined;
      });
}, 10000);
let server;
const clock = mode === 'watch' ? clockFor(c) : new FakeClock();
if (mode !== 'watch')
  clock.time = Math.max(c.epoch, Number(m.f.headers.get(c.head).timestamp) * 1000 + 1000);
const head = () => {
  if (mode !== 'watch') return c.head;
  const elapsed = Date.now() - c.started;
  // Successful requests see a frozen source from3:00 through5:10. Resume before
  // the separate heavy-page phase so it measures actual100-item observations too.
  const phase = control();
  const sourceElapsed = c.capacity
    ? phase.freezeAt === undefined
      ? elapsed
      : Math.min(phase.freezeAt - c.started, elapsed)
    : elapsed < 310000
      ? Math.min(180000, elapsed)
      : elapsed;
  return finalBlock + 1 + Math.floor(sourceElapsed / 3000);
};
async function response(body, signal, id, chain = 369) {
  const at = clock.now(),
    start = performance.now();
  const bytes = await m.raw(body, signal, head(), chain);
  const calls = JSON.parse(body);
  const answers = JSON.parse(bytes);
  const addressCall = calls.find(
    (r) =>
      r.method === 'eth_call' &&
      ['0x33060d90', '0x70a08231', '0x2607443b'].includes(r.params[0]?.data?.slice(0, 10)),
  );
  requests.push({
    at,
    id,
    address: addressCall ? '0x' + addressCall.params[0].data.slice(34, 74) : null,
    logical: calls.length,
    methods: calls.map((r) => r.method),
    bytes: bytes.length,
    ms: performance.now() - start,
    inputs: calls.flatMap((r, i) =>
      r.method === 'eth_call' &&
      ['0xf04b5fa0', '0x18160ddd', '0x5c9302c9'].includes(r.params[0]?.data?.slice(0, 10))
        ? [{ call: r, result: answers[i].result }]
        : [],
    ),
  });
  return {
    status: 200,
    retryAfter: null,
    body: (async function* () {
      yield bytes;
    })(),
  };
}
const source = (chain, n) => ({
  id: `synthetic-${chain}-${n}`,
  operator: `synthetic-${n}`,
  accountGroup: 'one-test-allocation',
  endpointEnv: `HDD_V2_PROVIDER_${chain}_${n}`,
});
const profile = {
  contract: CONTRACT,
  codeHash: CODE_HASH,
  policy: { mode: 'confirmed', confirmations: 1, rollbackBlocks: 128 },
  ethereum: [source(1, 1), source(1, 2)],
  pulsechain: [source(369, 1), source(369, 2)],
  constructor: {
    checkpoint: m.f.plain(100),
    transactionHash: '0x' + 10000n.toString(16).padStart(64, '0'),
    balances: [],
  },
  fork: { parent: m.f.plain(180), entry: m.f.plain(181) },
  target: m.f.plain(c.head - 1),
};
const endpoints = new Map();
for (const p of [...profile.ethereum, ...profile.pulsechain]) {
  const chain = p.id.includes('-369-') ? 369 : 1;
  process.env[p.endpointEnv] = 'https://' + p.id + '.invalid';
  endpoints.set(process.env[p.endpointEnv], (body, signal) => response(body, signal, p.id, chain));
}
process.env.HDD_V2_SOURCE_PROFILE = '/state/integration-profile.json';
process.env.HDD_V2_METRICS_PROFILE = '/state/integration-metrics.json';
await writeFile(process.env.HDD_V2_SOURCE_PROFILE, JSON.stringify(profile));
await writeFile(process.env.HDD_V2_METRICS_PROFILE, JSON.stringify(m.price));
if (mode === 'watch') {
  server = http.createServer(async (req, res) => {
    try {
      if (req.method !== 'POST' || req.url !== '/rpc') {
        res.writeHead(404).end();
        return;
      }
      const chunks = [];
      let length = 0;
      for await (const chunk of req) {
        length += chunk.length;
        if (length > 65536) throw Error('bounded request');
        chunks.push(chunk);
      }
      const result = await response(
        Buffer.concat(chunks).toString(),
        new AbortController().signal,
        'api',
      );
      res.writeHead(result.status, { 'content-type': 'application/json' });
      for await (const chunk of result.body) res.write(chunk);
      res.end();
    } catch {
      res.writeHead(503).end();
    }
  });
  await new Promise((r) => server.listen(4444, '0.0.0.0', r));
}
try {
  if (mode === 'once' && c.label.startsWith('cycle-')) {
    const cycle = Number(c.label.slice('cycle-'.length));
    const client = await connect(databaseConfig('worker'));
    try {
      const first = c.startDay + 24,
        last = first + cycle - 1;
      await configureMarket(client, 369, 'delayed-synthetic-market', 'source-reported', first);
      if (cycle !== 12 && cycle !== 13) {
        const days = cycle === 14 ? [last - 2, last - 1, last] : [last];
        await importMarketBars(
          client,
          {
            chain: 369,
            source: 'delayed-synthetic-market',
            bars: days.map((day) => ({
              time: 1575331200 + day * 86400,
              revision: '0',
              open: '1',
              high: '2',
              low: '0.5',
              close: '1.5',
              volume: null,
              liquidity: null,
            })),
          },
          Math.floor(clock.now() / 1000),
          new AbortController().signal,
        );
      }
    } finally {
      await client.end();
    }
  }
  const failure = await runWorker(
    [['bootstrap', 'witness'].includes(mode) ? 'rebuild' : mode === 'watch' ? 'watch' : 'once'],
    {
      clock,
      transport: (endpoint) => {
        assert.ok(endpoints.has(endpoint));
        return endpoints.get(endpoint);
      },
    },
  );
  if (failure) throw failure;
} finally {
  clearInterval(resourceTimer);
  await sampling;
  await sampleResources();
  server?.closeAllConnections();
  if (server) await new Promise((r) => server.close(r));
  await writeFile(
    `/evidence/worker-${c.label}.json`,
    JSON.stringify(
      {
        mode,
        budget: budgetEvidence(),
        resources,
        dailyJobs,
        requests,
        virtualNow: clock.now(),
        rss: process.memoryUsage().rss,
        memory: {
          current: await readFile('/sys/fs/cgroup/memory.current', 'utf8'),
          peak: await readFile('/sys/fs/cgroup/memory.peak', 'utf8'),
          events: await readFile('/sys/fs/cgroup/memory.events', 'utf8'),
        },
      },
      null,
      2,
    ),
  );
}
